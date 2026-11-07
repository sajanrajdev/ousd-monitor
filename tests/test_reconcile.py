import ast
import itertools
import json
import time
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import ALICE, BOB, FakeRpc, make_chain
from ousd import reconcile
from ousd.chains import REQUIRED_CHAINS
from ousd.decode import ZERO_ADDRESS
from ousd.http import HttpError, PoliteClient
from ousd.ingest import sync_chain
from ousd.reconcile import (
    PIN_ROUNDS,
    REASONS,
    BalanceFinding,
    BalanceRead,
    BridgeFigures,
    BridgeWait,
    ChainReconciliation,
    ChainUnavailable,
    CheckOutcome,
    GroupFinding,
    Unchecked,
    bridge_window,
    check_at_block,
    check_bridge,
    choose_sample,
    compare_with_bridge,
    exit_code,
    overall_status,
    reconcile_chain,
    run_reconciliation,
)
from ousd.sources import BridgeSnapshot, ProofTransfer, RpcClient, RpcError, TransactionProof
from ousd.store import Status, Store, StoreConflict

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
        # Each balance read takes the next step: an error to raise, an Unchecked to return, or a
        # function over the true readings.
        self.balance_steps = []
        self.balance_reads = []
        # A proof to answer with in place of the chain's, by transaction. An error is raised.
        self.proofs = {}
        self.proof_reads = []

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
        self.events.append("balances")
        self.balance_reads.append((list(addresses), height))
        step = self.balance_steps.pop(0) if self.balance_steps else None
        if isinstance(step, Exception):
            raise step
        if isinstance(step, Unchecked):
            return step
        reads = self._true_balances(addresses, height)
        return step(reads) if step else reads

    def _true_balances(self, addresses, height):
        block = self.store.block_hashes(self.name).get(height, height)
        return [
            BalanceRead(address, height, self.rpc.balance_of(self.chain.token, address, block))
            for address in addresses
        ]

    def read_transaction_proof(self, tx_hash):
        self.proof_reads.append(tx_hash)
        if tx_hash in self.proofs:
            proof = self.proofs[tx_hash]
            if isinstance(proof, Exception):
                raise proof
            return proof
        return self.rpc.transaction_receipt(tx_hash, self.chain.token)


def four_probes(store, **steps):
    return [FakeProbe(store, name, steps.get(name, ())) for name in REQUIRED_CHAINS]


# FakeProbe's chains hold LARGE each from block 101, stamped 1_101, and pin at 1_120.
BRIDGE_T = 1_110
NOW = 1_200.0
FOUR_CHAINS = 4 * LARGE
GOOD = BridgeSnapshot(FOUR_CHAINS, BRIDGE_T)
# One base unit off, so no value in the window can match.
BAD = BridgeSnapshot(FOUR_CHAINS + 1, BRIDGE_T)
STALE = BridgeSnapshot(FOUR_CHAINS, int(NOW) - 1_801)


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


def run_it(store, probes, bridge=bridge_passes, sleep=no_sleep, clock=lambda: NOW, census=()):
    reported: list[Any] = []
    result = run_reconciliation(
        probes, store, reported.append, bridge=bridge, census=census, sleep=sleep, clock=clock
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


NEWEST_RUN = "(SELECT run_id FROM reconciliation_runs ORDER BY started_at DESC LIMIT 1)"


def newest_run_checks(store, check_name, subject):
    return store.db.execute(
        f"""
        SELECT attempt, status, reason FROM reconciliation_checks
        WHERE check_name = ? AND subject = ? AND run_id = {NEWEST_RUN} ORDER BY attempt
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
    assert probes[0].events == ["sync", "read", "sync", "read", "balances"]
    outcomes = [item for item in reported if isinstance(item, CheckOutcome)]
    supply = [o for o in outcomes if o.check_name == "chain_supply"]
    assert [o.status for o in supply if o.subject == "tempo"] == ["fail", "pass"]
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


# The Bridge check. See "The Bridge check" in the reconciliation plan. Its limits are written out
# as figures in these tests, not by their names, so changing a limit has to fail one.

T = 10_000
# No chain moves: each holds 10, 20, 30 and 40.
STILL = {
    name: [(T - 300, supply)]
    for name, supply in zip(REQUIRED_CHAINS, (10, 20, 30, 40), strict=True)
}
STILL_TOTAL = 100
PINS: dict[str, int | None] = dict.fromkeys(REQUIRED_CHAINS, T + 60)


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
    assert check.matched_times == dict.fromkeys(REQUIRED_CHAINS, T - 300)


@pytest.mark.parametrize("off", [1, -1], ids=["above", "below"])
def test_bridge_one_base_unit_off_with_no_movement_fails(off):
    check = judge(STILL_TOTAL + off)

    assert (check.status, check.reason) == ("fail", "bridge_mismatch")
    assert check.sum_at_t == STILL_TOTAL
    assert check.matched_sum is None
    assert check.matched_times == {}


MINT_AT_T_MINUS_10 = {**STILL, "tempo": [(T - 300, 10), (T - 10, 15)]}


@pytest.mark.parametrize("total", [100, 105], ids=["before", "after"])
def test_bridge_equal_to_either_side_of_a_mint_passes(total):
    assert judge(total, MINT_AT_T_MINUS_10).status == "pass"


def test_bridge_between_the_before_and_after_figures_fails():
    # A range test would pass this, and that is why the rule isn't one.
    assert judge(103, MINT_AT_T_MINUS_10).reason == "bridge_mismatch"


def test_the_sum_at_t_takes_each_chain_after_its_last_block_at_or_before_t():
    values = {
        **STILL,
        "tempo": [(T - 300, 10), (T, 11), (T + 1, 12)],
    }

    assert judge(0, values).sum_at_t == 101


def test_chains_read_at_different_moments_pass_and_record_each_time():
    values = {
        **STILL,
        "tempo": [(T - 300, 10), (T - 20, 15)],
        "base": [(T - 300, 30), (T + 20, 37)],
    }

    # Tempo after its mint, plus Base before its own.
    check = judge(15 + 20 + 30 + 40, values)

    assert check.status == "pass"
    assert check.sum_at_t == 105
    assert check.matched_times == {
        "tempo": T - 20,
        "ethereum": T - 300,
        "base": T - 300,
        "solana": T - 300,
    }


def test_a_value_held_twice_records_the_time_nearer_t():
    values = {**STILL, "tempo": [(T - 300, 10), (T - 40, 15), (T - 5, 10)]}

    assert judge(STILL_TOTAL, values).matched_times["tempo"] == T - 5


def test_bridge_arithmetic_stays_exact_above_2_to_the_60():
    values = {name: [(T - 300, LARGE)] for name in REQUIRED_CHAINS}

    assert judge(4 * LARGE, values).status == "pass"
    assert judge(4 * LARGE + 1, values).reason == "bridge_mismatch"
    assert judge(4 * LARGE - 1, values).sum_at_t == 4 * LARGE


def busy(count):
    return [(T - 300 + index, index) for index in range(count)]


def test_too_many_combinations_are_refused_without_building_them():
    # 10**16 sums: building them would never finish, so this returning at all is the proof.
    values = {name: busy(10_000) for name in REQUIRED_CHAINS}

    check = judge(-1, values)

    assert (check.status, check.reason) == ("unchecked", "bridge_window_too_busy")


def test_the_limit_on_combinations_is_inclusive():
    allowed = {**STILL, "tempo": busy(1_000), "ethereum": busy(1_000)}
    # 101 * 9_901 is 1_000_001, so a limit any higher lets this through.
    over = {**STILL, "tempo": busy(101), "ethereum": busy(9_901)}
    # Out of reach, so the whole allowed space is searched.
    assert judge(10**9, allowed).reason == "bridge_mismatch"
    assert judge(10**9, over).reason == "bridge_window_too_busy"


def test_a_supply_returning_to_a_value_adds_no_combination():
    bouncing = [(T - 300 + i, i % 2) for i in range(300)]

    check = judge(-1, {name: bouncing for name in REQUIRED_CHAINS})

    assert check.reason == "bridge_mismatch"


@pytest.mark.parametrize(
    ("age", "status", "reason"),
    [
        (1_800, "pass", None),
        (1_801, "unchecked", "bridge_stale"),
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
    times = itertools.chain([NOW], itertools.repeat(NOW + 3_600))

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
    assert bridge_window(T, T + 1_000) == (T - 300, T + 60)
    assert bridge_window(T, T + 59) == (
        T - 300,
        T + 59,
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

    assert seen == [(name, BRIDGE_T - 300, 1_120, 120) for name in REQUIRED_CHAINS]


WINDOW_T = 1_500


@pytest.mark.parametrize(
    ("mint_at", "total", "status"),
    [
        (WINDOW_T - 301, FOUR_CHAINS, "fail"),
        (WINDOW_T - 301, FOUR_CHAINS + 5, "pass"),
        (WINDOW_T - 300, FOUR_CHAINS, "pass"),
        (WINDOW_T - 300, FOUR_CHAINS + 5, "pass"),
        (WINDOW_T + 60, FOUR_CHAINS, "pass"),
        (WINDOW_T + 60, FOUR_CHAINS + 5, "pass"),
        (WINDOW_T + 61, FOUR_CHAINS, "pass"),
        (WINDOW_T + 61, FOUR_CHAINS + 5, "fail"),
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
    assert slept == [600] * 2
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
    assert slept == [600, 60]
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
    refetching = [60] * 5
    assert slept == [600, *refetching, 600, *refetching]
    # The most a run can wait on Bridge.
    assert sum(slept) == 1_800
    assert len(fetches) == 13
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
    assert slept == [600]
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
    assert slept == [600]
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
        "window_before": 300,
        "window_after": 60,
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


# The sample. See "Sampled balances" in the reconciliation plan.

DAY = "2026-11-04"
CAROL = "0x" + "d" * 40
DAN = "0x" + "e" * 40


def wallet(number):
    return f"0x{number:040x}"


WALLETS = [wallet(number) for number in range(1, 101)]


def drawn(sample):
    return {address for address, stratum in sample.items() if stratum == "random"}


def test_a_sample_is_the_same_for_the_same_date_and_rows_in_any_order():
    first = choose_sample("tempo", DAY, WALLETS, WALLETS[:2])
    again = choose_sample("tempo", DAY, list(reversed(WALLETS)), WALLETS[:2])

    assert first == again
    assert len(drawn(first)) == 30


def test_a_sample_changes_with_the_date_and_with_the_chain():
    first = drawn(choose_sample("tempo", DAY, WALLETS, []))

    assert drawn(choose_sample("tempo", "2026-11-05", WALLETS, [])) != first
    assert drawn(choose_sample("base", DAY, WALLETS, [])) != first


def test_a_new_candidate_changes_at_most_one_drawn_wallet():
    first = drawn(choose_sample("tempo", DAY, WALLETS, []))

    for number in range(101, 200):
        after = drawn(choose_sample("tempo", DAY, [*WALLETS, wallet(number)], []))
        assert len(after - first) <= 1
        assert len(first - after) <= 1


def test_a_sample_has_a_fixed_answer_so_a_new_algorithm_cannot_pass_unnoticed():
    # The ranks are sha256("v1|tempo|2026-11-04|<address>"), worked out outside this code.
    assert drawn(choose_sample("tempo", DAY, WALLETS[:32], [])) == set(WALLETS[:32]) - {
        wallet(9),
        wallet(13),
    }


@pytest.fixture
def tokyo_clock(monkeypatch):
    """A machine clock far from UTC, so a date taken in local time differs."""
    monkeypatch.setenv("TZ", "Asia/Tokyo")
    time.tzset()
    yield
    monkeypatch.undo()
    time.tzset()


MIDNIGHT = datetime(2026, 11, 4, tzinfo=UTC).timestamp()


@pytest.mark.parametrize(
    ("now", "date"),
    [(MIDNIGHT - 1, "2026-11-03"), (MIDNIGHT, "2026-11-04")],
    ids=["last-second", "first-second"],
)
def test_the_seed_takes_its_date_from_utc_either_side_of_midnight(store, tokyo_clock, now, date):
    run_it(store, four_probes(store), None, clock=lambda: now)

    assert {row[3] for row in samples(store)} == {f"v1|tempo|{date}"}


def test_a_sample_counts_are_twenty_top_and_thirty_drawn():
    top = WALLETS[:20]

    sample = choose_sample("tempo", DAY, WALLETS, top)

    assert [address for address, stratum in sample.items() if stratum == "top"] == top
    assert len(drawn(sample)) == 30
    assert len(sample) == 50


def test_fewer_candidates_than_asked_gives_all_of_them():
    sample = choose_sample("tempo", DAY, WALLETS[:3], WALLETS[:1])

    assert sample.keys() == set(WALLETS[:3])
    assert sample[WALLETS[0]] == "top"


def test_a_wallet_in_two_strata_appears_once_in_the_first_listed():
    every = choose_sample("tempo", DAY, WALLETS[:5], [])
    assert set(drawn(every)) == set(WALLETS[:5])

    sample = choose_sample("tempo", DAY, WALLETS[:5], WALLETS[:5])

    assert set(sample.values()) == {"top"}
    assert len(sample) == 5


@pytest.mark.parametrize("census", [False, True], ids=["sample", "census"])
def test_the_zero_address_is_never_chosen(census):
    sample = choose_sample("tempo", DAY, [ZERO_ADDRESS, *WALLETS], [ZERO_ADDRESS], census)

    assert ZERO_ADDRESS not in sample


def test_a_census_gives_every_candidate_and_keeps_the_strata():
    sample = choose_sample("tempo", DAY, WALLETS, WALLETS[:20], census=True)

    assert sample.keys() == set(WALLETS)
    assert list(sample.values()).count("top") == 20
    assert list(sample.values()).count("random") == 30
    assert list(sample.values()).count("census") == 50


# Sampled balances, over the same fake chain as the checks above.


def tempo_probes(store):
    probes = four_probes(store)
    return probes, probes[0]


def samples(store, chain="tempo"):
    return store.db.execute(
        """
        SELECT attempt, address, stratum, seed, height, model_balance, observed_balance
        FROM balance_samples WHERE chain = ? ORDER BY attempt, address
        """,
        [chain],
    ).fetchall()


def check_detail(store, check_name, subject, attempt=1):
    row = store.db.execute(
        f"""
        SELECT detail FROM reconciliation_checks
        WHERE check_name = ? AND subject = ? AND attempt = ? AND run_id = {NEWEST_RUN}
        """,
        [check_name, subject, attempt],
    ).fetchone()
    return json.loads(row[0])


def off_by(address, amount):
    def lie(reads):
        return [
            read._replace(amount=read.amount + amount) if read.address == address else read
            for read in reads
        ]

    return lie


def test_equal_balances_pass_and_each_wallet_is_recorded(store):
    probes, _ = tempo_probes(store)

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("pass", 0)
    assert checks(store, "sampled_balances", "tempo") == [(1, "pass", None)]
    seed = "v1|tempo|1970-01-01"
    assert samples(store) == [
        (1, ALICE, "top", seed, 120, LARGE - 7, LARGE - 7),
        (1, BOB, "top", seed, 120, 7, 7),
    ]
    assert check_detail(store, "sampled_balances", "tempo")["wallets"] == 2


def test_a_sampled_row_records_the_pin_like_the_gate(store):
    probes, tempo = tempo_probes(store)

    run_it(store, probes)

    row = store.db.execute(
        """
        SELECT pin_height, pin_hash, transfer_count FROM reconciliation_checks
        WHERE check_name = 'sampled_balances' AND subject = 'tempo'
        """
    ).fetchone()
    assert row == (120, tempo.rpc.hashes[120], 2)


def test_a_balance_one_base_unit_off_fails_above_two_to_the_sixty(store):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [off_by(ALICE, 1), off_by(ALICE, 1)]

    result, reported = run_it(store, probes)

    assert (result.chains["tempo"], result.status, result.exit_code) == ("fail", "fail", 1)
    assert result.chains["base"] == "pass"
    assert checks(store, "sampled_balances", "tempo") == [
        (1, "fail", "balance_mismatch"),
        (2, "fail", "balance_mismatch"),
    ]
    # Exact, so it can't be lost to a float on the way into the table.
    wrong = samples(store)[-1]
    assert wrong[1] == ALICE
    assert (wrong[5], wrong[6]) == (LARGE - 7, LARGE - 7 + 1)
    assert [item for item in reported if isinstance(item, BalanceFinding)] == [
        BalanceFinding("tempo", 1, ALICE, 120, LARGE - 7, LARGE - 7 + 1),
        BalanceFinding("tempo", 2, ALICE, 120, LARGE - 7, LARGE - 7 + 1),
    ]
    assert ALICE not in stored_check_text(store)
    assert not store.latest_reconciliation().usable


@pytest.mark.parametrize(
    "lie",
    [
        lambda reads: reads[:-1],
        lambda reads: [*reads, BalanceRead(CAROL, reads[0].height, 0)],
        lambda reads: [],
        lambda reads: [reads[0], reads[0]],
    ],
    ids=["missing", "extra", "empty", "repeated"],
)
def test_readings_that_are_not_exactly_the_wallets_asked_for_are_unchecked(store, lie):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [lie]

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("unchecked", 3)
    assert checks(store, "sampled_balances", "tempo") == [(1, "unchecked", "sample_incomplete")]
    assert not store.latest_reconciliation().usable


def test_a_chain_with_no_wallets_is_an_empty_sample_and_never_a_pass(store):
    probes, tempo = tempo_probes(store)
    tempo.rpc.logs.clear()

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("unchecked", 3)
    assert checks(store, "sampled_balances", "tempo") == [(1, "unchecked", "sample_incomplete")]


@pytest.mark.parametrize(
    ("step", "status", "reason"),
    [
        (ChainUnavailable("state_unavailable"), "unchecked", "state_unavailable"),
        (Unchecked("tempo", "not_synced"), "unchecked", "not_synced"),
        (StoreConflict("moved row"), "fail", "store_conflict"),
    ],
    ids=["refused", "unchecked-return", "conflict"],
)
def test_a_balance_read_that_cannot_be_made_is_recorded_with_its_code(store, step, status, reason):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [step]

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == status
    assert checks(store, "sampled_balances", "tempo") == [(1, status, reason)]
    assert result.chains["base"] == "pass"


def test_a_read_above_the_cursor_is_unchecked_as_its_rows_are_not_stored(store):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [lambda reads: [read._replace(height=121) for read in reads]]

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == "unchecked"
    assert checks(store, "sampled_balances", "tempo") == [(1, "unchecked", "above_cursor")]


def test_an_error_a_probe_failed_to_map_in_a_balance_read_leaves_the_run_unfinished(store):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [KeyError("a bug")]

    with pytest.raises(KeyError):
        run_it(store, probes)

    assert runs(store) == [("full", None, None, True)]


def lose(probe, block):
    """The node stops returning this block's logs, which still move its balances and supply."""
    real = probe.rpc.transfers
    probe.rpc.transfers = lambda token, start, end: [
        transfer for transfer in real(token, start, end) if transfer.block_number != block
    ]


def test_a_lost_ordinary_transfer_passes_supply_and_fails_balances(store):
    probes, tempo = tempo_probes(store)
    tempo.rpc.add_transfer(110, 5, sender=ALICE, to=BOB)
    lose(tempo, 110)

    result, _ = run_it(store, probes)

    assert checks(store, "chain_supply", "tempo")[0] == (1, "pass", None)
    assert checks(store, "sampled_balances", "tempo")[-1] == (2, "fail", "balance_mismatch")
    assert (result.chains["tempo"], result.exit_code) == ("fail", 1)


def test_a_mismatch_that_heals_passes_reading_only_that_wallet_after_a_sync(store):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [off_by(BOB, 1)]

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("pass", 0)
    assert [wallets for wallets, _ in tempo.balance_reads] == [[ALICE, BOB], [BOB]]
    assert tempo.events == ["sync", "read", "balances", "sync", "read", "balances"]
    assert checks(store, "sampled_balances", "tempo") == [
        (1, "fail", "balance_mismatch"),
        (2, "pass", None),
    ]
    assert checks(store, "chain_supply", "tempo") == [(1, "pass", None), (2, "pass", None)]
    assert [(row[0], row[1], row[2]) for row in samples(store)] == [
        (1, ALICE, "top"),
        (1, BOB, "top"),
        (2, BOB, "top"),
    ]
    assert store.latest_reconciliation().usable


def test_a_mismatch_that_persists_takes_exactly_one_more_sync(store):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [off_by(BOB, 1), off_by(BOB, 1)]

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == "fail"
    assert tempo.syncs() == 2
    assert len(tempo.balance_reads) == 2


def test_a_mismatch_whose_resync_cannot_be_read_is_unchecked(store):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [off_by(BOB, 1)]
    tempo.steps = [None, ChainUnavailable("sync_failed")]

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == "unchecked"
    assert result.exit_code == 3
    assert checks(store, "chain_supply", "tempo")[-1] == (2, "unchecked", "sync_failed")
    assert len(tempo.balance_reads) == 1
    assert not store.latest_reconciliation().usable


def test_a_mismatch_whose_recheck_cannot_be_read_is_unchecked(store):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [off_by(BOB, 1), ChainUnavailable("state_unavailable")]

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("unchecked", 3)
    assert checks(store, "sampled_balances", "tempo") == [
        (1, "fail", "balance_mismatch"),
        (2, "unchecked", "state_unavailable"),
    ]


def test_a_mismatch_whose_resync_finds_a_supply_mismatch_fails_through_its_own_retry(store):
    probes, tempo = tempo_probes(store)
    tempo.balance_steps = [off_by(BOB, 1)]
    tempo.steps = [None, Drift(1), Drift(1)]

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == "fail"
    assert checks(store, "chain_supply", "tempo") == [
        (1, "pass", None),
        (2, "fail", "supply_mismatch"),
        (3, "fail", "supply_mismatch"),
    ]


def test_a_failed_supply_reads_no_balances(store):
    probes, tempo = tempo_probes(store)
    tempo.steps = [Drift(1), Drift(1)]

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == "fail"
    assert tempo.balance_reads == []
    assert checks(store, "sampled_balances", "tempo") == []


def test_a_chain_that_cannot_be_read_gets_no_balance_or_group_rows(store):
    probes, tempo = tempo_probes(store)
    tempo.steps = [ChainUnavailable("not_synced")]

    run_it(store, probes)

    assert checks(store, "sampled_balances", "tempo") == []
    assert checks(store, "same_looking", "tempo") == []


# Later pins: a Bridge retry, or a read that moved the cursor.


def test_a_later_pin_reads_each_wallet_touched_since_at_that_pin(store):
    probes, tempo = tempo_probes(store)

    def advance(seconds):
        tempo.rpc.extend(130)
        tempo.rpc.add_transfer(125, 2, sender=BOB, to=CAROL)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=advance)

    assert (result.exit_code, result.bridge) == (0, "pass")
    pin = tempo.balance_reads[-1]
    assert pin == ([BOB, CAROL], tempo.store.synced_through("tempo"))
    assert [(row[0], row[1], row[2], row[4]) for row in samples(store) if row[0] == 2] == [
        (2, BOB, "delta", 130),
        (2, CAROL, "delta", 130),
    ]
    assert checks(store, "sampled_balances", "tempo") == [(1, "pass", None), (2, "pass", None)]
    assert store.latest_reconciliation().usable


def test_a_later_pin_with_no_wallet_touched_reads_nothing_and_says_so(store):
    probes, tempo = tempo_probes(store)

    def advance(seconds):
        tempo.rpc.extend(130)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=advance)

    assert result.exit_code == 0
    assert len(tempo.balance_reads) == 1
    assert checks(store, "sampled_balances", "tempo") == [(1, "pass", None), (2, "pass", None)]
    assert check_detail(store, "sampled_balances", "tempo", 2)["wallets"] == 0


def test_a_retry_at_the_same_pin_reads_nothing_more(store):
    probes, tempo = tempo_probes(store)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)))

    assert result.exit_code == 0
    assert len(tempo.balance_reads) == 1
    assert checks(store, "sampled_balances", "tempo") == [(1, "pass", None)]
    # The audit still runs against every final pin.
    assert checks(store, "same_looking", "tempo") == [(1, "pass", None), (2, "pass", None)]


def test_a_transfer_lost_between_two_pins_fails_the_run_and_never_exits_zero(store):
    probes, tempo = tempo_probes(store)

    def lose_one(seconds):
        tempo.rpc.extend(130)
        # Bob sent Dan 5, and that row is never returned. Bob's later row is what brings him back.
        tempo.rpc.add_transfer(123, 5, sender=BOB, to=DAN)
        lose(tempo, 123)
        tempo.rpc.add_transfer(125, 1, sender=BOB, to=CAROL)

    # Supply can't see it, and the second snapshot would pass, were it not for the check on the
    # new pin.
    result, reported = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=lose_one)

    assert checks(store, "chain_supply", "tempo")[1] == (2, "pass", None)
    assert checks(store, "sampled_balances", "tempo") == [
        (1, "pass", None),
        (2, "fail", "balance_mismatch"),
        (3, "fail", "balance_mismatch"),
    ]
    assert result.chains["tempo"] == "fail"
    assert (result.status, result.exit_code) == ("fail", 1)
    assert checks(store, "bridge", "all") == [
        (1, "fail", "bridge_mismatch"),
        (2, "unchecked", "chains_not_passed"),
    ]
    assert not store.latest_reconciliation().usable
    finding = next(item for item in reported if isinstance(item, BalanceFinding))
    assert (finding.address, finding.height) == (BOB, 130)
    assert (finding.model_balance, finding.observed_balance) == (6, 1)


def test_a_transfer_lost_between_wallets_with_no_later_row_exits_zero(store):
    # The limit the plan accepts, pinned so it can't change unnoticed in either direction. Bob's
    # reading stands from before the loss, and no later row brings him back.
    probes, tempo = tempo_probes(store)

    def lose_one(seconds):
        tempo.rpc.extend(130)
        tempo.rpc.add_transfer(123, 5, sender=BOB, to=DAN)
        lose(tempo, 123)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=lose_one)

    assert (result.chains["tempo"], result.exit_code) == ("pass", 0)
    assert store.latest_reconciliation().usable
    assert len(tempo.balance_reads) == 1
    assert store.balances_at("tempo", [BOB], 130)[BOB] == 7
    assert tempo.rpc.balance_of(tempo.chain.token, BOB, 130) == 2


def test_a_group_that_appears_between_two_pins_is_audited_at_the_new_pin(store):
    probes, tempo = tempo_probes(store)

    def add_group(seconds):
        tempo.rpc.extend(130)
        same_transaction(tempo, 125, TX, (BOB, CAROL, 1), (BOB, CAROL, 1))
        tempo.proofs[TX] = proof_of(tempo, TX, positions=[0])

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=add_group)

    assert result.chains["tempo"] == "fail"
    assert (result.status, result.exit_code) == ("fail", 1)
    assert checks(store, "same_looking", "tempo") == [
        (1, "pass", None),
        (2, "fail", "group_not_real"),
    ]
    assert audit(store, TX)[:2] == ("not_real", "receipt")


# A fork that replaces rows already compared. A delta only reads above what it has covered.


def fork_losing_a_transfer(probe, new_tip=None):
    """Replace the last blocks with a fork holding a Bob to Dan transfer sync never gets."""
    probe.rpc.reorg(from_block=118, new_tip=new_tip)
    probe.rpc.add_transfer(118, 5, sender=BOB, to=DAN)
    lose(probe, 118)


def test_a_fork_at_the_covered_height_between_attempts_reads_the_sample_again(store):
    probes, tempo = tempo_probes(store)

    def fork(seconds):
        fork_losing_a_transfer(tempo)

    # The second snapshot would pass, and the pin is the same height with a new hash.
    result, reported = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=fork)

    assert checks(store, "chain_supply", "tempo")[1] == (2, "pass", None)
    assert [wallets for wallets, _ in tempo.balance_reads[:2]] == [[ALICE, BOB], [ALICE, BOB]]
    assert (result.chains["tempo"], result.exit_code) == ("fail", 1)
    finding = next(item for item in reported if isinstance(item, BalanceFinding))
    assert (finding.address, finding.model_balance, finding.observed_balance) == (BOB, 7, 2)
    assert not store.latest_reconciliation().usable


def test_a_fork_to_a_shorter_chain_between_attempts_reads_the_sample_again(store):
    probes, tempo = tempo_probes(store)

    def fork(seconds):
        fork_losing_a_transfer(tempo, new_tip=119)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=fork)

    assert [height for _, height in tempo.balance_reads[:2]] == [120, 119]
    assert (result.chains["tempo"], result.exit_code) == ("fail", 1)
    assert not store.latest_reconciliation().usable


def test_a_fork_in_the_resync_a_mismatch_sets_off_reads_the_sample_again(store):
    probes, tempo = tempo_probes(store)

    def mismatch_then_fork(reads):
        fork_losing_a_transfer(tempo)
        return off_by(ALICE, 1)(reads)

    tempo.balance_steps = [mismatch_then_fork]

    result, _ = run_it(store, probes)

    # Alice heals on her recheck, and Bob's first reading was on the old fork.
    assert [wallets for wallets, _ in tempo.balance_reads[:3]] == [
        [ALICE, BOB],
        [ALICE],
        [ALICE, BOB],
    ]
    assert (result.chains["tempo"], result.exit_code) == ("fail", 1)
    assert not store.latest_reconciliation().usable


def test_a_fork_to_a_shorter_chain_in_a_mismatch_resync_reads_the_sample_again(store):
    probes, tempo = tempo_probes(store)

    def mismatch_then_fork(reads):
        fork_losing_a_transfer(tempo, new_tip=119)
        return off_by(ALICE, 1)(reads)

    tempo.balance_steps = [mismatch_then_fork]

    result, _ = run_it(store, probes)

    assert tempo.balance_reads[:3] == [([ALICE, BOB], 120), ([ALICE], 119), ([ALICE, BOB], 119)]
    assert (result.chains["tempo"], result.exit_code) == ("fail", 1)
    assert not store.latest_reconciliation().usable


def test_a_fork_in_the_resync_of_a_later_pin_reads_the_sample_again(store):
    probes, tempo = tempo_probes(store)

    def advance(seconds):
        tempo.rpc.extend(130)
        tempo.rpc.add_transfer(125, 6, sender=BOB, to=CAROL)

    def mismatch_then_fork(reads):
        # Carol's reading is on the old fork, and only Bob is read again.
        tempo.rpc.reorg(from_block=128)
        tempo.rpc.add_transfer(128, 5, sender=CAROL, to=DAN)
        lose(tempo, 128)
        return off_by(BOB, 1)(reads)

    tempo.balance_steps = [None, mismatch_then_fork]

    result, reported = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=advance)

    assert [wallets for wallets, _ in tempo.balance_reads[1:3]] == [[BOB, CAROL], [BOB]]
    assert (result.chains["tempo"], result.exit_code) == ("fail", 1)
    assert CAROL in [item.address for item in reported if isinstance(item, BalanceFinding)]
    assert not store.latest_reconciliation().usable


def test_a_census_is_read_again_after_a_fork_and_only_then(store):
    probes = census_probes(store)
    ethereum = probes[1]

    def fork(seconds):
        ethereum.rpc.reorg(from_block=118)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=fork, census=["ethereum"])

    assert result.exit_code == 0
    assert len(ethereum.balance_reads) == 2
    assert checks(store, "balance_census", "ethereum") == [(1, "pass", None), (2, "pass", None)]
    assert store.census_complete("ethereum")
    assert store.latest_reconciliation().usable


def test_a_clean_fork_passes_after_reading_the_sample_again(store):
    probes, tempo = tempo_probes(store)

    def fork(seconds):
        tempo.rpc.reorg(from_block=118)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=fork)

    assert result.exit_code == 0
    assert len(tempo.balance_reads) == 2
    assert store.latest_reconciliation().usable


def test_a_fork_above_the_covered_height_is_left_to_the_delta(store):
    probes, tempo = tempo_probes(store)

    def fork(seconds):
        tempo.rpc.extend(125)
        tempo.rpc.add_transfer(123, 1, sender=BOB, to=CAROL)
        tempo._sync()
        tempo.rpc.reorg(from_block=122)
        tempo.rpc.add_transfer(122, 1, sender=BOB, to=CAROL)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=fork)

    assert result.exit_code == 0
    assert tempo.balance_reads[-1] == ([BOB, CAROL], 125)
    assert len(tempo.balance_reads) == 2


def test_a_hash_pruned_as_final_is_not_taken_for_a_fork(store):
    probes, tempo = tempo_probes(store)

    def advance(seconds):
        tempo.rpc.extend(200)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), sleep=advance)

    assert 120 not in store.block_hashes("tempo")
    assert result.exit_code == 0
    assert len(tempo.balance_reads) == 1


# A chain like Solana: no past-state read, and a read that syncs through the slot it reports.


class SlotProbe(FakeProbe):
    """Each balance read lands `ahead` slots past the tip and syncs through it, or `behind` slots
    below the tip. With `spread`, the first read lands each wallet on a slot of its own."""

    def __init__(self, store, ahead=0, behind=0, spread=False, name="solana"):
        super().__init__(store, name)
        self.ahead, self.behind, self.spread = ahead, behind, spread
        # Runs before each supply check, to add movement the check will land past.
        self.before_supply = lambda: None

    def supply_check(self):
        self.before_supply()
        return super().supply_check()

    def _true_balances(self, addresses, height):
        tip = self.rpc.tip() + self.ahead
        self.rpc.extend(tip)
        self._sync()
        slot = tip - self.behind
        slots = [slot - index if self.spread else slot for index in range(len(addresses))]
        self.spread = False
        return [
            BalanceRead(address, at, self.rpc.balance_of(self.chain.token, address, at))
            for address, at in zip(addresses, slots, strict=True)
        ]


def slot_probes(store, **options):
    probes = four_probes(store)
    probes[3] = SlotProbe(store, **options)
    return probes, probes[3]


def only_the_first_read_moves_the_cursor(probe):
    real = probe._true_balances

    def once(addresses, height):
        reads = real(addresses, height)
        probe.ahead = 0
        return reads

    probe._true_balances = once


def test_a_read_that_moves_the_cursor_gets_another_supply_check(store):
    probes, solana = slot_probes(store, ahead=1)
    only_the_first_read_moves_the_cursor(solana)

    result, _ = run_it(store, probes)

    assert solana.events == ["sync", "read", "balances", "sync", "read"]
    assert (result.chains["solana"], result.exit_code) == ("pass", 0)
    assert checks(store, "chain_supply", "solana") == [(1, "pass", None), (2, "pass", None)]
    final = store.latest_reconciliation().chains["solana"]
    assert final.pin_height == store.synced_through("solana") == 121
    assert store.latest_reconciliation().usable


def test_a_read_that_does_not_move_the_cursor_gets_no_second_supply_check(store):
    probes, solana = slot_probes(store)

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert solana.events == ["sync", "read", "balances"]
    assert checks(store, "chain_supply", "solana") == [(1, "pass", None)]


def test_a_mismatch_on_the_second_supply_check_goes_through_the_normal_retry(store):
    probes, solana = slot_probes(store, ahead=1)
    solana.steps = [None, Drift(1)]
    only_the_first_read_moves_the_cursor(solana)

    result, _ = run_it(store, probes)

    assert (result.chains["solana"], result.exit_code) == ("pass", 0)
    assert checks(store, "chain_supply", "solana") == [
        (1, "pass", None),
        (2, "fail", "supply_mismatch"),
        (3, "pass", None),
    ]
    assert store.latest_reconciliation().usable


def test_a_wallet_first_seen_between_the_pin_and_the_read_is_still_read(store):
    probes, solana = slot_probes(store, ahead=1)
    only_the_first_read_moves_the_cursor(solana)
    real = solana._true_balances

    def carol_arrives(addresses, height):
        solana.rpc.extend(121)
        solana.rpc.add_transfer(121, 1, sender=ALICE, to=CAROL)
        solana._true_balances = real
        solana.ahead = 0
        return real(addresses, height)

    solana._true_balances = carol_arrives

    result, _ = run_it(store, probes)

    assert solana.balance_reads[0][0] == [ALICE, BOB]
    assert solana.balance_reads[1] == ([ALICE, CAROL], 121)
    assert (result.chains["solana"], result.exit_code) == ("pass", 0)
    assert store.latest_reconciliation().usable


def busy_for(probe, windows):
    """After the first supply check, this many more each find a new row, and the rest find none."""
    checks_seen = [0]

    def touch():
        checks_seen[0] += 1
        if 1 < checks_seen[0] <= windows + 1:
            tip = probe.rpc.tip() + 1
            probe.rpc.extend(tip)
            probe.rpc.add_transfer(tip, 1, sender=ALICE, to=BOB)

    probe.before_supply = touch


def test_three_busy_windows_use_every_round_and_a_fourth_is_never_tried(store):
    probes, solana = slot_probes(store, ahead=1)
    busy_for(solana, 3)

    result, _ = run_it(store, probes)

    assert (result.chains["solana"], result.exit_code) == ("unchecked", 3)
    # The sample and three rounds. The fourth window would be quiet, and isn't looked at.
    assert len(solana.balance_reads) == 4
    assert solana.events.count("read") == 4
    assert checks(store, "sampled_balances", "solana") == [
        (1, "pass", None),
        (2, "pass", None),
        (3, "pass", None),
        (4, "pass", None),
        (5, "unchecked", "pin_behind_cursor"),
    ]
    assert not store.latest_reconciliation().usable


def test_two_busy_windows_then_a_quiet_one_pass_on_the_last_round(store):
    probes, solana = slot_probes(store, ahead=1)
    busy_for(solana, 2)

    result, _ = run_it(store, probes)

    assert (result.chains["solana"], result.exit_code) == ("pass", 0)
    assert solana.events.count("read") == 4
    assert len(solana.balance_reads) == 3
    assert check_detail(store, "sampled_balances", "solana", 4)["wallets"] == 0
    assert store.latest_reconciliation().usable


def test_a_lagging_recheck_on_solana_lowers_what_the_read_covers(store):
    probes, solana = slot_probes(store)
    solana.rpc.add_transfer(120, 3, sender=ALICE, to=BOB)

    def mismatch_then_lag(reads):
        solana.behind = 1
        return off_by(BOB, 1)(reads)

    def catch_up(reads):
        solana.behind = 0
        return reads

    solana.balance_steps = [mismatch_then_lag, catch_up]

    result, _ = run_it(store, probes)

    # Bob's recheck stops at 119, so the row at 120 is still to be covered, at the pin.
    assert solana.balance_reads == [
        ([ALICE, BOB], 120),
        ([BOB], 120),
        ([ALICE, BOB], 120),
    ]
    assert [(row[0], row[1], row[2], row[4]) for row in samples(store, "solana")][2:] == [
        (2, BOB, "top", 119),
        (3, ALICE, "delta", 120),
        (3, BOB, "delta", 120),
    ]
    assert (result.chains["solana"], result.exit_code) == ("pass", 0)


def test_a_cursor_that_keeps_moving_is_never_a_pass(store):
    probes, solana = slot_probes(store, ahead=1)

    def touch():
        tip = solana.rpc.tip()
        solana.rpc.extend(tip + 1)
        solana.rpc.add_transfer(tip + 1, 1, sender=ALICE, to=BOB)

    solana.before_supply = touch

    result, _ = run_it(store, probes)

    assert result.chains["solana"] == "unchecked"
    assert result.exit_code == 3
    assert checks(store, "sampled_balances", "solana")[-1][1:] == (
        "unchecked",
        "pin_behind_cursor",
    )
    assert not store.latest_reconciliation().usable


def test_readings_at_their_own_slots_are_each_compared_at_that_slot(store):
    probes, solana = slot_probes(store, spread=True)
    # Bob's reading lands one slot below the tip, and a transfer lands on the tip.
    solana.rpc.add_transfer(120, 3, sender=ALICE, to=BOB)

    result, _ = run_it(store, probes)

    assert (result.chains["solana"], result.exit_code) == ("pass", 0)
    heights = {row[1]: row[4] for row in samples(store, "solana") if row[0] == 1}
    assert heights == {ALICE: 120, BOB: 119}
    bob = next(row for row in samples(store, "solana") if row[0] == 1 and row[1] == BOB)
    assert (bob[5], bob[6]) == (7, 7)


def test_a_read_below_the_cursor_is_compared_at_its_slot_then_covered_at_the_pin(store):
    probes, solana = slot_probes(store, behind=1)
    solana.rpc.add_transfer(120, 3, sender=ALICE, to=BOB)
    real = solana._true_balances

    def catch_up(addresses, height):
        reads = real(addresses, height)
        solana.behind = 0
        return reads

    solana._true_balances = catch_up

    result, _ = run_it(store, probes)

    # At the cursor this would differ by 3. At the read's slot, it matches.
    assert (result.chains["solana"], result.exit_code) == ("pass", 0)
    first = [row for row in samples(store, "solana") if row[0] == 1]
    assert {(row[1], row[4]) for row in first} == {(ALICE, 119), (BOB, 119)}
    assert solana.balance_reads[1][0] == [ALICE, BOB]
    delta = [row for row in samples(store, "solana") if row[0] == 2]
    assert {(row[1], row[2], row[4]) for row in delta} == {
        (ALICE, "delta", 120),
        (BOB, "delta", 120),
    }


def test_a_read_that_stays_below_the_pin_is_never_a_pass(store):
    probes, solana = slot_probes(store, behind=1)
    solana.rpc.add_transfer(120, 3, sender=ALICE, to=BOB)

    result, _ = run_it(store, probes)

    assert (result.chains["solana"], result.exit_code) == ("unchecked", 3)
    assert checks(store, "sampled_balances", "solana")[-1][1:] == (
        "unchecked",
        "pin_behind_cursor",
    )


def test_every_wallet_is_read_on_solana_with_no_census_asked_for(store):
    probes, solana = slot_probes(store)
    for number in range(1, 80):
        solana.rpc.add_transfer(103, 1, sender=ALICE, to=wallet(number))

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    read, _ = solana.balance_reads[0]
    assert set(read) == {ALICE, BOB, *(wallet(number) for number in range(1, 80))}
    strata = {row[2] for row in samples(store, "solana")}
    assert strata == {"top", "random", "census"}
    assert checks(store, "balance_census", "solana") == [(1, "pass", None)]


def test_an_evm_chain_reads_only_its_sample_with_no_census_asked_for(store):
    probes, tempo = tempo_probes(store)
    for number in range(1, 80):
        tempo.rpc.add_transfer(103, 1, sender=ALICE, to=wallet(number))

    run_it(store, probes)

    assert len(tempo.balance_reads[0][0]) == 50
    assert checks(store, "balance_census", "tempo") == []


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


# The census


def test_a_census_reads_every_wallet_and_lets_the_chain_pass(store):
    probes = census_probes(store)
    ethereum = probes[1]
    for number in range(1, 80):
        ethereum.rpc.add_transfer(103, 1, sender=ALICE, to=wallet(number))

    result, _ = run_it(store, probes, census=["ethereum"])

    assert (result.chains["ethereum"], result.exit_code) == ("pass", 0)
    read, _ = ethereum.balance_reads[0]
    assert set(read) == {ALICE, BOB, *(wallet(number) for number in range(1, 80))}
    assert checks(store, "balance_census", "ethereum") == [(1, "pass", None)]
    strata = [row[2] for row in samples(store, "ethereum")]
    assert (strata.count("top"), strata.count("random"), strata.count("census")) == (20, 30, 31)
    assert store.census_complete("ethereum")
    assert store.latest_reconciliation().usable


def test_a_later_run_needs_no_second_census_and_reads_only_its_sample(store):
    probes = census_probes(store)
    ethereum = probes[1]
    for number in range(1, 80):
        ethereum.rpc.add_transfer(103, 1, sender=ALICE, to=wallet(number))
    run_it(store, probes, census=["ethereum"])
    ethereum.balance_reads.clear()

    result, _ = run_it(store, probes)

    assert (result.chains["ethereum"], result.exit_code) == ("pass", 0)
    assert len(ethereum.balance_reads[0][0]) == 50
    assert checks(store, "balance_census", "ethereum") == [(1, "pass", None)]


def test_a_census_that_cannot_finish_does_not_count_and_leaves_the_chain_unchecked(store):
    probes = census_probes(store)
    probes[1].balance_steps = [ChainUnavailable("state_unavailable")]

    result, _ = run_it(store, probes, census=["ethereum"])

    assert (result.chains["ethereum"], result.exit_code) == ("unchecked", 3)
    assert not store.census_complete("ethereum")
    assert checks(store, "balance_census", "ethereum") == [
        (1, "unchecked", "state_unavailable"),
        (2, "unchecked", "census_missing"),
    ]


def test_a_census_that_finds_a_difference_fails_and_does_not_count(store):
    probes = census_probes(store)
    probes[1].balance_steps = [off_by(BOB, 1), off_by(BOB, 1)]

    result, _ = run_it(store, probes, census=["ethereum"])

    assert (result.chains["ethereum"], result.exit_code) == ("fail", 1)
    assert not store.census_complete("ethereum")
    assert checks(store, "balance_census", "ethereum")[0] == (1, "fail", "balance_mismatch")


def test_a_census_that_heals_on_its_retry_counts_once(store):
    probes = census_probes(store)
    probes[1].balance_steps = [off_by(BOB, 1)]

    result, _ = run_it(store, probes, census=["ethereum"])

    assert (result.chains["ethereum"], result.exit_code) == ("pass", 0)
    assert checks(store, "balance_census", "ethereum") == [(1, "pass", None)]


def test_the_newest_census_is_the_one_that_counts(store):
    probes = census_probes(store)
    run_it(store, probes, census=["ethereum"])
    assert store.census_complete("ethereum")

    # A later census of every wallet finds a difference, so the old pass no longer stands.
    probes[1].balance_steps = [off_by(BOB, 1), off_by(BOB, 1)]
    run_it(store, probes, census=["ethereum"])
    assert not store.census_complete("ethereum")

    result, _ = run_it(store, probes)

    assert (result.chains["ethereum"], result.exit_code) == ("unchecked", 3)
    assert newest_run_checks(store, "balance_census", "ethereum") == [
        (1, "unchecked", "census_missing")
    ]


def test_a_census_is_read_once_across_bridge_retries(store):
    probes = census_probes(store)

    result, _ = run_it(store, probes, BridgeFeed(BAD, good_at(1)), census=["ethereum"])

    assert result.exit_code == 0
    assert len(probes[1].balance_reads) == 1
    assert checks(store, "balance_census", "ethereum") == [(1, "pass", None)]


def test_a_census_of_a_chain_with_no_probe_is_refused_before_a_run_starts(store):
    with pytest.raises(ValueError, match="census of a chain with no probe"):
        run_it(store, [FakeProbe(store, "tempo")], census=["ethereum"])

    assert runs(store) == []


# Same-looking transfers. See "Whether same-looking transfers are real" in the reconciliation plan.

TX = "0x" + "1" * 64
TX_2 = "0x" + "2" * 64


def same_transaction(probe, block, tx_hash, *moves):
    """Add moves to a block as one transaction. Every log in that block joins it."""
    for sender, to, value in moves:
        probe.rpc.add_transfer(block, value, sender=sender, to=to)
    probe.rpc.logs[block] = [replace(row, tx_hash=tx_hash) for row in probe.rpc.logs[block]]


def proof_of(probe, asked, positions=None, **changes):
    proof = probe.rpc.transaction_receipt(asked, probe.chain.token)
    assert proof is not None
    transfers = [
        transfer
        for transfer in proof.transfers
        if positions is None or transfer.log_index in positions
    ]
    return proof._replace(**{"transfers": transfers, **changes})


def audit(store, tx_hash, chain="tempo"):
    return store.db.execute(
        """
        SELECT status, proof_source, stored_positions, proven_positions, block_number
        FROM transfer_group_audits WHERE chain = ? AND tx_hash = ?
        """,
        [chain, tx_hash],
    ).fetchone()


def transfer_rows(store, chain="tempo"):
    return store.db.execute(
        """
        SELECT block_number, log_index, tx_hash, from_address, to_address, value
        FROM transfers WHERE chain = ? ORDER BY block_number, log_index
        """,
        [chain],
    ).fetchall()


def test_a_real_group_is_recorded_with_its_source_and_never_read_again(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("pass", 0)
    assert checks(store, "same_looking", "tempo") == [(1, "pass", None)]
    assert audit(store, TX) == ("real", "receipt", [0, 1], [0, 1], 110)
    assert tempo.proof_reads == [TX]
    assert check_detail(store, "same_looking", "tempo")["proof_sources"] == {"receipt": 1}

    tempo.proof_reads.clear()
    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert tempo.proof_reads == []
    assert check_detail(store, "same_looking", "tempo")["transactions"] == 0


def test_a_mixed_transaction_is_proven_once_and_does_not_come_back(store):
    probes, tempo = tempo_probes(store)
    # A group at 0 and 2, and a row of the same transaction at 1 that isn't in it.
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, CAROL, 9), (ALICE, BOB, 2))

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert audit(store, TX) == ("real", "receipt", [0, 1, 2], [0, 1, 2], 110)
    assert tempo.proof_reads == [TX]

    run_it(store, probes)

    assert tempo.proof_reads == [TX]


def test_a_mixed_transaction_missing_the_row_outside_the_group_is_not_real(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, CAROL, 9), (ALICE, BOB, 2))
    # The node returns the group's rows, and loses their sibling.
    real = tempo.rpc.transfers
    tempo.rpc.transfers = lambda token, start, end: [
        row for row in real(token, start, end) if (row.block_number, row.log_index) != (110, 1)
    ]

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == "fail"
    assert audit(store, TX)[:4] == ("not_real", "receipt", [0, 2], [0, 1, 2])


def test_a_transaction_with_two_groups_is_read_once(store):
    probes, tempo = tempo_probes(store)
    same_transaction(
        tempo, 110, TX, (ALICE, BOB, 2), (BOB, ALICE, 2), (ALICE, BOB, 2), (BOB, ALICE, 2)
    )

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert tempo.proof_reads == [TX]
    assert check_detail(store, "same_looking", "tempo")["transactions"] == 1


def test_a_loop_that_nets_to_zero_is_decided_by_the_receipt_not_by_balances(store):
    probes, tempo = tempo_probes(store)
    moves = [(ALICE, BOB, 2)] * 4 + [(BOB, ALICE, 2)] * 4
    same_transaction(tempo, 110, TX, *moves)
    # Only one each way really happened: three rows each way are extra, and they cancel.
    tempo.proofs[TX] = proof_of(tempo, TX, positions=[0, 4])

    result, reported = run_it(store, probes)

    assert checks(store, "sampled_balances", "tempo") == [(1, "pass", None)]
    assert checks(store, "chain_supply", "tempo") == [(1, "pass", None)]
    assert checks(store, "same_looking", "tempo") == [(1, "fail", "group_not_real")]
    assert (result.chains["tempo"], result.status, result.exit_code) == ("fail", "fail", 1)
    assert audit(store, TX)[:4] == ("not_real", "receipt", list(range(8)), [0, 4])
    # The eight rows of the loop, and the two every fake chain starts with.
    assert len(transfer_rows(store)) == 10
    assert [item for item in reported if isinstance(item, GroupFinding)] == [
        GroupFinding("tempo", TX, "not_real", tuple(range(8)), (0, 4), False)
    ]
    assert not store.latest_reconciliation().usable


@pytest.mark.parametrize(
    ("change", "proven"),
    [
        ({"positions": [0]}, [0]),
        (
            {
                "transfers": [
                    ProofTransfer(0, ALICE, BOB, 2),
                    ProofTransfer(5, ALICE, BOB, 2),
                ]
            },
            [0, 5],
        ),
        ({"success": False}, [0, 1]),
        (
            {
                "transfers": [
                    ProofTransfer(0, ALICE, BOB, 2),
                    ProofTransfer(0, ALICE, BOB, 2),
                    ProofTransfer(1, ALICE, BOB, 2),
                ]
            },
            [0, 0, 1],
        ),
        (
            {
                "transfers": [
                    ProofTransfer(0, ALICE, BOB, 2),
                    ProofTransfer(1, ALICE, BOB, 2),
                    ProofTransfer(2, ALICE, CAROL, 4),
                ]
            },
            [0, 1, 2],
        ),
        (
            {
                "transfers": [
                    ProofTransfer(0, ALICE, BOB, 2),
                    ProofTransfer(1, ALICE, CAROL, 2),
                ]
            },
            [0, 1],
        ),
        (
            {
                "transfers": [
                    ProofTransfer(0, ALICE, BOB, 2),
                    ProofTransfer(1, ALICE, BOB, 3),
                ]
            },
            [0, 1],
        ),
    ],
    ids=[
        "fewer",
        "other-positions",
        "failed",
        "duplicate-entry",
        "lost-sibling",
        "other-receiver",
        "other-value",
    ],
)
def test_a_group_that_is_not_real_fails_and_every_row_stays(store, change, proven):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX] = proof_of(tempo, TX, **change)

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.status, result.exit_code) == ("fail", "fail", 1)
    assert checks(store, "same_looking", "tempo") == [(1, "fail", "group_not_real")]
    # Nothing is deleted or repaired, and both lists are there for the maintainer.
    kept = transfer_rows(store)
    assert [row[1] for row in kept if row[2] == TX] == [0, 1]
    assert audit(store, TX)[:4] == ("not_real", "receipt", [0, 1], proven)
    assert not store.latest_reconciliation().usable

    # It's read again on every run, so it clears only once it is fixed.
    tempo.proof_reads.clear()
    result, _ = run_it(store, probes)

    assert tempo.proof_reads == [TX]
    assert result.exit_code == 1
    assert transfer_rows(store) == kept


def test_a_group_that_is_not_real_clears_once_the_proof_agrees(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX] = proof_of(tempo, TX, positions=[0])
    run_it(store, probes)

    del tempo.proofs[TX]
    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert audit(store, TX)[0] == "real"


@pytest.mark.parametrize(
    "change",
    [{"tx_hash": TX_2}, {"block_number": 111}],
    ids=["another-transaction", "another-block"],
)
def test_a_proof_of_something_else_is_unavailable(store, change):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX] = proof_of(tempo, TX, **change)

    result, reported = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("unchecked", 3)
    assert checks(store, "same_looking", "tempo") == [(1, "unchecked", "group_proof_unavailable")]
    assert audit(store, TX) is None
    assert [item for item in reported if isinstance(item, GroupFinding)] == [
        GroupFinding("tempo", TX, "unavailable", (0, 1), (), False)
    ]


def test_a_proven_transaction_that_gains_a_row_is_proven_again_and_fails(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    run_it(store, probes)
    assert audit(store, TX)[0] == "real"
    tempo.proof_reads.clear()

    # A duplicate that got past the write guard, at a position the chain never had.
    store.db.execute(
        """
        INSERT INTO transfers
        SELECT chain, block_number, 9, block_hash, block_timestamp, tx_hash, from_address,
               to_address, value
        FROM transfers WHERE chain = 'tempo' AND tx_hash = ? AND log_index = 0
        """,
        [TX],
    )

    result, _ = run_it(store, probes)

    assert tempo.proof_reads == [TX]
    assert result.chains["tempo"] == "fail"
    assert newest_run_checks(store, "same_looking", "tempo") == [(1, "fail", "group_not_real")]
    assert audit(store, TX)[:4] == ("not_real", "receipt", [0, 1, 9], [0, 1])


def test_a_source_with_no_status_is_judged_on_its_rows_and_recorded_as_blockscout(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX] = proof_of(tempo, TX, success=None)

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert audit(store, TX)[:2] == ("real", "blockscout")


def test_a_source_with_no_status_still_fails_on_different_rows(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX] = proof_of(tempo, TX, positions=[0], success=None)

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == "fail"
    assert audit(store, TX)[:2] == ("not_real", "blockscout")


def test_a_failed_proof_is_not_real_and_is_read_once(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX] = proof_of(tempo, TX, success=False)

    result, _ = run_it(store, probes)

    assert result.chains["tempo"] == "fail"
    assert tempo.proof_reads == [TX]


def test_no_proof_from_any_source_is_unavailable(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX] = None

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("unchecked", 3)
    assert checks(store, "same_looking", "tempo") == [(1, "unchecked", "group_proof_unavailable")]
    assert not store.latest_reconciliation().usable


def test_a_solana_proof_is_recorded_as_a_transaction(store):
    probes, solana = slot_probes(store)
    same_transaction(solana, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert audit(store, TX, "solana")[:2] == ("real", "transaction")


def test_a_same_shaped_log_from_another_contract_is_not_counted(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    proof = proof_of(tempo, TX)
    transfer_topic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
    origin_dollar = "0x2a8e1e676ec238d8a992307b495b45b3feaa5e86"

    def log(address, index):
        return {
            "address": address,
            "topics": [
                transfer_topic,
                "0x" + ALICE[2:].rjust(64, "0"),
                "0x" + BOB[2:].rjust(64, "0"),
            ],
            "data": hex(2),
            "logIndex": hex(index),
        }

    # The real parser over a receipt holding the same transfer from Origin Dollar, the other OUSD.
    logs = [log(tempo.chain.token, 0), log(origin_dollar, 5), log(tempo.chain.token, 1)]
    receipt = {"transactionHash": TX, "blockNumber": hex(110), "status": "0x1", "logs": logs}
    http = PoliteClient(
        min_interval=0,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={"id": 1, "result": receipt})
        ),
        sleep=lambda _: None,
    )

    tempo.proofs[TX] = RpcClient(http, "http://rpc.invalid").transaction_receipt(
        TX, tempo.chain.token
    )
    assert tempo.proofs[TX].transfers == proof.transfers

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert audit(store, TX)[0] == "real"


def test_a_group_mixing_hashed_and_unhashed_rows_is_flagged_and_its_proof_still_decides(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))

    # What sync sees a row from Blockscout as: no hash. Hide it from the next sync's re-read too.
    def mark_mixed(store):
        store.db.execute(
            "UPDATE transfers SET block_hash = NULL WHERE chain = 'tempo' AND log_index = 1"
            " AND tx_hash = ?",
            [TX],
        )

    tempo._sync()
    mark_mixed(store)
    real_sync = tempo._sync

    def sync_and_mark():
        real_sync()
        mark_mixed(store)

    tempo._sync = sync_and_mark

    result, reported = run_it(store, probes)

    assert result.exit_code == 0
    assert check_detail(store, "same_looking", "tempo")["mixed_hash_groups"] == 1
    assert [item for item in reported if isinstance(item, GroupFinding)] == [
        GroupFinding("tempo", TX, "real", (0, 1), (0, 1), True)
    ]


def test_a_group_with_all_its_hashes_is_not_flagged(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))

    _, reported = run_it(store, probes)

    assert check_detail(store, "same_looking", "tempo")["mixed_hash_groups"] == 0
    assert not [item for item in reported if isinstance(item, GroupFinding)]


def test_rolling_back_past_an_audited_transaction_audits_it_again(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 118, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    run_it(store, probes)
    assert audit(store, TX)[0] == "real"
    tempo.proof_reads.clear()

    tempo.rpc.reorg(from_block=118)
    same_transaction(tempo, 118, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert tempo.proof_reads == [TX]
    assert audit(store, TX)[0] == "real"


def test_each_verdict_is_committed_so_a_stopped_run_resumes(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    same_transaction(tempo, 111, TX_2, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX_2] = KeyError("a bug")

    with pytest.raises(KeyError):
        run_it(store, probes)

    assert audit(store, TX)[0] == "real"
    assert audit(store, TX_2) is None
    del tempo.proofs[TX_2]
    tempo.proof_reads.clear()

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert tempo.proof_reads == [TX_2]


def test_a_source_that_is_down_stops_the_audit_and_keeps_what_it_proved(store):
    probes, tempo = tempo_probes(store)
    third = "0x" + "3" * 64
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    same_transaction(tempo, 111, TX_2, (ALICE, BOB, 2), (ALICE, BOB, 2))
    same_transaction(tempo, 112, third, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX_2] = caused_by(ChainUnavailable("state_unavailable"), HttpError(KEY))

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("unchecked", 3)
    assert checks(store, "same_looking", "tempo") == [(1, "unchecked", "group_proof_unavailable")]
    assert tempo.proof_reads == [TX, TX_2]
    assert audit(store, TX)[0] == "real"
    detail = check_detail(store, "same_looking", "tempo")
    assert detail["error"] == "HttpError"
    assert (detail["transactions"], detail["real"], detail["unavailable"]) == (3, 1, 1)
    assert detail["not_attempted"] == 1
    assert KEY not in stored_check_text(store)

    del tempo.proofs[TX_2]
    tempo.proof_reads.clear()
    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert tempo.proof_reads == [TX_2, third]


def test_a_transaction_with_no_proof_does_not_stop_the_next(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    same_transaction(tempo, 111, TX_2, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.proofs[TX] = None

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("unchecked", 3)
    assert tempo.proof_reads == [TX, TX_2]
    assert audit(store, TX) is None
    assert audit(store, TX_2)[0] == "real"
    detail = check_detail(store, "same_looking", "tempo")
    assert (detail["real"], detail["unavailable"], detail["not_attempted"]) == (1, 1, 0)


@pytest.mark.parametrize("proven_in", [110, 111], ids=["lower-block", "higher-block"])
def test_rows_of_one_transaction_in_two_blocks_are_not_real_in_either_order(store, proven_in):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    same_transaction(tempo, 111, TX, (BOB, CAROL, 1), (BOB, CAROL, 1))
    tempo.proofs[TX] = TransactionProof(
        TX,
        proven_in,
        True,
        [
            ProofTransfer(0, ALICE, BOB, 2),
            ProofTransfer(1, ALICE, BOB, 2),
            ProofTransfer(0, BOB, CAROL, 1),
            ProofTransfer(1, BOB, CAROL, 1),
        ],
    )

    result, _ = run_it(store, probes)

    assert (result.chains["tempo"], result.exit_code) == ("fail", 1)
    assert checks(store, "same_looking", "tempo") == [(1, "fail", "group_not_real")]
    assert audit(store, TX)[0] == "not_real"


def test_a_failed_supply_still_audits_its_groups_as_a_duplicate_mint_shows_in_both(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ZERO_ADDRESS, ALICE, 2), (ZERO_ADDRESS, ALICE, 2))
    tempo.proofs[TX] = proof_of(tempo, TX, positions=[0])
    tempo.steps = [Drift(-2), Drift(-2)]

    result, reported = run_it(store, probes)

    assert result.chains["tempo"] == "fail"
    assert checks(store, "same_looking", "tempo") == [(1, "fail", "group_not_real")]
    assert [item.verdict for item in reported if isinstance(item, GroupFinding)] == ["not_real"]


def test_a_group_found_real_never_gets_past_a_chain_that_failed(store):
    probes, tempo = tempo_probes(store)
    same_transaction(tempo, 110, TX, (ALICE, BOB, 2), (ALICE, BOB, 2))
    tempo.balance_steps = [off_by(ALICE, 1), off_by(ALICE, 1)]

    result, _ = run_it(store, probes)

    assert checks(store, "same_looking", "tempo") == [(1, "pass", None)]
    assert result.chains["tempo"] == "fail"


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
