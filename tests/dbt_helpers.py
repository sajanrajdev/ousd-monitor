"""Run the dbt project against a throwaway raw database. Nothing here touches the network."""

import csv
import gc
import json
import os
from collections.abc import Iterable, Sequence
from pathlib import Path

import duckdb
from dbt.adapters.duckdb.connections import DuckDBConnectionManager
from dbt.adapters.factory import reset_adapters
from dbt.cli.main import dbtRunner, dbtRunnerResult
from ousd.decode import Transfer
from ousd.store import Store

DBT_DIR = Path(__file__).resolve().parent.parent / "dbt"
LABEL_COLUMNS = [
    "chain",
    "address",
    "entity",
    "category",
    "source_type",
    "source_url",
    "confidence",
    "date_checked",
]


def write_raw(
    path: Path,
    transfers: Iterable[tuple[str, Transfer]],
    sync_state: dict[str, int],
    reconciliations: Sequence[tuple[str, int, int, int, int, bool]] = (),
) -> None:
    """Create a raw database with the real schema. `transfers` pairs a chain with a row."""
    by_chain: dict[str, list[Transfer]] = {}
    for chain, transfer in transfers:
        by_chain.setdefault(chain, []).append(transfer)
    store = Store(path)
    try:
        for chain, rows in by_chain.items():
            store.write_range(chain, rows, {}, sync_state.get(chain, 0))
        for chain, through in sync_state.items():
            store.db.execute("INSERT OR REPLACE INTO sync_state VALUES (?, ?)", [chain, through])
        for row in reconciliations:
            store.db.execute(
                "INSERT INTO reconciliations "
                "(chain, block_number, minted, burned, onchain_supply, matched) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                [row[0], row[1], str(row[2]), str(row[3]), str(row[4]), row[5]],
            )
    finally:
        store.close()


def run_dbt(
    tmp_path: Path,
    transfers: Iterable[tuple[str, Transfer]],
    labels: Sequence[dict[str, str]],
    sync_state: dict[str, int],
    reconciliations: Sequence[tuple[str, int, int, int, int, bool]] = (),
    select: Sequence[str] | None = None,
    dbt_vars: dict[str, object] | None = None,
) -> dbtRunnerResult:
    write_raw(tmp_path / "ousd.duckdb", transfers, sync_state, reconciliations)
    return invoke_dbt(tmp_path, labels, select, dbt_vars)


def invoke_dbt(
    tmp_path: Path,
    labels: Sequence[dict[str, str]] = (),
    select: Sequence[str] | None = None,
    dbt_vars: dict[str, object] | None = None,
) -> dbtRunnerResult:
    """Run `dbt build` over the raw file already under tmp_path."""
    raw_path = tmp_path / "ousd.duckdb"
    marts_path = tmp_path / "marts.duckdb"
    labels_path = tmp_path / "labels.csv"
    with labels_path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=LABEL_COLUMNS)
        writer.writeheader()
        writer.writerows(labels)

    args = [
        "build",
        "--project-dir",
        str(DBT_DIR),
        "--profiles-dir",
        str(DBT_DIR),
        "--target-path",
        str(tmp_path / "target"),
        "--log-path",
        str(tmp_path / "logs"),
        "--no-send-anonymous-usage-stats",
        "--vars",
        json.dumps({"labels_path": str(labels_path), **(dbt_vars or {})}),
    ]
    if select:
        args += ["--select", *select]
    previous = {k: os.environ.get(k) for k in ("OUSD_DB_PATH", "OUSD_MARTS_DB_PATH")}
    os.environ["OUSD_DB_PATH"] = str(raw_path)
    os.environ["OUSD_MARTS_DB_PATH"] = str(marts_path)
    try:
        return dbtRunner().invoke(args)
    finally:
        # dbt-duckdb keeps the file open in this process until the adapters are reset.
        reset_adapters()
        DuckDBConnectionManager.close_all_connections()
        gc.collect()
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def failed_tests(result: dbtRunnerResult) -> set[str]:
    """Names of the nodes (tests and models) that did not pass."""
    if result.result is None:
        return set()
    return {
        r.node.name
        for r in result.result.results  # type: ignore[union-attr]
        if r.status in ("fail", "error")
    }


def build_marts(
    tmp_path: Path,
    transfers: Iterable[tuple[str, Transfer]],
    labels: Sequence[dict[str, str]],
    sync_state: dict[str, int],
    reconciliations: Sequence[tuple[str, int, int, int, int, bool]] = (),
    select: Sequence[str] | None = None,
    dbt_vars: dict[str, object] | None = None,
) -> duckdb.DuckDBPyConnection:
    """Write a raw DuckDB and a labels CSV under tmp_path, run dbt build through dbtRunner,
    and return a read-only connection to the marts file with raw attached read-only.
    Raises if dbt fails."""
    result = run_dbt(tmp_path, transfers, labels, sync_state, reconciliations, select, dbt_vars)
    if not result.success:
        raise RuntimeError(f"dbt build failed: {result.exception or failed_tests(result)}")
    conn = duckdb.connect(str(tmp_path / "marts.duckdb"), read_only=True)
    # Staging views read through the `raw` alias, so a reader needs it attached too.
    conn.execute(f"ATTACH '{tmp_path / 'ousd.duckdb'}' AS raw (READ_ONLY)")
    return conn
