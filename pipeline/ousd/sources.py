"""Clients for the upstream data sources: JSON-RPC, Blockscout and Bridge."""

import re
from collections.abc import Callable, Iterator
from datetime import datetime
from decimal import Decimal, localcontext
from typing import Any, NamedTuple

import httpx

from ousd.chains import DECIMALS
from ousd.decode import (
    TRANSFER_TOPIC,
    Transfer,
    _address_from_topic,
    decode_blockscout_log,
    decode_rpc_log,
)
from ousd.http import PoliteClient

TOTAL_SUPPLY_SELECTOR = "0x18160ddd"
BALANCE_OF_SELECTOR = "0x70a08231"
BLOCKSCOUT_PAGE_SIZE = 1000
# Tempo refuses a result set over 20,000 logs with this error rather than truncating it.
TOO_MANY_RESULTS = "exceeds max results"
# Pages of one transaction's logs. Even a very large batch fits in far fewer.
MAX_LOG_PAGES = 20
TX_HASH = re.compile(r"0x[0-9a-f]{64}")
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
# Plain decimal digits only, so NaN, Infinity, exponents, signs and padding are all refused.
BRIDGE_TOTAL = re.compile(r"[0-9]{1,18}(\.[0-9]+)?")
RFC3339 = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})"
)


class Block(NamedTuple):
    hash: str
    parent_hash: str


class ProofTransfer(NamedTuple):
    log_index: int
    from_address: str
    to_address: str
    value: int  # Base units.


class TransactionProof(NamedTuple):
    """One transaction's Transfer logs from a single token, as a source reports them."""

    tx_hash: str
    block_number: int
    success: bool | None  # None: the source doesn't report a status.
    transfers: list[ProofTransfer]


class BridgeSnapshot(NamedTuple):
    total: int  # Base units.
    last_updated: int  # Unix seconds, UTC.


class RpcError(RuntimeError):
    """The node answered with a JSON-RPC error."""

    def __init__(self, message: str, too_many_results: bool = False) -> None:
        super().__init__(message)
        self.too_many_results = too_many_results


# What reading a provider's data raises when a field is missing, mistyped or not a number.
_MALFORMED = (ValueError, KeyError, TypeError, AttributeError, IndexError, ArithmeticError)
# Longest stretch of a provider's reply kept in an error, after scrubbing.
_DETAIL_LIMIT = 400


def _parse[T](http: PoliteClient, url: str, what: str, read: Callable[[], T]) -> T:
    """Run read() over provider data. A failure becomes a ValueError with the URL scrubbed.

    Python's own messages quote the offending value, and a provider may have put the key there.
    The new error is raised after the handler has exited, so it has no cause or context.
    """
    failure = ""
    try:
        return read()
    except _MALFORMED as exc:
        failure = repr(exc)
    raise ValueError(http.scrub(f"malformed {what}: {failure}", url)[:_DETAIL_LIMIT])


class RpcClient:
    def __init__(self, http: PoliteClient, url: str) -> None:
        self._http = http
        self._url = url

    def _call(self, method: str, params: list[Any]) -> Any:
        payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        body = self._http.request_json("POST", self._url, json=payload)
        if self._parse(f"{method} response", lambda: "error" in body):
            error = self._parse(f"{method} response", lambda: body["error"])
            # Decided on the raw text: scrubbing rewrites it when a host or path is a word in it.
            capped = TOO_MANY_RESULTS in str(error)
            raise RpcError(self._http.scrub(f"{method} {params}: {error}", self._url), capped)
        return self._parse(f"{method} response", lambda: body["result"])

    def _parse[T](self, what: str, read: Callable[[], T]) -> T:
        return _parse(self._http, self._url, what, read)

    def chain_id(self) -> int:
        result = self._call("eth_chainId", [])
        return self._parse("eth_chainId result", lambda: int(result, 16))

    def tip(self) -> int:
        result = self._call("eth_blockNumber", [])
        return self._parse("eth_blockNumber result", lambda: int(result, 16))

    def finalized(self) -> int:
        block = self._call("eth_getBlockByNumber", ["finalized", False])
        return self._parse("finalized block", lambda: int(block["number"], 16))

    def block(self, number: int) -> Block | None:
        block = self._call("eth_getBlockByNumber", [hex(number), False])
        return self._parse(
            f"block {number}",
            lambda: Block(block["hash"].lower(), block["parentHash"].lower()) if block else None,
        )

    def transfers(self, token: str, from_block: int, to_block: int) -> list[Transfer]:
        query = {
            "address": token,
            "topics": [TRANSFER_TOPIC],
            "fromBlock": hex(from_block),
            "toBlock": hex(to_block),
        }
        try:
            logs = self._call("eth_getLogs", [query])
        except RpcError as exc:
            if not exc.too_many_results or from_block == to_block:
                raise
            middle = (from_block + to_block) // 2
            return self.transfers(token, from_block, middle) + self.transfers(
                token, middle + 1, to_block
            )
        return self._parse(
            "eth_getLogs result",
            lambda: [decode_rpc_log(entry, token) for entry in logs if not entry.get("removed")],
        )

    def total_supply(self, token: str, block: int | str) -> int:
        """Read totalSupply() at a block number, or at a block hash (EIP-1898).

        A hash pins the read to one fork, so it cannot land on a competing block.
        """
        at = hex(block) if isinstance(block, int) else {"blockHash": block}
        result = self._call("eth_call", [{"to": token, "data": TOTAL_SUPPLY_SELECTOR}, at])
        return self._parse("totalSupply result", lambda: int(result, 16))

    def balance_of(self, token: str, address: str, block: int | str) -> int:
        """Read balanceOf(address) at a block number, or at a block hash (EIP-1898)."""
        if not ADDRESS.fullmatch(address):
            raise ValueError(f"not an address: {address!r}")
        data = BALANCE_OF_SELECTOR + address[2:].lower().rjust(64, "0")
        at = hex(block) if isinstance(block, int) else {"blockHash": block}
        result = self._call("eth_call", [{"to": token, "data": data}, at])
        return self._parse("balanceOf result", lambda: int(result, 16))

    def block_timestamp(self, number: int) -> int:
        block = self._call("eth_getBlockByNumber", [hex(number), False])
        if not block:
            raise RpcError(f"block {number} not found")
        return self._parse(f"block {number}", lambda: int(block["timestamp"], 16))

    def transaction_receipt(self, tx_hash: str, token: str) -> TransactionProof | None:
        """The token's Transfer logs in one transaction, or None if the node doesn't know it."""
        _check_tx_hash(tx_hash)
        receipt = self._call("eth_getTransactionReceipt", [tx_hash])
        if receipt is None:
            return None

        def read() -> TransactionProof:
            if receipt["transactionHash"].lower() != tx_hash:
                raise ValueError(f"receipt for {receipt['transactionHash']}, asked for {tx_hash}")
            status = receipt.get("status")
            transfers = [
                transfer
                for log in receipt["logs"]
                if (
                    transfer := _proof_transfer(
                        log["address"], log["topics"], log["data"], int(log["logIndex"], 16), token
                    )
                )
            ]
            return TransactionProof(
                tx_hash,
                int(receipt["blockNumber"], 16),
                None if status is None else int(status, 16) == 1,
                transfers,
            )

        return self._parse(f"receipt for {tx_hash}", read)


def _check_tx_hash(tx_hash: str) -> None:
    if not TX_HASH.fullmatch(tx_hash):
        raise ValueError(f"not a lowercase transaction hash: {tx_hash!r}")


def _proof_transfer(
    address: str, topics: list[str | None], data: str, log_index: int, token: str
) -> ProofTransfer | None:
    """The log as a Transfer, or None if it isn't one from this token.

    The ticker OUSD also belongs to Origin Dollar, so the address is checked here and not left
    to the server. Blockscout pads the topic list with nulls.
    """
    if address.lower() != token.lower():
        return None
    present = [topic for topic in topics if topic is not None]
    if not present or present[0].lower() != TRANSFER_TOPIC:
        return None
    if len(present) != 3:
        raise ValueError(f"not an ERC-20 Transfer log at index {log_index}")
    return ProofTransfer(
        log_index,
        _address_from_topic(present[1]),
        _address_from_topic(present[2]),
        int(data, 16),
    )


class BlockscoutClient:
    def __init__(self, http: PoliteClient, url: str) -> None:
        self._http = http
        self._url = url

    def _page(self, token: str, from_block: int, to_block: int) -> list[Transfer]:
        params = {
            "module": "logs",
            "action": "getLogs",
            "fromBlock": from_block,
            "toBlock": to_block,
            "address": token,
            "topic0": TRANSFER_TOPIC,
        }
        body = self._http.request_json("GET", self._url, params=params)
        status, message = self._parse("response", lambda: (body["status"], body["message"]))
        if status != "1":
            if self._parse("response", lambda: message.startswith("No logs found")):
                return []
            raise RuntimeError(
                self._http.scrub(f"Blockscout error for {params}: {body}", self._url)[
                    :_DETAIL_LIMIT
                ]
            )
        return self._parse(
            "logs result", lambda: [decode_blockscout_log(entry, token) for entry in body["result"]]
        )

    def _parse[T](self, what: str, read: Callable[[], T]) -> T:
        return _parse(self._http, self._url, what, read)

    def _logs_url(self, tx_hash: str) -> httpx.URL:
        invalid = False
        try:
            base = httpx.URL(self._url)
            return base.copy_with(path=f"{base.path.rstrip('/')}/v2/transactions/{tx_hash}/logs")
        except httpx.InvalidURL:
            # Its text can quote part of the URL. Raised below, outside the handler.
            invalid = True
        assert invalid
        raise ValueError("invalid Blockscout URL")

    def pages(
        self, token: str, from_block: int, to_block: int
    ) -> Iterator[tuple[list[Transfer], int]]:
        """Yield (transfers, complete_through_block) until to_block is covered.

        A page may stop part way through its last block, so that block is dropped and requested
        again as the start of the next page. No row is lost or returned twice.

        Only a response with nothing past its first block finishes the range. A short page is
        not proof, because it would silently skip the rest if the server's limit ever shrank.
        That costs one extra request per range.
        """
        start = from_block
        while True:
            rows = self._page(token, start, to_block)
            _check_page_order(rows, start, to_block)
            last_block = rows[-1].block_number if rows else start
            if last_block == start:
                if len(rows) >= BLOCKSCOUT_PAGE_SIZE:
                    # Paging by block cannot get past this, and truncating would lose rows.
                    raise RuntimeError(f"block {start} alone fills a Blockscout page")
                yield rows, to_block
                return
            yield [row for row in rows if row.block_number < last_block], last_block - 1
            start = last_block

    def transaction_logs(self, tx_hash: str, token: str) -> TransactionProof:
        """The token's Transfer logs in one transaction, from Blockscout's v2 API.

        That endpoint reports no status, so the success flag is None.
        """
        _check_tx_hash(tx_hash)
        first = self._logs_url(tx_hash)
        url = first
        transfers: list[ProofTransfer] = []
        block_numbers: set[int] = set()
        seen: set[tuple[tuple[str, str], ...]] = set()
        for _ in range(MAX_LOG_PAGES):
            body = self._http.request_json("GET", str(url))

            def read_page(body: Any = body) -> tuple[tuple[str, str], ...] | None:
                for item in body["items"]:
                    if item["transaction_hash"].lower() != tx_hash:
                        raise ValueError(f"log of {item['transaction_hash']}, asked for {tx_hash}")
                    block_numbers.add(int(item["block_number"]))
                    transfer = _proof_transfer(
                        item["address"]["hash"],
                        item["topics"],
                        item["data"],
                        int(item["index"]),
                        token,
                    )
                    if transfer:
                        transfers.append(transfer)
                cursor = body["next_page_params"]
                if cursor is None:
                    return None
                return tuple(sorted((str(key), str(value)) for key, value in cursor.items()))

            query = self._parse(f"logs for {tx_hash}", read_page)
            if query is None:
                break
            if not query or query in seen:
                raise ValueError(f"Blockscout logs for {tx_hash} repeat a page cursor")
            seen.add(query)
            url = first.copy_merge_params(dict(query))
        else:
            raise ValueError(f"Blockscout logs for {tx_hash} run past {MAX_LOG_PAGES} pages")
        if not block_numbers:
            raise ValueError(f"Blockscout returned no logs for {tx_hash}")
        if len(block_numbers) != 1:
            raise ValueError(f"Blockscout logs for {tx_hash} name blocks {sorted(block_numbers)}")
        return TransactionProof(tx_hash, block_numbers.pop(), None, transfers)


def _check_page_order(rows: list[Transfer], from_block: int, to_block: int) -> None:
    """Paging is only safe if each page is the lowest rows of the range, in block order."""
    blocks = [row.block_number for row in rows]
    if blocks != sorted(blocks) or (
        blocks and not from_block <= blocks[0] <= blocks[-1] <= to_block
    ):
        raise RuntimeError(
            f"Blockscout page for blocks {from_block} to {to_block} is out of order or out of "
            f"range: it spans {blocks[0]} to {blocks[-1]}"
        )


def _base_units(amount: object) -> int:
    """A Bridge decimal string as base units. Anything that can't convert exactly is an error."""
    if not isinstance(amount, str):
        raise ValueError(f"Bridge total should be a decimal string, got {amount!r}")
    if not BRIDGE_TOTAL.fullmatch(amount):
        raise ValueError(f"Bridge total is not plain decimal digits: {amount!r}")
    with localcontext(prec=78):
        base_units = Decimal(amount).scaleb(DECIMALS)
    if base_units != base_units.to_integral_value():
        raise ValueError(f"Bridge total {amount} is finer than one base unit")
    return int(base_units)


def _unix_seconds(stamp: object) -> int:
    if not isinstance(stamp, str) or not RFC3339.fullmatch(stamp):
        raise ValueError(f"Bridge last_updated should be an RFC 3339 time, got {stamp!r}")
    try:
        return int(datetime.fromisoformat(stamp).timestamp())
    except ValueError as exc:
        raise ValueError(f"Bridge last_updated is not a real time: {stamp!r}") from exc


def _bridge_body(http: PoliteClient, url: str) -> dict[str, Any]:
    body = http.request_json("GET", url)
    if not isinstance(body, dict):
        raise ValueError("Bridge response should be an object")
    return body


def bridge_total_base_units(http: PoliteClient, url: str) -> int:
    """Bridge's reported on-chain total, converted from a decimal string without floats."""
    body = _bridge_body(http, url)
    if "total_onchain_amount" not in body:
        raise ValueError("Bridge response has no total_onchain_amount")
    return _base_units(body["total_onchain_amount"])


def bridge_snapshot(http: PoliteClient, url: str) -> BridgeSnapshot:
    """Bridge's total with the time it says the figure is from."""
    body = _bridge_body(http, url)
    for name in ("total_onchain_amount", "last_updated"):
        if name not in body:
            raise ValueError(f"Bridge response has no {name}")
    return BridgeSnapshot(
        _base_units(body["total_onchain_amount"]), _unix_seconds(body["last_updated"])
    )
