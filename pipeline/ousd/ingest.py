"""Sync one chain's Transfer events from its first block to the tip, surviving reorgs."""

import logging
from dataclasses import dataclass

from ousd.chains import Chain
from ousd.sources import BlockscoutClient, RpcClient
from ousd.store import Store

log = logging.getLogger(__name__)


class ReorgError(RuntimeError):
    """A reorg this run cannot resolve by itself. Details are in the message."""


@dataclass(frozen=True)
class SyncResult:
    chain: str
    tip: int
    finalized: int
    # The last block both we and the chain agreed on, when a reorg was repaired.
    reorg_fork_block: int | None
    transfers_stored: int


def sync_chain(
    chain: Chain, rpc: RpcClient, store: Store, history: BlockscoutClient | None = None
) -> SyncResult:
    tip = rpc.tip()
    finalized = rpc.finalized()
    fork_block = _repair_reorg(chain, rpc, store)

    window_start = _window_start(chain, tip, finalized)
    cursor = store.synced_through(chain.name)
    next_block = chain.start_block if cursor is None else min(cursor + 1, window_start)

    if history is not None:
        # Blockscout rows carry no block hash, so it may only serve blocks that can't reorg.
        history_end = min(tip - chain.rpc_tail_blocks, finalized)
        if next_block <= history_end:
            for transfers, through in history.pages(chain.token, next_block, history_end):
                store.write_range(chain.name, transfers, {}, through)
                log.info("%s: stored history through block %d", chain.name, through)
            next_block = history_end + 1
            # That can take hours. Reconciliation needs recent state, so finish at the real tip.
            tip, finalized = rpc.tip(), rpc.finalized()
            window_start = _window_start(chain, tip, finalized)

    _ingest_from_rpc(chain, rpc, store, next_block, tip, window_start)
    store.prune_blocks(chain.name, window_start)
    return SyncResult(chain.name, tip, finalized, fork_block, store.transfer_count(chain.name))


def _window_start(chain: Chain, tip: int, finalized: int) -> int:
    """First block whose hash we keep. Covers every unfinalized block, even if finality stalls."""
    return max(chain.start_block, min(tip - chain.reorg_lookback, finalized) + 1)


def _repair_reorg(chain: Chain, rpc: RpcClient, store: Store) -> int | None:
    """Roll back to the newest stored block still on the canonical chain.

    A block hash commits to all its ancestors, so walking down stops at the first match.
    With no reorg, that is a single request.
    """
    stored = store.block_hashes(chain.name)
    for number in sorted(stored, reverse=True):
        block = rpc.block(number)
        if block is not None and block.hash == stored[number]:
            if number == max(stored):
                return None
            log.warning("%s: reorg found, rolling back to block %d", chain.name, number)
            store.rollback_to(chain.name, number)
            return number
    if stored:
        raise ReorgError(
            f"{chain.name}: no stored block from {min(stored)} to {max(stored)} is canonical. "
            "The reorg is deeper than the lookback, so re-ingest from a fresh database."
        )
    return None


def _ingest_from_rpc(
    chain: Chain, rpc: RpcClient, store: Store, first: int, tip: int, window_start: int
) -> None:
    known = store.block_hashes(chain.name)
    for low in range(first, tip + 1, chain.max_log_range):
        high = min(low + chain.max_log_range - 1, tip)
        new_hashes: dict[int, str] = {}
        for number in range(max(low, window_start), high + 1):
            if number not in known:
                block = rpc.block(number)
                if block is None:
                    raise ReorgError(f"{chain.name}: block {number} vanished during sync; rerun")
                # Repair trusts a block hash to commit to its ancestors, which only holds if
                # the stored hashes are one chain. So a block must extend the one below it.
                if number - 1 in known and block.parent_hash != known[number - 1]:
                    raise ReorgError(
                        f"{chain.name}: block {number} does not extend stored block "
                        f"{number - 1}; rerun"
                    )
                new_hashes[number] = known[number] = block.hash

        transfers = rpc.transfers(chain.token, low, high)
        for transfer in transfers:
            expected = known.get(transfer.block_number)
            if expected is not None and transfer.block_hash != expected:
                raise ReorgError(
                    f"{chain.name}: block {transfer.block_number} changed during sync; rerun"
                )
        store.write_range(chain.name, transfers, new_hashes, high)
        log.info("%s: stored through block %d", chain.name, high)
