"""Every file of one dataset, assembled from the store, the marts and the labels and validated
in memory, and refused unless the run's recorded checks still describe the data.
"""

import csv
import hashlib
import io
import json
from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Any

import duckdb

from ousd.chains import REQUIRED_CHAINS
from ousd.checks import (
    CHECK_NAMES,
    Sources,
    built_thresholds,
    data_fingerprint,
    data_warnings,
    freshness,
    mart_rows,
    read_labels,
    reconciliation_gate,
    unacceptable,
    utc_text,
)
from ousd.publish.errors import PublishRefused
from ousd.publish.provenance import _git_commit, _provenance
from ousd.publish.safety import (
    _looks_like_a_name,
    _read_exchange_listings,
    _read_legend,
    _read_source_hosts,
    _read_unnamed_rule,
    _refuse_bad_source,
    _refuse_unsafe_dataset,
)
from ousd.publish.schema import MANIFEST_SCHEMA_VERSION, SCHEMA_VERSION, _json_bytes, _validate
from ousd.store import LatestReconciliation, Store, StoredCheck
from ousd.verdict import ChainFigures, VerdictInputs, build_verdict, known_limits

# OUSD's first day. Placed reads artificially low until wallets are placed_days old.
DAY_ZERO = date(2026, 9, 30)
INDEPENDENCE_NOTICE = "Independent. Not affiliated with Open Standard or Bridge."
PREVIEW_NOTICE = (
    "Local preview only, never for public release. It was published with --allow-partial, so "
    "chains may be missing and the full reconciliation may not have been checked."
)
PREVIEW_CSV_MARK = "LOCAL PREVIEW, NOT FOR RELEASE"
UNNAMED_RULE_REFERENCE = "labels/README.md#how-unnamed-clusters-are-found"
VELOCITY_DEFINITIONS = {
    "velocity_bps": {"numerator": "clean_7d / 7", "denominator": "circulating_supply"},
    "velocity_everyday_bps": {
        "numerator": "clean_everyday_7d / 7",
        "denominator": "circulating_supply",
    },
    "headline_velocity_bps": {"numerator": "headline_7d / 7", "denominator": "total_supply"},
}

# Written as strings of base units, as anything above 2^53 loses exactness in a JSON reader.
_AMOUNTS = frozenset(
    {
        "total_supply",
        "issuer_inventory",
        "placed_supply",
        "placed_exchange_linked",
        "balance",
        "venue_dex",
        "venue_lending",
        "venue_exchange",
        "free_floating",
        "top10_value",
        "headline_value",
        "minted",
        "burned",
        "fees",
        "fee_liquidity",
        "issuer_flows",
        "same_entity",
        "same_tx_netting",
        "dex_flow",
        "lending_flow",
        "clean_large",
        "clean_everyday",
        "circulating_supply",
        "headline_7d",
        "clean_7d",
        "clean_everyday_7d",
        "minted_30d",
        "burned_30d",
        "dex_flow_30d",
        "lending_flow_30d",
        "clean_30d",
        "clean_everyday_30d",
        "event_value",
        "reference_value",
        "difference",
    }
)
_LEADING_MEASURES = {
    "supply": "total_supply",
    "issuance": "minted_30d",
    "everyday": "clean_everyday_30d",
    "dex_flow": "dex_flow_30d",
    "lending_flow": "lending_flow_30d",
}
_DEFINITION_AMOUNTS = (
    "placed_min_base_units",
    "large_transfer_base_units",
    "active_dust_base_units",
    "active_secondary_base_units",
    "clean_tx_min_base_units",
)
_RECONCILIATION_COLUMNS = (
    "kind",
    "subject",
    "block_number",
    "event_value",
    "reference_value",
    "difference",
    "passed",
    "checked_at",
    "run_id",
    "in_latest_run",
)


def _published(row: Mapping[str, Any]) -> dict[str, Any]:
    """One mart row as it is written: amounts as strings, days as dates, times in UTC."""
    out: dict[str, Any] = {}
    for name, value in row.items():
        if name in _AMOUNTS and value is not None:
            value = str(value)
        elif isinstance(value, datetime):
            value = utc_text(value)
        elif isinstance(value, date):
            value = value.isoformat()
        out["day" if name == "day_utc" else name] = value
    return out


def _by_chain_and_day(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(rows, key=lambda row: (row["chain"], row.get("day") or row.get("as_of_day")))


def _journey_rows(
    tables: Mapping[str, Sequence[Mapping[str, Any]]], first_day: date
) -> list[dict[str, Any]]:
    return _by_chain_and_day(
        [_published(row) for row in tables["mart_supply_journey"] if row["day_utc"] >= first_day]
    )


def _activity_rows(tables: Mapping[str, Sequence[Mapping[str, Any]]]) -> list[dict[str, Any]]:
    """A waterfall row per chain and day, with its KPIs. A day that ends with no supply has no
    KPI row, so those columns are null there, and every volume column is still present."""
    kpis = {(row["chain"], row["day_utc"]): row for row in tables["mart_activity_kpis"]}
    kpi_columns = [
        name
        for name in (tables["mart_activity_kpis"][0] if tables["mart_activity_kpis"] else {})
        if name not in ("chain", "day_utc")
    ]
    rows = []
    for row in tables["mart_activity_waterfall"]:
        kpi = kpis.get((row["chain"], row["day_utc"]), {})
        rows.append(_published({**row, **{name: kpi.get(name) for name in kpi_columns}}))
    return _by_chain_and_day(rows)


def _chain_role_rows(tables: Mapping[str, Sequence[Mapping[str, Any]]]) -> list[dict[str, Any]]:
    roles = tables["mart_chain_roles"]
    highest = {
        measure: max((int(row[column]) for row in roles), default=0)
        for measure, column in _LEADING_MEASURES.items()
    }
    rows = []
    for row in roles:
        leading = [
            measure
            for measure, column in _LEADING_MEASURES.items()
            if highest[measure] > 0 and int(row[column]) == highest[measure]
        ]
        rows.append({**_published(row), "leading_for": leading})
    return _by_chain_and_day(rows)


def _run_of_chain_row(store: Store, row: Mapping[str, Any]) -> str | None:
    """The run its `reconciliations` row was filed under, when that run proved its figures in a
    supply check. Only a row written before run_id existed falls back to the finished run that
    proved its figures. None when unclear."""
    recorded: set[str | None] = {
        run_id
        for (run_id,) in store.reconciliation_runs(
            row["subject"],
            row["block_number"],
            row["checked_at"],
            str(row["reference_value"]),
            str(row["event_value"]),
        )
    }
    if len(recorded) != 1:
        # No such row, or rows filed under different runs: no run can be named.
        return None
    (run_id,) = recorded
    figures = (
        row["subject"],
        row["block_number"],
        str(row["reference_value"]),
        str(row["event_value"]),
    )
    if run_id is not None:
        found = store.supply_proof_in_run(*figures, run_id)
        return run_id if found else None
    # Without a run_id, only a row checked before migration 1 added the column may fall back. A
    # later one was written outside any run, so it is no run's.
    found = store.supply_proof_before_run_ids(*figures, row["checked_at"])
    return found[0] if found else None


def _reconciliation_rows(
    store: Store,
    tables: Mapping[str, Sequence[Mapping[str, Any]]],
    latest: LatestReconciliation | None,
) -> list[dict[str, Any]]:
    rows = []
    for row in tables["mart_reconciliation"]:
        run_id = _run_of_chain_row(store, row) if row["kind"] == "chain" else row["run_id"]
        in_latest_run = latest is not None and run_id == latest.run_id
        published = _published({**row, "run_id": run_id, "in_latest_run": in_latest_run})
        rows.append({name: published[name] for name in _RECONCILIATION_COLUMNS})
    return sorted(rows, key=lambda row: (row["kind"], row["subject"]))


def _refuse_unless_one_run(rows: Sequence[Mapping[str, Any]], latest: LatestReconciliation) -> None:
    """The published numbers must be the ones the gate's run proved, or the trust strip lies."""
    chains = {row["subject"]: row for row in rows if row["kind"] == "chain"}
    bridge = [row for row in rows if row["kind"] == "bridge"]
    wrong = [
        chain
        for chain in REQUIRED_CHAINS
        if chain not in chains
        or not chains[chain]["passed"]
        or chains[chain]["difference"] != "0"
        or chains[chain]["run_id"] != latest.run_id
    ]
    if wrong:
        raise PublishRefused(
            f"mart_reconciliation is not from run {latest.run_id} for: {', '.join(wrong)}"
        )
    if (
        len(bridge) != 1
        or not bridge[0]["passed"]
        or bridge[0]["difference"] != "0"
        or bridge[0]["run_id"] != latest.run_id
    ):
        raise PublishRefused(f"mart_reconciliation's Bridge row is not from run {latest.run_id}")


def _issuer_coverage(
    labels: Sequence[Mapping[str, str]], journey: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """Per chain, the rows behind issuer inventory. `issuer_labeled` is the mart's flag, true for
    a route wallet too, so a chain can be labeled and still have no issuer row."""
    labeled = {}
    for row in journey:
        labeled[row["chain"]] = row["issuer_labeled"]
    coverage = []
    for chain in REQUIRED_CHAINS:
        categories = [row["category"] for row in labels if row["chain"] == chain]
        issuer_rows = categories.count("issuer")
        coverage.append(
            {
                "chain": chain,
                "issuer_rows": issuer_rows,
                "issuer_route_rows": categories.count("issuer_route"),
                "has_issuer_row": issuer_rows > 0,
                "issuer_labeled": labeled.get(chain),
            }
        )
    return coverage


def _without_issuer_row(coverage: Sequence[Mapping[str, Any]]) -> list[str]:
    return [row["chain"] for row in coverage if not row["has_issuer_row"]]


def _exchange_holdings(
    tables: Mapping[str, Sequence[Mapping[str, Any]]], journey: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """Each named exchange on each chain's newest published day. They must add up to that day's
    exchange venues, or the two figures a reader sees could disagree."""
    newest: dict[str, Mapping[str, Any]] = {}
    for row in journey:
        if row["chain"] not in newest or row["day"] > newest[row["chain"]]["day"]:
            newest[row["chain"]] = row
    rows = [
        _published(row)
        for row in tables["mart_exchange_holdings"]
        if row["chain"] in newest and row["day_utc"].isoformat() == newest[row["chain"]]["day"]
    ]
    for chain, row in newest.items():
        total = sum(int(held["balance"]) for held in rows if held["chain"] == chain)
        if total != int(row["venue_exchange"]):
            raise PublishRefused(f"exchange holdings don't add up to exchange venues on {chain}")
    return sorted(rows, key=lambda row: (row["chain"], row["entity"]))


def _labels_payload(
    labels: Sequence[Mapping[str, str]],
    readme: str,
    coverage: Sequence[Mapping[str, Any]],
    preview: bool,
    exchange_holdings: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Named labels with how we know them, and unnamed clusters only as a count and their rule.

    An unnamed row publishes no address and no link to one: labels.csv stays the full record. A
    named row's link holds its own address where its source needs that, or a reader can't open it.
    """
    legend = _read_legend(readme)
    known = {row["source_type"] for row in legend["source_types"]}
    if unexplained := {row["source_type"] for row in labels} - known:
        raise PublishRefused(f"label source types not in the legend: {sorted(unexplained)}")
    hosts = _read_source_hosts(readme)
    named = [row for row in labels if row["entity"]]
    for row in named:
        if row["category"] == "exchange_linked":
            raise PublishRefused(f"an exchange-linked label on {row['chain']} has a name")
        if not _looks_like_a_name(row["entity"]):
            raise PublishRefused(
                f"a label on {row['chain']} has an entity that doesn't look like a name"
            )
        _refuse_bad_source(row, hosts)
    rows = sorted(
        (
            {
                "chain": row["chain"],
                "entity": row["entity"],
                "category": row["category"],
                "source_type": row["source_type"],
                "source_url": row["source_url"],
                "confidence": row["confidence"],
                "date_checked": row["date_checked"],
            }
            for row in named
        ),
        key=lambda row: (row["chain"], row["category"], row["entity"], row["source_url"]),
    )
    unnamed = Counter((row["chain"], row["category"]) for row in labels if not row["entity"])
    listings = _read_exchange_listings(readme)
    others = {row["entity"] for row in named if row["category"] != "exchange"}
    if any(row["entity"] in others for row in listings):
        raise PublishRefused("an exchange listing has the name of a label that isn't an exchange")
    return {
        "schema_version": SCHEMA_VERSION,
        "preview": preview,
        "data": rows,
        "unnamed_clusters": {
            "rule_reference": UNNAMED_RULE_REFERENCE,
            "rule": _read_unnamed_rule(readme),
            "counts": [
                {"chain": chain, "category": category, "count": count}
                for (chain, category), count in sorted(unnamed.items())
            ],
        },
        "source_legend": legend,
        "exchange_holdings": list(exchange_holdings),
        "exchange_listings": listings,
        "issuer_coverage": coverage,
        "chains_without_issuer_row": _without_issuer_row(coverage),
    }


def _definitions(sources: Sources, marts: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    """The thresholds the marts were built with, from their own record of the build, so a changed
    dbt_project.yml or a --vars on that build can't make the manifest misdescribe them."""
    built = built_thresholds(marts, json.loads(sources.run_results.read_text()))
    return {
        "placed_days": built["placed_days"],
        **{name: str(built[name]) for name in _DEFINITION_AMOUNTS},
        "journey_first_day": (DAY_ZERO + timedelta(days=built["placed_days"])).isoformat(),
        "velocity": VELOCITY_DEFINITIONS,
    }


def _kpi_rows(
    tables: Mapping[str, Sequence[Mapping[str, Any]]], chains: Sequence[str]
) -> list[dict[str, Any]]:
    """Each chain's newest KPI day, with the supply figures beside it, for the first screen."""
    journey = {(row["chain"], row["day_utc"]): row for row in tables["mart_supply_journey"]}
    rows = []
    for chain in chains:
        kpi = max(
            (row for row in tables["mart_activity_kpis"] if row["chain"] == chain),
            key=lambda row: row["day_utc"],
        )
        held = journey[chain, kpi["day_utc"]]
        total = int(kpi["total_supply"])
        placed = int(held["placed_supply"])
        rows.append(
            _published(
                {
                    "chain": chain,
                    "day_utc": kpi["day_utc"],
                    "total_supply": total,
                    "placed_supply": placed,
                    "placed_share_bps": placed * 10_000 // total if total else None,
                    "circulating_supply": kpi["circulating_supply"],
                    "headline_7d": kpi["headline_7d"],
                    "clean_7d": kpi["clean_7d"],
                    "clean_everyday_7d": kpi["clean_everyday_7d"],
                    "velocity_bps": kpi["velocity_bps"],
                    "velocity_everyday_bps": kpi["velocity_everyday_bps"],
                    "headline_velocity_bps": kpi["headline_velocity_bps"],
                    "active_wallets_7d": kpi["active_wallets_7d"],
                    "active_wallets_over_100_7d": kpi["active_wallets_over_100_7d"],
                    "issuer_labeled": held["issuer_labeled"],
                }
            )
        )
    return rows


def _summary_payload(
    tables: Mapping[str, Sequence[Mapping[str, Any]]],
    chains: Sequence[str],
    statuses: Mapping[str, str],
    definitions: Mapping[str, Any],
    coverage: Sequence[Mapping[str, Any]],
    preview: bool,
) -> dict[str, Any]:
    kpis = _kpi_rows(tables, chains)
    held = {
        (row["chain"], row["day_utc"].isoformat()): row for row in tables["mart_supply_journey"]
    }
    with_issuer = {row["chain"] for row in coverage if row["has_issuer_row"]}
    bridge = [row for row in tables["mart_reconciliation"] if row["kind"] == "bridge"]
    large = int(definitions["large_transfer_base_units"])
    verdict = build_verdict(
        VerdictInputs(
            chains=[
                ChainFigures(
                    chain=row["chain"],
                    day=date.fromisoformat(row["day"]),
                    total_supply=int(row["total_supply"]),
                    placed_supply=int(row["placed_supply"]),
                    placed_exchange_linked=int(
                        held[row["chain"], row["day"]]["placed_exchange_linked"]
                    ),
                    clean_everyday_7d=int(row["clean_everyday_7d"]),
                    full_window=row["headline_velocity_bps"] is not None,
                    has_issuer_label=row["chain"] in with_issuer,
                )
                for row in kpis
            ],
            check_statuses=statuses,
            placed_days=int(definitions["placed_days"]),
            placed_min_base_units=int(definitions["placed_min_base_units"]),
            large_transfer_base_units=large,
            journey_first_day=date.fromisoformat(definitions["journey_first_day"]),
            bridge_total=int(bridge[0]["reference_value"]) if bridge else None,
            preview=preview,
        )
    )
    limits = known_limits(
        large,
        chains_without_issuer_row=_without_issuer_row(coverage),
        chains_not_issuer_labeled=[row["chain"] for row in kpis if not row["issuer_labeled"]],
        chains_missing=[chain for chain in REQUIRED_CHAINS if chain not in chains],
        preview=preview,
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "preview": preview,
        "notice": INDEPENDENCE_NOTICE,
        "verdict": {
            "state": verdict.state,
            "scope": verdict.scope,
            "as_of": verdict.as_of,
            "text": verdict.text,
            "facts": verdict.facts,
            "estimates": verdict.estimates,
            "opinions": verdict.opinions,
        },
        "known_limits": [{"id": limit.id, "text": limit.text} for limit in limits],
        "kpis": kpis,
    }


def _csv_bytes(rows: Sequence[Mapping[str, Any]], preview: bool = False) -> bytes:
    """Base units and the same columns as the JSON. A preview gets a first column saying so on every
    row, as a CSV travels without its folder and manifest."""
    buffer = io.StringIO()
    mark = {"preview": PREVIEW_CSV_MARK} if preview else {}
    writer = csv.DictWriter(buffer, fieldnames=[*mark, *rows[0]], lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow(
            mark
            | {
                name: (
                    ";".join(value)
                    if isinstance(value, list)
                    else str(value).lower()
                    if isinstance(value, bool)
                    else value
                )
                for name, value in row.items()
            }
        )
    return buffer.getvalue().encode()


def _refuse_unless_checked(
    checks: Sequence[StoredCheck],
    run_id: str,
    store: Store,
    marts: duckdb.DuckDBPyConnection,
    moment: datetime,
    allow_partial: bool,
    sources: Sources,
) -> None:
    """Only recorded results count, never an exit status. What they describe must still be true."""
    if not checks:
        raise PublishRefused(f"no check results for run {run_id}")
    statuses = {check.check_name: check.status for check in checks}
    if reasons := unacceptable(statuses, allow_partial):
        raise PublishRefused(f"run {run_id}: {'; '.join(reasons)}")
    if any(not check.blocking for check in checks):
        raise PublishRefused(f"run {run_id}: a check was recorded as not blocking")
    fingerprints = {check.data_fingerprint for check in checks}
    if len(fingerprints) != 1 or None in fingerprints:
        raise PublishRefused(f"run {run_id}: its checks don't describe one state of the data")
    if fingerprints != {data_fingerprint(store, marts, sources)}:
        raise PublishRefused(f"run {run_id}: the data has changed since these checks ran")
    if allow_partial:
        return
    # Rows can be days old. These two read only the store, so they say what is true now.
    for live in (reconciliation_gate(store), freshness(store, REQUIRED_CHAINS, moment)):
        if live.status != "passed":
            raise PublishRefused(f"{live.name} no longer passes: {live.detail}")


def _data_payload(rows: Sequence[Mapping[str, Any]], preview: bool) -> dict[str, Any]:
    return {"schema_version": SCHEMA_VERSION, "preview": preview, "data": list(rows)}


def _dataset_version(moment: datetime, preview: bool) -> str:
    stamp = moment.strftime("%Y%m%dT%H%M%SZ")
    return f"preview-{stamp}" if preview else stamp


def _manifest_payload(
    version: str,
    moment: datetime,
    run_id: str,
    preview: bool,
    latest_run: Mapping[str, Any] | None,
    included: Sequence[str],
    missing: Sequence[str],
    coverage: Sequence[Mapping[str, Any]],
    tables: Mapping[str, Sequence[Mapping[str, Any]]],
    store: Store,
    marts: duckdb.DuckDBPyConnection,
    checks: Mapping[str, StoredCheck],
    definitions: Mapping[str, Any],
    sources: Sources,
    files: Mapping[str, bytes],
    row_counts: Mapping[str, int],
) -> dict[str, Any]:
    days: dict[str, date] = {}
    for row in tables["mart_supply_journey"]:
        days[row["chain"]] = max(row["day_utc"], days.get(row["chain"], row["day_utc"]))
    newest_transfers = dict(store.newest_transfer_timestamps())
    commit, tree_state = _git_commit()
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "dataset_version": version,
        "generated_at": utc_text(moment),
        "time_zone": "UTC",
        "git_commit": commit,
        "provenance": _provenance(tree_state, store, sources),
        "preview": preview,
        "notice": PREVIEW_NOTICE if preview else None,
        "check_run_id": run_id,
        "reconciliation": latest_run,
        "coverage": {
            "chains_expected": list(REQUIRED_CHAINS),
            "chains_included": list(included),
            "chains_missing": list(missing),
            "complete": not missing,
            "data_as_of": {chain: days[chain].isoformat() for chain in included},
            "last_transfer_at": {
                chain: utc_text(datetime.fromtimestamp(newest_transfers[chain], UTC))
                for chain in included
            },
            "synced_through": {chain: store.synced_through(chain) for chain in included},
            "chains_without_issuer_row": _without_issuer_row(coverage),
        },
        "checks": [
            {
                "name": name,
                "status": checks[name].status,
                "blocking": checks[name].blocking,
                "detail": checks[name].detail,
                "checked_at": utc_text(checks[name].checked_at),
            }
            for name in CHECK_NAMES
        ],
        "warnings": [
            {
                "chain": warning.chain,
                "metric": warning.metric,
                "day": warning.day.isoformat(),
                "previous": str(warning.previous),
                "current": str(warning.current),
            }
            for warning in data_warnings(marts, included)
        ],
        "definitions": definitions,
        "labels_sha256": hashlib.sha256(sources.labels.read_bytes()).hexdigest(),
        "files": {
            name: {"sha256": hashlib.sha256(data).hexdigest(), "rows": row_counts[name]}
            for name, data in sorted(files.items())
        },
    }


def _build_files(
    run_id: str,
    store: Store,
    marts: duckdb.DuckDBPyConnection,
    moment: datetime,
    allow_partial: bool,
    sources: Sources,
) -> tuple[str, dict[str, bytes]]:
    """Every file of one dataset, already validated, as (dataset version, bytes by name)."""
    checks = store.check_results(run_id)
    _refuse_unless_checked(checks, run_id, store, marts, moment, allow_partial, sources)
    by_name = {check.check_name: check for check in checks}
    statuses = {check.check_name: check.status for check in checks}

    tables = mart_rows(marts)
    definitions = _definitions(sources, marts)
    journey = _journey_rows(tables, date.fromisoformat(definitions["journey_first_day"]))
    activity = _activity_rows(tables)
    roles = _chain_role_rows(tables)
    latest = store.latest_reconciliation()
    reconciliation = _reconciliation_rows(store, tables, latest)

    has_rows = [
        {row["chain"] for row in rows}
        for rows in (journey, activity, roles, tables["mart_activity_kpis"])
    ]
    included = [chain for chain in REQUIRED_CHAINS if all(chain in seen for seen in has_rows)]
    missing = [chain for chain in REQUIRED_CHAINS if chain not in included]
    if not included:
        raise PublishRefused("no chain has rows to publish")
    if not allow_partial:
        if missing:
            raise PublishRefused(f"chains missing from the dataset: {', '.join(missing)}")
        if latest is None:
            raise PublishRefused("no finished reconciliation run")
        _refuse_unless_one_run(reconciliation, latest)

    labels = read_labels(sources.labels)
    coverage = _issuer_coverage(labels, journey)
    readme = sources.legend.read_text()
    summary = _summary_payload(tables, included, statuses, definitions, coverage, allow_partial)
    latest_run = (
        {
            "run_id": latest.run_id,
            "scope": latest.scope,
            "status": latest.status,
            "finished_at": utc_text(latest.finished_at),
        }
        if latest
        else None
    )
    payloads: dict[str, dict[str, Any]] = {
        "summary.json": summary,
        "journey.json": _data_payload(journey, allow_partial),
        "activity.json": _data_payload(activity, allow_partial),
        "chain_roles.json": _data_payload(roles, allow_partial),
        "reconciliation.json": {
            **_data_payload(reconciliation, allow_partial),
            "latest_run": latest_run,
        },
        "labels.json": _labels_payload(
            labels, readme, coverage, allow_partial, _exchange_holdings(tables, journey)
        ),
    }
    tabular = {"journey.csv": journey, "activity.csv": activity, "chain_roles.csv": roles}

    files = {name: _json_bytes(payload) for name, payload in payloads.items()}
    written = {name: _csv_bytes(rows, allow_partial) for name, rows in tabular.items()}
    files.update(written)
    row_counts = {
        **{name: len(rows) for name, rows in tabular.items()},
        **{name: len(payload.get("data", ())) for name, payload in payloads.items()},
        "summary.json": len(summary["kpis"]),
    }

    version = _dataset_version(moment, allow_partial)
    manifest = _manifest_payload(
        version,
        moment,
        run_id,
        allow_partial,
        latest_run,
        included,
        missing,
        coverage,
        tables,
        store,
        marts,
        by_name,
        definitions,
        sources,
        files,
        row_counts,
    )
    every_payload = {**payloads, "manifest.json": manifest}
    for name, payload in every_payload.items():
        _validate(name, payload)
    _refuse_unsafe_dataset(every_payload, written)
    files["manifest.json"] = _json_bytes(manifest)
    return version, files
