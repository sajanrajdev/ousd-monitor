"""The seven blocking checks, as plain functions over the store, the marts and dbt's own record.

Nothing here reads a chain, Bridge or an exit status. Each check reads what was recorded and says
what it found, so a pass can only ever come from the store.
"""

import csv
import hashlib
import json
import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

import duckdb
import yaml

from ousd.chains import REQUIRED_CHAINS
from ousd.http import scrubbed_traceback
from ousd.store import LatestReconciliation, Store

log = logging.getLogger(__name__)

DEFAULT_MARTS_PATH = "data/marts.duckdb"
CHECK_NAMES = (
    "chain_supply",
    "cross_chain_supply",
    "sampled_balances",
    "dbt_tests",
    "volume_waterfall",
    "reconciliation_gate",
    "freshness",
)
# Only these may be skipped, only with a chain missing, and only for a local preview.
SKIPPABLE = ("cross_chain_supply", "reconciliation_gate")
# A daily schedule, with room for one retry.
FRESHNESS_LIMIT = timedelta(hours=36)
MARTS = (
    "mart_supply_journey",
    "mart_activity_waterfall",
    "mart_activity_kpis",
    "mart_chain_roles",
    "mart_reconciliation",
    "mart_exchange_holdings",
)
# Any of these in dbt's arguments means the build covered less than the whole project.
_NARROWING_ARGS = ("select", "exclude", "selector", "resource_types", "exclude_resource_types")
_PASSING_NODE = ("success", "pass")
# The model that records a build's thresholds as one row, with the dbt invocation that built it.
# dbt_project.yml can change after a build, with nothing rebuilt, so this row is what a build used.
# The model selects one column for each name here, from the var of that name.
_BUILD_PARAMS_MODEL = "mart_build_params"
_THRESHOLDS = (
    "placed_days",
    "placed_min_base_units",
    "large_transfer_base_units",
    "clean_tx_min_base_units",
    "active_dust_base_units",
    "active_secondary_base_units",
)
# Day-over-day change, in percent, above which a person should look. They never block.
_SUPPLY_WARNING_PERCENT = 25
_EVERYDAY_WARNING_PERCENT = 100

CheckStatus = Literal["passed", "failed", "skipped"]


@dataclass(frozen=True)
class CheckResult:
    name: str
    status: CheckStatus
    blocking: bool
    detail: str


@dataclass(frozen=True)
class DataWarning:
    """A change that looks wrong and needs a person, never a reason to stop."""

    chain: str
    metric: str
    day: date
    previous: int
    current: int


@dataclass(frozen=True)
class Sources:
    """Files the checks and publish read, relative to the repo root, where every command runs."""

    run_results: Path = Path("dbt/target/run_results.json")
    labels: Path = Path("labels/labels.csv")
    legend: Path = Path("labels/README.md")
    dbt_project: Path = Path("dbt/dbt_project.yml")


def utc_moment(now: datetime | None) -> datetime:
    """The clock, in UTC. A naive time would silently be read as local, so it is refused."""
    if now is None:
        return datetime.now(UTC)
    if now.tzinfo is None:
        raise ValueError("now must carry a time zone")
    return now.astimezone(UTC)


def utc_text(moment: datetime) -> str:
    """ISO 8601 ending in Z, whatever zone the session is in.

    DuckDB returns a TIMESTAMPTZ in the session's zone, and the store's own reads are naive UTC.
    """
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _result(name: str, problems: Sequence[str], passed_detail: str) -> CheckResult:
    if problems:
        return CheckResult(name, "failed", True, "; ".join(problems))
    return CheckResult(name, "passed", True, passed_detail)


def _names(chains: Sequence[str]) -> str:
    return ", ".join(chains)


def _partial_refusal(name: str, missing: Sequence[str], allow_partial: bool) -> CheckResult:
    detail = f"chains missing: {_names(missing)}"
    return CheckResult(name, "skipped" if allow_partial else "failed", True, detail)


def chain_supply(store: Store, chains: Sequence[str]) -> CheckResult:
    """The newest supply result per chain passed, at the cursor, and the events still explain it."""
    problems = []
    for chain in chains:
        row = store.db.execute(
            """
            SELECT status, pin_height, reference_value, observed_value
            FROM reconciliation_checks
            WHERE check_name = 'chain_supply' AND subject = ?
            ORDER BY recorded_at DESC, attempt DESC LIMIT 1
            """,
            [chain],
        ).fetchone()
        if row is None:
            problems.append(f"{chain}: no supply check recorded")
            continue
        status, height, onchain, recorded_events = row
        cursor = store.synced_through(chain)
        if status != "pass":
            problems.append(f"{chain}: newest supply check is {status}")
        elif height is None or height != cursor:
            problems.append(f"{chain}: supply checked at {height}, cursor at {cursor}")
        elif onchain is None or recorded_events != onchain:
            problems.append(f"{chain}: recorded {recorded_events} against {onchain}")
        else:
            minted, burned = store.minted_and_burned(chain, height)
            if minted - burned != onchain:
                problems.append(f"{chain}: events give {minted - burned} against {onchain}")
    return _result("chain_supply", problems, f"{_names(chains)} matched")


def cross_chain_supply(
    store: Store, missing: Sequence[str] = (), allow_partial: bool = False
) -> CheckResult:
    """The newest finished run's recorded Bridge result. It never asks Bridge again: a second read
    has a weaker rule than the recorded one, and could disagree with it."""
    name = "cross_chain_supply"
    if missing:
        return _partial_refusal(name, missing, allow_partial)
    latest = store.latest_reconciliation()
    if latest is None:
        return _result(name, ["no finished reconciliation run"], "")
    final = store.db.execute(
        """
        SELECT status, reference_value, observed_value FROM reconciliation_checks
        WHERE run_id = ? AND check_name = 'bridge'
        ORDER BY attempt DESC LIMIT 1
        """,
        [latest.run_id],
    ).fetchone()
    if final is None:
        return _result(name, [f"run {latest.run_id} recorded no Bridge result"], "")
    status, bridge_total, chains_total = final
    if status != "pass":
        return _result(name, [f"run {latest.run_id}: Bridge result is {status}"], "")
    if bridge_total is None or chains_total != bridge_total:
        return _result(name, [f"chains {chains_total} against Bridge {bridge_total}"], "")
    comparison = store.db.execute(
        """
        SELECT passed, tolerance, chains_total, bridge_total, chains_missing
        FROM bridge_comparisons WHERE run_id = ?
        ORDER BY checked_at DESC LIMIT 1
        """,
        [latest.run_id],
    ).fetchone()
    if comparison is None:
        return _result(name, [f"run {latest.run_id} recorded no Bridge comparison"], "")
    passed, tolerance, compared_chains, compared_bridge, chains_missing = comparison
    if (
        not passed
        or tolerance != 0
        or compared_chains != compared_bridge
        or compared_bridge != bridge_total
        or chains_missing
    ):
        return _result(name, [f"run {latest.run_id}: the Bridge comparison does not match"], "")
    return _result(name, [], f"run {latest.run_id}: chains equal Bridge's {bridge_total}")


def _model_balances(
    marts: duckdb.DuckDBPyConnection, chain: str, samples: Sequence[tuple[str, int, int]]
) -> dict[tuple[str, int], int]:
    """The dbt model's balance at each sample's own height. A wallet with no rows holds 0."""
    rows = marts.execute(
        """
        WITH wanted AS (
            SELECT unnest($addresses::VARCHAR[]) AS address, unnest($heights::BIGINT[]) AS height
        )
        SELECT w.address, w.height,
               arg_max(e.running_balance, (e.block_number, e.log_index, e.side))
        FROM wanted AS w
        LEFT JOIN int_wallet_events AS e
            ON e.chain = $chain AND e.address = w.address AND e.block_number <= w.height
        GROUP BY w.address, w.height
        """,
        {
            "chain": chain,
            "addresses": [address for address, _, _ in samples],
            "heights": [height for _, height, _ in samples],
        },
    ).fetchall()
    return {(address, height): int(balance or 0) for address, height, balance in rows}


def _sample_run(
    store: Store, chain: str, latest: LatestReconciliation | None, partial: bool
) -> str | None:
    """The gate's own run. Only a partial preview may look further back for this chain's samples."""
    if not partial:
        return latest.run_id if latest else None
    row = store.db.execute(
        """
        SELECT r.run_id FROM reconciliation_runs AS r
        WHERE r.finished_at IS NOT NULL AND EXISTS (
            SELECT 1 FROM balance_samples AS s WHERE s.run_id = r.run_id AND s.chain = ?
        )
        ORDER BY r.finished_at DESC, r.started_at DESC, r.run_id DESC LIMIT 1
        """,
        [chain],
    ).fetchone()
    return row[0] if row else None


def sampled_balances(
    store: Store,
    marts: duckdb.DuckDBPyConnection,
    chains: Sequence[str],
    partial: bool = False,
) -> CheckResult:
    """The dbt model against the chain's own reading, recorded by the run, with no network.

    Reconciliation already compared the raw events with these readings. This catches a dbt error
    in between. Details hold counts only, so a wallet address can't reach the manifest.
    """
    latest = store.latest_reconciliation()
    problems = []
    compared = 0
    for chain in chains:
        run_id = _sample_run(store, chain, latest, partial)
        if run_id is None:
            problems.append(f"{chain}: no finished run with samples")
            continue
        final = store.db.execute(
            """
            SELECT status FROM reconciliation_checks
            WHERE run_id = ? AND check_name = 'sampled_balances' AND subject = ?
            ORDER BY attempt DESC LIMIT 1
            """,
            [run_id, chain],
        ).fetchone()
        if final is None or final[0] != "pass":
            state = final[0] if final else "missing"
            problems.append(f"{chain}: sampled balances check is {state}")
            continue
        # Each wallet's newest reading, from any attempt. A recheck rereads only the wallets that
        # differed, so the others keep their reading from the attempt that failed. And a fork can
        # leave an older reading describing rows since replaced.
        samples = store.db.execute(
            """
            SELECT address, height, observed_balance
            FROM balance_samples
            WHERE run_id = ? AND chain = ?
            QUALIFY row_number() OVER (PARTITION BY address ORDER BY attempt DESC) = 1
            """,
            [run_id, chain],
        ).fetchall()
        if not samples:
            problems.append(f"{chain}: run {run_id} recorded no samples")
            continue
        model = _model_balances(marts, chain, samples)
        differing = sum(
            1
            for address, height, observed in samples
            if model.get((address, height)) != int(observed)
        )
        compared += len(samples)
        if differing:
            problems.append(f"{chain}: {differing} of {len(samples)} sampled wallets differ")
    return _result(
        "sampled_balances", problems, f"{compared} wallets equal the model on {_names(chains)}"
    )


def _threshold_row(
    columns: Sequence[str], rows: Sequence[Sequence[Any]]
) -> tuple[str, dict[str, int]]:
    """The one mart_build_params row: the invocation that built it, and its thresholds. It raises
    rather than guess at any other shape, or at an empty or inexact value. Names are matched
    whatever their case, as a formatter may change that, so two that differ only in case are
    refused."""
    names = [column.lower() for column in columns]
    problem = f"the marts' {_BUILD_PARAMS_MODEL} does not hold one row of every threshold"
    if len(rows) != 1 or len(set(names)) != len(names):
        raise ValueError(problem)
    row = dict(zip(names, rows[0], strict=True))
    invocation = row.get("invocation_id")
    thresholds = {name: row.get(name) for name in _THRESHOLDS}
    if type(invocation) is not str or not invocation:
        raise ValueError(problem)
    # A bool is an int to Python, and a string or float would be a guess at the number.
    exact = {name: value for name, value in thresholds.items() if type(value) is int}
    if len(exact) != len(_THRESHOLDS):
        raise ValueError(problem)
    return invocation, exact


def built_thresholds(
    marts: duckdb.DuckDBPyConnection, results: Mapping[str, Any]
) -> dict[str, int]:
    """The thresholds the marts were built with: their mart_build_params row, which must come from
    the build that dbt's record describes, so a later build that left the marts alone can't vouch
    for them."""
    try:
        cursor = marts.execute(f"SELECT * FROM {_BUILD_PARAMS_MODEL}")
    except duckdb.CatalogException as exc:
        raise ValueError(f"marts have no {_BUILD_PARAMS_MODEL}") from exc
    columns = [column[0] for column in cursor.description or ()]
    invocation, thresholds = _threshold_row(columns, cursor.fetchall())
    if invocation != results.get("metadata", {}).get("invocation_id"):
        raise ValueError(f"marts' {_BUILD_PARAMS_MODEL} is not from the build dbt recorded")
    return thresholds


def _threshold_problems(
    results: Mapping[str, Any], project: Path, marts: duckdb.DuckDBPyConnection
) -> list[str]:
    """The marts must hold the thresholds of the build dbt recorded, and those must be the
    project's, with any --vars on that build."""
    try:
        built = built_thresholds(marts, results)
    except ValueError as exc:
        return [str(exc)]
    configured = yaml.safe_load(project.read_text())["vars"]
    expected = {**configured, **results.get("args", {}).get("vars", {})}
    differing = [name for name, value in built.items() if int(expected[name]) != value]
    if differing:
        return [f"marts were built with other values of {', '.join(sorted(differing))}"]
    return []


def _dbt_problems(sources: Sources, marts: duckdb.DuckDBPyConnection) -> list[str]:
    """Reads dbt's own record of each node, because an exit status can't show what was built."""
    try:
        results = json.loads(sources.run_results.read_text())
    except FileNotFoundError:
        return ["dbt has no run_results.json"]
    args = results.get("args", {})
    problems = []
    if args.get("which") != "build":
        problems.append(f"newest dbt command was {args.get('which')}, not build")
    if narrowed := [name for name in _NARROWING_ARGS if args.get(name)]:
        problems.append(f"dbt build was narrowed by {', '.join(narrowed)}")
    # dbt records an exposure as a no-op in every build, as it has nothing to run.
    nodes = [n for n in results.get("results", []) if not n["unique_id"].startswith("exposure.")]
    kinds = {node["unique_id"].split(".")[0] for node in nodes}
    if not {"model", "test"} <= kinds:
        problems.append("dbt build ran no models or no tests")
    if bad := [node["unique_id"] for node in nodes if node["status"] not in _PASSING_NODE]:
        problems.append(f"{len(bad)} dbt nodes did not pass, first {sorted(bad)[0]}")
    problems += _threshold_problems(results, sources.dbt_project, marts)
    return problems


def _marts_behind_raw(
    store: Store, marts: duckdb.DuckDBPyConnection, chains: Sequence[str]
) -> list[str]:
    """dbt can pass over rows older than the ones just reconciled."""
    problems = []
    for chain in chains:
        built = marts.execute(
            """
            SELECT max(block_number), count(DISTINCT (block_number, log_index))
            FROM int_wallet_events WHERE chain = ?
            """,
            [chain],
        ).fetchone()
        raw = store.db.execute(
            "SELECT max(block_number), count(*) FROM transfers WHERE chain = ?", [chain]
        ).fetchone()
        if built != raw:
            problems.append(f"{chain}: marts were not built from the stored transfers")
    return problems


def read_labels(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def _labels_disagree(marts: duckdb.DuckDBPyConnection, path: Path) -> list[str]:
    """The manifest names one labels file, so the marts must have been built from that file."""
    labels = {(row["chain"], row["address"]): row["category"] for row in read_labels(path)}
    wallets = marts.execute(
        "SELECT DISTINCT chain, address, category FROM int_wallet_placed"
    ).fetchall()
    if any(labels.get((chain, address)) != category for chain, address, category in wallets):
        return ["marts were built from a different labels file"]
    return []


def dbt_tests(
    store: Store, marts: duckdb.DuckDBPyConnection, chains: Sequence[str], sources: Sources
) -> CheckResult:
    problems = _dbt_problems(sources, marts)
    problems += _marts_behind_raw(store, marts, chains)
    problems += _labels_disagree(marts, sources.labels)
    return _result("dbt_tests", problems, "full dbt build passed, over the stored transfers")


def volume_waterfall(marts: duckdb.DuckDBPyConnection, chains: Sequence[str]) -> CheckResult:
    """Separate from the dbt test of the same rule, so it is named in the manifest."""
    rows = marts.execute(
        """
        WITH checked AS (
            SELECT
                chain, day_utc,
                headline_value <> minted + burned + fees + fee_liquidity + issuer_flows
                + same_entity + same_tx_netting + dex_flow + lending_flow + clean_large
                + clean_everyday AS off
            FROM mart_activity_waterfall
        )
        SELECT chain, count(*), count(*) FILTER (WHERE off), min(day_utc) FILTER (WHERE off)
        FROM checked GROUP BY chain
        """
    ).fetchall()
    found = {chain: (days, off, first) for chain, days, off, first in rows}
    problems = []
    for chain in chains:
        if chain not in found:
            problems.append(f"{chain}: no waterfall rows")
        elif found[chain][1]:
            days, off, first = found[chain]
            problems.append(f"{chain}: {off} of {days} days do not add up, first {first}")
    return _result("volume_waterfall", problems, f"parts equal headline on {_names(chains)}")


def reconciliation_gate(
    store: Store, missing: Sequence[str] = (), allow_partial: bool = False
) -> CheckResult:
    """Its own check, because the others can pass on `reconciliations.matched` while the run is
    `fail` or `unchecked`, for example with a same-looking group that isn't real."""
    name = "reconciliation_gate"
    if missing:
        return _partial_refusal(name, missing, allow_partial)
    latest = store.latest_reconciliation()
    if latest is None:
        return _result(name, ["no finished reconciliation run"], "")
    if latest.usable:
        return _result(name, [], f"run {latest.run_id}: full pass, and the data has not moved")
    moved = [chain for chain, pin in latest.chains.items() if not pin.current]
    state = f"scope {latest.scope}, status {latest.status}, exit code {latest.exit_code}"
    changed = f", changed since: {_names(sorted(moved))}" if moved else ""
    return _result(name, [f"run {latest.run_id}: not usable, {state}{changed}"], "")


def freshness(store: Store, chains: Sequence[str], now: datetime) -> CheckResult:
    limit = f"{FRESHNESS_LIMIT.total_seconds() / 3600:.0f} hours"
    problems = []
    for chain in chains:
        newest_transfer = store.db.execute(
            "SELECT max(block_timestamp) FROM transfers WHERE chain = ?", [chain]
        ).fetchone()
        # From a finished run only: a run that crashed proved nothing, however recently it began.
        newest_check = store.db.execute(
            """
            SELECT max(c.recorded_at) AT TIME ZONE 'UTC'
            FROM reconciliation_checks AS c
            INNER JOIN reconciliation_runs AS r ON r.run_id = c.run_id
            WHERE c.check_name = 'chain_supply' AND c.subject = ? AND r.finished_at IS NOT NULL
            """,
            [chain],
        ).fetchone()
        if newest_transfer is None or newest_transfer[0] is None:
            problems.append(f"{chain}: no transfers")
        elif now - datetime.fromtimestamp(newest_transfer[0], UTC) > FRESHNESS_LIMIT:
            problems.append(f"{chain}: newest transfer is over {limit} old")
        if newest_check is None or newest_check[0] is None:
            problems.append(f"{chain}: no reconciliation")
        elif now - newest_check[0].replace(tzinfo=UTC) > FRESHNESS_LIMIT:
            problems.append(f"{chain}: newest reconciliation is over {limit} old")
    return _result("freshness", problems, f"{_names(chains)} within {limit}")


def present_chains(store: Store) -> list[str]:
    """Required chains with a cursor and at least one transfer, in the one list's order."""
    return [
        chain
        for chain in REQUIRED_CHAINS
        if store.synced_through(chain) is not None and store.transfer_count(chain) > 0
    ]


def _table_rows(marts: duckdb.DuckDBPyConnection, table: str) -> list[dict[str, Any]]:
    """A table's rows, in a stable order, whatever order the file holds them in."""
    cursor = marts.execute(f"SELECT * FROM {table} ORDER BY ALL")
    names = [column[0] for column in cursor.description or ()]
    return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]


def mart_rows(marts: duckdb.DuckDBPyConnection) -> dict[str, list[dict[str, Any]]]:
    """Every published mart, in a stable order."""
    return {table: _table_rows(marts, table) for table in MARTS}


def _plain(value: object) -> str:
    if isinstance(value, datetime):
        return utc_text(value)
    if isinstance(value, date):
        return value.isoformat()
    raise TypeError(f"cannot fingerprint a {type(value).__name__}")


def data_fingerprint(store: Store, marts: duckdb.DuckDBPyConnection, sources: Sources) -> str:
    """Identifies the raw state, the marts, the labels, dbt's record, the project's thresholds and
    the thresholds the marts were built with, as the checks saw them."""
    raw = {
        chain: [
            cursor := store.synced_through(chain),
            store.transfer_count(chain),
            store.block_hashes(chain).get(cursor) if cursor is not None else None,
        ]
        for chain in REQUIRED_CHAINS
    }
    files = [
        hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (sources.labels, sources.run_results, sources.dbt_project)
    ]
    built = _table_rows(marts, _BUILD_PARAMS_MODEL)
    payload = json.dumps([raw, files, mart_rows(marts), built], default=_plain, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


def _guarded(name: str, check: Callable[[], CheckResult]) -> CheckResult:
    """A check that can't run has not passed. The detail is published, so it names the class
    only, as a message can hold a path. The log gets the scrubbed traceback."""
    try:
        return check()
    except Exception as exc:
        log.error("%s could not run:\n%s", name, scrubbed_traceback(exc))
        return CheckResult(name, "failed", True, f"could not run: {type(exc).__name__}")


@dataclass(frozen=True)
class EvaluatedChecks:
    """The seven results, when they ran, and the state of the data they saw."""

    results: list[CheckResult]
    moment: datetime
    fingerprint: str | None


def run_checks(
    store: Store,
    marts: duckdb.DuckDBPyConnection,
    run_id: str,
    allow_partial: bool = False,
    now: datetime | None = None,
    sources: Sources | None = None,
) -> list[CheckResult]:
    """Run all seven and record them under run_id, replacing any earlier rows of that run."""
    evaluated = evaluate_checks(store, marts, allow_partial, now, sources)
    record_checks(store, run_id, evaluated)
    return evaluated.results


def evaluate_checks(
    store: Store,
    marts: duckdb.DuckDBPyConnection,
    allow_partial: bool = False,
    now: datetime | None = None,
    sources: Sources | None = None,
) -> EvaluatedChecks:
    """Run all seven without recording anything, so a read-only store will do."""
    moment = utc_moment(now)
    files = sources or Sources()
    present = present_chains(store)
    missing = [chain for chain in REQUIRED_CHAINS if chain not in present]
    partial = allow_partial and bool(missing)
    # Without a partial preview a missing chain is looked for, and so fails each check.
    chains: Sequence[str] = present if partial else REQUIRED_CHAINS
    checks: dict[str, Callable[[], CheckResult]] = {
        "chain_supply": lambda: chain_supply(store, chains),
        "cross_chain_supply": lambda: cross_chain_supply(store, missing, allow_partial),
        "sampled_balances": lambda: sampled_balances(store, marts, chains, partial),
        "dbt_tests": lambda: dbt_tests(store, marts, chains, files),
        "volume_waterfall": lambda: volume_waterfall(marts, chains),
        "reconciliation_gate": lambda: reconciliation_gate(store, missing, allow_partial),
        "freshness": lambda: freshness(store, chains, moment),
    }
    if not chains:
        results = [
            CheckResult(name, "failed", True, "no required chain has data") for name in CHECK_NAMES
        ]
    else:
        results = [_guarded(name, checks[name]) for name in CHECK_NAMES]
    try:
        fingerprint: str | None = data_fingerprint(store, marts, files)
    except Exception:
        # Publish refuses a missing fingerprint, so this can't let anything through.
        fingerprint = None
    return EvaluatedChecks(results, moment, fingerprint)


def record_checks(store: Store, run_id: str, evaluated: EvaluatedChecks) -> None:
    """Record them under run_id, replacing any earlier rows of that run."""
    store.replace_check_results(
        run_id,
        [(r.name, r.status, r.blocking, r.detail) for r in evaluated.results],
        evaluated.moment,
        evaluated.fingerprint,
    )


def unacceptable(statuses: Mapping[str, str], allow_partial: bool = False) -> list[str]:
    """Why these results can't publish, empty when they can. One rule for `check` and `publish`."""
    reasons = []
    for name in CHECK_NAMES:
        status = statuses.get(name)
        if status == "passed" or (allow_partial and status == "skipped" and name in SKIPPABLE):
            continue
        reasons.append(f"{name} is {status or 'missing'}")
    return reasons


def _change_is_large(previous: int, current: int, percent: int) -> bool:
    if previous == 0:
        return current != 0
    return abs(current - previous) * 100 > percent * abs(previous)


def data_warnings(marts: duckdb.DuckDBPyConnection, chains: Sequence[str]) -> list[DataWarning]:
    """Each chain's newest day against the day before it."""
    found = []
    metrics = (
        ("mart_supply_journey", "total_supply", _SUPPLY_WARNING_PERCENT),
        ("mart_supply_journey", "placed_supply", _SUPPLY_WARNING_PERCENT),
        ("mart_activity_kpis", "circulating_supply", _SUPPLY_WARNING_PERCENT),
        ("mart_activity_kpis", "clean_everyday_7d", _EVERYDAY_WARNING_PERCENT),
    )
    for chain in chains:
        for table, metric, percent in metrics:
            rows = marts.execute(
                f"SELECT day_utc, {metric} FROM {table} WHERE chain = ? "
                "ORDER BY day_utc DESC LIMIT 2",
                [chain],
            ).fetchall()
            if len(rows) == 2:
                (day, current), (_, previous) = rows
                if _change_is_large(int(previous), int(current), percent):
                    found.append(DataWarning(chain, metric, day, int(previous), int(current)))
    return found
