"""What reconcile asks of each chain family: chain-specific reads, and their errors as fixed codes.

Clients are built here, each through PoliteClient, and a label only ever holds the chain's name.
"""

from collections.abc import Sequence

from ousd.chains import Chain
from ousd.http import HttpError, PoliteClient
from ousd.ingest import sync_chain
from ousd.reconcile import (
    BalanceRead,
    ChainProbe,
    ChainReconciliation,
    ChainUnavailable,
    Unchecked,
    reconcile_chain,
)
from ousd.solana import (
    RPC_INTERVAL,
    SolanaChain,
    SolanaDataError,
    SolanaRpc,
    SolanaRpcError,
    TailReread,
    decode_transaction,
    read_sampled_balances,
    reconcile_solana,
)
from ousd.sources import BlockscoutClient, ProofTransfer, RpcClient, TransactionProof
from ousd.store import Store, StoreConflict

BLOCKSCOUT_INTERVAL = 0.25

# HttpError, RpcError and ReorgError are RuntimeErrors, and a malformed reply is a ValueError.
# StoreConflict is a RuntimeError too, so each handler that can meet it lets it through first. A
# KeyError or TypeError here is a bug, so it stays out of this and raises.
_EVM_SOURCE_ERRORS = (RuntimeError, ValueError)
_SOLANA_SOURCE_ERRORS = (HttpError, SolanaRpcError, SolanaDataError)


def rpc_for(chain: Chain) -> RpcClient:
    http = PoliteClient(label=f"{chain.name}-rpc", min_interval=chain.rpc_interval)
    return RpcClient(http, chain.rpc_url)


def history_for(chain: Chain) -> BlockscoutClient | None:
    if not chain.blockscout_url:
        return None
    http = PoliteClient(label=f"{chain.name}-blockscout", min_interval=BLOCKSCOUT_INTERVAL)
    return BlockscoutClient(http, chain.blockscout_url)


def solana_rpc_for(chain: SolanaChain) -> SolanaRpc:
    http = PoliteClient(label=f"{chain.name}-rpc", min_interval=RPC_INTERVAL)
    return SolanaRpc(http, chain.rpc_url)


class EvmProbe:
    def __init__(
        self, chain: Chain, rpc: RpcClient, store: Store, history: BlockscoutClient | None = None
    ) -> None:
        self.name = chain.name
        # Not its truthiness: blanking the URL must not drop a check the stored rows still need.
        self.needs_census = chain.blockscout_url is not None
        self._chain = chain
        self._rpc = rpc
        self._store = store
        self._history = history

    def supply_check(self) -> ChainReconciliation:
        # Before any sync, so a reconcile never starts a backfill.
        if self._store.synced_through(self.name) is None:
            raise ChainUnavailable("not_synced")
        try:
            sync_chain(self._chain, self._rpc, self._store, self._history)
        except StoreConflict:
            raise
        except _EVM_SOURCE_ERRORS as exc:
            raise ChainUnavailable("sync_failed") from exc
        try:
            return reconcile_chain(self._chain, self._rpc, self._store)
        except StoreConflict:
            raise
        except _EVM_SOURCE_ERRORS as exc:
            raise ChainUnavailable("state_unavailable") from exc

    def pin_timestamp(self, height: int) -> int:
        try:
            return self._rpc.block_timestamp(height)
        except _EVM_SOURCE_ERRORS as exc:
            raise ChainUnavailable("coverage_gap") from exc

    def read_balances(self, addresses: Sequence[str], height: int) -> list[BalanceRead]:
        # By hash, so every wallet is read on the fork the supply check pinned. A read by number
        # could land on a competing block.
        pinned_hash = self._store.block_hashes(self.name).get(height)
        if pinned_hash is None:
            raise ChainUnavailable("pin_hash_missing")
        try:
            return [
                BalanceRead(
                    address, height, self._rpc.balance_of(self._chain.token, address, pinned_hash)
                )
                for address in addresses
            ]
        except _EVM_SOURCE_ERRORS as exc:
            raise ChainUnavailable("state_unavailable") from exc

    def read_transaction_proof(self, tx_hash: str) -> TransactionProof | None:
        token = self._chain.token
        try:
            proof = self._rpc.transaction_receipt(tx_hash, token)
            if proof is None and self._history is not None:
                return self._history.transaction_logs(tx_hash, token)
        except _EVM_SOURCE_ERRORS as exc:
            raise ChainUnavailable("group_proof_unavailable") from exc
        return proof


class SolanaProbe:
    """One run's view of Solana, so build a new one for each run: the tail is re-read only once."""

    needs_census = False

    def __init__(self, chain: SolanaChain, rpc: SolanaRpc, store: Store) -> None:
        self.name = chain.name
        self._chain = chain
        self._rpc = rpc
        self._store = store
        self._reread = TailReread()

    def _require_cursor(self) -> None:
        # solana.py's own check gives free text, which the recorder can only call source_error.
        if self._store.synced_through(self.name) is None:
            raise ChainUnavailable("not_synced")

    def supply_check(self) -> ChainReconciliation | Unchecked:
        self._require_cursor()
        return reconcile_solana(self._chain, self._rpc, self._store, self._reread)

    def pin_timestamp(self, height: int) -> int:
        try:
            return self._rpc.block_time(height)
        except _SOLANA_SOURCE_ERRORS as exc:
            raise ChainUnavailable("coverage_gap") from exc

    def read_balances(self, addresses: Sequence[str], height: int) -> list[BalanceRead] | Unchecked:
        # `height` goes unused: there is no past-slot read, so each reading reports its own slot,
        # which is the height it must be compared at.
        self._require_cursor()
        readings = read_sampled_balances(
            self._chain, self._rpc, self._store, addresses, self._reread
        )
        if isinstance(readings, Unchecked):
            return readings
        return [BalanceRead(reading.owner, reading.slot, reading.amount) for reading in readings]

    def read_transaction_proof(self, tx_hash: str) -> TransactionProof | None:
        try:
            transaction = self._rpc.transaction(tx_hash)
            if transaction is None:
                return None
            rows = decode_transaction(transaction, self._chain.mint)
        except _SOLANA_SOURCE_ERRORS as exc:
            raise ChainUnavailable("group_proof_unavailable") from exc
        # Decoding has read each of these fields. The signature and slot come from the reply, not
        # the request, so reconcile can tell when a node answered about something else.
        return TransactionProof(
            str(transaction["transaction"]["signatures"][0]),
            int(transaction["slot"]),
            transaction["meta"]["err"] is None,
            [
                ProofTransfer(row.log_index, row.from_address, row.to_address, row.value)
                for row in rows
            ],
        )


def build_probes(chains: Sequence[Chain | SolanaChain], store: Store) -> list[ChainProbe]:
    """One probe per chain, in order, for one run. The only place that branches on a family."""
    probes: list[ChainProbe] = []
    for chain in chains:
        if isinstance(chain, SolanaChain):
            probes.append(SolanaProbe(chain, solana_rpc_for(chain), store))
        else:
            probes.append(EvmProbe(chain, rpc_for(chain), store, history_for(chain)))
    return probes
