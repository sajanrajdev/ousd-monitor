"""An in-memory Solana node for sync tests, built from real fixtures. No connection is opened."""

import copy
import json
from pathlib import Path
from typing import Any

from ousd.solana import (
    OUSD_MINT,
    BalanceSnapshot,
    SignatureRow,
    SlotReading,
    SolanaRpc,
    SolanaRpcError,
)

FIXTURES = Path(__file__).parent / "fixtures" / "solana"
MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"


def load(name: str) -> Any:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def movement(signature: str, slot: int, index: int, value: int = 100_000) -> dict[str, Any]:
    """`top_level_transfer` moved to another signature, slot and index, and to another amount."""
    tx = copy.deepcopy(load("top_level_transfer"))
    tx["transaction"]["signatures"][0] = signature
    tx["slot"], tx["transactionIndex"] = slot, index
    transfer = next(
        i["parsed"]["info"]
        for i in tx["transaction"]["message"]["instructions"]
        if i.get("parsed", {}).get("type") == "transferChecked"
    )
    transfer["tokenAmount"]["amount"] = str(value)
    pre, post = tx["meta"]["preTokenBalances"], tx["meta"]["postTokenBalances"]
    pre[0]["uiTokenAmount"]["amount"] = str(value)
    post[0]["uiTokenAmount"]["amount"] = "0"
    post[1]["uiTokenAmount"]["amount"] = str(int(pre[1]["uiTokenAmount"]["amount"]) + value)
    return tx


def row_of(tx: dict[str, Any], failed: bool = False) -> SignatureRow:
    return SignatureRow(
        tx["transaction"]["signatures"][0], tx["slot"], tx["transactionIndex"], failed
    )


class FakeSolanaRpc(SolanaRpc):
    """The same surface sync uses on SolanaRpc. SolanaRpc.__init__ isn't called, so any method not
    overridden here fails loudly instead of reaching a network."""

    def __init__(self, head: int, genesis: str = MAINNET_GENESIS) -> None:
        self.head = head
        self.genesis = genesis
        self.rows: list[SignatureRow] = []
        self.transactions: dict[str, dict[str, Any] | None] = {}
        self.page_size = 1000
        self.supply = SlotReading(head, 0)
        self.snapshot = BalanceSnapshot(head, {})
        self.times: dict[int, int] = {}
        # Supply reads answered in turn before falling back to `supply`.
        self.supply_queue: list[SlotReading] = []
        # Faults. A count is how many times the call fails before it works.
        self.read_errors: dict[str, Exception] = {}
        self.min_context_failures = 0
        self.min_context_error: dict[str, Any] = load("error_min_context_slot")["error"]
        self.null_for: dict[str, int] = {}
        self.raise_on_transaction_call: int | None = None
        # What was asked.
        self.calls: list[str] = []
        self.signature_requests: list[tuple[str | None, int]] = []
        self.transaction_requests: list[str] = []
        self.pauses: list[float] = []
        self.sleep = self.pauses.append

    def add(self, tx: dict[str, Any], failed: bool = False) -> dict[str, Any]:
        row = row_of(tx, failed)
        self.rows.append(row)
        self.transactions[row.signature] = tx
        return tx

    def scrub(self, text: str) -> str:
        return text

    def genesis_hash(self) -> str:
        self.calls.append("genesis")
        return self.genesis

    def _read(self, call: str) -> None:
        self.calls.append(call)
        if call in self.read_errors:
            raise self.read_errors[call]

    def finalized_slot(self) -> int:
        self._read("slot")
        return self.head

    def signatures(
        self, mint: str, before: str | None, min_context_slot: int
    ) -> list[SignatureRow]:
        assert mint == OUSD_MINT
        self.calls.append("signatures")
        self.signature_requests.append((before, min_context_slot))
        if self.min_context_failures:
            self.min_context_failures -= 1
            error = self.min_context_error
            raise SolanaRpcError(error["code"], error["message"])
        ordered = sorted(self.rows, key=lambda r: (r.slot, r.transaction_index), reverse=True)
        start = 0
        if before is not None:
            start = [r.signature for r in ordered].index(before) + 1
        return ordered[start : start + self.page_size]

    def transaction(self, signature: str) -> dict[str, Any] | None:
        self.calls.append("transaction")
        self.transaction_requests.append(signature)
        if self.raise_on_transaction_call == len(self.transaction_requests):
            raise RuntimeError("the fake node dropped")
        if self.null_for.get(signature, 0):
            self.null_for[signature] -= 1
            return None
        tx = self.transactions[signature]
        return copy.deepcopy(tx) if tx is not None else None

    def block_time(self, slot: int) -> int:
        self.calls.append("block_time")
        return self.times[slot]

    def token_supply(self, mint: str) -> SlotReading:
        assert mint == OUSD_MINT
        self._read("supply")
        return self.supply_queue.pop(0) if self.supply_queue else self.supply

    def token_accounts(self, mint: str) -> BalanceSnapshot:
        assert mint == OUSD_MINT
        self._read("accounts")
        return self.snapshot
