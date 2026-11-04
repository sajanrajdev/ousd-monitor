import itertools
from dataclasses import dataclass
from typing import Any

import pytest
from conftest import ALICE, BOB, FakeRpc, make_chain
from ousd.chains import REQUIRED_CHAINS
from ousd.decode import ZERO_ADDRESS
from ousd.http import HttpError
from ousd.ingest import sync_chain
from ousd.reconcile import (
    BRIDGE_RETRY_DELAY,
    PIN_ROUNDS,
    REASONS,
    BridgeWait,
    ChainReconciliation,
    ChainUnavailable,
    CheckOutcome,
    Unchecked,
    check_at_block,
    compare_with_bridge,
    exit_code,
    overall_status,
    reconcile_chain,
    run_reconciliation,
)
from ousd.sources import RpcError
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
        return reconcile_chain(self.chain, self.rpc, self.store, at_block)

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
        raise NotImplementedError

    def read_balances(self, addresses, height):
        raise NotImplementedError

    def read_transaction_proof(self, tx_hash):
        raise NotImplementedError


def four_probes(store, **steps):
    return [FakeProbe(store, name, steps.get(name, ())) for name in REQUIRED_CHAINS]


def bridge_passes(readings):
    return "pass", None


def bridge_results(*results):
    remaining = list(results)
    return lambda readings: remaining.pop(0)


def no_sleep(seconds):
    pass


def run_it(store, probes, bridge=bridge_passes, sleep=no_sleep, **kwargs):
    reported: list[Any] = []
    result = run_reconciliation(
        probes, store, reported.append, bridge=bridge, sleep=sleep, **kwargs
    )
    return result, reported


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
    assert len(reported) == len(REQUIRED_CHAINS) + 1


def test_the_bridge_check_sees_every_chains_final_reading(store):
    seen = []

    def bridge(readings):
        seen.extend(readings)
        return "pass", None

    run_it(store, four_probes(store), bridge)

    assert [reading.chain for reading in seen] == list(REQUIRED_CHAINS)
    assert all(reading.block_number == 120 for reading in seen)


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
    def bridge(readings):
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


def test_reconcile_chain_can_skip_recording(store):
    chain, rpc = synced_chain(store)
    before = reconciliation_rows(store)

    result = reconcile_chain(chain, rpc, store, record=False)

    assert result.matched
    assert reconciliation_rows(store) == before


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
    assert [o.status for o in reported if o.subject == "tempo"] == ["fail", "pass"]
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
    assert [o.subject for o in reported][:4] == list(REQUIRED_CHAINS)


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


def test_a_bridge_check_that_raises_leaves_the_run_unfinished(store):
    def bridge(readings):
        raise HttpError("bridge: HTTP 500")

    with pytest.raises(HttpError):
        run_it(store, four_probes(store), bridge)

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
    results = [("fail", "bridge_mismatch"), ("pass", None)]

    result, _ = run_it(store, four_probes(store), lambda readings: results.pop(0))

    assert result.exit_code == 0
    assert store.latest_reconciliation().usable


def test_exit_zero_and_the_gate_agree_when_bridge_never_matches(store):
    results = [("fail", "bridge_mismatch")] * 3

    result, _ = run_it(store, four_probes(store), lambda readings: results.pop(0))

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

    results = [("fail", "bridge_mismatch"), ("pass", None)]

    def bridge(readings):
        # The next attempt syncs to a newer tip.
        tempo.rpc.extend(125)
        return results.pop(0)

    result, reported = run_it(store, probes, bridge, sleep=sleeps.append, clock=lambda: 1_000.0)

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
    assert waits == [BridgeWait(1, BRIDGE_RETRY_DELAY, 1_000.0 + BRIDGE_RETRY_DELAY)]


@pytest.mark.parametrize(
    ("results", "status", "code", "sleeps"),
    [
        ([("fail", "bridge_mismatch")] * 3, "fail", 1, 2),
        ([("unchecked", "bridge_stale")] * 3, "unchecked", 3, 2),
        (
            [
                ("unchecked", "bridge_stale"),
                ("fail", "bridge_mismatch"),
                ("unchecked", "bridge_stale"),
            ],
            "fail",
            1,
            2,
        ),
        ([("unchecked", "bridge_stale"), ("pass", None)], "pass", 0, 1),
    ],
    ids=["fail-thrice", "stale-thrice", "one-fail-among-stale", "stale-then-pass"],
)
def test_any_bridge_pass_counts_and_one_unmatched_attempt_is_enough_to_fail(
    store, results, status, code, sleeps
):
    slept: list[float] = []

    result, _ = run_it(store, four_probes(store), bridge_results(*results), sleep=slept.append)

    assert (result.bridge, result.status, result.exit_code) == (status, status, code)
    assert len(slept) == sleeps


def test_a_chain_that_stops_passing_on_a_bridge_retry_ends_the_run(store):
    probes = four_probes(store, tempo=[None, ChainUnavailable("sync_failed")])
    slept: list[float] = []

    result, _ = run_it(
        store, probes, bridge_results(("fail", "bridge_mismatch")), sleep=slept.append
    )

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


def test_a_free_text_bridge_reason_is_replaced_with_a_code(store):
    result, _ = run_it(store, four_probes(store), bridge_results(*[("unchecked", KEY)] * 3))

    assert KEY not in stored_check_text(store)
    assert checks(store, "bridge", "all")[0] == (1, "unchecked", "source_error")
    assert result.bridge == "unchecked"


def test_the_detail_names_the_class_of_a_cause_and_nothing_else(store):
    error = caused_by(ChainUnavailable("sync_failed"), HttpError(f"HTTP 500: {KEY}"))

    run_it(store, four_probes(store, tempo=[error]))

    detail = store.db.execute(
        "SELECT detail FROM reconciliation_checks WHERE subject = 'tempo'"
    ).fetchone()[0]
    assert detail == '{"error": "HttpError"}'
