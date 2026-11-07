import ast
from pathlib import Path
from typing import Any

import pytest
from conftest import ALICE, BOB
from ousd import reconcile
from ousd.chains import REQUIRED_CHAINS
from ousd.http import HttpError
from ousd.reconcile import (
    REASONS,
    BridgeWait,
    ChainUnavailable,
    CheckOutcome,
    Unchecked,
    reconcile_chain,
    run_reconciliation,
)
from ousd.store import Store, StoreConflict
from reconcile_fakes import (
    BAD,
    FOUR_CHAINS,
    KEY,
    LARGE,
    NOW,
    STALE,
    TX,
    BridgeFeed,
    Drift,
    FakeProbe,
    PinBehind,
    WrongChain,
    bad_at,
    bridge_passes,
    caused_by,
    checks,
    comparisons,
    four_probes,
    good_at,
    no_sleep,
    off_by,
    only_the_first_read_moves_the_cursor,
    proof_of,
    run_it,
    runs,
    same_transaction,
    slot_probes,
    stored_check_text,
    synced_chain,
    tempo_probes,
)


def test_four_passing_chains_and_bridge_exit_zero_and_open_the_gate(store):
    result, reported = run_it(store, four_probes(store))

    assert (result.scope, result.status, result.exit_code) == ("full", "pass", 0)
    assert set(result.chains.values()) == {"pass"}
    assert result.bridge == "pass"
    assert runs(store) == [("full", "pass", 0, False)]
    latest = store.latest_reconciliation()
    assert latest.usable
    assert latest.chains["tempo"].pin_hash is not None
    assert latest.chains["solana"].pin_hash is None
    outcomes = [item for item in reported if isinstance(item, CheckOutcome)]
    names = [(outcome.check_name, outcome.subject) for outcome in outcomes]
    for chain in REQUIRED_CHAINS:
        assert names.count(("chain_supply", chain)) == 1
        assert names.count(("sampled_balances", chain)) == 1
        assert names.count(("same_looking", chain)) == 1
    assert names.count(("bridge", "all")) == 1


def test_the_bridge_check_reads_every_chain_through_its_final_pin(store, monkeypatch):
    seen = []
    real = store.supply_values

    def spy(chain, start_ts, end_ts, through_block):
        seen.append((chain, through_block))
        return real(chain, start_ts, end_ts, through_block)

    monkeypatch.setattr(store, "supply_values", spy)

    run_it(store, four_probes(store, tempo=[PinBehind(1), None]))

    assert seen == [(name, 120) for name in REQUIRED_CHAINS]


def test_with_no_bridge_check_four_passing_chains_are_unchecked(store):
    result, _ = run_it(store, four_probes(store), bridge=None)

    assert (result.status, result.exit_code) == ("unchecked", 3)
    assert checks(store, "bridge", "all") == [(1, "unchecked", "not_configured")]
    assert not store.latest_reconciliation().usable


def test_two_probes_for_one_chain_are_refused_before_a_run_starts(store):
    with pytest.raises(ValueError, match="more than one probe"):
        run_it(store, [FakeProbe(store, "tempo"), FakeProbe(store, "tempo")])

    assert runs(store) == []


@pytest.mark.parametrize(
    "names", [("tempo",), REQUIRED_CHAINS[:3], ("tempo", "testnet")], ids=["one", "three", "extra"]
)
def test_a_matching_subset_is_unchecked_and_never_consults_bridge(store, names):
    def bridge():
        raise AssertionError("a partial run must not reach Bridge")

    probes = [FakeProbe(store, name) for name in names]

    result, reported = run_it(store, probes, bridge)

    assert (result.scope, result.status, result.exit_code) == ("partial", "unchecked", 3)
    assert all(result.chains[name] == "pass" for name in names)
    assert checks(store, "bridge", "all") == [(1, "unchecked", "chains_not_passed")]
    assert not store.latest_reconciliation().usable
    missing = [name for name in REQUIRED_CHAINS if name not in names]
    for name in missing:
        assert result.chains[name] == "unchecked"
        assert checks(store, "chain_supply", name) == [(1, "unchecked", "not_configured")]
    assert {o.subject for o in reported} >= {*names, *missing, "all"}
    assert comparisons(store) == []


def test_no_probes_at_all_is_unchecked(store):
    result, _ = run_it(store, [])

    assert (result.scope, result.status, result.exit_code) == ("partial", "unchecked", 3)
    assert set(result.chains) == set(REQUIRED_CHAINS)


# Failures


def test_a_chain_that_cannot_be_read_does_not_stop_the_others(store):
    probes = four_probes(store, ethereum=[ChainUnavailable("sync_failed")])

    result, reported = run_it(store, probes)

    assert result.chains == {
        "tempo": "pass",
        "ethereum": "unchecked",
        "base": "pass",
        "solana": "pass",
    }
    assert (result.status, result.exit_code) == ("unchecked", 3)
    assert checks(store, "chain_supply", "ethereum") == [(1, "unchecked", "sync_failed")]
    assert probes[2].syncs() == probes[3].syncs() == 1
    outcomes = [item for item in reported if isinstance(item, CheckOutcome)]
    supply = [o for o in outcomes if o.check_name == "chain_supply"]
    assert [o.subject for o in supply][:4] == list(REQUIRED_CHAINS)


def test_a_store_conflict_is_a_fail(store):
    probes = four_probes(store, base=[StoreConflict("base: block 5, log 0 is stored as ...")])

    result, _ = run_it(store, probes)

    assert (result.chains["base"], result.status, result.exit_code) == ("fail", "fail", 1)
    assert checks(store, "chain_supply", "base") == [(1, "fail", "store_conflict")]
    assert probes[3].syncs() == 1


def test_an_unchecked_return_is_unchecked(store):
    probes = four_probes(store, solana=[Unchecked("solana", "not_synced")])

    result, _ = run_it(store, probes)

    assert (result.chains["solana"], result.status, result.exit_code) == (
        "unchecked",
        "unchecked",
        3,
    )
    assert checks(store, "chain_supply", "solana") == [(1, "unchecked", "not_synced")]


def test_an_unexpected_error_propagates_and_leaves_the_run_unfinished(store):
    probes = four_probes(store, ethereum=[KeyError("a programming error")])
    reported: list[Any] = []

    with pytest.raises(KeyError):
        run_reconciliation(probes, store, reported.append, bridge=bridge_passes, sleep=no_sleep)

    assert ("tempo", "chain_supply", "pass") in [
        (o.subject, o.check_name, o.status) for o in reported
    ]
    assert {o.subject for o in reported} == {"tempo"}
    assert runs(store) == [("full", None, None, True)]
    assert store.latest_reconciliation() is None


def test_a_source_error_a_probe_failed_to_map_leaves_the_run_unfinished(store):
    probes = four_probes(store, tempo=[HttpError("tempo-rpc: HTTP 500")])

    with pytest.raises(HttpError):
        run_it(store, probes)

    assert runs(store) == [("full", None, None, True)]
    assert store.latest_reconciliation() is None


@pytest.mark.parametrize(
    "step",
    [WrongChain("ethereum"), Unchecked("ethereum", "not_synced")],
    ids=["reading", "unchecked-return"],
)
def test_a_probe_answering_for_another_chain_raises_and_leaves_the_run_unfinished(store, step):
    probes = four_probes(store, tempo=[step])
    reported: list[Any] = []

    with pytest.raises(ValueError, match="tempo probe answered for ethereum"):
        run_reconciliation(probes, store, reported.append, bridge=bridge_passes, sleep=no_sleep)

    assert reported == []
    assert checks(store, "chain_supply", "tempo") == []
    assert runs(store) == [("full", None, None, True)]
    assert store.latest_reconciliation() is None


def test_a_bug_in_the_bridge_fetch_raises_and_leaves_the_run_unfinished(store):
    with pytest.raises(KeyError):
        run_it(store, four_probes(store), BridgeFeed(KeyError("total")))

    assert runs(store) == [("full", None, None, True)]
    assert store.latest_reconciliation() is None


# Bridge attempts, and recording


def test_attempt_rises_across_every_kind_of_retry_and_the_final_pin_is_the_highest(store):
    probes = four_probes(store, tempo=[Drift(1), PinBehind(1), None])
    tempo = probes[0]
    sleeps: list[float] = []

    snapshots = [bad_at(0), good_at(1)]

    def bridge():
        # The attempt after this one syncs to a newer tip.
        tempo.rpc.extend(125)
        return snapshots.pop(0)

    result, reported = run_it(store, probes, bridge, sleep=sleeps.append)

    assert (result.status, result.exit_code) == ("pass", 0)
    assert sleeps == [600]
    assert checks(store, "chain_supply", "tempo") == [
        (1, "fail", "supply_mismatch"),
        (2, "unchecked", "pin_behind_cursor"),
        (3, "pass", None),
        (4, "pass", None),
    ]
    assert checks(store, "chain_supply", "base") == [(1, "pass", None), (2, "pass", None)]
    assert checks(store, "bridge", "all") == [(1, "fail", "bridge_mismatch"), (2, "pass", None)]
    heights = store.db.execute(
        """
        SELECT pin_height FROM reconciliation_checks
        WHERE check_name = 'chain_supply' AND subject = 'tempo' ORDER BY attempt
        """
    ).fetchall()
    assert heights[-1] == (125,)
    latest = store.latest_reconciliation()
    assert latest.chains["tempo"].pin_height == 125 == store.synced_through("tempo")
    assert latest.usable
    waits = [item for item in reported if isinstance(item, BridgeWait)]
    assert waits == [BridgeWait(1, 600, NOW + 600)]


@pytest.mark.parametrize(
    ("snapshots", "status", "code", "rows"),
    [
        (
            [bad_at(0), good_at(1)],
            "pass",
            0,
            [(1, "fail", "bridge_mismatch"), (2, "pass", None)],
        ),
        (
            [bad_at(0), bad_at(1), bad_at(2)],
            "fail",
            1,
            [
                (1, "fail", "bridge_mismatch"),
                (2, "fail", "bridge_mismatch"),
                (3, "fail", "bridge_mismatch"),
            ],
        ),
        (
            [STALE, STALE, STALE],
            "unchecked",
            3,
            [
                (1, "unchecked", "bridge_stale"),
                (2, "unchecked", "bridge_stale"),
                (3, "unchecked", "bridge_stale"),
            ],
        ),
        (
            [STALE, bad_at(0), STALE],
            "fail",
            1,
            [
                (1, "unchecked", "bridge_stale"),
                (2, "fail", "bridge_mismatch"),
                (3, "unchecked", "bridge_stale"),
            ],
        ),
        (
            [STALE, good_at(0)],
            "pass",
            0,
            [(1, "unchecked", "bridge_stale"), (2, "pass", None)],
        ),
    ],
    ids=[
        "fail-then-pass",
        "fail-thrice",
        "stale-thrice",
        "one-fail-among-stale",
        "stale-then-pass",
    ],
)
def test_any_bridge_pass_counts_and_one_unmatched_attempt_is_enough_to_fail(
    store, snapshots, status, code, rows
):
    slept: list[float] = []

    result, _ = run_it(store, four_probes(store), BridgeFeed(*snapshots), sleep=slept.append)

    assert (result.bridge, result.status, result.exit_code) == (status, status, code)
    assert slept == [600] * (len(rows) - 1)
    assert checks(store, "bridge", "all") == rows


def test_a_chain_that_stops_passing_on_a_bridge_retry_ends_the_run(store):
    probes = four_probes(store, tempo=[None, ChainUnavailable("sync_failed")])
    slept: list[float] = []

    result, _ = run_it(store, probes, BridgeFeed(bad_at(0), good_at(1)), sleep=slept.append)

    assert result.chains["tempo"] == "unchecked"
    assert (result.bridge, result.status, result.exit_code) == ("fail", "fail", 1)
    assert slept == [600]
    assert checks(store, "bridge", "all") == [
        (1, "fail", "bridge_mismatch"),
        (2, "unchecked", "chains_not_passed"),
    ]


def test_a_finished_run_records_its_status_exit_code_and_a_default_check(store):
    result, _ = run_it(store, four_probes(store), bridge=None)

    assert runs(store) == [("full", "unchecked", 3, False)]
    by_chain = store.db.execute(
        "SELECT chain, block_number, matched FROM reconciliations ORDER BY chain"
    ).fetchall()
    assert by_chain == [(name, 120, True) for name in sorted(REQUIRED_CHAINS)]
    stored = store.db.execute(
        """
        SELECT pin_height, transfer_count, reference_value, observed_value
        FROM reconciliation_checks WHERE check_name = 'chain_supply' AND subject = 'tempo'
        """
    ).fetchone()
    assert stored == (120, 2, LARGE, LARGE)
    assert result.run_id == store.latest_reconciliation().run_id


def test_every_reconciliation_in_a_run_is_filed_under_that_run(store):
    first, _ = run_it(store, four_probes(store, tempo=[Drift(1)]))
    second, _ = run_it(store, four_probes(store))

    by_run = store.db.execute(
        "SELECT run_id, count(*) FROM reconciliations GROUP BY run_id ORDER BY count(*) DESC"
    ).fetchall()
    # The first run's tempo mismatch was read twice.
    chains = len(REQUIRED_CHAINS)
    assert by_run == [(first.run_id, chains + 1), (second.run_id, chains)]


def test_a_reconciliation_outside_a_run_has_no_run(store):
    chain, rpc = synced_chain(store)
    reconcile_chain(chain, rpc, store)

    assert store.db.execute("SELECT run_id FROM reconciliations").fetchall() == [(None,)]


def test_a_mismatch_row_keeps_the_chain_figure_and_the_event_figure_apart(store):
    run_it(store, four_probes(store, tempo=[Drift(1), Drift(2)]))

    stored = store.db.execute(
        """
        SELECT attempt, reference_value, observed_value FROM reconciliation_checks
        WHERE check_name = 'chain_supply' AND subject = 'tempo' ORDER BY attempt
        """
    ).fetchall()
    assert stored == [(1, LARGE + 1, LARGE), (2, LARGE + 2, LARGE)]


# Secrets

SECRET_TEXTS = (
    KEY,
    f"https://rpc.example/v1/?api-key={KEY}",
    f"https%3A%2F%2Frpc.example%2Fv1%2F%3Fapi-key%3D{KEY}",
)


@pytest.mark.parametrize("text", SECRET_TEXTS, ids=["key", "query-string", "percent-encoded"])
@pytest.mark.parametrize(
    "step",
    [
        lambda text: ChainUnavailable(text),
        lambda text: caused_by(ChainUnavailable("sync_failed"), HttpError(text)),
        lambda text: Unchecked("tempo", text),
        lambda text: StoreConflict(text),
    ],
    ids=["reason", "cause", "unchecked", "conflict"],
)
def test_no_key_reaches_the_checks_table_or_the_report(store, step, text):
    probes = four_probes(store, tempo=[step(text)])

    _, reported = run_it(store, probes)

    assert KEY not in stored_check_text(store)
    assert all(KEY not in repr(item) for item in reported)
    reasons = store.db.execute(
        "SELECT reason FROM reconciliation_checks WHERE reason IS NOT NULL"
    ).fetchall()
    assert {reason for (reason,) in reasons} <= REASONS


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (HttpError(f"bridge: HTTP 500: {KEY}"), "bridge_unavailable"),
        (ValueError(KEY), "bridge_malformed"),
    ],
    ids=["unavailable", "malformed"],
)
def test_no_key_in_a_bridge_error_reaches_the_checks_table(store, error, reason):
    result, _ = run_it(store, four_probes(store), BridgeFeed(error, error, error))

    assert KEY not in stored_check_text(store)
    assert checks(store, "bridge", "all")[0] == (1, "unchecked", reason)
    assert result.bridge == "unchecked"


def test_the_detail_names_the_class_of_a_cause_and_nothing_else(store):
    error = caused_by(ChainUnavailable("sync_failed"), HttpError(f"HTTP 500: {KEY}"))

    run_it(store, four_probes(store, tempo=[error]))

    detail = store.db.execute(
        "SELECT detail FROM reconciliation_checks WHERE subject = 'tempo'"
    ).fetchone()[0]
    assert detail == '{"error": "HttpError"}'


class Crash(BaseException):
    """The process dying, for the writes outside a transaction this run holds open."""


class NoRollback:
    """A connection whose rollback does nothing, as a process that dies never gets to run one."""

    def __init__(self, db):
        self._db = db

    def __getattr__(self, name):
        return getattr(self._db, name)

    def rollback(self):
        pass


def crash_on_bridge_outcome(item):
    if isinstance(item, CheckOutcome) and item.check_name == "bridge":
        raise Crash


def crashes(store, method):
    def crash(*args, **kwargs):
        raise Crash

    setattr(store, method, crash)


def run_until_it_crashes(path, arrange, bridge=bridge_passes, report=lambda item: None):
    """Run into a crash, then reopen the file, which is what the next process would read."""
    store = Store(path)
    probes = four_probes(store)
    arrange(store)
    with pytest.raises(Crash):
        run_reconciliation(probes, store, report, bridge=bridge, sleep=no_sleep, clock=lambda: NOW)
    store.close()
    reopened = Store(path)
    passed = reopened.db.execute("SELECT passed FROM bridge_comparisons").fetchall()
    unfinished = sum(row[3] for row in runs(reopened))
    bridge_checks = checks(reopened, "bridge", "all")
    latest = reopened.latest_reconciliation()
    reopened.close()
    return passed, unfinished, bridge_checks, latest


def test_a_crash_before_the_check_row_leaves_no_passing_comparison(tmp_path):
    def arrange(store):
        real = store.record_check

        def crash_on_bridge(run_id, check_name, *args, **kwargs):
            if check_name == "bridge":
                raise Crash
            real(run_id, check_name, *args, **kwargs)

        store.record_check = crash_on_bridge

    passed, unfinished, bridge_checks, latest = run_until_it_crashes(
        tmp_path / "ousd.duckdb", arrange
    )

    assert (passed, unfinished, bridge_checks, latest) == ([], 1, [], None)


def test_a_crash_after_the_check_row_leaves_no_passing_comparison(tmp_path):
    passed, unfinished, bridge_checks, latest = run_until_it_crashes(
        tmp_path / "ousd.duckdb", lambda store: None, report=crash_on_bridge_outcome
    )

    assert (passed, unfinished, bridge_checks, latest) == ([], 1, [(1, "pass", None)], None)


@pytest.mark.parametrize("method", ["record_bridge_comparison", "finish_run"])
def test_a_passing_comparison_and_the_finished_run_are_written_together(tmp_path, method):
    def crash_after_the_real_write(store):
        store.db = NoRollback(store.db)
        real = getattr(store, method)

        def crash(*args, **kwargs):
            real(*args, **kwargs)
            raise Crash

        setattr(store, method, crash)

    passed, unfinished, bridge_checks, latest = run_until_it_crashes(
        tmp_path / "ousd.duckdb", crash_after_the_real_write
    )

    assert (passed, unfinished, bridge_checks, latest) == ([], 1, [(1, "pass", None)], None)


def test_a_finish_that_fails_takes_the_passing_comparison_with_it(store, monkeypatch):
    def refuse(run_id, status, code):
        raise KeyError(run_id)

    monkeypatch.setattr(store, "finish_run", refuse)

    with pytest.raises(KeyError):
        run_it(store, four_probes(store))

    assert comparisons(store) == []
    assert runs(store) == [("full", None, None, True)]
    # The rollback left the connection usable, so the failure can't hide behind a second one.
    assert store.db.execute("SELECT count(*) FROM bridge_comparisons").fetchone() == (0,)


def test_ctrl_c_during_the_finish_leaves_the_connection_clean_for_the_next_run(store):
    real = store.finish_run

    def interrupt(run_id, status, code):
        real(run_id, status, code)
        raise KeyboardInterrupt

    store.finish_run = interrupt

    with pytest.raises(KeyboardInterrupt):
        run_it(store, four_probes(store))

    # This same connection would read its own uncommitted pass, had it not rolled back.
    assert comparisons(store) == []
    assert runs(store) == [("full", None, None, True)]
    assert store.latest_reconciliation() is None

    store.finish_run = real
    result, _ = run_it(store, four_probes(store))

    assert result.exit_code == 0
    assert [row[5] for row in comparisons(store)] == [True]
    assert store.latest_reconciliation().usable


def test_a_pass_and_its_comparison_are_still_there_after_the_store_is_closed(tmp_path):
    path = tmp_path / "ousd.duckdb"
    store = Store(path)
    result, _ = run_it(store, four_probes(store))
    store.close()

    reopened = Store(path)
    latest = reopened.latest_reconciliation()

    assert result.exit_code == 0
    assert runs(reopened) == [("full", "pass", 0, False)]
    assert comparisons(reopened) == [
        ("tempo,ethereum,base,solana", "", FOUR_CHAINS, FOUR_CHAINS, 0, True)
    ]
    assert latest is not None
    assert latest.usable
    reopened.close()


def test_a_crash_while_waiting_after_a_fail_leaves_only_that_fail(tmp_path):
    path = tmp_path / "ousd.duckdb"
    store = Store(path)
    probes = four_probes(store)

    def die(seconds):
        raise Crash

    with pytest.raises(Crash):
        run_reconciliation(
            probes, store, lambda item: None, bridge=lambda: BAD, sleep=die, clock=lambda: NOW
        )
    store.close()
    reopened = Store(path)

    assert reopened.db.execute("SELECT passed FROM bridge_comparisons").fetchall() == [(False,)]
    assert checks(reopened, "bridge", "all") == [(1, "fail", "bridge_mismatch")]
    assert reopened.latest_reconciliation() is None
    reopened.close()


def test_a_failing_comparison_is_never_written_without_its_check_row(tmp_path):
    passed, unfinished, bridge_checks, latest = run_until_it_crashes(
        tmp_path / "ousd.duckdb",
        lambda store: crashes(store, "record_bridge_comparison"),
        lambda: BAD,
    )

    assert (passed, unfinished, bridge_checks, latest) == (
        [],
        1,
        [(1, "fail", "bridge_mismatch")],
        None,
    )


def test_reconcile_imports_no_chain_family_code():
    imported = set()
    for node in (
        node
        for path in Path(reconcile.__file__).parent.glob("*.py")
        for node in ast.walk(ast.parse(path.read_text()))
    ):
        if isinstance(node, ast.Import):
            imported |= {alias.name for alias in node.names}
        if isinstance(node, ast.ImportFrom):
            module = node.module or ""
            imported |= {f"{module}.{alias.name}" for alias in node.names} | {module}

    assert "ousd.chains" in imported
    assert not {"ousd.solana", "ousd.probes"} & imported


def test_no_address_reaches_a_check_row_in_any_failure(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX] = proof_of(tempo, TX, positions=[0])
    tempo.balance_steps = [off_by(BOB, 1), off_by(BOB, 1)]

    run_it(store, probes)

    text = stored_check_text(store)
    assert ALICE not in text
    assert BOB not in text
    assert TX not in text


@pytest.mark.parametrize("text", SECRET_TEXTS, ids=["key", "query-string", "percent-encoded"])
@pytest.mark.parametrize(
    "step",
    [
        lambda text: ChainUnavailable(text),
        lambda text: caused_by(ChainUnavailable("state_unavailable"), HttpError(text)),
        lambda text: Unchecked("tempo", text),
        lambda text: StoreConflict(text),
    ],
    ids=["reason", "cause", "unchecked", "conflict"],
)
def test_no_key_in_a_balance_read_reaches_the_checks_table_or_the_report(store, step, text):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [step(text)]

    _, reported = run_it(store, probes)

    assert KEY not in stored_check_text(store)
    assert all(KEY not in repr(item) for item in reported)


def balance_steps(*steps):
    return lambda probe: setattr(probe, "balance_steps", list(steps))


def a_group(probe):
    same_transaction(probe, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))


def an_unproven_group(probe):
    a_group(probe)
    probe.proofs[TX] = None


@pytest.mark.parametrize(
    "arrange",
    [
        balance_steps(off_by(BOB, 1)),
        balance_steps(off_by(BOB, 1), off_by(BOB, 1)),
        balance_steps(ChainUnavailable("state_unavailable")),
        balance_steps(lambda reads: reads[:-1]),
        a_group,
        an_unproven_group,
    ],
    ids=["heals", "stays", "refused", "incomplete", "real-group", "group-unavailable"],
)
def test_exit_zero_and_the_gate_never_disagree_on_balances_and_groups(store, arrange):
    probes, tempo = tempo_probes(store)
    arrange(tempo)

    result, _ = run_it(store, probes)

    assert (result.exit_code == 0) == store.latest_reconciliation().usable


def test_exit_zero_and_the_gate_agree_when_a_read_moves_the_cursor(store):
    probes, solana = slot_probes(store, ahead=1)
    only_the_first_read_moves_the_cursor(solana)

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert store.latest_reconciliation().usable
