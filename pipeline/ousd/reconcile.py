"""The key check: do stored events explain the supply each chain reports?"""

from dataclasses import dataclass

from ousd.chains import PENDING_CHAINS, Chain
from ousd.sources import RpcClient
from ousd.store import Store


@dataclass(frozen=True)
class ChainReconciliation:
    chain: str
    block_number: int
    minted: int
    burned: int
    onchain_supply: int

    @property
    def event_supply(self) -> int:
        return self.minted - self.burned

    @property
    def difference(self) -> int:
        return self.event_supply - self.onchain_supply

    @property
    def matched(self) -> bool:
        return self.difference == 0


@dataclass(frozen=True)
class BridgeComparison:
    """Our chain sum against Bridge. Partial until every chain is ingested."""

    chains_included: tuple[str, ...]
    chains_missing: tuple[str, ...]
    chains_total: int
    bridge_total: int

    @property
    def difference(self) -> int:
        return self.chains_total - self.bridge_total

    @property
    def is_partial(self) -> bool:
        return bool(self.chains_missing)


def reconcile_chain(
    chain: Chain, rpc: RpcClient, store: Store, at_block: int | None = None
) -> ChainReconciliation:
    """Compare events with totalSupply() at one block.

    By default that is the last synced block, pinned by its hash. A past block can be given
    to check history against an archive node. It is read by number, as its hash has been pruned.
    """
    synced = store.synced_through(chain.name)
    if synced is None:
        raise RuntimeError(f"{chain.name}: nothing synced yet, run sync first")
    block_number = synced if at_block is None else at_block
    if block_number > synced:
        raise ValueError(f"{chain.name}: block {block_number} is above synced block {synced}")

    pinned_hash = store.block_hashes(chain.name).get(block_number)
    onchain = rpc.total_supply(chain.token, pinned_hash or block_number)
    minted, burned = store.minted_and_burned(chain.name, block_number)
    result = ChainReconciliation(chain.name, block_number, minted, burned, onchain)
    store.record_reconciliation(chain.name, block_number, minted, burned, onchain, result.matched)
    return result


def compare_with_bridge(results: list[ChainReconciliation], bridge_total: int) -> BridgeComparison:
    return BridgeComparison(
        chains_included=tuple(result.chain for result in results),
        chains_missing=PENDING_CHAINS,
        chains_total=sum(result.onchain_supply for result in results),
        bridge_total=bridge_total,
    )
