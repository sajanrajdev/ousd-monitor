import pytest
from conftest import ALICE, BOB, FakeRpc, make_chain, rows
from ousd.decode import ZERO_ADDRESS, Transfer
from ousd.ingest import ReorgError, sync_chain


class FakeHistory:
    """Stands in for Blockscout: old rows, with no block hash, one page per call."""

    def __init__(self, transfers: list[Transfer]) -> None:
        self.transfers = transfers
        self.ranges: list[tuple[int, int]] = []

    def pages(self, token, from_block, to_block):
        self.ranges.append((from_block, to_block))
        yield [t for t in self.transfers if from_block <= t.block_number <= to_block], to_block


def test_backfill_covers_every_range_and_stores_recent_hashes_only(store):
    chain = make_chain()
    rpc = FakeRpc(tip=135)
    rpc.add_transfer(99, 7)  # Before start_block, so out of scope.
    rpc.add_transfer(100, 1)
    rpc.add_transfer(109, 2)
    rpc.add_transfer(110, 3)
    rpc.add_transfer(135, 4)

    result = sync_chain(chain, rpc, store)

    assert [row[0] for row in rows(store)] == [100, 109, 110, 135]
    assert store.synced_through("testnet") == 135
    assert sorted(store.block_hashes("testnet")) == list(range(131, 136))
    assert result.reorg_fork_block is None
    assert result.transfers_stored == 4


def test_rerun_changes_nothing(store):
    chain = make_chain()
    rpc = FakeRpc(tip=120)
    rpc.add_transfer(105, 1)
    rpc.add_transfer(118, 2)
    sync_chain(chain, rpc, store)
    before = rows(store)

    sync_chain(chain, rpc, store)

    assert rows(store) == before
    assert store.synced_through("testnet") == 120


def test_second_run_only_picks_up_new_blocks(store):
    chain = make_chain()
    rpc = FakeRpc(tip=120)
    rpc.add_transfer(105, 1)
    sync_chain(chain, rpc, store)

    rpc.extend(125)
    rpc.add_transfer(124, 2)
    sync_chain(chain, rpc, store)

    assert [row[0] for row in rows(store)] == [105, 124]


def test_log_a_lagging_node_missed_is_healed_by_the_lookback(store):
    chain = make_chain()
    rpc = FakeRpc(tip=120)
    sync_chain(chain, rpc, store)

    # The log was not served during the first run, though its block was.
    rpc.add_transfer(119, 5)
    sync_chain(chain, rpc, store)

    assert [row[0] for row in rows(store)] == [119]


def test_interrupted_backfill_resumes_without_duplicates(store):
    chain = make_chain()
    rpc = FakeRpc(tip=130)
    rpc.add_transfer(101, 1)
    rpc.add_transfer(125, 2)
    real_transfers = rpc.transfers
    calls = {"count": 0}

    def fail_on_third_range(token, low, high):
        calls["count"] += 1
        if calls["count"] == 3:
            raise ConnectionError("provider went away")
        return real_transfers(token, low, high)

    rpc.transfers = fail_on_third_range
    with pytest.raises(ConnectionError):
        sync_chain(chain, rpc, store)
    assert store.synced_through("testnet") == 119

    rpc.transfers = real_transfers
    sync_chain(chain, rpc, store)

    assert [row[0] for row in rows(store)] == [101, 125]
    assert store.synced_through("testnet") == 130


def test_history_source_serves_old_blocks_and_rpc_serves_the_tail(store):
    chain = make_chain(rpc_tail_blocks=10)
    rpc = FakeRpc(tip=150)
    old = rpc.add_transfer(120, 1)
    rpc.add_transfer(145, 2)
    history = FakeHistory([Transfer(**{**old.__dict__, "block_hash": None})])

    sync_chain(chain, rpc, store, history)

    assert history.ranges == [(100, 140)]
    stored = rows(store)
    assert [row[0] for row in stored] == [120, 145]
    assert stored[0][2] is None  # History rows carry no hash.
    assert stored[1][2] == rpc.hashes[145]


def test_reorg_replaces_orphaned_transfers_at_the_same_positions(store):
    chain = make_chain()
    rpc = FakeRpc(tip=120)
    rpc.add_transfer(110, 1)
    rpc.add_transfer(118, 100, to=ALICE)
    rpc.add_transfer(119, 200, to=ALICE)
    sync_chain(chain, rpc, store)

    # Block 118 onward is replaced. Same block and log index, different content.
    rpc.reorg(from_block=118)
    rpc.add_transfer(118, 999, to=BOB)
    result = sync_chain(chain, rpc, store)

    stored = rows(store)
    assert result.reorg_fork_block == 117
    assert [(row[0], row[1], row[4], row[5]) for row in stored] == [
        (110, 0, ALICE, 1),
        (118, 0, BOB, 999),
    ]
    assert stored[1][2] == rpc.hashes[118]
    assert store.block_hashes("testnet")[120] == rpc.hashes[120]


def test_reorg_onto_a_shorter_chain_rolls_back_past_the_new_tip(store):
    chain = make_chain()
    rpc = FakeRpc(tip=120)
    rpc.add_transfer(119, 1)
    rpc.add_transfer(120, 2)
    sync_chain(chain, rpc, store)

    rpc.reorg(from_block=119, new_tip=119)
    result = sync_chain(chain, rpc, store)

    assert result.reorg_fork_block == 118
    assert rows(store) == []
    assert store.synced_through("testnet") == 119


def test_repeated_reorgs_converge_on_the_canonical_chain(store):
    chain = make_chain()
    rpc = FakeRpc(tip=120)
    sync_chain(chain, rpc, store)

    for fork in ("b", "c", "d"):
        rpc.reorg(from_block=119, fork=fork)
        rpc.add_transfer(119, 5)
        sync_chain(chain, rpc, store)

    assert [(row[0], row[5]) for row in rows(store)] == [(119, 5)]


def test_no_reorg_costs_a_single_hash_check(store):
    chain = make_chain()
    rpc = FakeRpc(tip=120)
    sync_chain(chain, rpc, store)
    rpc.hash_requests = 0

    sync_chain(chain, rpc, store)

    assert rpc.hash_requests == 1


def test_reorg_deeper_than_the_lookback_stops_instead_of_guessing(store):
    chain = make_chain()
    rpc = FakeRpc(tip=120)
    rpc.add_transfer(105, 1)
    sync_chain(chain, rpc, store)
    before = rows(store)

    rpc.reorg(from_block=110)

    with pytest.raises(ReorgError, match="deeper than the lookback"):
        sync_chain(chain, rpc, store)
    assert rows(store) == before


def test_block_changing_during_a_sync_aborts_that_range(store):
    rpc = FakeRpc(tip=120)
    rpc.add_transfer(119, 1)
    real_transfers = rpc.transfers

    def reorg_mid_sync(token, low, high):
        rpc.reorg(from_block=119)
        rpc.add_transfer(119, 2)
        return real_transfers(token, low, high)

    rpc.transfers = reorg_mid_sync
    with pytest.raises(ReorgError, match="changed during sync"):
        sync_chain(make_chain(start_block=115), rpc, store)
    assert rows(store) == []


def test_lookback_widens_to_cover_unfinalized_blocks_when_finality_stalls(store):
    chain = make_chain(reorg_lookback=2)
    rpc = FakeRpc(tip=120, finality_lag=8)

    sync_chain(chain, rpc, store)

    assert min(store.block_hashes("testnet")) == 113
    assert rpc.finalized() == 112


def test_mint_and_burn_addresses_round_trip(store):
    rpc = FakeRpc(tip=105)
    rpc.add_transfer(101, 10, sender=ZERO_ADDRESS, to=ALICE)
    rpc.add_transfer(102, 4, sender=ALICE, to=ZERO_ADDRESS)
    sync_chain(make_chain(), rpc, store)

    assert store.minted_and_burned("testnet", 105) == (10, 4)


@pytest.mark.parametrize("new_fork_value", [9, None])
def test_reorg_between_two_ranges_never_stores_a_mix_of_forks(store, new_fork_value):
    # The hash window (102 to 109) spans two log ranges, and the fork lands between them.
    chain = make_chain(max_log_range=5, reorg_lookback=8)
    rpc = FakeRpc(tip=109, finality_lag=8)
    rpc.add_transfer(103, 1)
    real_transfers = rpc.transfers

    def reorg_after_first_range(token, low, high):
        result = real_transfers(token, low, high)
        rpc.transfers = real_transfers
        rpc.reorg(from_block=103)
        if new_fork_value is not None:
            rpc.add_transfer(103, new_fork_value)
        return result

    rpc.transfers = reorg_after_first_range
    with pytest.raises(ReorgError, match="does not extend"):
        sync_chain(chain, rpc, store)

    result = sync_chain(chain, rpc, store)

    assert result.reorg_fork_block == 102
    assert [row[5] for row in rows(store)] == ([] if new_fork_value is None else [new_fork_value])
    assert store.block_hashes("testnet") == {n: rpc.hashes[n] for n in range(102, 110)}


def test_history_stops_at_finality_even_if_the_tail_is_short(store):
    # Finality has stalled 20 blocks back, deeper than the 3 block tail.
    chain = make_chain(rpc_tail_blocks=3)
    rpc = FakeRpc(tip=130, finality_lag=20)
    rpc.add_transfer(120, 1)
    history = FakeHistory([])

    sync_chain(chain, rpc, store, history)

    assert history.ranges == [(100, 110)]
    assert [(row[0], row[2]) for row in rows(store)] == [(120, rpc.hashes[120])]


def test_sync_ends_near_the_tip_after_a_long_history_backfill(store):
    chain = make_chain(rpc_tail_blocks=10)
    rpc = FakeRpc(tip=150)
    history = FakeHistory([])
    real_pages = history.pages

    def slow_pages(token, low, high):
        yield from real_pages(token, low, high)
        rpc.extend(170)  # The chain moved on while history was rate limited.

    history.pages = slow_pages
    result = sync_chain(chain, rpc, store, history)

    assert history.ranges == [(100, 140)]
    assert result.tip == 170
    assert store.synced_through("testnet") == 170
    assert max(store.block_hashes("testnet")) == 170
