"""mart_reconciliation scenarios. Every case builds the dbt project over a throwaway database."""

from datetime import UTC, datetime, timedelta

import duckdb
from dbt_helpers import invoke_dbt, write_raw

T0 = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)
BIG = 2**70


def at(minutes):
    return T0 + timedelta(minutes=minutes)


def build(tmp_path, chain_results=(), runs=(), bridges=()):
    """Write a raw database, add the recorded results, run dbt and return mart rows by kind.

    chain_results: (chain, minted, burned, onchain, matched, minute)
    runs: (run_id, scope, status, finished_minute or None)
    bridges: (run_id, chains_total, bridge_total, passed, minute)
    """
    write_raw(tmp_path / "ousd.duckdb", [], {})
    raw = duckdb.connect(str(tmp_path / "ousd.duckdb"))
    try:
        for chain, minted, burned, onchain, matched, minute in chain_results:
            raw.execute(
                "INSERT INTO reconciliations VALUES (?, ?, 100, "
                "CAST(? AS HUGEINT), CAST(? AS HUGEINT), CAST(? AS HUGEINT), ?)",
                [at(minute), chain, str(minted), str(burned), str(onchain), matched],
            )
        for run_id, scope, status, finished in runs:
            raw.execute(
                "INSERT INTO reconciliation_runs (run_id, started_at, finished_at, scope, status) "
                "VALUES (?, ?, ?, ?, ?)",
                [run_id, at(0), None if finished is None else at(finished), scope, status],
            )
        for run_id, chains_total, bridge_total, passed, minute in bridges:
            raw.execute(
                "INSERT INTO bridge_comparisons VALUES (?, 'tempo', '', "
                "CAST(? AS HUGEINT), CAST(? AS HUGEINT), 0, ?, ?)",
                [at(minute), str(chains_total), str(bridge_total), passed, run_id],
            )
    finally:
        raw.close()
    result = invoke_dbt(tmp_path, select=["mart_reconciliation"])
    assert result.success
    conn = duckdb.connect(str(tmp_path / "marts.duckdb"), read_only=True)
    try:
        cursor = conn.execute("select * from mart_reconciliation order by kind, subject")
        names = [d[0] for d in cursor.description]
        return [dict(zip(names, r, strict=True)) for r in cursor.fetchall()]
    finally:
        conn.close()


def only(rows, kind, subject=None):
    found = [r for r in rows if r["kind"] == kind and subject in (None, r["subject"])]
    assert len(found) == 1
    return found[0]


def test_only_the_newest_row_per_chain_appears(tmp_path):
    rows = build(
        tmp_path,
        chain_results=[("tempo", 50, 10, 40, True, 1), ("tempo", 90, 10, 70, False, 2)],
    )
    assert [r["kind"] for r in rows] == ["chain"]
    assert rows[0]["event_value"] == 80
    assert rows[0]["passed"] is False


def test_difference_is_exact_above_2_to_the_64(tmp_path):
    rows = build(tmp_path, chain_results=[("tempo", BIG + 5, 3, BIG, True, 1)])
    assert rows[0]["difference"] == 2
    assert rows[0]["event_value"] == BIG + 2


def test_a_chain_mismatch_surfaces_passed_false(tmp_path):
    rows = build(
        tmp_path,
        chain_results=[("tempo", 100, 0, 100, True, 1), ("base", 100, 0, 99, False, 1)],
    )
    assert only(rows, "chain", "tempo")["passed"] is True
    base = only(rows, "chain", "base")
    assert base["passed"] is False
    assert base["difference"] == 1


def test_no_bridge_comparisons_gives_chain_rows_only(tmp_path):
    rows = build(tmp_path, chain_results=[("tempo", 1, 0, 1, True, 1)])
    assert {r["kind"] for r in rows} == {"chain"}


def test_a_bridge_row_gives_one_bridge_row_with_its_run(tmp_path):
    rows = build(
        tmp_path,
        runs=[("r1", "full", "pass", 5)],
        bridges=[("r1", BIG + 1, BIG, False, 4)],
    )
    bridge = only(rows, "bridge")
    assert bridge["subject"] == "all_chains"
    assert bridge["difference"] == 1
    assert bridge["passed"] is False
    assert bridge["run_id"] == "r1"
    assert bridge["in_latest_run"] is True


def test_a_run_with_no_comparison_leaves_the_older_bridge_row_marked_as_not_this_runs(tmp_path):
    rows = build(
        tmp_path,
        runs=[("old", "full", "pass", 5), ("new", "partial", "unchecked", 15)],
        bridges=[("old", 10, 10, True, 4)],
    )
    bridge = only(rows, "bridge")
    assert bridge["run_id"] == "old"
    assert bridge["passed"] is True  # that run's own result, kept as recorded
    assert bridge["in_latest_run"] is False
    # Every row shows the latest run's own status, not the older pass.
    assert bridge["latest_run_id"] == "new"
    assert bridge["latest_run_status"] == "unchecked"
    assert bridge["latest_run_scope"] == "partial"


def test_an_unfinished_run_is_not_the_latest_run(tmp_path):
    rows = build(
        tmp_path,
        runs=[("done", "full", "fail", 5), ("open", "full", None, None)],
        bridges=[("done", 1, 2, False, 4)],
    )
    bridge = only(rows, "bridge")
    assert bridge["latest_run_id"] == "done"
    assert bridge["latest_run_status"] == "fail"
    assert bridge["in_latest_run"] is True


def test_with_no_finished_run_the_status_is_null_and_nothing_is_this_runs(tmp_path):
    rows = build(
        tmp_path,
        chain_results=[("tempo", 1, 0, 1, True, 1)],
        bridges=[(None, 10, 10, True, 4)],
    )
    bridge = only(rows, "bridge")
    assert bridge["latest_run_status"] is None
    assert bridge["in_latest_run"] is False
    assert only(rows, "chain")["latest_run_id"] is None


def test_the_newest_of_several_bridge_rows_wins_and_its_run_follows(tmp_path):
    rows = build(
        tmp_path,
        runs=[("r1", "full", "fail", 5), ("r2", "full", "pass", 15)],
        bridges=[("r2", 10, 10, True, 14), ("r1", 10, 11, False, 4)],
    )
    bridge = only(rows, "bridge")
    assert bridge["run_id"] == "r2"
    assert bridge["passed"] is True
    assert bridge["in_latest_run"] is True
