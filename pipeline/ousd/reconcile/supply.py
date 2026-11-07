"""Blocking check 1: do the stored events explain the chain's own supply, at a pin equal to the
cursor? Also the `--at-block` diagnostic, which records nothing.
"""

from ousd.chains import Chain
from ousd.http import HttpError
from ousd.reconcile.recorder import _RunRecorder
from ousd.reconcile.status import (
    ChainProbe,
    ChainReconciliation,
    ChainUnavailable,
    CheckOutcome,
    Unchecked,
)
from ousd.sources import RpcClient, RpcError
from ousd.store import Status, Store, StoreConflict

# Rereads after the first, for a pin that lands below the cursor.
PIN_ROUNDS = 3
# Solana reads only finalized blocks, so it stores no block hashes. Store.latest_reconciliation
# accepts a missing pin hash for these chains and no others.
CHAINS_WITHOUT_BLOCK_HASHES = frozenset({"solana"})


def _read_supply(chain: Chain, rpc: RpcClient, block_number: int, stored_hash: str | None) -> int:
    """totalSupply() at one block, the only part of a check that talks to a node.

    A past block's hash has been pruned from the store, so it is fetched, and the block is read
    by number only if the node can't find it. Hash reads reach far deeper on public nodes.
    """
    pinned_hash = stored_hash
    if pinned_hash is None:
        block = rpc.block(block_number)
        pinned_hash = block.hash if block else None
    return rpc.total_supply(chain.token, pinned_hash or block_number)


def reconcile_chain(
    chain: Chain, rpc: RpcClient, store: Store, at_block: int | None = None
) -> ChainReconciliation:
    """Compare events with totalSupply() at one block, and record it.

    By default that is the last synced block, pinned by its hash. A past block can be given
    to check history.
    """
    synced = store.synced_through(chain.name)
    if synced is None:
        raise RuntimeError(f"{chain.name}: nothing synced yet, run sync first")
    block_number = synced if at_block is None else at_block
    if block_number > synced:
        raise ValueError(f"{chain.name}: block {block_number} is above synced block {synced}")

    stored_hash = store.block_hashes(chain.name).get(block_number)
    onchain = _read_supply(chain, rpc, block_number, stored_hash)
    minted, burned = store.minted_and_burned(chain.name, block_number)
    result = ChainReconciliation(chain.name, block_number, minted, burned, onchain)
    store.record_reconciliation(chain.name, block_number, minted, burned, onchain, result.matched)
    return result


def check_at_block(chain: Chain, rpc: RpcClient, store: Store, block: int) -> CheckOutcome:
    """The `--at-block` diagnostic. It records nothing, so it can't affect the publish gate.

    A match is `unchecked`, as one past block says nothing about the data as it stands.
    """

    def outcome(
        status: Status, reason: str, reading: ChainReconciliation | None = None
    ) -> CheckOutcome:
        return CheckOutcome("chain_supply", chain.name, status, reason, None, reading)

    synced = store.synced_through(chain.name)
    if synced is None:
        return outcome("unchecked", "not_synced")
    if block > synced:
        return outcome("unchecked", "above_cursor")
    stored_hash = store.block_hashes(chain.name).get(block)
    try:
        onchain = _read_supply(chain, rpc, block, stored_hash)
    except (HttpError, RpcError, ValueError):
        # A node refusing old state, or answering "0x" for it, proves nothing about the events.
        # Only the node reads are inside this, so a store error or a bug still raises.
        return outcome("unchecked", "state_unavailable")
    minted, burned = store.minted_and_burned(chain.name, block)
    reading = ChainReconciliation(chain.name, block, minted, burned, onchain)
    if reading.matched:
        return outcome("unchecked", "diagnostic_only", reading)
    return outcome("fail", "supply_mismatch", reading)


def _judge_supply(
    probe: ChainProbe, reading: ChainReconciliation, store: Store
) -> tuple[Status, str | None]:
    if not reading.matched:
        return "fail", "supply_mismatch"
    if reading.block_number != store.synced_through(probe.name):
        return "unchecked", "pin_behind_cursor"
    # The gate treats a missing hash as changed data, so a pass here would never be usable.
    if (
        probe.name not in CHAINS_WITHOUT_BLOCK_HASHES
        and reading.block_number not in store.block_hashes(probe.name)
    ):
        return "unchecked", "pin_hash_missing"
    return "pass", None


def _check_supply(probe: ChainProbe, store: Store, recorder: _RunRecorder) -> CheckOutcome:
    """Blocking check 1, ending at a pin equal to the cursor.

    A mismatch gets one more sync and read, since a load-balanced node can serve a block's hash
    before another returns its logs, and a real loss doesn't heal. A second mismatch is a fail.
    A probe's supply_check syncs first, so each read here is at a fresh tip.
    """
    mismatch_retried = False
    pin_rounds = 0
    while True:
        try:
            reading = probe.supply_check()
        except ChainUnavailable as exc:
            return recorder.record(
                "chain_supply", probe.name, "unchecked", exc.reason, cause=exc.__cause__
            )
        except StoreConflict as exc:
            return recorder.record("chain_supply", probe.name, "fail", "store_conflict", cause=exc)
        if reading.chain != probe.name:
            # A bug in the probe. Recording it would file another chain's figures under this name.
            raise ValueError(f"{probe.name} probe answered for {reading.chain}")
        if isinstance(reading, Unchecked):
            return recorder.record("chain_supply", probe.name, "unchecked", reading.reason)

        status, reason = _judge_supply(probe, reading, store)
        outcome = recorder.record("chain_supply", probe.name, status, reason, reading=reading)
        if reason == "supply_mismatch" and not mismatch_retried:
            mismatch_retried = True
        elif reason == "pin_behind_cursor" and pin_rounds < PIN_ROUNDS:
            pin_rounds += 1
        else:
            return outcome


def _pin(supply: CheckOutcome) -> int:
    if supply.reconciliation is None:
        raise ValueError(f"{supply.subject}: a chain_supply outcome with no reading has no pin")
    return supply.reconciliation.block_number
