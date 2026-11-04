"""Writes the versioned dataset the site reads, and refuses unless every check passed in this run.

Everything is built and validated in memory first, so a failure can't leave a half dataset. A
refusal leaves the last good dataset where it is, and marks it stale.

--allow-partial is a local preview for site development, never a release. It writes under a
different folder, under a different pointer, with `preview: true` in every JSON file.
"""

import csv
import hashlib
import io
import json
import logging
import os
import re
import shutil
import subprocess
from collections import Counter
from collections.abc import Iterator, Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import duckdb
import jsonschema

from ousd.chains import KEYED_RPC_ENV, REQUIRED_CHAINS, load_chains
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
    utc_moment,
    utc_text,
)
from ousd.solana import OUSD_MINT
from ousd.store import LatestReconciliation, Store, StoredCheck
from ousd.verdict import ChainFigures, VerdictInputs, build_verdict, known_limits

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
SCHEMA_DIR = Path(__file__).parent / "schemas"
DEFAULT_PUBLISHED_DIR = "data/published"
# A sibling of the real output, so nothing that reads data/published can land on it.
PREVIEW_DIRNAME = "preview-not-for-release"
LATEST = "latest"
LATEST_PREVIEW = "latest-preview"
KEEP_FOLDERS = 14
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

_STAMP = re.compile(r"^(preview-)?[0-9]{8}T[0-9]{6}Z(\.tmp)?$")
_LEGEND_HEADING = "## How we know: the source legend"
_RULE_HEADING = "## How unnamed clusters are found"
_HOSTS_HEADING = "## Where each source lives"
_LEGEND_ROW = re.compile(r"^\| `([a-z_]+)` \| (.+?) \| (.+?) \|$")
_HOST_ROW = re.compile(r"^\| `([a-z_]+)` \| (.+?) \|$")
_READING_NOTE = re.compile(r"^\*\*Reading a label:\*\* (.+)$", re.MULTILINE)
_EVM_SHAPE = re.compile(r"0[xX][0-9a-fA-F]{40}")
# The same address with no prefix. Bounded, so it can't match part of a 64-character hash.
_BARE_EVM_SHAPE = re.compile(r"(?<![0-9A-Za-z])[0-9a-fA-F]{40}(?![0-9A-Za-z])")
# Bounded by anything that isn't a letter or digit, so a longer hash can't match part of itself.
_BASE58_SHAPE = re.compile(r"(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![0-9A-Za-z])")
# A run id is exactly this, and is also valid base58. Any other length of hex stays suspect.
_RUN_ID_SHAPE = re.compile(r"[0-9a-f]{32}")
_URL_SHAPE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://")
# What a word of a name can be. A dotted word reads as a host, so a real one is listed by name.
_NAME_WORD = re.compile(r"\(?[A-Za-z0-9&'-]+\)?")
_PAIR_WORD = re.compile(r"[A-Z0-9]{1,12}/[A-Z0-9]{1,12}")
_DOTTED_NAMES = frozenset({"LI.FI"})
# What a link's path segment can't be. `key` alone, so a slug like key-findings stays readable.
_PLAIN_SEGMENT = re.compile(r"[A-Za-z0-9._-]+")
_KEY_SEGMENT = re.compile(
    r"key|secret|password|passwd|bearer|jwt|credentials?"
    r"|.*(api[-_]?key|access[-_]?token|auth[-_]?token).*",
    re.IGNORECASE,
)
# A label's link, the one place a wallet-shaped value may be, and only after its own check.
_LABEL_LINK_PLACE = re.compile(r"labels\.json/data/\d+/source_url")
# Other variables that can hold a provider URL. KEYED_RPC_ENV has the rest.
_RPC_ENV = ("TEMPO_RPC_URL", "ETHEREUM_RPC_URL", "ETHEREUM_BLOCKSCOUT_URL")

# jsonschema follows the spec, where 714.0 is an integer. A float here means a mart changed type.
_Validator = jsonschema.validators.extend(
    jsonschema.Draft202012Validator,
    type_checker=jsonschema.Draft202012Validator.TYPE_CHECKER.redefine(
        "integer", lambda _, value: isinstance(value, int) and not isinstance(value, bool)
    ),
)

# Written as strings of base units, as anything above 2^53 loses exactness in a JSON reader.
_AMOUNTS = frozenset(
    {
        "total_supply",
        "issuer_inventory",
        "placed_supply",
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


class PublishRefused(RuntimeError):
    """The dataset can't be published. Its message is ours, so it can be shown and stored."""


class PublishUnavailable(PublishRefused):
    """A database is in use. It says nothing about the data, so nothing is marked stale."""


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
    """`reconciliations` records no run, so a chain row's run is the finished one that recorded its
    figures in a supply check."""
    found = store.db.execute(
        """
        SELECT c.run_id
        FROM reconciliation_checks AS c
        INNER JOIN reconciliation_runs AS r ON r.run_id = c.run_id
        WHERE c.check_name = 'chain_supply' AND c.subject = ? AND c.status = 'pass'
          AND c.pin_height = ? AND r.finished_at IS NOT NULL
          AND c.reference_value = CAST(? AS HUGEINT) AND c.observed_value = CAST(? AS HUGEINT)
        ORDER BY c.recorded_at DESC, c.attempt DESC LIMIT 1
        """,
        [row["subject"], row["block_number"], str(row["reference_value"]), str(row["event_value"])],
    ).fetchone()
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


def _section(text: str, heading: str) -> str:
    _, found, after = text.partition(heading)
    if not found:
        raise PublishRefused(f"labels/README.md has no section {heading.removeprefix('## ')!r}")
    return after.partition("\n## ")[0]


def _read_legend(text: str) -> dict[str, Any]:
    """The source legend, parsed from labels/README.md so there is one copy of the words."""
    section = _section(text, _LEGEND_HEADING)
    note = _READING_NOTE.search(section)
    if note is None:
        raise PublishRefused("labels/README.md has no source legend to publish")
    rows = [
        {"source_type": match[1], "meaning": match[2], "how_to_check": match[3]}
        for line in section.splitlines()
        if (match := _LEGEND_ROW.match(line))
    ]
    return {"source_types": rows, "reading_a_label": note[1]}


def _read_unnamed_rule(text: str) -> str:
    return " ".join(_section(text, _RULE_HEADING).split())


def _read_source_hosts(text: str) -> dict[str, set[str]]:
    return {
        match[1]: set(re.findall(r"`([^`]+)`", match[2]))
        for line in _section(text, _HOSTS_HEADING).splitlines()
        if (match := _HOST_ROW.match(line))
    }


def _comparable(address: str) -> str:
    """EVM addresses are case-insensitive. Base58 addresses are not."""
    return address.lower() if address.lower().startswith("0x") else address


def _wallet_shapes(text: str) -> list[str]:
    evm = _EVM_SHAPE.findall(text)
    bare = _BARE_EVM_SHAPE.findall(text)
    base58 = [shape for shape in _BASE58_SHAPE.findall(text) if not _RUN_ID_SHAPE.fullmatch(shape)]
    return [*evm, *bare, *base58]


def _looks_opaque(text: str) -> bool:
    """A run of letters and digits too long or too mixed to be a word."""
    runs = re.split(r"[-_.]", text)
    return any(len(run) >= 20 or (len(run) >= 12 and any(c.isdigit() for c in run)) for run in runs)


def _looks_like_a_name(entity: str) -> bool:
    """Words only, so a URL, a host or a key with no scheme can't pass as a name."""
    return all(
        word in _DOTTED_NAMES
        or ((_NAME_WORD.fullmatch(word) or _PAIR_WORD.fullmatch(word)) and not _looks_opaque(word))
        for word in entity.split(" ")
    )


def _is_key_like(segment: str) -> bool:
    return (
        not _PLAIN_SEGMENT.fullmatch(segment)
        or bool(_KEY_SEGMENT.fullmatch(segment))
        or _looks_opaque(segment)
    )


def _refuse_bad_source(row: Mapping[str, str], hosts: Mapping[str, set[str]]) -> None:
    """A named label's link must open on the source its type documents, and show only that row.
    Messages name the chain alone, since a bad value may be the very thing that must not spread."""
    link = row["source_url"]
    where = f"a label on {row['chain']}"
    parts = urlsplit(link)
    if parts.scheme != "https" or "?" in link or "#" in link or "@" in parts.netloc:
        raise PublishRefused(f"{where} has a source link that isn't a plain https link")
    if parts.hostname not in hosts.get(row["source_type"], ()):
        raise PublishRefused(f"{where} has a source link on a host its source type doesn't list")
    own = _comparable(row["address"])
    if any(_comparable(shape) != own for shape in _wallet_shapes(link)):
        raise PublishRefused(f"{where} has a source link holding another address")
    for segment in filter(None, parts.path.split("/")):
        if _comparable(segment) != own and _is_key_like(segment):
            raise PublishRefused(f"{where} has a source link with a key-like path segment")


def _token_contracts() -> set[str]:
    """OUSD's own contracts, which are public and identify the token rather than any holder."""
    evm = {chain.token.lower() for chain in load_chains({}).values()}
    return {*evm, OUSD_MINT}


def _provider_values() -> list[str]:
    names = (*KEYED_RPC_ENV.values(), *_RPC_ENV)
    return [value for name in names if (value := os.environ.get(name, "").strip())]


def _strings(value: Any, place: str) -> Iterator[tuple[str, str]]:
    if isinstance(value, str):
        yield place, value
    elif isinstance(value, Mapping):
        for key, inner in value.items():
            yield f"{place}/{key}", str(key)
            yield from _strings(inner, f"{place}/{key}")
    elif isinstance(value, list):
        for index, inner in enumerate(value):
            yield from _strings(inner, f"{place}/{index}")


def _refuse_unsafe_text(place: str, text: str, tokens: set[str], providers: Sequence[str]) -> None:
    """Names the place, never the value, as the value is what must not spread."""
    if any(_comparable(shape) not in tokens for shape in _wallet_shapes(text)):
        raise PublishRefused(f"{place} holds a wallet-shaped value")
    if _URL_SHAPE.search(text):
        raise PublishRefused(f"{place} holds a URL")
    if any(value in text for value in providers):
        raise PublishRefused(f"{place} holds a provider URL")


def _refuse_unsafe_dataset(
    payloads: Mapping[str, Mapping[str, Any]], tabular: Mapping[str, bytes]
) -> None:
    """The last gate on what leaves: the whole dataset is refused for one bad value, wherever a
    new column, a check's detail or a label put it. A named label's link has its own check."""
    tokens = _token_contracts()
    providers = _provider_values()
    for filename, payload in payloads.items():
        for place, text in _strings(payload, filename):
            if not _LABEL_LINK_PLACE.fullmatch(place):
                _refuse_unsafe_text(place, text, tokens, providers)
    for filename, data in tabular.items():
        _refuse_unsafe_text(filename, data.decode(), tokens, providers)


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


def _labels_payload(
    labels: Sequence[Mapping[str, str]],
    readme: str,
    coverage: Sequence[Mapping[str, Any]],
    preview: bool,
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
        "issuer_coverage": coverage,
        "chains_without_issuer_row": _without_issuer_row(coverage),
    }


def _definitions(sources: Sources) -> dict[str, Any]:
    """The thresholds the marts were built with, from the build's own compiled SQL, so a changed
    dbt_project.yml or a --vars on that build can't make the manifest misdescribe them."""
    built = built_thresholds(json.loads(sources.run_results.read_text()))
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


def _json_bytes(payload: Mapping[str, Any]) -> bytes:
    return (json.dumps(payload, indent=2, ensure_ascii=False) + "\n").encode()


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


def _validate(filename: str, payload: Mapping[str, Any]) -> None:
    schema = json.loads((SCHEMA_DIR / f"{filename.removesuffix('.json')}.schema.json").read_text())
    error = jsonschema.exceptions.best_match(_Validator(schema).iter_errors(payload))
    if error is not None:
        # The place and the rule, not the value.
        place = "/".join(str(part) for part in error.absolute_path)
        raise PublishRefused(f"{filename} fails its schema at {place or 'top'}: {error.validator}")


def _git_commit() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "--short=12", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise PublishRefused("cannot read the git commit, so this dataset couldn't be traced")
    return result.stdout.strip()


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
    newest_transfers = dict(
        store.db.execute(
            "SELECT chain, max(block_timestamp) FROM transfers GROUP BY chain"
        ).fetchall()
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "dataset_version": version,
        "generated_at": utc_text(moment),
        "time_zone": "UTC",
        "git_commit": _git_commit(),
        "preview": preview,
        "notice": PREVIEW_NOTICE if preview else None,
        "stale": False,
        "stale_since": None,
        "stale_reason": None,
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
    definitions = _definitions(sources)
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
        "labels.json": _labels_payload(labels, readme, coverage, allow_partial),
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


def _point(root: Path, pointer: str, target: str) -> None:
    """Swap the pointer in one step, so a reader sees the old dataset or the new one."""
    temporary = root / f"{pointer}.tmp"
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    os.replace(temporary, root / pointer)


def _install(root: Path, version: str, files: Mapping[str, bytes], pointer: str) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    temporary = root / f"{version}.tmp"
    final = root / version
    shutil.rmtree(temporary, ignore_errors=True)
    temporary.mkdir()
    try:
        for name, data in files.items():
            (temporary / name).write_bytes(data)
        temporary.rename(final)
        try:
            _point(root, pointer, version)
        except BaseException:
            # Ctrl-C can land after the swap, and the pointer must never be left dangling.
            if os.path.realpath(root / pointer) != os.path.realpath(final):
                shutil.rmtree(final, ignore_errors=True)
            raise
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return final


def _prune(root: Path, pointer: str) -> None:
    """Keep the newest folders. The pointer's target stays, whatever its age."""
    current = (root / pointer).resolve().name
    folders = sorted(
        path.name
        for path in root.iterdir()
        if path.is_dir() and not path.is_symlink() and _STAMP.match(path.name)
    )
    finished = [name for name in folders if not name.endswith(".tmp")]
    doomed = [name for name in folders if name.endswith(".tmp")]
    doomed += finished[:-KEEP_FOLDERS]
    for name in doomed:
        if name != current:
            shutil.rmtree(root / name, ignore_errors=True)


def mark_stale(out_root: Path, now: datetime | None = None, reason: str = "") -> bool:
    """Say on the last good dataset that it is no longer current. Only the manifest changes, in
    one step, so its numbers and hashes stay as published. False when there is nothing to mark.

    It isn't validated against today's schema, which it may predate: that mustn't stop the mark.
    """
    moment = utc_moment(now)
    if not (out_root / LATEST).exists():
        return False
    # Resolved once, so a pointer that moves can't send this manifest into another folder.
    path = (out_root / LATEST).resolve() / "manifest.json"
    manifest = json.loads(path.read_text())
    manifest["stale_since"] = manifest.get("stale_since") or utc_text(moment)
    manifest["stale"] = True
    manifest["stale_reason"] = reason
    temporary = path.with_name("manifest.json.tmp")
    try:
        temporary.write_bytes(_json_bytes(manifest))
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def _read_and_build(
    run_id: str,
    marts_path: Path,
    raw_path: Path,
    moment: datetime,
    allow_partial: bool,
    sources: Sources,
) -> tuple[str, dict[str, bytes]]:
    # Store would create a missing file, and an empty database is not a refusal to explain.
    if not raw_path.is_file():
        raise PublishRefused("the raw database does not exist")
    if not marts_path.is_file():
        raise PublishRefused("the marts database does not exist, so run dbt first")
    try:
        store = Store(raw_path)
    except duckdb.IOException as exc:
        raise PublishUnavailable("the raw database is in use by another process") from exc
    try:
        marts = duckdb.connect(str(marts_path), read_only=True)
    except duckdb.IOException as exc:
        store.close()
        raise PublishUnavailable("the marts database is in use by another process") from exc
    try:
        return _build_files(run_id, store, marts, moment, allow_partial, sources)
    finally:
        marts.close()
        store.close()


def publish(
    run_id: str,
    marts_path: Path,
    raw_path: Path,
    out_root: Path,
    allow_partial: bool = False,
    now: datetime | None = None,
    sources: Sources | None = None,
) -> Path:
    """Read check_results for run_id and refuse unless all seven are present and acceptable.

    Build and validate everything, write a new dated folder, then repoint the pointer. Return the
    new folder. On any failure the pointer and every published number stay as they were, and a
    real publish marks the last good dataset stale. A preview touches nothing under out_root.
    """
    moment = utc_moment(now)
    files_from = sources or Sources()
    root = out_root.parent / PREVIEW_DIRNAME if allow_partial else out_root
    pointer = LATEST_PREVIEW if allow_partial else LATEST
    # Versions have one-second resolution. A second publish that fast says nothing about the data.
    if (root / _dataset_version(moment, allow_partial)).exists():
        raise PublishUnavailable("a dataset with this version exists, so try again in a second")
    try:
        version, files = _read_and_build(
            run_id, marts_path, raw_path, moment, allow_partial, files_from
        )
        folder = _install(root, version, files, pointer)
    except PublishUnavailable:
        raise
    except Exception as exc:
        reason = str(exc) if isinstance(exc, PublishRefused) else type(exc).__name__
        if not allow_partial:
            try:
                mark_stale(out_root, moment, reason)
            except Exception as stale_error:
                raise PublishRefused(
                    f"{reason}. The last good dataset could not be marked stale: "
                    f"{type(stale_error).__name__}"
                ) from exc
        if isinstance(exc, PublishRefused):
            raise
        raise PublishRefused(f"publish failed: {reason}") from exc
    try:
        _prune(root, pointer)
    except OSError as exc:
        logger.warning("could not prune old datasets: %s", type(exc).__name__)
    return folder
