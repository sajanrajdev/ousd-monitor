import json
from decimal import Decimal

import httpx
import pytest
from ousd.decode import TRANSFER_TOPIC
from ousd.http import PoliteClient
from ousd.sources import (
    BLOCKSCOUT_PAGE_SIZE,
    BlockscoutClient,
    RpcClient,
    RpcError,
    bridge_total_base_units,
)

TOKEN = "0x" + "c" * 40


def http_with(handler) -> PoliteClient:
    return PoliteClient(
        min_interval=0, transport=httpx.MockTransport(handler), sleep=lambda _: None
    )


def blockscout_row(block: int, index: int) -> dict:
    return {
        "blockNumber": hex(block),
        "logIndex": hex(index),
        "timeStamp": "0x1",
        "transactionHash": "0x" + "d" * 64,
        "data": hex(1),
        "topics": [TRANSFER_TOPIC, "0x" + "0" * 64, "0x" + "a" * 64, None],
    }


class FakeBlockscout:
    """Serves rows in block order and truncates each response at the page size."""

    def __init__(self, rows: list[dict], page_size: int = BLOCKSCOUT_PAGE_SIZE) -> None:
        self.rows = rows
        self.page_size = page_size
        self.requests: list[tuple[int, int]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        low = int(request.url.params["fromBlock"])
        high = int(request.url.params["toBlock"])
        self.requests.append((low, high))
        matching = [row for row in self.rows if low <= int(row["blockNumber"], 16) <= high]
        if not matching:
            return httpx.Response(
                200, json={"status": "0", "message": "No logs found", "result": []}
            )
        page = matching[: self.page_size]
        return httpx.Response(200, json={"status": "1", "message": "OK", "result": page})


def collect(fake: FakeBlockscout, low: int, high: int) -> tuple[list, list[int]]:
    client = BlockscoutClient(http_with(fake), "http://blockscout.invalid/api")
    transfers, checkpoints = [], []
    for page, through in client.pages(TOKEN, low, high):
        transfers.extend(page)
        checkpoints.append(through)
    return transfers, checkpoints


def test_block_split_across_a_page_boundary_loses_and_repeats_nothing():
    # 999 rows in block 1, then 5 in block 2: the first page stops inside block 2.
    rows = [blockscout_row(1, i) for i in range(999)] + [blockscout_row(2, i) for i in range(5)]
    fake = FakeBlockscout(rows)

    transfers, checkpoints = collect(fake, 1, 10)

    positions = [(t.block_number, t.log_index) for t in transfers]
    assert len(positions) == 1004
    assert len(set(positions)) == 1004
    assert checkpoints == [1, 10]
    assert fake.requests == [(1, 10), (2, 10)]


def test_page_ending_exactly_on_a_block_boundary_loses_nothing():
    # Block 2 ends on row 1000. The client cannot know that, so it asks for block 2 again.
    rows = [blockscout_row(1, i) for i in range(500)] + [blockscout_row(2, i) for i in range(500)]
    rows.append(blockscout_row(3, 0))
    fake = FakeBlockscout(rows)

    transfers, checkpoints = collect(fake, 1, 5)

    assert len(transfers) == 1001
    assert checkpoints == [1, 5]
    assert fake.requests == [(1, 5), (2, 5)]


def test_exactly_full_page_ending_at_the_last_row_requests_once_more():
    rows = [blockscout_row(1, 0)] + [blockscout_row(2, i) for i in range(999)]
    transfers, checkpoints = collect(FakeBlockscout(rows), 1, 2)

    assert len(transfers) == 1000
    assert checkpoints == [1, 2]


def test_single_block_filling_a_page_fails_loudly():
    rows = [blockscout_row(7, i) for i in range(1000)]
    client = BlockscoutClient(http_with(FakeBlockscout(rows)), "http://blockscout.invalid/api")

    with pytest.raises(RuntimeError, match="block 7 alone fills"):
        list(client.pages(TOKEN, 7, 9))


def test_empty_range_is_complete_rather_than_an_error():
    transfers, checkpoints = collect(FakeBlockscout([]), 1, 10)

    assert transfers == []
    assert checkpoints == [10]


def test_other_blockscout_errors_are_raised():
    def handler(request):
        return httpx.Response(200, json={"status": "0", "message": "Query timeout", "result": None})

    client = BlockscoutClient(http_with(handler), "http://blockscout.invalid/api")

    with pytest.raises(RuntimeError, match="Query timeout"):
        list(client.pages(TOKEN, 1, 2))


def test_rpc_error_is_raised_with_the_method_name():
    def handler(request):
        return httpx.Response(200, json={"id": 1, "error": {"code": -32000, "message": "nope"}})

    with pytest.raises(RpcError, match=r"eth_blockNumber.*nope"):
        RpcClient(http_with(handler), "http://rpc.invalid").tip()


def test_range_over_the_result_cap_is_split_until_it_fits():
    logs_by_block = {
        block: {
            "blockNumber": hex(block),
            "blockHash": "0x" + "e" * 64,
            "blockTimestamp": "0x1",
            "logIndex": "0x0",
            "transactionHash": "0x" + "d" * 64,
            "data": hex(1),
            "topics": [TRANSFER_TOPIC, "0x" + "0" * 64, "0x" + "a" * 64],
        }
        for block in range(1, 9)
    }

    def handler(request):
        query = json.loads(request.content)["params"][0]
        wanted = range(int(query["fromBlock"], 16), int(query["toBlock"], 16) + 1)
        if len(wanted) > 3:
            error = {"code": -32602, "message": "query exceeds max results 20000, retry"}
            return httpx.Response(200, json={"id": 1, "error": error})
        return httpx.Response(200, json={"id": 1, "result": [logs_by_block[n] for n in wanted]})

    transfers = RpcClient(http_with(handler), "http://rpc.invalid").transfers(TOKEN, 1, 8)

    assert [t.block_number for t in transfers] == list(range(1, 9))


def test_total_supply_pins_to_a_block_hash_or_number():
    params = []

    def handler(request):
        params.append(json.loads(request.content)["params"][1])
        return httpx.Response(200, json={"id": 1, "result": hex(2**70)})

    rpc = RpcClient(http_with(handler), "http://rpc.invalid")

    assert rpc.total_supply(TOKEN, "0xabc") == 2**70
    assert rpc.total_supply(TOKEN, 255) == 2**70
    assert params == [{"blockHash": "0xabc"}, "0xff"]


def test_bridge_total_converts_a_decimal_string_exactly():
    def handler(request):
        return httpx.Response(200, json={"total_onchain_amount": "872221164.60664"})

    total = bridge_total_base_units(http_with(handler), "http://bridge.invalid")

    assert total == 872_221_164_606_640
    assert Decimal(total).scaleb(-6) == Decimal("872221164.60664")
