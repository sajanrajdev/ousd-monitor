import itertools
import json
from dataclasses import dataclass, replace
from typing import Any

import pytest
from conftest import ALICE, BOB, FakeRpc, make_chain
from ousd.chains import REQUIRED_CHAINS
from ousd.decode import ZERO_ADDRESS
from ousd.http import HttpError
from ousd.ingest import sync_chain
from ousd.reconcile import (
    BRIDGE_MAX_AGE,
    BRIDGE_MAX_SUMS,
    BRIDGE_RETRY_DELAY,
    BRIDGE_SAME_SNAPSHOT_TRIES,
    BRIDGE_SAME_SNAPSHOT_WAIT,
    BRIDGE_WINDOW_AFTER,
    BRIDGE_WINDOW_BEFORE,
    PIN_ROUNDS,
    REASONS,
    BridgeFigures,
    BridgeWait,
    ChainReconciliation,
    ChainUnavailable,
    CheckOutcome,
    Unchecked,
    bridge_window,
    check_at_block,
    check_bridge,
    compare_with_bridge,
    exit_code,
    overall_status,
    reconcile_chain,
    run_reconciliation,
)
from ousd.sources import BridgeSnapshot, RpcError
from ousd.store import Status, StoreConflict

# Above 2**53 on purpose: a float anywhere in the path would break equality.
LARGE = 2**60 + 1


def synced_chain(store):
    chain = make_chain()
    rpc = FakeRpc(tip=120)
    rpc.add_transfer(101, LARGE)
    rpc.add_transfer(102, 7, sender=ALICE, to=BOB)
    rpc.add_transfer(103, 3, sender=BOB, to=ZERO_ADDRESS)
    sync_chain(chain, rpc, store)
    return chain, rpc


def test_matches_to_the_base_unit_and_ignores_ordinary_transfers(store):
    chain, rpc = synced_chain(store)

    result = reconcile_chain(chain, rpc, store)

    assert result.matched
    assert result.block_number == 120
    assert (result.minted, result.burned) == (LARGE, 3)
    assert result.onchain_supply == LARGE - 3


def test_a_single_base_unit_gap_is_reported_with_its_size(store):
    chain, rpc = synced_chain(store)
    rpc.total_supply = lambda token, block: LARGE - 3 + 1

    result = reconcile_chain(chain, rpc, store)

    assert not result.matched
    assert result.difference == -1


def test_result_is_recorded(store):
    chain, rpc = synced_chain(store)

    reconcile_chain(chain, rpc, store)

    recorded = store.db.execute(
        "SELECT chain, block_number, minted, burned, matched FROM reconciliations"
    ).fetchall()
    assert recorded == [("testnet", 120, LARGE, 3, True)]


def test_events_after_the_checked_block_are_not_counted(store):
    chain, rpc = synced_chain(store)

    result = reconcile_chain(chain, rpc, store, at_block=102)

    assert result.matched
    assert (result.minted, result.burned) == (LARGE, 0)
    assert result.onchain_supply == LARGE


def test_reads_supply_by_the_stored_hash_so_it_cannot_land_on_another_fork(store):
    chain, rpc = synced_chain(store)
    seen = []
    real = rpc.total_supply

    def spy(token, block):
        seen.append(block)
        return real(token, block)

    rpc.total_supply = spy
    reconcile_chain(chain, rpc, store)

    assert seen == [rpc.hashes[120]]


def test_matches_after_a_reorg_replaces_a_mint(store):
    chain, rpc = synced_chain(store)
    rpc.add_transfer(120, 50)
    sync_chain(chain, rpc, store)
    assert reconcile_chain(chain, rpc, store).minted == LARGE + 50

    rpc.reorg(from_block=120)
    rpc.add_transfer(120, 75)
    sync_chain(chain, rpc, store)

    result = reconcile_chain(chain, rpc, store)
    assert result.matched
    assert result.minted == LARGE + 75


def test_cannot_reconcile_before_sync_or_above_the_cursor(store):
    chain = make_chain()
    rpc = FakeRpc(tip=120)
    with pytest.raises(RuntimeError, match="run sync first"):
        reconcile_chain(chain, rpc, store)

    sync_chain(chain, rpc, store)
    with pytest.raises(ValueError, match="above synced block"):
        reconcile_chain(chain, rpc, store, at_block=121)


def test_bridge_comparison_counts_any_unchecked_chain_as_missing():
    comparison = compare_with_bridge([ChainReconciliation("tempo", 1, 100, 10, 90)], 200)

    assert comparison.is_partial
    assert comparison.chains_missing == ("ethereum", "base", "solana")


def test_bridge_comparison_is_full_only_with_every_chain():
    results = [
        ChainReconciliation(name, 1, 1, 0, 1) for name in ("tempo", "ethereum", "base", "solana")
    ]

    assert not compare_with_bridge(results, 4).is_partial


def test_bridge_comparison_is_partial_while_chains_are_missing():
    results = [
        ChainReconciliation("tempo", 1, 100, 10, 90),
        ChainReconciliation("ethereum", 2, 30, 0, 30),
    ]

    comparison = compare_with_bridge(results, bridge_total=200)

    assert comparison.is_partial
    assert comparison.chains_missing == ("base", "solana")
    assert comparison.chains_total == 120
    assert comparison.difference == -80


# The decision tables. See "What a full pass is" in the reconciliation plan.

ALL_PASS: dict[str, Status] = dict.fromkeys(REQUIRED_CHAINS, "pass")


@pytest.mark.parametrize(
    ("chains", "bridge", "status", "code"),
    [
        (ALL_PASS, "pass", "pass", 0),
        ({**ALL_PASS, "base": "unchecked"}, "pass", "unchecked", 3),
        ({**ALL_PASS, "base": "fail"}, "pass", "fail", 1),
        ({**ALL_PASS, "base": "fail", "tempo": "unchecked"}, "pass", "fail", 1),
        (ALL_PASS, "unchecked", "unchecked", 3),
        (ALL_PASS, "fail", "fail", 1),
        ({**ALL_PASS, "base": "unchecked"}, "fail", "fail", 1),
    ],
)
def test_the_run_decision_table(chains, bridge, status, code):
    assert overall_status(REQUIRED_CHAINS, chains, bridge) == status
    assert exit_code(status) == code


def test_all_pass_over_three_chains_is_never_a_pass():
    three = REQUIRED_CHAINS[:3]

    chains: dict[str, Status] = dict.fromkeys(three, "pass")

    status = overall_status(three, chains, "pass")

    assert status == "unchecked"
    assert exit_code(status) == 3
    # Nor can a fourth result rescue a scope that didn't include it.
    assert overall_status(three, ALL_PASS, "pass") == "unchecked"


def test_a_scope_of_four_with_a_result_missing_is_not_a_pass():
    without_base = {name: status for name, status in ALL_PASS.items() if name != "base"}

    assert overall_status(REQUIRED_CHAINS, without_base, "pass") == "unchecked"


def test_an_empty_list_of_chains_is_not_vacuously_a_pass():
    assert overall_status((), {}, "pass") == "unchecked"
    assert overall_status(REQUIRED_CHAINS, {}, "pass") == "unchecked"


def test_a_fail_outside_the_required_chains_still_fails():
    assert overall_status(REQUIRED_CHAINS, {**ALL_PASS, "testnet": "fail"}, "pass") == "fail"
    assert overall_status(("tempo",), {"tempo": "fail"}, "unchecked") == "fail"


def test_a_status_it_does_not_know_is_never_a_pass():
    unknown: Any = "passed"

    assert overall_status(REQUIRED_CHAINS, {**ALL_PASS, "base": unknown}, "pass") == "unchecked"
    assert overall_status(REQUIRED_CHAINS, ALL_PASS, unknown) == "unchecked"
    with pytest.raises(KeyError):
        exit_code(unknown)


def test_exit_zero_appears_only_when_every_part_passes():
    statuses: tuple[Status, ...] = ("pass", "fail", "unchecked")
    seen = set()

    for *parts, bridge in itertools.product(statuses, repeat=len(REQUIRED_CHAINS) + 1):
        chains = dict(zip(REQUIRED_CHAINS, parts, strict=True))
        status = overall_status(REQUIRED_CHAINS, chains, bridge)
        code = exit_code(status)
        seen.add(code)
        everything = [*parts, bridge]
        assert (code == 0) == all(part == "pass" for part in everything)
        assert (code == 1) == ("fail" in everything)

    assert seen == {0, 1, 3}


# A probe over a real store and real sync_chain and reconcile_chain, on a fake chain.


@dataclass(frozen=True)
class Drift:
    """totalSupply reads this far from the events until the next read."""

    offset: int


@dataclass(frozen=True)
class PinBehind:
    """The read lands this many blocks below the cursor."""

    blocks: int


@dataclass(frozen=True)
class NoPinHash:
    """The block hash at the cursor isn't stored."""


@dataclass(frozen=True)
class WrongChain:
    """The read names another chain, at the same height."""

    chain: str


class DriftingRpc(FakeRpc):
    offset = 0

    def total_supply(self, token, block):
        return super().total_supply(token, block) + self.offset


class FakeProbe:
    def __init__(self, store, name="tempo", steps=(), needs_census=False):
        self.name = name
        self.needs_census = needs_census
        self.store = store
        self.chain = make_chain(name=name)
        self.rpc = DriftingRpc(tip=120)
        self.rpc.add_transfer(101, LARGE)
        self.rpc.add_transfer(102, 7, sender=ALICE, to=BOB)
        self.steps = list(steps)
        self.events = []

    def supply_check(self):
        step = self.steps.pop(0) if self.steps else None
        if isinstance(step, Exception):
            raise step
        if isinstance(step, Unchecked):
            return step
        self.events.append("sync")
        self._sync()
        self.events.append("read")
        self.rpc.offset = step.offset if isinstance(step, Drift) else 0
        at_block = None
        if isinstance(step, PinBehind):
            at_block = self.store.synced_through(self.name) - step.blocks
        if isinstance(step, NoPinHash):
            self.store.db.execute(
                "DELETE FROM blocks WHERE chain = ? AND block_number = ?",
                [self.name, self.store.synced_through(self.name)],
            )
        reading = reconcile_chain(self.chain, self.rpc, self.store, at_block)
        return replace(reading, chain=step.chain) if isinstance(step, WrongChain) else reading

    def _sync(self):
        if self.name == "solana":
            # Solana reads only finalized blocks, so it stores no block hashes.
            tip = self.rpc.tip()
            rows = self.rpc.transfers(self.chain.token, self.chain.start_block, tip)
            self.store.write_range(self.name, rows, {}, tip)
        else:
            sync_chain(self.chain, self.rpc, self.store)

    def syncs(self):
        return self.events.count("sync")

    def pin_timestamp(self, height: int) -> int:
        return self.rpc.block_timestamp(height)

    def read_balances(self, addresses, height):
        raise NotImplementedError

    def read_transaction_proof(self, tx_hash):
        raise NotImplementedError


def four_probes(store, **steps):
    return [FakeProbe(store, name, steps.get(name, ())) for name in REQUIRED_CHAINS]


# FakeProbe's chains hold LARGE each from block 101, stamped 1_101, and pin at 1_120.
BRIDGE_T = 1_110
NOW = 1_200.0
FOUR_CHAINS = 4 * LARGE
GOOD = BridgeSnapshot(FOUR_CHAINS, BRIDGE_T)
# One base unit off, so no value in the window can match.
BAD = BridgeSnapshot(FOUR_CHAINS + 1, BRIDGE_T)
STALE = BridgeSnapshot(FOUR_CHAINS, int(NOW) - BRIDGE_MAX_AGE - 1)


def bridge_passes():
    return GOOD


def bad_at(offset):
    return BAD._replace(last_updated=BRIDGE_T + offset)


def good_at(offset):
    return GOOD._replace(last_updated=BRIDGE_T + offset)


class BridgeFeed:
    """Each fetch gives the next snapshot, or raises the next error."""

    def __init__(self, *items):
        self.remaining = list(items)

    def __call__(self):
        item = self.remaining.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def no_sleep(seconds):
    pass


def run_it(store, probes, bridge=bridge_passes, sleep=no_sleep, clock=lambda: NOW):
    reported: list[Any] = []
    result = run_reconciliation(
        probes, store, reported.append, bridge=bridge, sleep=sleep, clock=clock
    )
    return result, reported


def comparisons(store):
    return store.db.execute(
        """
        SELECT chains_included, chains_missing, chains_total, bridge_total, tolerance, passed
        FROM bridge_comparisons ORDER BY checked_at
        """
    ).fetchall()


def bridge_detail(store, attempt=1):
    row = store.db.execute(
        """
        SELECT detail FROM reconciliation_checks
        WHERE check_name = 'bridge' AND attempt = ?
        """,
        [attempt],
    ).fetchone()
    return json.loads(row[0])


def checks(store, check_name, subject):
    return store.db.execute(
        """
        SELECT attempt, status, reason FROM reconciliation_checks
        WHERE check_name = ? AND subject = ? ORDER BY attempt
        """,
        [check_name, subject],
    ).fetchall()


def runs(store):
    return store.db.execute(
        "SELECT scope, status, exit_code, finished_at IS NULL FROM reconciliation_runs"
    ).fetchall()


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
    assert len(outcomes) == len(REQUIRED_CHAINS) + 1


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


# check_at_block


def at_block_store(store):
    probe = FakeProbe(store)
    probe.supply_check()
    return probe


def assert_at_block_wrote_nothing(store):
    assert runs(store) == []
    assert checks(store, "chain_supply", "tempo") == []


def reconciliation_rows(store):
    return store.db.execute("SELECT count(*) FROM reconciliations").fetchone()[0]


def test_check_at_block_match_is_never_a_pass(store):
    probe = at_block_store(store)
    before = reconciliation_rows(store)

    outcome = check_at_block(probe.chain, probe.rpc, store, 102)

    assert isinstance(outcome, CheckOutcome)
    assert (outcome.status, outcome.reason) == ("unchecked", "diagnostic_only")
    assert exit_code(outcome.status) == 3
    assert outcome.reconciliation is not None
    assert outcome.reconciliation.matched
    assert outcome.reconciliation.block_number == 102
    assert reconciliation_rows(store) == before
    assert_at_block_wrote_nothing(store)


def test_check_at_block_mismatch_fails(store):
    probe = at_block_store(store)
    before = reconciliation_rows(store)
    probe.rpc.offset = 1

    outcome = check_at_block(probe.chain, probe.rpc, store, 102)

    assert (outcome.status, outcome.reason) == ("fail", "supply_mismatch")
    assert exit_code(outcome.status) == 1
    assert outcome.reconciliation is not None
    assert outcome.reconciliation.difference == -1
    assert reconciliation_rows(store) == before
    assert_at_block_wrote_nothing(store)


def test_check_at_block_with_nothing_synced_is_unchecked(store):
    chain = make_chain(name="tempo")

    outcome = check_at_block(chain, FakeRpc(tip=120), store, 102)

    assert (outcome.status, outcome.reason) == ("unchecked", "not_synced")
    assert_at_block_wrote_nothing(store)


def test_check_at_block_above_the_cursor_is_unchecked(store):
    probe = at_block_store(store)

    outcome = check_at_block(probe.chain, probe.rpc, store, 121)

    assert (outcome.status, outcome.reason) == ("unchecked", "above_cursor")
    assert_at_block_wrote_nothing(store)


@pytest.mark.parametrize(
    "error",
    [
        HttpError("tempo-rpc: HTTP 403: Archive requests require a personal token"),
        RpcError("eth_call: header not found"),
        ValueError("invalid literal for int() with base 16: '0x'"),
    ],
    ids=["403", "rpc-error", "empty-result"],
)
def test_check_at_block_turns_a_source_error_into_unchecked(store, error):
    probe = at_block_store(store)

    def refuse(token, block):
        raise error

    probe.rpc.total_supply = refuse

    outcome = check_at_block(probe.chain, probe.rpc, store, 102)

    assert (outcome.status, outcome.reason) == ("unchecked", "state_unavailable")
    assert outcome.reconciliation is None
    assert_at_block_wrote_nothing(store)


def test_check_at_block_turns_a_failed_hash_fetch_into_unchecked(store):
    probe = at_block_store(store)

    def refuse(number):
        raise HttpError("tempo-rpc: HTTP 403")

    probe.rpc.block = refuse

    outcome = check_at_block(probe.chain, probe.rpc, store, 102)

    assert (outcome.status, outcome.reason) == ("unchecked", "state_unavailable")
    assert_at_block_wrote_nothing(store)


@pytest.mark.parametrize(
    "error",
    [KeyError("a bug"), TypeError("a bug"), AttributeError("a bug")],
    ids=lambda e: type(e).__name__,
)
def test_check_at_block_lets_a_programming_error_in_a_read_raise(store, error):
    probe = at_block_store(store)

    def broken(token, block):
        raise error

    probe.rpc.total_supply = broken

    with pytest.raises(type(error)):
        check_at_block(probe.chain, probe.rpc, store, 102)


@pytest.mark.parametrize("method", ["block_hashes", "minted_and_burned"])
def test_check_at_block_lets_a_store_error_raise(store, monkeypatch, method):
    probe = at_block_store(store)

    def broken(*args):
        raise ValueError("a store error")

    monkeypatch.setattr(store, method, broken)

    with pytest.raises(ValueError, match="a store error"):
        check_at_block(probe.chain, probe.rpc, store, 102)


def test_check_at_block_leaves_a_newer_full_pass_standing(store):
    probes = four_probes(store)
    run_it(store, probes)
    assert store.latest_reconciliation().usable
    rows = reconciliation_rows(store)

    check_at_block(probes[0].chain, probes[0].rpc, store, 102)

    assert reconciliation_rows(store) == rows
    assert len(runs(store)) == 1
    assert store.latest_reconciliation().usable


# A hash that has been pruned


def test_a_pruned_block_is_read_by_a_fetched_hash(store):
    chain, rpc = synced_chain(store)
    assert 102 not in store.block_hashes(chain.name)
    seen = []
    real = rpc.total_supply

    def spy(token, block):
        seen.append(block)
        return real(token, block)

    rpc.total_supply = spy

    result = reconcile_chain(chain, rpc, store, at_block=102)

    assert seen == [rpc.hashes[102]]
    assert result.matched


def test_a_block_the_node_cannot_find_falls_back_to_its_number(store):
    chain, rpc = synced_chain(store)
    seen = []
    real = rpc.total_supply

    def spy(token, block):
        seen.append(block)
        return real(token, block)

    rpc.total_supply = spy
    rpc.block = lambda number: None

    result = reconcile_chain(chain, rpc, store, at_block=102)

    assert seen == [102]
    assert result.matched


# The mismatch retry


def test_a_mismatch_that_heals_passes_with_a_sync_between_the_rows(store):
    probes = four_probes(store, tempo=[Drift(1)])

    result, reported = run_it(store, probes)

    assert (result.status, result.exit_code) == ("pass", 0)
    assert checks(store, "chain_supply", "tempo") == [
        (1, "fail", "supply_mismatch"),
        (2, "pass", None),
    ]
    assert probes[0].events == ["sync", "read", "sync", "read"]
    outcomes = [item for item in reported if isinstance(item, CheckOutcome)]
    assert [o.status for o in outcomes if o.subject == "tempo"] == ["fail", "pass"]
    assert store.latest_reconciliation().usable


def test_a_mismatch_that_persists_fails_after_exactly_one_more_sync(store):
    probes = four_probes(store, tempo=[Drift(1), Drift(1), Drift(1)])

    result, _ = run_it(store, probes)

    assert (result.status, result.exit_code) == ("fail", 1)
    assert result.chains["tempo"] == "fail"
    assert checks(store, "chain_supply", "tempo") == [
        (1, "fail", "supply_mismatch"),
        (2, "fail", "supply_mismatch"),
    ]
    assert probes[0].syncs() == 2
    assert checks(store, "bridge", "all") == [(1, "unchecked", "chains_not_passed")]


def test_a_match_takes_no_extra_sync(store):
    probes = four_probes(store)

    run_it(store, probes)

    assert all(probe.syncs() == 1 for probe in probes)
    assert checks(store, "chain_supply", "tempo") == [(1, "pass", None)]


def test_a_mismatch_retried_into_a_refused_read_is_unchecked(store):
    probes = four_probes(store, tempo=[Drift(1), ChainUnavailable("state_unavailable")])

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.status, result.exit_code) == (
        "unchecked",
        "unchecked",
        3,
    )
    assert checks(store, "chain_supply", "tempo")[-1] == (2, "unchecked", "state_unavailable")


def test_a_mismatch_retried_into_an_unchecked_return_is_unchecked(store):
    probes = four_probes(store, tempo=[Drift(1), Unchecked("tempo", "not_synced")])

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("unchecked", 3)
    assert checks(store, "chain_supply", "tempo") == [
        (1, "fail", "supply_mismatch"),
        (2, "unchecked", "not_synced"),
    ]


@pytest.mark.parametrize(
    "unreadable",
    [ChainUnavailable("state_unavailable"), Unchecked("tempo", "not_synced")],
    ids=["refused", "unchecked-return"],
)
def test_a_mismatch_before_an_unreadable_retry_reaches_the_caller_on_every_run(store, unreadable):
    probes = four_probes(store)

    for _ in range(2):
        probes[0].steps = [Drift(1), unreadable]
        result, reported = run_it(store, probes)

        assert result.exit_code == 3
        mismatches = [o for o in result.outcomes if o.reason == "supply_mismatch"]
        assert [(o.subject, o.status, o.attempt) for o in mismatches] == [("tempo", "fail", 1)]
        first = mismatches[0].reconciliation
        assert first is not None
        assert (first.onchain_supply, first.event_supply) == (LARGE + 1, LARGE)
        assert mismatches[0] in reported


def test_a_mismatch_retried_into_a_store_conflict_fails(store):
    probes = four_probes(store, tempo=[Drift(1), StoreConflict("moved row")])

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("fail", 1)


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
    assert [o.subject for o in outcomes][:4] == list(REQUIRED_CHAINS)


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

    assert [(o.subject, o.status) for o in reported] == [("tempo", "pass")]
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


# The final pin


def test_a_pin_below_the_cursor_is_repeated_until_it_reaches_it(store):
    probes = four_probes(store, tempo=[PinBehind(1), PinBehind(1)])

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("pass", 0)
    assert probes[0].syncs() == 3
    assert checks(store, "chain_supply", "tempo") == [
        (1, "unchecked", "pin_behind_cursor"),
        (2, "unchecked", "pin_behind_cursor"),
        (3, "pass", None),
    ]
    assert store.latest_reconciliation().usable


def test_a_pin_that_never_reaches_the_cursor_is_never_a_pass(store):
    probes = four_probes(store, tempo=[PinBehind(1)] * 10)

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.status, result.exit_code) == (
        "unchecked",
        "unchecked",
        3,
    )
    assert probes[0].syncs() == 1 + PIN_ROUNDS == 4
    assert checks(store, "chain_supply", "tempo")[-1] == (4, "unchecked", "pin_behind_cursor")
    assert checks(store, "bridge", "all") == [(1, "unchecked", "chains_not_passed")]
    assert not store.latest_reconciliation().usable


def test_a_mismatch_on_a_later_pin_round_still_gets_its_one_retry(store):
    probes = four_probes(store, tempo=[PinBehind(1), Drift(1)])

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("pass", 0)
    assert [row[1] for row in checks(store, "chain_supply", "tempo")] == [
        "unchecked",
        "fail",
        "pass",
    ]


def test_a_second_mismatch_after_a_pin_round_fails(store):
    probes = four_probes(store, tempo=[Drift(1), PinBehind(1), Drift(1)])

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("fail", 1)
    assert probes[0].syncs() == 3


def test_an_evm_pin_with_no_stored_hash_is_unchecked_as_the_gate_would_refuse_it(store):
    probes = four_probes(store, base=[NoPinHash()])

    result, _ = run_it(store, probes)

    assert (result.chains["base"], result.status, result.exit_code) == ("unchecked", "unchecked", 3)
    assert checks(store, "chain_supply", "base") == [(1, "unchecked", "pin_hash_missing")]


@pytest.mark.parametrize(
    ("steps", "bridge"),
    [
        ({}, bridge_passes),
        ({"tempo": [Drift(1)]}, bridge_passes),
        ({"tempo": [Drift(1), Drift(1)]}, bridge_passes),
        ({"tempo": [PinBehind(1)]}, bridge_passes),
        ({"tempo": [PinBehind(1)] * 10}, bridge_passes),
        ({"base": [NoPinHash()]}, bridge_passes),
        ({"ethereum": [ChainUnavailable("sync_failed")]}, bridge_passes),
        ({"base": [StoreConflict("moved row")]}, bridge_passes),
        ({"solana": [Unchecked("solana", "not_synced")]}, bridge_passes),
        ({}, None),
    ],
    ids=[
        "clean",
        "mismatch-heals",
        "mismatch-stays",
        "pin-catches-up",
        "pin-never-catches-up",
        "no-pin-hash",
        "unreadable",
        "conflict",
        "unchecked-return",
        "no-bridge",
    ],
)
def test_exit_zero_and_the_gate_never_disagree(store, steps, bridge):
    result, _ = run_it(store, four_probes(store, **steps), bridge)

    assert (result.exit_code == 0) == store.latest_reconciliation().usable


def test_exit_zero_and_the_gate_agree_after_a_bridge_retry(store):
    result, _ = run_it(store, four_probes(store), BridgeFeed(bad_at(0), good_at(1)))

    assert result.exit_code == 0
    assert store.latest_reconciliation().usable


def test_exit_zero_and_the_gate_agree_when_bridge_never_matches(store):
    result, _ = run_it(store, four_probes(store), BridgeFeed(bad_at(0), bad_at(1), bad_at(2)))

    assert result.exit_code == 1
    assert not store.latest_reconciliation().usable


def test_a_pin_with_no_stored_hash_is_allowed_only_on_solana(store):
    # Solana stores no hash at its pin, and that alone must not stop it.
    result, _ = run_it(store, four_probes(store))

    row = store.db.execute(
        """
        SELECT pin_height, pin_hash, transfer_count FROM reconciliation_checks
        WHERE check_name = 'chain_supply' AND subject = 'solana'
        """
    ).fetchone()
    assert result.exit_code == 0
    assert row == (120, None, 2)
    assert store.latest_reconciliation().usable


# The census


def census_probes(store):
    probes = four_probes(store)
    probes[1].needs_census = True
    return probes


def test_a_required_census_never_completed_is_unchecked(store):
    result, _ = run_it(store, census_probes(store))

    assert result.chains == {
        "tempo": "pass",
        "ethereum": "unchecked",
        "base": "pass",
        "solana": "pass",
    }
    assert (result.status, result.exit_code) == ("unchecked", 3)
    assert checks(store, "balance_census", "ethereum") == [(1, "unchecked", "census_missing")]
    assert checks(store, "chain_supply", "ethereum") == [(1, "pass", None)]
    assert checks(store, "bridge", "all") == [(1, "unchecked", "chains_not_passed")]


def test_a_partial_census_does_not_count(store):
    earlier = store.start_run("partial")
    store.record_check(earlier, "balance_census", "ethereum", 1, "unchecked", "census_missing")
    store.finish_run(earlier, "unchecked", 3)

    result, _ = run_it(store, census_probes(store))

    assert result.chains["ethereum"] == "unchecked"
    assert result.exit_code == 3


def test_a_completed_census_counts_and_records_no_new_row(store):
    earlier = store.start_run("partial")
    store.record_check(earlier, "balance_census", "ethereum", 1, "pass")
    store.finish_run(earlier, "unchecked", 3)

    result, _ = run_it(store, census_probes(store))

    assert (result.chains["ethereum"], result.exit_code) == ("pass", 0)
    assert checks(store, "balance_census", "ethereum") == [(1, "pass", None)]
    assert store.latest_reconciliation().usable


def test_a_supply_fail_outranks_a_missing_census(store):
    probes = census_probes(store)
    probes[1].steps = [Drift(1), Drift(1)]

    result, _ = run_it(store, probes)

    assert (result.chains["ethereum"], result.exit_code) == ("fail", 1)
    assert checks(store, "balance_census", "ethereum") == [(1, "unchecked", "census_missing")]


def test_a_missing_census_is_still_recorded_when_the_chain_cannot_be_read(store):
    probes = census_probes(store)
    probes[1].steps = [ChainUnavailable("sync_failed")]

    result, _ = run_it(store, probes)

    assert result.chains["ethereum"] == "unchecked"
    assert checks(store, "chain_supply", "ethereum") == [(1, "unchecked", "sync_failed")]
    assert checks(store, "balance_census", "ethereum") == [(1, "unchecked", "census_missing")]


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
    assert sleeps == [BRIDGE_RETRY_DELAY]
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
    assert waits == [BridgeWait(1, BRIDGE_RETRY_DELAY, NOW + BRIDGE_RETRY_DELAY)]


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
    assert slept == [BRIDGE_RETRY_DELAY] * (len(rows) - 1)
    assert checks(store, "bridge", "all") == rows


def test_a_chain_that_stops_passing_on_a_bridge_retry_ends_the_run(store):
    probes = four_probes(store, tempo=[None, ChainUnavailable("sync_failed")])
    slept: list[float] = []

    result, _ = run_it(store, probes, BridgeFeed(bad_at(0), good_at(1)), sleep=slept.append)

    assert result.chains["tempo"] == "unchecked"
    assert (result.bridge, result.status, result.exit_code) == ("fail", "fail", 1)
    assert slept == [BRIDGE_RETRY_DELAY]
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

KEY = "sk_live_abcdef0123456789"
SECRET_TEXTS = (
    KEY,
    f"https://rpc.example/v1/?api-key={KEY}",
    f"https%3A%2F%2Frpc.example%2Fv1%2F%3Fapi-key%3D{KEY}",
)


def caused_by(error, cause):
    error.__cause__ = cause
    return error


def stored_check_text(store):
    return repr(
        store.db.execute("SELECT * EXCLUDE (recorded_at) FROM reconciliation_checks").fetchall()
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


# The Bridge check. See "The Bridge check" in the reconciliation plan.

T = 10_000
# No chain moves: each holds 10, 20, 30 and 40.
STILL = {
    name: [(T - BRIDGE_WINDOW_BEFORE, supply)]
    for name, supply in zip(REQUIRED_CHAINS, (10, 20, 30, 40), strict=True)
}
STILL_TOTAL = 100
PINS: dict[str, int | None] = dict.fromkeys(REQUIRED_CHAINS, T + BRIDGE_WINDOW_AFTER)


def judge(total, values=None, fetched_at=T + 5, pins=None, last_updated=T):
    return check_bridge(
        BridgeSnapshot(total, last_updated),
        fetched_at,
        PINS if pins is None else pins,
        STILL if values is None else values,
    )


def test_bridge_equal_with_no_movement_passes():
    check = judge(STILL_TOTAL)

    assert (check.status, check.reason) == ("pass", None)
    assert check.sum_at_t == check.matched_sum == STILL_TOTAL
    assert check.matched_times == dict.fromkeys(REQUIRED_CHAINS, T - BRIDGE_WINDOW_BEFORE)


@pytest.mark.parametrize("off", [1, -1], ids=["above", "below"])
def test_bridge_one_base_unit_off_with_no_movement_fails(off):
    check = judge(STILL_TOTAL + off)

    assert (check.status, check.reason) == ("fail", "bridge_mismatch")
    assert check.sum_at_t == STILL_TOTAL
    assert check.matched_sum is None
    assert check.matched_times == {}


MINT_AT_T_MINUS_10 = {**STILL, "tempo": [(T - BRIDGE_WINDOW_BEFORE, 10), (T - 10, 15)]}


@pytest.mark.parametrize("total", [100, 105], ids=["before", "after"])
def test_bridge_equal_to_either_side_of_a_mint_passes(total):
    assert judge(total, MINT_AT_T_MINUS_10).status == "pass"


def test_bridge_between_the_before_and_after_figures_fails():
    # A range test would pass this, and that is why the rule isn't one.
    assert judge(103, MINT_AT_T_MINUS_10).reason == "bridge_mismatch"


def test_the_sum_at_t_takes_each_chain_after_its_last_block_at_or_before_t():
    values = {
        **STILL,
        "tempo": [(T - BRIDGE_WINDOW_BEFORE, 10), (T, 11), (T + 1, 12)],
    }

    assert judge(0, values).sum_at_t == 101


def test_chains_read_at_different_moments_pass_and_record_each_time():
    values = {
        **STILL,
        "tempo": [(T - BRIDGE_WINDOW_BEFORE, 10), (T - 20, 15)],
        "base": [(T - BRIDGE_WINDOW_BEFORE, 30), (T + 20, 37)],
    }

    # Tempo after its mint, plus Base before its own.
    check = judge(15 + 20 + 30 + 40, values)

    assert check.status == "pass"
    assert check.sum_at_t == 105
    assert check.matched_times == {
        "tempo": T - 20,
        "ethereum": T - BRIDGE_WINDOW_BEFORE,
        "base": T - BRIDGE_WINDOW_BEFORE,
        "solana": T - BRIDGE_WINDOW_BEFORE,
    }


def test_a_value_held_twice_records_the_time_nearer_t():
    values = {**STILL, "tempo": [(T - BRIDGE_WINDOW_BEFORE, 10), (T - 40, 15), (T - 5, 10)]}

    assert judge(STILL_TOTAL, values).matched_times["tempo"] == T - 5


def test_bridge_arithmetic_stays_exact_above_2_to_the_60():
    values = {name: [(T - BRIDGE_WINDOW_BEFORE, LARGE)] for name in REQUIRED_CHAINS}

    assert judge(4 * LARGE, values).status == "pass"
    assert judge(4 * LARGE + 1, values).reason == "bridge_mismatch"
    assert judge(4 * LARGE - 1, values).sum_at_t == 4 * LARGE


def busy(count):
    return [(T - BRIDGE_WINDOW_BEFORE + index, index) for index in range(count)]


def test_too_many_combinations_are_refused_without_building_them():
    # 10**16 sums: building them would never finish, so this returning at all is the proof.
    values = {name: busy(10_000) for name in REQUIRED_CHAINS}

    check = judge(-1, values)

    assert (check.status, check.reason) == ("unchecked", "bridge_window_too_busy")


def test_the_limit_on_combinations_is_inclusive():
    allowed = {**STILL, "tempo": busy(1_000), "ethereum": busy(BRIDGE_MAX_SUMS // 1_000)}
    over = {**allowed, "ethereum": busy(BRIDGE_MAX_SUMS // 1_000 + 1)}
    # Out of reach, so the whole allowed space is searched.
    assert judge(10**9, allowed).reason == "bridge_mismatch"
    assert judge(10**9, over).reason == "bridge_window_too_busy"


def test_a_supply_returning_to_a_value_adds_no_combination():
    bouncing = [(T - BRIDGE_WINDOW_BEFORE + i, i % 2) for i in range(BRIDGE_WINDOW_BEFORE)]

    check = judge(-1, {name: bouncing for name in REQUIRED_CHAINS})

    assert check.reason == "bridge_mismatch"


@pytest.mark.parametrize(
    ("age", "status", "reason"),
    [
        (BRIDGE_MAX_AGE, "pass", None),
        (BRIDGE_MAX_AGE + 1, "unchecked", "bridge_stale"),
        (-59, "pass", None),
        (-60, "pass", None),
        (-61, "unchecked", "bridge_malformed"),
    ],
    ids=["30-minutes", "a-second-more", "59s-ahead", "60s-ahead", "61s-ahead"],
)
def test_a_snapshots_age_is_taken_at_fetch(age, status, reason):
    check = judge(STILL_TOTAL, fetched_at=T + age)

    assert (check.status, check.reason) == (status, reason)


def test_a_slow_run_does_not_make_its_own_snapshot_stale(store):
    # The fetch is at NOW. Syncing then takes well past the age limit.
    times = iter([NOW, NOW + BRIDGE_MAX_AGE * 2])

    result, _ = run_it(store, four_probes(store), clock=lambda: next(times))

    assert result.bridge == "pass"


@pytest.mark.parametrize(
    "pin",
    [T - 1, None],
    ids=["before-t", "unreadable"],
)
def test_a_pin_that_does_not_reach_t_is_a_coverage_gap(pin):
    check = judge(STILL_TOTAL, pins={**PINS, "base": pin})

    assert (check.status, check.reason) == ("unchecked", "coverage_gap")


def test_a_pin_exactly_at_t_is_covered():
    assert judge(STILL_TOTAL, pins={**PINS, "base": T}).status == "pass"


@pytest.mark.parametrize("missing", REQUIRED_CHAINS)
def test_a_chain_left_out_is_a_coverage_gap_and_never_a_pass(missing):
    pins = {name: pin for name, pin in PINS.items() if name != missing}
    values = {name: value for name, value in STILL.items() if name != missing}

    assert judge(STILL_TOTAL, pins=pins).reason == "coverage_gap"
    assert judge(STILL_TOTAL, values).reason == "coverage_gap"
    assert judge(STILL_TOTAL, {**STILL, missing: []}).reason == "coverage_gap"


def test_the_window_stops_at_the_pin():
    assert bridge_window(T, T + 1_000) == (T - BRIDGE_WINDOW_BEFORE, T + BRIDGE_WINDOW_AFTER)
    assert bridge_window(T, T + BRIDGE_WINDOW_AFTER - 1) == (
        T - BRIDGE_WINDOW_BEFORE,
        T + BRIDGE_WINDOW_AFTER - 1,
    )


def test_a_pin_before_the_window_end_limits_what_is_read(store, monkeypatch):
    seen = []
    real = store.supply_values

    def spy(chain, start_ts, end_ts, through_block):
        seen.append((chain, start_ts, end_ts, through_block))
        return real(chain, start_ts, end_ts, through_block)

    monkeypatch.setattr(store, "supply_values", spy)

    # T + 60 is 1_170, and the pins are at 1_120.
    run_it(store, four_probes(store))

    assert seen == [(name, BRIDGE_T - BRIDGE_WINDOW_BEFORE, 1_120, 120) for name in REQUIRED_CHAINS]


WINDOW_T = 1_500


@pytest.mark.parametrize(
    ("mint_at", "total", "status"),
    [
        (WINDOW_T - BRIDGE_WINDOW_BEFORE - 1, FOUR_CHAINS, "fail"),
        (WINDOW_T - BRIDGE_WINDOW_BEFORE - 1, FOUR_CHAINS + 5, "pass"),
        (WINDOW_T - BRIDGE_WINDOW_BEFORE, FOUR_CHAINS, "pass"),
        (WINDOW_T - BRIDGE_WINDOW_BEFORE, FOUR_CHAINS + 5, "pass"),
        (WINDOW_T + BRIDGE_WINDOW_AFTER, FOUR_CHAINS, "pass"),
        (WINDOW_T + BRIDGE_WINDOW_AFTER, FOUR_CHAINS + 5, "pass"),
        (WINDOW_T + BRIDGE_WINDOW_AFTER + 1, FOUR_CHAINS, "pass"),
        (WINDOW_T + BRIDGE_WINDOW_AFTER + 1, FOUR_CHAINS + 5, "fail"),
    ],
    ids=[
        "T-301-before",
        "T-301-after",
        "T-300-before",
        "T-300-after",
        "T+60-before",
        "T+60-after",
        "T+61-before",
        "T+61-after",
    ],
)
def test_window_edges_show_in_which_values_can_match(store, mint_at, total, status):
    # Tempo mints 5 at mint_at, and every chain's pin is past the window. Block n is stamped
    # 1_000 + n. Later attempts see their own T, and only the first is under test.
    probes = four_probes(store)
    for probe in probes:
        probe.rpc.extend(600)
    probes[0].rpc.add_transfer(mint_at - 1_000, 5)
    snapshots = [BridgeSnapshot(total, WINDOW_T + offset) for offset in range(3)]

    run_it(store, probes, BridgeFeed(*snapshots), clock=lambda: float(WINDOW_T))

    assert checks(store, "bridge", "all")[0][1] == status


def test_an_unreadable_pin_time_is_a_coverage_gap_and_writes_no_comparison(store):
    probes = four_probes(store)

    def refuse(height):
        raise ChainUnavailable("state_unavailable")

    probes[2].pin_timestamp = refuse

    result, _ = run_it(store, probes, BridgeFeed(good_at(0), good_at(1), good_at(2)))

    assert result.bridge == "unchecked"
    assert result.exit_code == 3
    assert checks(store, "bridge", "all")[0] == (1, "unchecked", "coverage_gap")
    assert comparisons(store) == []


def test_a_pin_time_error_a_probe_failed_to_map_leaves_the_run_unfinished(store):
    probes = four_probes(store)

    def refuse(height):
        raise RpcError("block not found")

    probes[2].pin_timestamp = refuse

    with pytest.raises(RpcError):
        run_it(store, probes)

    assert runs(store) == [("full", None, None, True)]
    assert store.latest_reconciliation() is None


def test_a_pin_before_t_in_a_run_is_a_coverage_gap(store):
    ahead = GOOD._replace(last_updated=1_121)

    result, _ = run_it(store, four_probes(store), BridgeFeed(ahead, ahead, ahead))

    assert result.exit_code == 3
    assert checks(store, "bridge", "all") == [(n, "unchecked", "coverage_gap") for n in (1, 2, 3)]


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (HttpError("bridge: HTTP 500"), "bridge_unavailable"),
        (ValueError("bad"), "bridge_malformed"),
    ],
    ids=["unavailable", "malformed"],
)
def test_a_bridge_that_cannot_be_read_is_unchecked_and_writes_no_comparison(store, error, reason):
    slept: list[float] = []

    result, _ = run_it(
        store, four_probes(store), BridgeFeed(error, error, error), sleep=slept.append
    )

    assert (result.bridge, result.status, result.exit_code) == ("unchecked", "unchecked", 3)
    assert checks(store, "bridge", "all") == [(n, "unchecked", reason) for n in (1, 2, 3)]
    assert slept == [BRIDGE_RETRY_DELAY] * 2
    assert comparisons(store) == []
    assert not store.latest_reconciliation().usable


def test_a_read_error_records_its_class_and_no_message(store):
    error = HttpError("bridge: HTTP 500")

    run_it(store, four_probes(store), BridgeFeed(error, error, error))

    assert bridge_detail(store) == {"error": "HttpError"}


def test_the_snapshot_is_fetched_before_any_chain_syncs_on_every_attempt(store):
    probes = four_probes(store)
    syncs_at_fetch = []

    def bridge():
        syncs_at_fetch.append(sum(probe.syncs() for probe in probes))
        return bad_at(len(syncs_at_fetch))

    run_it(store, probes, bridge)

    assert syncs_at_fetch == [0, 4, 8]


def test_a_repeated_snapshot_is_not_counted_and_is_refetched_after_a_minute(store):
    slept: list[float] = []
    feed = BridgeFeed(bad_at(0), bad_at(0), good_at(1))

    result, reported = run_it(store, four_probes(store), feed, sleep=slept.append)

    assert result.status == "pass"
    assert slept == [BRIDGE_RETRY_DELAY, BRIDGE_SAME_SNAPSHOT_WAIT]
    assert checks(store, "bridge", "all") == [(1, "fail", "bridge_mismatch"), (2, "pass", None)]
    waits = [item for item in reported if isinstance(item, BridgeWait)]
    assert [wait.attempt for wait in waits] == [1, 2]
    assert feed.remaining == []


def test_a_fetch_that_fails_while_refetching_is_unchecked_for_that_attempt(store):
    feed = BridgeFeed(bad_at(0), bad_at(0), HttpError("bridge: HTTP 500"), good_at(1))

    result, _ = run_it(store, four_probes(store), feed)

    assert result.status == "pass"
    assert checks(store, "bridge", "all") == [
        (1, "fail", "bridge_mismatch"),
        (2, "unchecked", "bridge_unavailable"),
        (3, "pass", None),
    ]


def test_a_snapshot_that_never_changes_ends_as_same_snapshot(store):
    slept: list[float] = []
    fetches = []

    def bridge():
        fetches.append(1)
        return bad_at(0)

    result, _ = run_it(store, four_probes(store), bridge, sleep=slept.append)

    assert (result.bridge, result.status, result.exit_code) == ("fail", "fail", 1)
    assert checks(store, "bridge", "all") == [
        (1, "fail", "bridge_mismatch"),
        (2, "unchecked", "bridge_same_snapshot"),
        (3, "unchecked", "bridge_same_snapshot"),
    ]
    refetching = [BRIDGE_SAME_SNAPSHOT_WAIT] * BRIDGE_SAME_SNAPSHOT_TRIES
    assert slept == [BRIDGE_RETRY_DELAY, *refetching, BRIDGE_RETRY_DELAY, *refetching]
    assert len(fetches) == 1 + 2 * (1 + BRIDGE_SAME_SNAPSHOT_TRIES)
    assert len(comparisons(store)) == 1


def test_only_a_compared_snapshot_counts_as_already_seen(store):
    # Nothing was compared on a coverage gap, and a later pin can cover the same T.
    ahead = GOOD._replace(last_updated=1_121)
    slept: list[float] = []
    probes = four_probes(store)

    def bridge():
        return ahead

    def extend(seconds):
        slept.append(seconds)
        for probe in probes:
            probe.rpc.extend(130)

    result, _ = run_it(store, probes, bridge, sleep=extend)

    assert result.status == "pass"
    assert slept == [BRIDGE_RETRY_DELAY]
    assert checks(store, "bridge", "all") == [(1, "unchecked", "coverage_gap"), (2, "pass", None)]


def test_a_retry_compares_against_its_new_pin(store):
    # This total exists only above the first pin, so a stale reading of the pin can't reach it.
    probes = four_probes(store)
    tempo = probes[0]
    second = BridgeSnapshot(FOUR_CHAINS + 5, 1_125)
    slept: list[float] = []

    def mint_while_waiting(seconds):
        slept.append(seconds)
        for probe in probes:
            probe.rpc.extend(130)
        tempo.rpc.add_transfer(123, 5)

    result, _ = run_it(store, probes, BridgeFeed(BAD, second), sleep=mint_while_waiting)

    assert (result.bridge, result.exit_code) == ("pass", 0)
    assert slept == [BRIDGE_RETRY_DELAY]
    assert checks(store, "chain_supply", "tempo") == [(1, "pass", None), (2, "pass", None)]
    latest = store.latest_reconciliation()
    assert latest.usable
    assert latest.chains["tempo"].pin_height == 130
    assert bridge_detail(store, attempt=2)["matched_times"]["tempo"] == 1_123


def test_a_mint_lost_between_two_pins_fails_the_run_and_never_exits_zero(store):
    probes = four_probes(store)
    tempo = probes[0]
    real = tempo.rpc.transfers

    def lose_it(seconds):
        tempo.rpc.extend(130)
        tempo.rpc.add_transfer(123, 5)
        tempo.rpc.transfers = lambda token, start, end: [
            transfer for transfer in real(token, start, end) if transfer.block_number != 123
        ]

    # The second snapshot would pass, were it not for the check on the new pin.
    feed = BridgeFeed(BAD, good_at(1))

    result, _ = run_it(store, probes, feed, sleep=lose_it)

    assert result.chains["tempo"] == "fail"
    assert (result.status, result.exit_code) == ("fail", 1)
    assert checks(store, "chain_supply", "tempo") == [
        (1, "pass", None),
        (2, "fail", "supply_mismatch"),
        (3, "fail", "supply_mismatch"),
    ]
    assert checks(store, "bridge", "all") == [
        (1, "fail", "bridge_mismatch"),
        (2, "unchecked", "chains_not_passed"),
    ]
    assert not store.latest_reconciliation().usable


def test_every_retry_repeats_the_supply_check_through_the_new_tip(store):
    probes = four_probes(store)

    def advance(seconds):
        for probe in probes:
            probe.rpc.extend(probe.rpc.tip() + 5)

    run_it(store, probes, BridgeFeed(BAD, bad_at(1), good_at(2)), sleep=advance)

    assert all(probe.syncs() == 3 for probe in probes)
    pins = store.db.execute(
        """
        SELECT pin_height FROM reconciliation_checks
        WHERE check_name = 'chain_supply' AND subject = 'base' ORDER BY attempt
        """
    ).fetchall()
    assert pins == [(120,), (125,), (130,)]


def test_a_failed_chain_stops_the_retries_and_still_reports_the_difference(store):
    slept: list[float] = []

    result, reported = run_it(
        store,
        four_probes(store, tempo=[Drift(1), Drift(1)]),
        BridgeFeed(BridgeSnapshot(FOUR_CHAINS + 9, BRIDGE_T)),
        sleep=slept.append,
    )

    assert (result.status, result.exit_code) == ("fail", 1)
    assert result.bridge == "unchecked"
    assert checks(store, "bridge", "all") == [(1, "unchecked", "chains_not_passed")]
    assert slept == []
    assert comparisons(store) == []
    figures = [item for item in reported if isinstance(item, BridgeFigures)]
    assert len(figures) == 1
    # Each chain's totalSupply: tempo reads one high.
    assert figures[0].comparison.difference == 1 - 9


def test_an_unread_chain_is_shown_as_missing_from_the_difference(store):
    _, reported = run_it(
        store,
        four_probes(store, base=[ChainUnavailable("sync_failed")]),
        BridgeFeed(GOOD),
    )

    figures = [item for item in reported if isinstance(item, BridgeFigures)]
    assert figures[0].comparison.chains_missing == ("base",)
    assert figures[0].comparison.is_partial


def test_a_bridge_outage_with_a_failed_chain_reports_no_figures(store):
    _, reported = run_it(
        store,
        four_probes(store, tempo=[Drift(1), Drift(1)]),
        BridgeFeed(HttpError("bridge: HTTP 500")),
    )

    assert not [item for item in reported if isinstance(item, BridgeFigures)]
    assert checks(store, "bridge", "all") == [(1, "unchecked", "chains_not_passed")]


def test_a_pass_records_the_matched_sum_with_no_amount_tolerance(store):
    result, reported = run_it(store, four_probes(store))

    assert comparisons(store) == [
        ("tempo,ethereum,base,solana", "", FOUR_CHAINS, FOUR_CHAINS, 0, True)
    ]
    run_id = store.db.execute("SELECT run_id FROM bridge_comparisons").fetchone()[0]
    assert run_id == result.run_id
    assert bridge_detail(store) == {
        "last_updated": BRIDGE_T,
        "window_before": BRIDGE_WINDOW_BEFORE,
        "window_after": BRIDGE_WINDOW_AFTER,
        "pin_times": dict.fromkeys(REQUIRED_CHAINS, 1_120),
        "matched_times": dict.fromkeys(REQUIRED_CHAINS, 1_101),
        "sum_at_t": str(FOUR_CHAINS),
    }
    figures = [item for item in reported if isinstance(item, BridgeFigures)]
    assert [(item.attempt, item.snapshot, item.fetched_at) for item in figures] == [(1, GOOD, NOW)]
    assert figures[0].comparison.difference == 0
    assert not figures[0].comparison.is_partial


def test_a_pass_on_a_value_other_than_t_records_the_matched_sum(store):
    # Tempo mints at 1_105, before T, and Bridge equals the figure from before that mint.
    probes = four_probes(store)
    probes[0].rpc.add_transfer(105, 5)

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert comparisons(store) == [
        ("tempo,ethereum,base,solana", "", FOUR_CHAINS, FOUR_CHAINS, 0, True)
    ]
    assert bridge_detail(store)["sum_at_t"] == str(FOUR_CHAINS + 5)
    assert bridge_detail(store)["matched_times"]["tempo"] == 1_101


def test_a_fail_records_the_sum_at_t(store):
    feed = BridgeFeed(bad_at(0), bad_at(1), bad_at(2))

    run_it(store, four_probes(store), feed)

    assert (
        comparisons(store)
        == [("tempo,ethereum,base,solana", "", FOUR_CHAINS, FOUR_CHAINS + 1, 0, False)] * 3
    )
    row = store.db.execute(
        """
        SELECT reference_value, observed_value, pin_height FROM reconciliation_checks
        WHERE check_name = 'bridge' AND attempt = 1
        """
    ).fetchone()
    assert row == (FOUR_CHAINS + 1, FOUR_CHAINS, None)


def test_the_sum_at_t_agrees_with_the_store(store):
    probes = four_probes(store)

    run_it(store, probes)

    expected = sum(store.supply_at_time(name, BRIDGE_T) for name in REQUIRED_CHAINS)
    assert bridge_detail(store)["sum_at_t"] == str(expected)


@pytest.mark.parametrize(
    "bridge",
    [
        BridgeFeed(*[STALE] * 3),
        BridgeFeed(*[HttpError("bridge: HTTP 500")] * 3),
        BridgeFeed(*[ValueError("bad")] * 3),
    ],
    ids=["stale", "outage", "malformed"],
)
def test_nothing_compared_writes_no_comparison_row(store, bridge):
    result, _ = run_it(store, four_probes(store), bridge)

    assert result.exit_code == 3
    assert comparisons(store) == []


def test_a_busy_window_in_a_run_is_unchecked_and_writes_no_comparison(store, monkeypatch):
    monkeypatch.setattr(
        store,
        "supply_values",
        lambda chain, start, end, through: [(start + i, i) for i in range(10_000)],
    )
    feed = BridgeFeed(good_at(0), good_at(1), good_at(2))

    result, _ = run_it(store, four_probes(store), feed)

    assert result.exit_code == 3
    assert checks(store, "bridge", "all")[0] == (1, "unchecked", "bridge_window_too_busy")
    assert comparisons(store) == []
