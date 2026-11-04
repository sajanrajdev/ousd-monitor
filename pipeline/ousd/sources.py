"""Clients for the upstream data sources: JSON-RPC, Blockscout and Bridge."""

from collections.abc import Iterator
from decimal import Decimal, localcontext
from typing import Any

from ousd.chains import DECIMALS
from ousd.decode import TRANSFER_TOPIC, Transfer, decode_blockscout_log, decode_rpc_log
from ousd.http import PoliteClient

TOTAL_SUPPLY_SELECTOR = "0x18160ddd"
BLOCKSCOUT_PAGE_SIZE = 1000
# Tempo refuses a result set over 20,000 logs with this error rather than truncating it.
TOO_MANY_RESULTS = "exceeds max results"


class RpcError(RuntimeError):
    """The node answered with a JSON-RPC error."""


class RpcClient:
    def __init__(self, http: PoliteClient, url: str) -> None:
        self._http = http
        self._url = url

    def _call(self, method: str, params: list[Any]) -> Any:
        payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        body = self._http.request_json("POST", self._url, json=payload)
        if "error" in body:
            raise RpcError(f"{method} {params}: {body['error']}")
        return body["result"]

    def tip(self) -> int:
        return int(self._call("eth_blockNumber", []), 16)

    def finalized(self) -> int:
        return int(self._call("eth_getBlockByNumber", ["finalized", False])["number"], 16)

    def block_hash(self, number: int) -> str | None:
        block = self._call("eth_getBlockByNumber", [hex(number), False])
        return block["hash"].lower() if block else None

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
            if TOO_MANY_RESULTS not in str(exc) or from_block == to_block:
                raise
            middle = (from_block + to_block) // 2
            return self.transfers(token, from_block, middle) + self.transfers(
                token, middle + 1, to_block
            )
        return [decode_rpc_log(entry, token) for entry in logs if not entry.get("removed")]

    def total_supply(self, token: str, block: int | str) -> int:
        """Read totalSupply() at a block number, or at a block hash (EIP-1898).

        A hash pins the read to one fork, so it cannot land on a competing block.
        """
        at = hex(block) if isinstance(block, int) else {"blockHash": block}
        return int(self._call("eth_call", [{"to": token, "data": TOTAL_SUPPLY_SELECTOR}, at]), 16)


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
        if body["status"] != "1":
            if body["message"].startswith("No logs found"):
                return []
            raise RuntimeError(f"Blockscout error for {params}: {body}")
        return [decode_blockscout_log(entry, token) for entry in body["result"]]

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


def bridge_total_base_units(http: PoliteClient, url: str) -> int:
    """Bridge's reported on-chain total, converted from a decimal string without floats.

    Anything that can't convert exactly is an error, not a rounded number.
    """
    amount = http.request_json("GET", url)["total_onchain_amount"]
    if not isinstance(amount, str):
        raise ValueError(f"Bridge total should be a decimal string, got {amount!r}")
    with localcontext(prec=78):
        base_units = Decimal(amount).scaleb(DECIMALS)
    if base_units != base_units.to_integral_value():
        raise ValueError(f"Bridge total {amount} is finer than one base unit")
    return int(base_units)
