"""Base: its chain entry, the log filter, and how its provider's replies are handled.

Nothing here opens a connection. Provider replies reproduce the text the provider returned when
measured, see docs/plans/2026-11-03-003-base-source-plan.md.
"""

import dataclasses
import hashlib
import json
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest
from conftest import ALICE, BOB, FakeRpc, rows
from ousd import cli
from ousd.chains import KEYED_RPC_ENV, REQUIRED_CHAINS, Chain, load_chains
from ousd.decode import TRANSFER_TOPIC, ZERO_ADDRESS, Transfer, decode_rpc_log
from ousd.http import HttpError, PoliteClient
from ousd.ingest import sync_chain
from ousd.reconcile import reconcile_chain
from ousd.sources import RpcClient, RpcError

TOKEN = "0xb2000000000000000000002feb517dfec7415344"
FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "base_rpc_log.json").read_text())
OTHER_TOKEN = "0x" + "d" * 40
MISSING_KEY = "set BASE_RPC_URL in .env"


def base() -> Chain:
    return load_chains({"BASE_RPC_URL": "http://base-rpc.invalid"})["base"]


def http_with(handler) -> PoliteClient:
    return PoliteClient(
        min_interval=0, transport=httpx.MockTransport(handler), sleep=lambda _: None
    )


# --- Config ---


def test_the_base_entry_has_the_measured_settings():
    chain = load_chains({"BASE_RPC_URL": "http://base-rpc.invalid"})["base"]

    assert chain.token == TOKEN
    assert chain.chain_id == 8453
    assert chain.start_block == 48_631_941
    assert chain.max_log_range == 10_000
    assert chain.reorg_lookback == 1_200
    assert chain.blockscout_url is None


@pytest.mark.parametrize("value", [None, "", "   "])
def test_an_unset_or_blank_key_loads_without_error(value):
    env = {} if value is None else {"BASE_RPC_URL": value}

    assert load_chains(env)["base"].rpc_url == ""


def test_a_key_with_surrounding_whitespace_is_stripped():
    chain = load_chains({"BASE_RPC_URL": "  http://base-rpc.invalid/v2  \n"})["base"]

    assert chain.rpc_url == "http://base-rpc.invalid/v2"


def test_base_is_covered_by_the_missing_key_check():
    assert "base" in REQUIRED_CHAINS
    assert KEYED_RPC_ENV["base"] == "BASE_RPC_URL"


@pytest.mark.parametrize("value", [None, ""])
def test_sync_without_a_key_exits_2_naming_it_and_creates_no_database(
    value, monkeypatch, tmp_path, capsys
):
    database = tmp_path / "ousd.duckdb"
    monkeypatch.setenv("OUSD_DB_PATH", str(database))
    monkeypatch.delenv("BASE_RPC_URL", raising=False)
    if value is not None:
        monkeypatch.setenv("BASE_RPC_URL", value)

    with pytest.raises(SystemExit) as stopped:
        cli.main(["--chain", "base", "sync"])

    assert stopped.value.code == 2
    assert MISSING_KEY in capsys.readouterr().err
    assert not database.exists()


# --- Filter and decode ---


def test_the_first_transfer_decodes_to_the_first_mint():
    transfer = decode_rpc_log(FIXTURE, TOKEN)

    assert transfer.block_number == 50_497_983
    assert transfer.value == 1_000_000
    assert transfer.from_address == ZERO_ADDRESS
    assert transfer.to_address == "0x4c2c0f0bb2631b02ac9299c59690914ee7a200b8"
    assert transfer.block_hash == FIXTURE["blockHash"]
    assert transfer.block_timestamp == 1_787_785_313
    assert transfer.tx_hash == FIXTURE["transactionHash"]
    assert transfer.log_index == 11


def test_a_log_from_another_contract_is_refused():
    # The ticker OUSD also belongs to Origin Dollar.
    other = {**FIXTURE, "address": OTHER_TOKEN}

    with pytest.raises(ValueError, match="not " + TOKEN):
        decode_rpc_log(other, TOKEN)


def block_hash(number: int) -> str:
    return "0x" + hashlib.sha256(f"base:{number}".encode()).hexdigest()


def log_at(block: int) -> dict:
    return {
        **FIXTURE,
        "blockNumber": hex(block),
        "blockHash": block_hash(block),
        "logIndex": "0x0",
    }


class BaseNode:
    """A JSON-RPC handler for a Base-shaped node: linked blocks and a capped eth_getLogs."""

    def __init__(self, tip: int, mint_blocks: tuple[int, ...] = (), finality_lag: int = 725):
        self.tip = tip
        self.finality_lag = finality_lag
        self.mint_blocks = mint_blocks
        self.log_queries: list[dict] = []
        # Set by a test to make eth_getLogs fail for the ranges it matches.
        self.fail_logs: Callable[[dict], httpx.Response | None] | None = None

    def block(self, number: int) -> dict:
        return {
            "number": hex(number),
            "hash": block_hash(number),
            "parentHash": block_hash(number - 1),
        }

    def __call__(self, request: httpx.Request) -> httpx.Response:
        call = json.loads(request.content)
        method, params = call["method"], call["params"]
        result: object
        if method == "eth_chainId":
            result = hex(8453)
        elif method == "eth_blockNumber":
            result = hex(self.tip)
        elif method == "eth_getBlockByNumber":
            number = (
                self.tip - self.finality_lag if params[0] == "finalized" else int(params[0], 16)
            )
            result = self.block(number) if number <= self.tip else None
        elif method == "eth_getLogs":
            query = params[0]
            self.log_queries.append(query)
            if self.fail_logs is not None:
                failure = self.fail_logs(query)
                if failure is not None:
                    return failure
            low, high = int(query["fromBlock"], 16), int(query["toBlock"], 16)
            result = [log_at(n) for n in self.mint_blocks if low <= n <= high]
        else:
            raise AssertionError(f"unexpected call {method}")
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": result})

    def ranges(self) -> list[tuple[int, int]]:
        return [(int(q["fromBlock"], 16), int(q["toBlock"], 16)) for q in self.log_queries]


def rpc_for(node: BaseNode) -> RpcClient:
    return RpcClient(http_with(node), "http://base-rpc.invalid")


def test_sync_asks_for_the_lowercase_address_and_topic_in_spans_that_cover_every_block(store):
    chain = dataclasses.replace(base(), start_block=1)
    node = BaseNode(tip=25_000)

    sync_chain(chain, rpc_for(node), store)

    assert node.log_queries
    for query in node.log_queries:
        assert query["address"] == TOKEN
        assert query["topics"] == [TRANSFER_TOPIC]
        assert query["fromBlock"] == hex(int(query["fromBlock"], 16))
        assert query["toBlock"] == hex(int(query["toBlock"], 16))
    ranges = node.ranges()
    assert len(ranges) == 3
    assert all(high - low + 1 <= 10_000 for low, high in ranges)
    # Each block is asked for once: every range starts where the one before it ended.
    assert ranges[0][0] == 1
    assert ranges[-1][1] == 25_000
    assert all(ranges[i][1] + 1 == ranges[i + 1][0] for i in range(len(ranges) - 1))


# --- Provider responses ---


def error_reply(message: str, code: int = -32602) -> httpx.Response:
    return httpx.Response(200, json={"id": 1, "error": {"code": code, "message": message}})


def test_a_range_over_the_result_cap_is_split_and_every_log_comes_back_once_in_order():
    def handler(request):
        query = json.loads(request.content)["params"][0]
        wanted = range(int(query["fromBlock"], 16), int(query["toBlock"], 16) + 1)
        if len(wanted) > 3:
            return error_reply(
                "query exceeds max results 20000, retry with the range 53284845-53285190"
            )
        return httpx.Response(200, json={"id": 1, "result": [log_at(n) for n in wanted]})

    transfers = RpcClient(http_with(handler), "http://base-rpc.invalid").transfers(TOKEN, 1, 8)

    assert [t.block_number for t in transfers] == list(range(1, 9))


def test_a_span_the_provider_refuses_is_an_error_after_one_request_and_is_not_split():
    requests = []

    def handler(request):
        requests.append(request)
        return error_reply("exceed maximum block range: 50000")

    rpc = RpcClient(http_with(handler), "http://base-rpc.invalid")

    with pytest.raises(RpcError, match="exceed maximum block range"):
        rpc.transfers(TOKEN, 1, 50_000)

    assert len(requests) == 1


def test_a_range_past_the_head_stops_the_run_and_a_rerun_completes_without_duplicates(store):
    chain = dataclasses.replace(base(), start_block=1)
    node = BaseNode(tip=25_000, mint_blocks=(5, 15_000, 24_000))

    def past_the_head(query):
        if int(query["toBlock"], 16) > 24_990:
            return error_reply(
                "block range extends beyond current head block: requested 25000, head 24990"
            )
        return None

    node.fail_logs = past_the_head
    with pytest.raises(RpcError, match="beyond current head block"):
        sync_chain(chain, rpc_for(node), store)

    assert [row[0] for row in rows(store, "base")] == [5, 15_000]
    assert store.synced_through("base") == 20_000

    node.fail_logs = None
    sync_chain(chain, rpc_for(node), store)

    assert [row[0] for row in rows(store, "base")] == [5, 15_000, 24_000]
    assert store.synced_through("base") == 25_000


def test_a_node_error_behind_a_500_is_retried_until_it_succeeds(store):
    chain = dataclasses.replace(base(), start_block=1)
    node = BaseNode(tip=5_000, mint_blocks=(7,))
    failures = iter(range(3))

    def flaky(query):
        if next(failures, None) is not None:
            return httpx.Response(
                500,
                json=json.loads(
                    '{"id": 1, "error": {"code": -32701, "message": "broker: node error"}}'
                ),
            )
        return None

    node.fail_logs = flaky

    sync_chain(chain, rpc_for(node), store)

    assert [row[0] for row in rows(store, "base")] == [7]
    assert store.synced_through("base") == 5_000


def test_a_node_error_that_never_clears_leaves_the_cursor_and_a_rerun_resumes(store):
    chain = dataclasses.replace(base(), start_block=1)
    node = BaseNode(tip=25_000, mint_blocks=(5, 12_000))

    def down_after_the_first_range(query):
        if int(query["fromBlock"], 16) > 1:
            return httpx.Response(
                500, json={"id": 1, "error": {"code": -32701, "message": "broker: node error"}}
            )
        return None

    node.fail_logs = down_after_the_first_range
    with pytest.raises(HttpError, match="gave up"):
        sync_chain(chain, rpc_for(node), store)

    assert store.synced_through("base") == 10_000
    assert [row[0] for row in rows(store, "base")] == [5]

    node.fail_logs = None
    sync_chain(chain, rpc_for(node), store)

    assert [row[0] for row in rows(store, "base")] == [5, 12_000]
    assert store.synced_through("base") == 25_000


# --- Reorg and idempotence, shaped like Base and simulated ---


def simulated(**overrides) -> Chain:
    # FakeRpc serves chain 1 and has hashes from block 0, so only these two are swapped.
    return dataclasses.replace(base(), chain_id=1, start_block=100, **overrides)


def test_hashes_cover_every_block_above_finalized(store):
    chain = simulated()
    rpc = FakeRpc(tip=3_000, finality_lag=725)

    sync_chain(chain, rpc, store)

    stored = set(store.block_hashes("base"))
    assert set(range(rpc.finalized() + 1, 3_001)) <= stored
    assert stored == set(range(3_000 - 1_200 + 1, 3_001))


def test_finality_moving_backward_between_runs_changes_nothing(store):
    chain = simulated()
    rpc = FakeRpc(tip=3_000)
    rpc.add_transfer(500, 4)
    rpc.add_transfer(2_900, 6)
    rpc.finality_lag = 725
    first = sync_chain(chain, rpc, store)
    settled = rows(store, "base")

    for lag in (505, 725):
        rpc.finality_lag = lag
        result = sync_chain(chain, rpc, store)
        assert result.reorg_fork_block is None
        assert rows(store, "base") == settled

    assert first.reorg_fork_block is None
    assert store.synced_through("base") == 3_000


def test_stalled_finality_keeps_hashes_down_to_finalized_plus_one(store):
    chain = simulated()
    rpc = FakeRpc(tip=3_000, finality_lag=2_000)

    sync_chain(chain, rpc, store)

    stored = store.block_hashes("base")
    assert min(stored) == rpc.finalized() + 1
    assert max(stored) == 3_000


def test_a_reorg_700_blocks_down_is_rolled_back_and_reconciles(store):
    chain = simulated()
    rpc = FakeRpc(tip=3_000, finality_lag=725)
    rpc.add_transfer(500, 40)
    rpc.add_transfer(2_300, 5, to=BOB)
    sync_chain(chain, rpc, store)
    assert reconcile_chain(chain, rpc, store).matched

    # The mint at block 2,300 is replaced on a competing fork by a different one.
    rpc.reorg(from_block=2_300)
    rpc.add_transfer(2_300, 9, to=ALICE)
    result = sync_chain(chain, rpc, store)

    assert result.reorg_fork_block == 2_299
    assert [(row[0], row[5]) for row in rows(store, "base")] == [(500, 40), (2_300, 9)]
    outcome = reconcile_chain(chain, rpc, store)
    assert outcome.matched
    assert outcome.onchain_supply == 49


def test_a_rerun_after_a_complete_sync_changes_nothing(store):
    chain = simulated()
    rpc = FakeRpc(tip=3_000)
    rpc.add_transfer(150, 3)
    rpc.add_transfer(2_950, 8)
    sync_chain(chain, rpc, store)
    before, cursor = rows(store, "base"), store.synced_through("base")

    sync_chain(chain, rpc, store)

    assert rows(store, "base") == before
    assert store.synced_through("base") == cursor


class RecordingRpc(FakeRpc):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.asked: list[tuple[int, int]] = []

    def transfers(self, token, from_block, to_block):
        self.asked.append((from_block, to_block))
        return super().transfers(token, from_block, to_block)


def test_rolling_back_to_before_the_start_block_removes_only_base(store):
    chain = simulated()
    rpc = RecordingRpc(tip=3_000)
    rpc.add_transfer(150, 3)
    rpc.add_transfer(2_950, 8)
    sync_chain(chain, rpc, store)
    elsewhere = Transfer(7, "0x" + "7" * 64, 1_007, "0x" + "e" * 64, 0, ZERO_ADDRESS, ALICE, 11)
    store.write_range("other", [elsewhere], {7: "0x" + "7" * 64}, 7)

    store.rollback_to("base", chain.start_block - 1)

    assert rows(store, "base") == []
    assert store.block_hashes("base") == {}
    assert len(rows(store, "other")) == 1
    assert store.block_hashes("other") == {7: "0x" + "7" * 64}
    assert store.synced_through("other") == 7

    rpc.asked.clear()
    sync_chain(chain, rpc, store)

    assert rpc.asked[0][0] == chain.start_block
    assert [row[0] for row in rows(store, "base")] == [150, 2_950]
