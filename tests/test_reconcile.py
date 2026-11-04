import pytest
from conftest import ALICE, BOB, FakeRpc, make_chain
from ousd.decode import ZERO_ADDRESS
from ousd.ingest import sync_chain
from ousd.reconcile import ChainReconciliation, compare_with_bridge, reconcile_chain

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
