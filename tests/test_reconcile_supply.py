import pytest
from conftest import FakeRpc, make_chain
from ousd.http import HttpError
from ousd.ingest import sync_chain
from ousd.reconcile import (
    PIN_ROUNDS,
    ChainUnavailable,
    CheckOutcome,
    Unchecked,
    check_at_block,
    exit_code,
    reconcile_chain,
)
from ousd.sources import RpcError
from ousd.store import StoreConflict
from reconcile_fakes import (
    LARGE,
    BridgeFeed,
    Drift,
    FakeProbe,
    NoPinHash,
    PinBehind,
    bad_at,
    bridge_passes,
    checks,
    four_probes,
    good_at,
    run_it,
    runs,
    synced_chain,
)


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
