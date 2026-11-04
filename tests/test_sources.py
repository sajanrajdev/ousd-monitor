import json
from decimal import Decimal
from pathlib import Path

import httpx
import pytest
from conftest import ALICE, BOB, FakeRpc
from ousd.decode import TRANSFER_TOPIC, ZERO_ADDRESS
from ousd.http import PoliteClient
from ousd.sources import (
    BLOCKSCOUT_PAGE_SIZE,
    BlockscoutClient,
    ProofTransfer,
    RpcClient,
    RpcError,
    bridge_snapshot,
    bridge_total_base_units,
)

FIXTURES = Path(__file__).parent / "fixtures"
TOKEN = "0x" + "c" * 40
OUSD = "0x9f6f3991d525015a6f8caf062c83b62fd3ac4436"
ORIGIN_DOLLAR = "0x2a8e1e676ec238d8a992307b495b45b3feaa5e86"
TX = "0xc50dd0ca4a1aa86b9a8b64bbc6da524bf928c344c411a13d3e6e7e12d6653cca"
OUSD_POSITIONS = [169, 172, 175, 178, 181, 184, 187, 190]


def http_with(handler) -> PoliteClient:
    return PoliteClient(
        min_interval=0, transport=httpx.MockTransport(handler), sleep=lambda _: None
    )


def blockscout_row(block: int, index: int) -> dict:
    return {
        "address": TOKEN,
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
    # That second page is short but spans two blocks, so block 3 is confirmed by a third request.
    rows = [blockscout_row(1, i) for i in range(500)] + [blockscout_row(2, i) for i in range(500)]
    rows.append(blockscout_row(3, 0))
    fake = FakeBlockscout(rows)

    transfers, checkpoints = collect(fake, 1, 5)

    assert len(transfers) == 1001
    assert checkpoints == [1, 2, 5]
    assert fake.requests == [(1, 5), (2, 5), (3, 5)]


def test_exactly_full_page_ending_at_the_last_row_requests_once_more():
    rows = [blockscout_row(1, 0)] + [blockscout_row(2, i) for i in range(999)]
    transfers, checkpoints = collect(FakeBlockscout(rows), 1, 2)

    assert len(transfers) == 1000
    assert checkpoints == [1, 2]


def test_page_limit_smaller_than_expected_still_loses_nothing():
    rows = [blockscout_row(block, i) for block in (1, 2, 3) for i in range(300)]
    fake = FakeBlockscout(rows, page_size=500)

    transfers, checkpoints = collect(fake, 1, 10)

    positions = [(t.block_number, t.log_index) for t in transfers]
    assert len(positions) == 900
    assert len(set(positions)) == 900
    assert checkpoints == [1, 2, 10]


def test_rows_in_several_blocks_cost_one_request_to_confirm_the_end():
    fake = FakeBlockscout([blockscout_row(1, 0), blockscout_row(4, 0)])

    transfers, checkpoints = collect(fake, 1, 10)

    assert [t.block_number for t in transfers] == [1, 4]
    assert checkpoints == [3, 10]
    assert fake.requests == [(1, 10), (4, 10)]


@pytest.mark.parametrize(
    "served",
    [
        [blockscout_row(5, 0), blockscout_row(4, 0)],  # Newest first.
        [blockscout_row(11, 0)],  # Above the requested range.
        [blockscout_row(0, 0)],  # Below it.
    ],
)
def test_a_page_that_breaks_the_paging_assumptions_fails_loudly(served):
    def handler(request):
        return httpx.Response(200, json={"status": "1", "message": "OK", "result": served})

    client = BlockscoutClient(http_with(handler), "http://blockscout.invalid/api")

    with pytest.raises(RuntimeError, match="out of order or out of range"):
        list(client.pages(TOKEN, 1, 10))


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
            "address": TOKEN,
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


def test_block_reads_hash_and_parent_and_handles_a_missing_block():
    block = {"hash": "0xAA", "parentHash": "0xBB", "number": "0x1"}
    results = iter([block, None])

    def handler(request):
        return httpx.Response(200, json={"id": 1, "result": next(results)})

    rpc = RpcClient(http_with(handler), "http://rpc.invalid")

    assert rpc.block(1) == ("0xaa", "0xbb")
    assert rpc.block(2) is None


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


@pytest.mark.parametrize(
    ("served", "message"),
    [
        ("1.1234567", "finer than one base unit"),
        (872221164.60664, "should be a decimal string"),
    ],
)
def test_bridge_total_that_cannot_convert_exactly_is_refused(served, message):
    def handler(request):
        return httpx.Response(200, json={"total_onchain_amount": served})

    with pytest.raises(ValueError, match=message):
        bridge_total_base_units(http_with(handler), "http://bridge.invalid")


def rpc_serving(result, seen: list | None = None) -> RpcClient:
    def handler(request):
        if seen is not None:
            seen.append(json.loads(request.content)["params"])
        return httpx.Response(200, json={"id": 1, "result": result})

    return RpcClient(http_with(handler), "http://rpc.invalid")


def test_balance_of_encodes_the_address_and_reads_by_number_or_hash():
    seen: list = []
    rpc = rpc_serving(hex(2**70 + 1), seen)
    address = "0x" + "aB" * 20

    assert rpc.balance_of(TOKEN, address, 255) == 2**70 + 1
    assert rpc.balance_of(TOKEN, address, "0xabc") == 2**70 + 1

    data = "0x70a08231" + "000000000000000000000000" + "ab" * 20
    assert seen[0] == [{"to": TOKEN, "data": data}, "0xff"]
    assert seen[1] == [{"to": TOKEN, "data": data}, {"blockHash": "0xabc"}]


def test_balance_of_refuses_a_malformed_address_before_any_request():
    seen: list = []

    with pytest.raises(ValueError, match="not an address"):
        rpc_serving("0x0", seen).balance_of(TOKEN, "0x1234", 1)

    assert seen == []


def test_block_timestamp_reads_the_time_and_a_missing_block_raises():
    assert rpc_serving({"timestamp": hex(1_700_000_000)}).block_timestamp(5) == 1_700_000_000
    with pytest.raises(RpcError, match="block 5 not found"):
        rpc_serving(None).block_timestamp(5)


def receipt_fixture() -> dict:
    return json.loads((FIXTURES / "rpc_receipt.json").read_text())["result"]


def test_transaction_receipt_keeps_only_this_tokens_transfers():
    proof = rpc_serving(receipt_fixture()).transaction_receipt(TX, OUSD)

    assert proof is not None
    assert proof.tx_hash == TX
    assert proof.block_number == 26330904
    assert proof.success is True
    assert [t.log_index for t in proof.transfers] == OUSD_POSITIONS
    # The fixture also holds other tokens' Transfers and non-Transfer events.
    assert len(receipt_fixture()["logs"]) > len(proof.transfers)
    assert proof.transfers[0].value == 0x43E40CFA


def test_transaction_receipt_excludes_origin_dollar_and_other_events():
    receipt = receipt_fixture()
    ousd_log = next(log for log in receipt["logs"] if log["address"].lower() == OUSD)
    origin = dict(ousd_log, address=ORIGIN_DOLLAR, logIndex="0x999")
    approval = dict(ousd_log, topics=["0x" + "ab" * 32, *ousd_log["topics"][1:]], logIndex="0x998")
    receipt["logs"] += [origin, approval]

    proof = rpc_serving(receipt).transaction_receipt(TX, OUSD)

    assert proof is not None
    assert [t.log_index for t in proof.transfers] == OUSD_POSITIONS


def test_transaction_receipt_null_is_none_and_failed_status_is_false():
    assert rpc_serving(None).transaction_receipt(TX, OUSD) is None

    failed = rpc_serving(receipt_fixture() | {"status": "0x0"}).transaction_receipt(TX, OUSD)

    assert failed is not None
    assert failed.success is False


@pytest.mark.parametrize(
    "change",
    [
        {"transactionHash": "0x" + "1" * 64},
        {"blockNumber": "zz"},
        {"blockNumber": None},
    ],
)
def test_transaction_receipt_malformed_fields_raise_value_error(change):
    with pytest.raises(ValueError):
        rpc_serving(receipt_fixture() | change).transaction_receipt(TX, OUSD)


def test_transaction_receipt_malformed_log_raises_value_error():
    receipt = receipt_fixture()
    del receipt["logs"][0]["data"]

    with pytest.raises(ValueError, match="malformed receipt"):
        rpc_serving(receipt).transaction_receipt(TX, OUSD)


def blockscout_logs() -> dict:
    return json.loads((FIXTURES / "blockscout_tx_logs.json").read_text())


def serving_pages(pages: list[dict], seen: list | None = None) -> BlockscoutClient:
    remaining = iter(pages)

    def handler(request):
        if seen is not None:
            seen.append(request.url)
        return httpx.Response(200, json=next(remaining))

    return BlockscoutClient(http_with(handler), "https://scout.invalid/api?apikey=SECRETKEY")


def test_transaction_logs_parses_the_fixture_to_the_ousd_positions():
    seen: list = []

    proof = serving_pages([blockscout_logs()], seen).transaction_logs(TX, OUSD)

    assert proof.tx_hash == TX
    assert proof.block_number == 26330904
    assert proof.success is None
    assert [t.log_index for t in proof.transfers] == OUSD_POSITIONS
    assert proof.transfers[0] == ProofTransfer(
        169,
        "0x46c16995bbd99bc4908d4f9412cc9fbd57cb8274",
        "0x0cef320d0c5793ade37964e2661a033771e53cd5",
        0x43E40CFA,
    )
    assert seen[0].path == f"/api/v2/transactions/{TX}/logs"
    assert seen[0].params["apikey"] == "SECRETKEY"


def test_transaction_logs_matches_the_receipt():
    from_receipt = rpc_serving(receipt_fixture()).transaction_receipt(TX, OUSD)
    from_scout = serving_pages([blockscout_logs()]).transaction_logs(TX, OUSD)

    assert from_receipt is not None
    assert from_scout.transfers == from_receipt.transfers
    assert from_scout.block_number == from_receipt.block_number


def test_transaction_logs_follows_a_second_page():
    page = blockscout_logs()
    half = len(page["items"]) // 2
    first = dict(
        page, items=page["items"][:half], next_page_params={"index": 178, "items_count": 50}
    )
    second = dict(page, items=page["items"][half:], next_page_params=None)
    seen: list = []

    proof = serving_pages([first, second], seen).transaction_logs(TX, OUSD)

    assert [t.log_index for t in proof.transfers] == OUSD_POSITIONS
    assert seen[1].params["index"] == "178"
    assert seen[1].params["apikey"] == "SECRETKEY"


def test_transaction_logs_excludes_another_contracts_logs():
    page = blockscout_logs()
    for item in page["items"]:
        if item["address"]["hash"].lower() == OUSD:
            item["address"] = dict(item["address"], hash=ORIGIN_DOLLAR)

    assert serving_pages([page]).transaction_logs(TX, OUSD).transfers == []


def test_transaction_logs_malformed_hash_raises_before_any_request():
    seen: list = []
    client = serving_pages([blockscout_logs()], seen)

    for bad in (TX.upper(), TX[:-1], TX + "?x=1", "../" + TX):
        with pytest.raises(ValueError, match="transaction hash"):
            client.transaction_logs(bad, OUSD)

    assert seen == []


def test_transaction_logs_looping_cursor_raises_without_leaking_the_key():
    page = dict(blockscout_logs(), next_page_params={"index": 1})

    with pytest.raises(ValueError, match="repeat a page cursor") as raised:
        serving_pages([page, page]).transaction_logs(TX, OUSD)

    assert "SECRETKEY" not in str(raised.value)


def test_transaction_logs_more_than_twenty_pages_raises():
    pages = [dict(blockscout_logs(), next_page_params={"index": n}) for n in range(30)]

    with pytest.raises(ValueError, match="run past 20 pages") as raised:
        serving_pages(pages).transaction_logs(TX, OUSD)

    assert "SECRETKEY" not in str(raised.value)


def test_transaction_logs_for_another_transaction_raises():
    page = blockscout_logs()
    page["items"][0]["transaction_hash"] = "0x" + "1" * 64

    with pytest.raises(ValueError, match="asked for"):
        serving_pages([page]).transaction_logs(TX, OUSD)


def bridge_body(**overrides) -> dict:
    return {
        "total_onchain_amount": "872221164.60664",
        "last_updated": "2026-11-03T01:00:00Z",
    } | overrides


def snapshot_from(body):
    return bridge_snapshot(
        http_with(lambda request: httpx.Response(200, json=body)), "http://b.invalid"
    )


@pytest.mark.parametrize(
    "stamp",
    [
        "2026-11-03T01:00:00Z",
        "2026-11-03T03:00:00+02:00",
        "2026-11-02T20:00:00-05:00",
        "2026-11-03T01:00:00.789Z",
    ],
)
def test_bridge_snapshot_parses_the_time_and_total(stamp):
    snapshot = snapshot_from(bridge_body(last_updated=stamp))

    assert snapshot.total == 872_221_164_606_640
    assert snapshot.last_updated == 1_793_667_600


def test_bridge_snapshot_total_stays_exact():
    snapshot = snapshot_from(bridge_body(total_onchain_amount="0.000001"))

    assert snapshot.total == 1


@pytest.mark.parametrize(
    "body",
    [
        {"total_onchain_amount": "1.5"},
        bridge_body(last_updated=1_793_667_600),
        bridge_body(last_updated="yesterday"),
        bridge_body(last_updated="2026-11-03T01:00:00"),
        bridge_body(last_updated="2026-11-03"),
        bridge_body(last_updated="2026-11-03T01:00:60Z"),
        bridge_body(last_updated="2026-11-03t01:00:00z"),
        bridge_body(total_onchain_amount=872221164.60664),
        {"last_updated": "2026-11-03T01:00:00Z"},
        ["not", "an", "object"],
        *(
            bridge_body(total_onchain_amount=total)
            for total in ("abc", "NaN", "Infinity", "-1", "1E+999999999", " 1", "1\n", "1.1234567")
        ),
    ],
)
def test_bridge_snapshot_malformed_input_raises_value_error(body):
    with pytest.raises(ValueError):
        snapshot_from(body)


def test_bridge_total_refuses_what_the_snapshot_refuses():
    for total in ("NaN", "1E+9", "-1"):
        with pytest.raises(ValueError):
            bridge_total_base_units(
                http_with(lambda r, t=total: httpx.Response(200, json={"total_onchain_amount": t})),
                "http://b.invalid",
            )


def test_fake_rpc_balances_agree_with_its_own_transfers():
    rpc = FakeRpc(tip=10)
    rpc.add_transfer(3, 100)
    rpc.add_transfer(4, 40, sender=ALICE, to=BOB)
    rpc.add_transfer(6, 10, sender=BOB, to=ALICE)

    assert rpc.balance_of(TOKEN, ALICE, 3) == 100
    assert rpc.balance_of(TOKEN, ALICE, 5) == 60
    assert rpc.balance_of(TOKEN, ALICE, rpc.hashes[6]) == 70
    assert rpc.balance_of(TOKEN, BOB, 10) == 30
    assert rpc.total_supply(TOKEN, 10) == 100
    assert rpc.balance_of(TOKEN, ZERO_ADDRESS, 10) == 0
    assert rpc.balance_of(TOKEN, ALICE, 10) + rpc.balance_of(TOKEN, BOB, 10) == 100
    assert rpc.block_timestamp(6) == rpc.logs[6][0].block_timestamp
    proof = rpc.transaction_receipt(rpc.logs[4][0].tx_hash, TOKEN)
    assert proof is not None
    assert proof.block_number == 4
    assert proof.transfers == [ProofTransfer(0, ALICE, BOB, 40)]
    assert rpc.transaction_receipt("0x" + "9" * 64, TOKEN) is None
    with pytest.raises(RpcError):
        rpc.block_timestamp(99)


def test_transaction_logs_with_no_logs_raises():
    with pytest.raises(ValueError, match="no logs"):
        serving_pages([{"items": [], "next_page_params": None}]).transaction_logs(TX, OUSD)


def test_transaction_logs_naming_two_blocks_raises():
    page = blockscout_logs()
    page["items"][1]["block_number"] += 1

    with pytest.raises(ValueError, match="name blocks"):
        serving_pages([page]).transaction_logs(TX, OUSD)
