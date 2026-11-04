"""Shared test doubles. Nothing in this suite touches the network."""

import dataclasses
import hashlib
import socket

import pytest
from ousd.chains import Chain
from ousd.decode import ZERO_ADDRESS, Transfer
from ousd.sources import Block, ProofTransfer, RpcClient, RpcError, TransactionProof
from ousd.store import Store

ALICE = "0x" + "a" * 40
BOB = "0x" + "b" * 40


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def refuse(self, address):
        raise RuntimeError(f"a test tried to open a connection to {address}")

    monkeypatch.setattr(socket.socket, "connect", refuse)


def make_chain(**overrides) -> Chain:
    chain = Chain(
        name="testnet",
        chain_id=1,
        token="0x" + "c" * 40,
        rpc_url="http://rpc.invalid",
        start_block=100,
        max_log_range=10,
        reorg_lookback=5,
    )
    return dataclasses.replace(chain, **overrides)


class FakeRpc(RpcClient):
    """An in-memory chain with the same surface ingest uses on RpcClient.

    Subclassing lets mypy hold these signatures to the real ones. It never opens a connection:
    RpcClient.__init__ isn't called, so anything not overridden here fails loudly.
    """

    def __init__(self, tip: int, finality_lag: int = 2, fork: str = "a") -> None:
        self.finality_lag = finality_lag
        self.hashes: dict[int, str] = {}
        self.logs: dict[int, list[Transfer]] = {}
        self.hash_requests = 0
        self.extend(tip, fork)

    def extend(self, tip: int, fork: str = "a") -> None:
        for number in range(self.tip() + 1 if self.hashes else 0, tip + 1):
            self.hashes[number] = _block_hash(number, fork)

    def add_transfer(
        self, block: int, value: int, sender: str = ZERO_ADDRESS, to: str = ALICE
    ) -> Transfer:
        index = len(self.logs.get(block, []))
        transfer = Transfer(
            block_number=block,
            block_hash=self.hashes[block],
            block_timestamp=1_000 + block,
            tx_hash=f"0x{block:060x}{index:04x}",
            log_index=index,
            from_address=sender,
            to_address=to,
            value=value,
        )
        self.logs.setdefault(block, []).append(transfer)
        return transfer

    def reorg(self, from_block: int, new_tip: int | None = None, fork: str = "b") -> None:
        """Replace every block from from_block upward with a competing fork."""
        tip = self.tip() if new_tip is None else new_tip
        for number in [n for n in self.hashes if n >= from_block]:
            del self.hashes[number]
            self.logs.pop(number, None)
        for number in range(from_block, tip + 1):
            self.hashes[number] = _block_hash(number, fork)

    def chain_id(self) -> int:
        return 1

    def tip(self) -> int:
        return max(self.hashes)

    def finalized(self) -> int:
        return self.tip() - self.finality_lag

    def block(self, number: int) -> Block | None:
        self.hash_requests += 1
        if number not in self.hashes:
            return None
        return Block(self.hashes[number], self.hashes.get(number - 1, "0x0"))

    def transfers(self, token: str, from_block: int, to_block: int) -> list[Transfer]:
        return [
            transfer
            for number in range(from_block, to_block + 1)
            for transfer in self.logs.get(number, [])
        ]

    def _number(self, block: int | str) -> int:
        if isinstance(block, int):
            return block
        numbers = [number for number, value in self.hashes.items() if value == block]
        if not numbers:
            raise RuntimeError("unknown block hash")
        return numbers[0]

    def total_supply(self, token: str, block: int | str) -> int:
        block = self._number(block)
        supply = 0
        for number, transfers in self.logs.items():
            if number <= block:
                for transfer in transfers:
                    if transfer.from_address == ZERO_ADDRESS:
                        supply += transfer.value
                    if transfer.to_address == ZERO_ADDRESS:
                        supply -= transfer.value
        return supply

    def balance_of(self, token: str, address: str, block: int | str) -> int:
        block = self._number(block)
        balance = 0
        for number, transfers in self.logs.items():
            if number <= block:
                for transfer in transfers:
                    # Mints and burns don't change the zero address's balance on a real token.
                    if address == ZERO_ADDRESS:
                        continue
                    if transfer.to_address == address:
                        balance += transfer.value
                    if transfer.from_address == address:
                        balance -= transfer.value
        return balance

    def block_timestamp(self, number: int) -> int:
        if number not in self.hashes:
            raise RpcError(f"block {number} not found")
        return 1_000 + number

    def transaction_receipt(self, tx_hash: str, token: str) -> TransactionProof | None:
        found = [
            transfer
            for transfers in self.logs.values()
            for transfer in transfers
            if transfer.tx_hash == tx_hash
        ]
        if not found:
            return None
        return TransactionProof(
            tx_hash,
            found[0].block_number,
            True,
            [ProofTransfer(t.log_index, t.from_address, t.to_address, t.value) for t in found],
        )


def _block_hash(number: int, fork: str) -> str:
    return "0x" + hashlib.sha256(f"{fork}:{number}".encode()).hexdigest()


def rows(store: Store, chain: str = "testnet") -> list[tuple]:
    return store.db.execute(
        """
        SELECT block_number, log_index, block_hash, from_address, to_address, value
        FROM transfers WHERE chain = ? ORDER BY block_number, log_index
        """,
        [chain],
    ).fetchall()


@pytest.fixture
def store():
    store = Store()
    yield store
    store.close()
