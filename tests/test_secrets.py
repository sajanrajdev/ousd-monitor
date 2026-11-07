"""A keyed RPC URL, or the key alone, must never reach a log line, an exception or a repr."""

import json
import logging
import subprocess
import sys
import traceback

import httpx
import pytest
from conftest import make_chain
from ousd import cli, probes
from ousd.chains import Chain, missing_rpc_keys
from ousd.decode import TRANSFER_TOPIC
from ousd.http import HttpError, PoliteClient
from ousd.solana import SolanaChain, SolanaDataError, SolanaRpc, SolanaRpcError
from ousd.sources import BlockscoutClient, RpcClient, RpcError

KEY = "k3y9aZ7QwErTyUiOpAsDfGhJkLzXcVbNm1234567890abcdefghijklmnopqr"
# Where sources.py cuts a provider's reply in an error.
DETAIL_LIMIT = 2000
URLS = [
    f"http://base-rpc.provider.invalid/v2/{KEY}",
    f"http://rpc.provider.invalid/v2?apikey={KEY}",
    f"http://user:{KEY}@rpc.provider.invalid/v2",
    f"http://rpc.provider.invalid/v2?{KEY}",
]
PARAMS = [
    pytest.param(url, id=kind)
    for url, kind in zip(URLS, ["path", "query", "password", "bare-query"], strict=True)
]


def make_client(handler, label: str = "rpc", sleeps: list[float] | None = None) -> PoliteClient:
    recorder = sleeps if sleeps is not None else []
    return PoliteClient(
        label=label,
        min_interval=0,
        transport=httpx.MockTransport(handler),
        sleep=recorder.append,
    )


def chain_of(exc: BaseException | None):
    while exc is not None:
        yield exc
        yield from chain_of(exc.__cause__)
        exc = exc.__context__


def assert_clean(exc: BaseException, caplog, *secrets: str) -> None:
    """The secret appears nowhere an operator could read it, in the error or its causes."""
    secrets = secrets or (KEY,)
    for link in chain_of(exc):
        assert not hasattr(link, "request"), f"{type(link).__name__} carries a request"
        seen = [
            str(link),
            repr(link),
            repr(link.args),
            "".join(traceback.format_exception(link)),
        ]
        for text in seen:
            for secret in secrets:
                assert secret not in text
    for secret in secrets:
        assert secret not in caplog.text


def shown(secret: str) -> list[str]:
    """Every prefix of the secret that is long enough to be worth hiding."""
    return [secret[:n] for n in range(8, len(secret) + 1)]


@pytest.fixture(autouse=True)
def debug_logging(caplog):
    caplog.set_level(logging.DEBUG)


@pytest.mark.parametrize("url", PARAMS)
def test_exhausted_retries_name_the_label_and_stay_clean(url, caplog):
    client = make_client(lambda request: httpx.Response(500, text=f"bad {url}"))

    with pytest.raises(HttpError) as raised:
        client.request_json("POST", url, json={})

    assert "rpc" in str(raised.value)
    assert_clean(raised.value, caplog)


@pytest.mark.parametrize("url", PARAMS)
def test_a_4xx_body_with_the_bare_key_is_scrubbed_but_keeps_its_meaning(url, caplog):
    client = make_client(lambda request: httpx.Response(403, text=f"archive access denied {KEY}"))

    with pytest.raises(HttpError) as raised:
        client.request_json("POST", url, json={})

    assert "archive" in str(raised.value)
    assert_clean(raised.value, caplog)


@pytest.mark.parametrize("url", PARAMS)
@pytest.mark.parametrize("echo", ["key", "url"])
def test_a_key_across_byte_200_leaves_no_usable_prefix(url, echo, caplog):
    secret = KEY if echo == "key" else url
    body = "x" * (200 - 20) + secret
    client = make_client(lambda request: httpx.Response(403, text=body))

    with pytest.raises(HttpError) as raised:
        client.request_json("POST", url, json={})

    assert not any(prefix in str(raised.value) for prefix in shown(KEY))
    assert_clean(raised.value, caplog)


@pytest.mark.parametrize("url", PARAMS)
@pytest.mark.parametrize("echo", ["url", "key"])
def test_a_json_rpc_error_on_http_200_is_scrubbed(url, echo, caplog):
    message = url if echo == "url" else KEY
    error = {"code": -32000, "message": f"unauthorized {message}"}
    client = make_client(lambda request: httpx.Response(200, json={"id": 1, "error": error}))

    with pytest.raises(RpcError) as raised:
        RpcClient(client, url).tip()

    assert "eth_blockNumber" in str(raised.value)
    assert_clean(raised.value, caplog)


@pytest.mark.parametrize("url", PARAMS)
def test_a_transport_error_quoting_the_key_is_clean_after_retries(url, caplog):
    def handler(request):
        raise httpx.ConnectError(f"cannot reach {KEY}", request=request)

    client = make_client(handler)

    with pytest.raises(HttpError) as raised:
        client.request_json("POST", url, json={})

    assert_clean(raised.value, caplog)


@pytest.mark.parametrize("url", PARAMS)
def test_a_response_that_is_not_json_is_clean_after_retries(url, caplog):
    client = make_client(lambda request: httpx.Response(200, text=f"<html>{url} {KEY}</html>"))

    with pytest.raises(HttpError) as raised:
        client.request_json("POST", url, json={})

    assert_clean(raised.value, caplog)


@pytest.mark.parametrize("url", PARAMS)
def test_a_body_that_claims_gzip_but_is_not_is_clean(url, caplog):
    client = make_client(
        lambda request: httpx.Response(200, headers={"content-encoding": "gzip"}, content=b"nope")
    )

    with pytest.raises(HttpError) as raised:
        client.request_json("POST", url, json={})

    assert "gave up" in str(raised.value)
    assert_clean(raised.value, caplog)


@pytest.mark.parametrize("url", PARAMS)
def test_a_redirect_echoing_the_url_is_clean_and_not_followed(url, caplog):
    requested: list[str] = []

    def handler(request):
        requested.append(str(request.url))
        return httpx.Response(302, headers={"location": url + "/next"}, text=f"moved to {url}")

    client = make_client(handler)

    with pytest.raises(HttpError) as raised:
        client.request_json("POST", url, json={})

    assert len(set(requested)) == 1
    assert_clean(raised.value, caplog)


@pytest.mark.parametrize("url", PARAMS)
def test_a_blockscout_error_holding_the_key_is_clean(url, caplog):
    body = {"status": "0", "message": f"Query denied for {KEY}", "result": None}
    client = make_client(lambda request: httpx.Response(200, json=body))

    with pytest.raises(RuntimeError) as raised:
        list(BlockscoutClient(client, url).pages("0x" + "c" * 40, 1, 2))

    assert "Blockscout error" in str(raised.value)
    assert_clean(raised.value, caplog)


def test_a_non_numeric_port_fails_once_as_an_invalid_url(caplog):
    url = f"http://rpc.provider.invalid:{KEY}/v2/{KEY}"
    sleeps: list[float] = []
    client = make_client(lambda request: httpx.Response(200, json={}), sleeps=sleeps)

    with pytest.raises(HttpError) as raised:
        client.request_json("POST", url, json={})

    assert "invalid URL" in str(raised.value)
    assert "rpc" in str(raised.value)
    assert sleeps == []
    assert_clean(raised.value, caplog)


def test_importing_the_client_silences_httpx_request_logs():
    code = (
        "import logging\n"
        "logging.basicConfig(level=logging.DEBUG)\n"
        "import ousd.http\n"
        "for name in ('httpx', 'httpcore'):\n"
        "    assert logging.getLogger(name).getEffectiveLevel() >= logging.WARNING, name\n"
    )

    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)

    assert done.returncode == 0, done.stderr


@pytest.mark.parametrize("url", PARAMS)
def test_a_successful_request_logs_no_key(url, caplog):
    client = make_client(lambda request: httpx.Response(200, json={"result": "0x1"}))

    assert client.request_json("POST", url, json={}) == {"result": "0x1"}

    assert KEY not in caplog.text


def test_reprs_hide_the_keyed_url():
    url = URLS[0]
    chain = make_chain(rpc_url=url, blockscout_url=url)
    client = RpcClient(make_client(lambda request: httpx.Response(200)), url)

    assert KEY not in repr(chain)
    assert KEY not in repr(client)
    assert isinstance(chain, Chain)


def test_scrub_leaves_short_parts_and_unrelated_text_alone():
    client = make_client(lambda request: httpx.Response(200))
    url = "http://rpc.provider.invalid/v2/?network=base"

    assert client.scrub("GET /v2/ network=base fine", url) == "GET /v2/ network=base fine"
    assert client.scrub("nothing to hide", url) == "nothing to hide"
    assert client.scrub("text", "") == "text"


def test_scrub_does_not_rewrite_its_own_label():
    client = make_client(lambda request: httpx.Response(200), label="base-rpc")
    url = "http://base-rpc.provider.invalid/v2"

    assert client.scrub("down: base-rpc.provider.invalid", url) == "down: <base-rpc>"


def test_a_result_cap_error_on_a_keyed_url_still_splits():
    url = URLS[0]
    calls: list[tuple[str, str]] = []

    def handler(request):
        query = json.loads(request.content)["params"][0]
        calls.append((query["fromBlock"], query["toBlock"]))
        if query["fromBlock"] == "0x1" and query["toBlock"] == "0x4":
            error = {"code": -32000, "message": f"query exceeds max results 20000 at {url}"}
            return httpx.Response(200, json={"id": 1, "error": error})
        return httpx.Response(200, json={"id": 1, "result": []})

    RpcClient(make_client(handler), url).transfers("0x" + "c" * 40, 1, 4)

    assert calls == [("0x1", "0x4"), ("0x1", "0x2"), ("0x3", "0x4")]


TOKEN = "0x" + "c" * 40
TX = "0x" + "a" * 64
ADDRESS_TOPIC = "0x" + "0" * 24 + "1" * 40


def rpc_log(**change) -> dict:
    log = {
        "address": TOKEN,
        "topics": [TRANSFER_TOPIC, ADDRESS_TOPIC, ADDRESS_TOPIC],
        "data": "0x01",
        "blockNumber": "0x1",
        "blockHash": "0x" + "b" * 64,
        "blockTimestamp": "0x1",
        "transactionHash": TX,
        "logIndex": "0x0",
    }
    return log | change


def blockscout_log(**change) -> dict:
    log = {
        "address": TOKEN,
        "topics": [TRANSFER_TOPIC, ADDRESS_TOPIC, ADDRESS_TOPIC, None],
        "data": "0x01",
        "blockNumber": "0x1",
        "timeStamp": "0x1",
        "transactionHash": TX,
        "logIndex": "0x0",
    }
    return log | change


def v2_item(**change) -> dict:
    item = {
        "address": {"hash": TOKEN},
        "topics": [TRANSFER_TOPIC, ADDRESS_TOPIC, ADDRESS_TOPIC, None],
        "data": "0x01",
        "block_number": 1,
        "index": 0,
        "transaction_hash": TX,
    }
    return item | change


def receipt(**change) -> dict:
    log = {
        "address": TOKEN,
        "topics": [TRANSFER_TOPIC, ADDRESS_TOPIC, ADDRESS_TOPIC],
        "data": "0x01",
        "logIndex": "0x0",
    }
    return {"transactionHash": TX, "blockNumber": "0x1", "logs": [log]} | change


def rpc(url: str, result) -> RpcClient:
    handler = lambda request: httpx.Response(200, json={"id": 1, "result": result})  # noqa: E731
    return RpcClient(make_client(handler), url)


def blockscout(url: str, body) -> BlockscoutClient:
    return BlockscoutClient(make_client(lambda request: httpx.Response(200, json=body)), url)


def blockscout_rows(*rows) -> dict:
    return {"status": "1", "message": "OK", "result": list(rows)}


# Each read that parses a provider reply, fed a reply that makes the parser quote the key.
POISONED_READS = {
    "chain_id": lambda url: rpc(url, f"unauthorized {KEY}").chain_id(),
    "tip": lambda url: rpc(url, f"unauthorized {KEY}").tip(),
    "finalized": lambda url: rpc(url, {"number": f"zz {KEY}"}).finalized(),
    "block": lambda url: rpc(url, {"hash": 1, "parentHash": KEY}).block(1),
    "total_supply": lambda url: rpc(url, f"unauthorized {KEY}").total_supply(TOKEN, 1),
    "balance_of": lambda url: rpc(url, f"unauthorized {KEY}").balance_of(TOKEN, TOKEN, 1),
    "block_timestamp": lambda url: rpc(url, {"timestamp": f"zz {KEY}"}).block_timestamp(1),
    "receipt_data": lambda url: rpc(
        url, receipt(logs=[receipt()["logs"][0] | {"data": KEY}])
    ).transaction_receipt(TX, TOKEN),
    "receipt_hash": lambda url: rpc(url, receipt(transactionHash=KEY)).transaction_receipt(
        TX, TOKEN
    ),
    "receipt_not_a_dict": lambda url: rpc(url, f"unauthorized {KEY}").transaction_receipt(
        TX, TOKEN
    ),
    "rpc_log_data": lambda url: rpc(url, [rpc_log(data=KEY)]).transfers(TOKEN, 1, 1),
    "rpc_log_topics": lambda url: rpc(url, [rpc_log(topics=[KEY])]).transfers(TOKEN, 1, 1),
    "rpc_log_address": lambda url: rpc(url, [rpc_log(address=KEY)]).transfers(TOKEN, 1, 1),
    "rpc_log_stamp": lambda url: rpc(url, [rpc_log(blockTimestamp=KEY)]).transfers(TOKEN, 1, 1),
    "blockscout_log_data": lambda url: list(
        blockscout(url, blockscout_rows(blockscout_log(data=KEY))).pages(TOKEN, 1, 2)
    ),
    "blockscout_log_topics": lambda url: list(
        blockscout(url, blockscout_rows(blockscout_log(topics=[KEY]))).pages(TOKEN, 1, 2)
    ),
    "blockscout_log_stamp": lambda url: list(
        blockscout(url, blockscout_rows(blockscout_log(timeStamp=KEY))).pages(TOKEN, 1, 2)
    ),
    "blockscout_reply_not_a_dict": lambda url: list(
        blockscout(url, f"unauthorized {KEY}").pages(TOKEN, 1, 2)
    ),
    "v2_log_data": lambda url: blockscout(
        url, {"items": [v2_item(data=KEY)], "next_page_params": None}
    ).transaction_logs(TX, TOKEN),
    "v2_log_hash": lambda url: blockscout(
        url, {"items": [v2_item(transaction_hash=KEY)], "next_page_params": None}
    ).transaction_logs(TX, TOKEN),
    "v2_block_number": lambda url: blockscout(
        url, {"items": [v2_item(block_number=KEY)], "next_page_params": None}
    ).transaction_logs(TX, TOKEN),
}


@pytest.mark.parametrize("url", PARAMS)
@pytest.mark.parametrize("read", POISONED_READS)
def test_a_parse_failure_on_provider_data_never_shows_the_key(read, url, caplog):
    with pytest.raises(ValueError) as raised:
        POISONED_READS[read](url)

    assert "malformed" in str(raised.value)
    assert_clean(raised.value, caplog)


@pytest.mark.parametrize("url", PARAMS)
@pytest.mark.parametrize("field", ["block_number", "index"])
def test_an_overflowing_number_in_a_reply_is_a_clean_value_error(field, url, caplog):
    # json.loads reads 1e999 as infinity, and int() of that raises OverflowError.
    body = {"items": [v2_item(**{field: "HUGE"})], "next_page_params": None}
    raw = json.dumps(body).replace('"HUGE"', "1e999")
    client = make_client(lambda request: httpx.Response(200, content=raw))

    with pytest.raises(ValueError) as raised:
        BlockscoutClient(client, url).transaction_logs(TX, TOKEN)

    assert "malformed" in str(raised.value)
    assert_clean(raised.value, caplog)


def test_a_blockscout_page_that_reports_success_needs_no_message():
    body = {"status": "1", "result": []}

    assert list(blockscout(URLS[0], body).pages(TOKEN, 1, 2)) == [([], 2)]


def test_a_log_with_four_topics_keeps_its_hash_block_and_data_in_the_error():
    topics = [TRANSFER_TOPIC, ADDRESS_TOPIC, ADDRESS_TOPIC, ADDRESS_TOPIC]
    log = rpc_log(topics=topics, data="0xfeed", blockNumber="0x1234")

    with pytest.raises(ValueError) as raised:
        rpc(URLS[0], [log]).transfers(TOKEN, 1, 1)

    assert TX in str(raised.value)
    assert "0x1234" in str(raised.value)
    assert "0xfeed" in str(raised.value)


def test_a_long_blockscout_error_keeps_its_tail():
    body = {"status": "0", "message": "denied", "result": "x" * 600 + " retry later"}

    with pytest.raises(RuntimeError) as raised:
        list(blockscout(URLS[0], body).pages(TOKEN, 1, 2))

    assert "retry later" in str(raised.value)


def parse_failure_quoting(url: str, text: str) -> None:
    rpc(url, receipt(transactionHash=text)).transaction_receipt(TX, TOKEN)


def blockscout_error_quoting(url: str, text: str) -> None:
    body = {"status": "0", "message": text, "result": None}
    list(blockscout(url, body).pages(TOKEN, 1, 2))


CUT_ERRORS = [
    pytest.param(parse_failure_quoting, ValueError, id="parse"),
    pytest.param(blockscout_error_quoting, RuntimeError, id="blockscout"),
]


@pytest.mark.parametrize("url", PARAMS)
@pytest.mark.parametrize(("fail", "error"), CUT_ERRORS)
def test_a_key_across_the_detail_cut_leaves_no_usable_prefix(fail, error, url):
    # The step is shorter than the key, so one of these puts the key across the cut.
    for padding in range(DETAIL_LIMIT - 600, DETAIL_LIMIT, 40):
        with pytest.raises(error) as raised:
            fail(url, "z" * padding + KEY)

        assert not any(prefix in str(raised.value) for prefix in shown(KEY))


@pytest.mark.parametrize(("fail", "error"), CUT_ERRORS)
def test_a_provider_error_is_cut_at_the_detail_limit(fail, error):
    with pytest.raises(error) as raised:
        fail(URLS[0], "z" * (DETAIL_LIMIT * 2))

    assert len(str(raised.value)) == DETAIL_LIMIT


def test_a_bad_port_in_a_blockscout_url_is_clean_for_transaction_logs(caplog):
    url = f"http://rpc.provider.invalid:{KEY}/v2/{KEY}"

    with pytest.raises(ValueError) as raised:
        blockscout(url, {}).transaction_logs(TX, TOKEN)

    assert_clean(raised.value, caplog)


def test_a_parse_failure_leaves_the_failing_reads_other_details_visible():
    with pytest.raises(ValueError) as raised:
        rpc(URLS[0], {"timestamp": f"zz {KEY}"}).block_timestamp(7)

    assert "block 7" in str(raised.value)
    assert "zz" in str(raised.value)


def test_a_url_that_cannot_be_parsed_for_scrubbing_shows_no_provider_text(caplog):
    url = f"http://user:[{KEY}]@rpc.provider.invalid/v2"
    client = make_client(lambda request: httpx.Response(403, text=f"denied {KEY}"))

    with pytest.raises(HttpError) as raised:
        client.request_json("POST", url, json={})

    assert str(raised.value).startswith("rpc: HTTP 403: <rpc>")
    assert "denied" not in str(raised.value)
    assert_clean(raised.value, caplog)


def test_scrub_withholds_all_text_when_the_url_has_no_parts():
    client = make_client(lambda request: httpx.Response(200))

    result = client.scrub(f"echo {KEY}", f"http://user:[{KEY}]@rpc.provider.invalid/v2")

    assert result.startswith("<rpc>")
    assert KEY not in result


COMPOSITE = [
    pytest.param(f"http://rpc.provider.invalid/apikey={KEY}", id="path-assignment"),
    pytest.param(f"http://rpc.provider.invalid/{KEY}.json", id="path-extension"),
    pytest.param(f"http://rpc.provider.invalid/v2;apikey={KEY}", id="path-parameter"),
    pytest.param(f"http://rpc.provider.invalid/v2?a=1;apikey={KEY}", id="query-semicolon"),
    pytest.param(f"http://rpc.provider.invalid/v2#token={KEY}", id="fragment-assignment"),
    pytest.param(f"http://rpc.provider.invalid/v2/chain,{KEY}", id="path-comma"),
    pytest.param(f"http://rpc.provider.invalid/v2/token:{KEY}", id="path-colon"),
    pytest.param(f"http://rpc.provider.invalid/v2/tok|{KEY}", id="path-pipe"),
    pytest.param(f"http://rpc.provider.invalid/v2/tok%7C{KEY}", id="path-encoded-pipe"),
    pytest.param(f"http://rpc.provider.invalid/v2?auth=tok:{KEY}", id="query-colon"),
    pytest.param(f"http://rpc.provider.invalid/v2?auth=tok|{KEY}", id="query-pipe"),
    pytest.param(f"http://user:tok:{KEY}@rpc.provider.invalid/v2", id="password-colon"),
    pytest.param(f"http://user:tok|{KEY}@rpc.provider.invalid/v2", id="password-pipe"),
]


@pytest.mark.parametrize("url", COMPOSITE)
def test_a_key_inside_a_composite_part_is_scrubbed_from_a_bare_echo(url, caplog):
    client = make_client(lambda request: httpx.Response(403, text=f"denied {KEY}"))

    with pytest.raises(HttpError) as raised:
        client.request_json("POST", url, json={})

    assert "denied" in str(raised.value)
    assert_clean(raised.value, caplog)


def test_a_result_cap_error_splits_when_the_host_is_a_word_in_the_message():
    url = f"http://max:8545/v2/{KEY}"
    calls: list[tuple[str, str]] = []

    def handler(request):
        query = json.loads(request.content)["params"][0]
        calls.append((query["fromBlock"], query["toBlock"]))
        if query["fromBlock"] == "0x1" and query["toBlock"] == "0x4":
            error = {"code": -32000, "message": "query exceeds max results 20000"}
            return httpx.Response(200, json={"id": 1, "error": error})
        return httpx.Response(200, json={"id": 1, "result": []})

    RpcClient(make_client(handler), url).transfers(TOKEN, 1, 4)

    assert calls == [("0x1", "0x4"), ("0x1", "0x2"), ("0x3", "0x4")]


def test_a_result_cap_error_that_cannot_split_still_hides_the_url():
    url = f"http://max:8545/v2/{KEY}"
    error = {"code": -32000, "message": f"query exceeds max results at {url}"}
    handler = lambda request: httpx.Response(200, json={"id": 1, "error": error})  # noqa: E731

    with pytest.raises(RpcError) as raised:
        RpcClient(make_client(handler), url).transfers(TOKEN, 1, 1)

    assert KEY not in str(raised.value)


def scrubbed(url: str, echo: str) -> str:
    return make_client(lambda request: httpx.Response(200)).scrub(f"seen {echo} here", url)


def test_scrub_ignores_letter_case():
    url = "http://AbCdEfGh12.provider.invalid/v2/Zy9XwVuT8sRq"

    assert "zy9xwvut8srq" not in scrubbed(url, "zy9xwvut8srq")
    assert "ABCDEFGH12" not in scrubbed(url, "ABCDEFGH12")


def test_scrub_hides_a_percent_decoded_form_of_a_part():
    assert "abcd+efghijkl" not in scrubbed(
        "http://rpc.provider.invalid/v2/abcd%2Befghijkl", "abcd+efghijkl"
    )


def test_scrub_hides_a_percent_encoded_form_of_a_part():
    url = "http://rpc.provider.invalid/v2?k=abcd+efghijkl"

    assert "abcd%20efghijkl" not in scrubbed(url, "abcd%20efghijkl")


def test_scrub_hides_a_form_encoded_form_of_a_part():
    assert "abcd+efghijkl" not in scrubbed(
        "http://rpc.provider.invalid/v2?k=abcd%20efghijkl", "abcd+efghijkl"
    )


def test_scrub_hides_a_bare_fragment():
    assert "Fr4gm3ntKey" not in scrubbed(
        "http://rpc.provider.invalid/v2#Fr4gm3ntKey", "Fr4gm3ntKey"
    )


def test_scrub_hides_a_bare_host_label():
    assert "hostkey-abc" not in scrubbed("http://hostkey-abc.provider.invalid/v2", "hostkey-abc")


def test_scrub_hides_a_part_of_exactly_eight_characters_and_not_seven():
    url = "http://rpc.provider.invalid/v2/Ab3dEf7h/Ab3dEf7"

    assert "Ab3dEf7h" not in scrubbed(url, "Ab3dEf7h")
    assert "Ab3dEf7" in scrubbed(url, "Ab3dEf7")


@pytest.mark.parametrize("separator", [":", "|"])
def test_a_colon_or_pipe_piece_keeps_the_eight_character_floor(separator):
    url = f"http://rpc.provider.invalid/v2/token{separator}Ab3dEf7h/token{separator}Ab3dEf7"

    assert "Ab3dEf7h" not in scrubbed(url, "Ab3dEf7h")
    assert "Ab3dEf7" in scrubbed(url, "Ab3dEf7")
    assert "token" in scrubbed(url, "token")


@pytest.mark.parametrize(
    ("url", "whole", "piece"),
    [
        pytest.param(
            "http://base-ethereum.provider.invalid/v2",
            "base-ethereum",
            "ethereum",
            id="hyphenated-host",
        ),
        pytest.param(
            "http://rpc.provider.invalid/v2/123e4567-e89b-12d3-a456-426614174000",
            "123e4567-e89b-12d3-a456-426614174000",
            "426614174000",
            id="uuid-key",
        ),
        # The recorded limit: a bare key echoed from "tok_KEY" or "key-KEY" survives.
        pytest.param(
            "http://rpc.provider.invalid/v2/tok_Ab3dEf7hIj",
            "tok_Ab3dEf7hIj",
            "Ab3dEf7hIj",
            id="underscore-limit",
        ),
    ],
)
def test_scrub_hides_hyphen_and_underscore_parts_whole_but_does_not_split_them(url, whole, piece):
    assert whole not in scrubbed(url, whole)
    assert piece in scrubbed(url, piece)


def test_a_failing_sync_through_the_cli_never_shows_the_key(monkeypatch, tmp_path, capsys, caplog):
    monkeypatch.setenv("TEMPO_RPC_URL", URLS[0])
    monkeypatch.setenv("OUSD_DB_PATH", str(tmp_path / "ousd.duckdb"))
    # A client error is not retried, and its body goes into the error text, so the echoed URL has
    # to be scrubbed for the key to stay out.
    transport = httpx.MockTransport(lambda request: httpx.Response(403, text=f"denied {URLS[0]}"))

    def polite(**kwargs):
        return PoliteClient(transport=transport, sleep=lambda _: None, **kwargs)

    # Sync clients are built in probes; cli.PoliteClient is only the Bridge client.
    monkeypatch.setattr(probes, "PoliteClient", polite)

    with pytest.raises(HttpError) as raised:
        cli.main(["--chain", "tempo", "sync"])

    assert_clean(raised.value, caplog)
    captured = capsys.readouterr()
    assert KEY not in captured.out + captured.err


@pytest.mark.parametrize("value", [None, "", "   "])
def test_missing_rpc_keys_lists_an_unset_or_blank_variable(value):
    env = {} if value is None else {"BASE_RPC_URL": value}

    assert missing_rpc_keys(["base"], env) == ["BASE_RPC_URL"]
    assert missing_rpc_keys(["base"], {"BASE_RPC_URL": "http://x.invalid"}) == []
    assert missing_rpc_keys(["tempo", "ethereum"], env) == []
    assert missing_rpc_keys(["solana", "base"], {}) == ["SOLANA_RPC_URL", "BASE_RPC_URL"]


@pytest.mark.parametrize("value", [None, ""])
@pytest.mark.parametrize(
    "argv",
    [["--chain", "base", "sync"], ["--chain", "base", "reconcile"], ["sync"], ["reconcile"]],
)
def test_a_chain_without_its_key_stops_before_the_database_is_created(
    argv, value, monkeypatch, tmp_path, capsys
):
    database = tmp_path / "ousd.duckdb"
    monkeypatch.setenv("OUSD_DB_PATH", str(database))
    if value is None:
        monkeypatch.delenv("BASE_RPC_URL", raising=False)
    else:
        monkeypatch.setenv("BASE_RPC_URL", value)
    monkeypatch.setattr(cli, "load_chains", lambda: {"base": make_chain(name="base")})

    with pytest.raises(SystemExit) as stopped:
        cli.main(argv)

    assert stopped.value.code == 2
    assert "BASE_RPC_URL" in capsys.readouterr().err
    assert not database.exists()


def test_other_chains_still_run_without_a_base_key(monkeypatch, tmp_path):
    monkeypatch.setenv("OUSD_DB_PATH", str(tmp_path / "ousd.duckdb"))
    monkeypatch.delenv("BASE_RPC_URL", raising=False)
    synced: list[str] = []
    monkeypatch.setattr(cli, "_sync", lambda chains, store: synced.extend(c.name for c in chains))

    cli.main(["--chain", "tempo", "sync"])

    assert synced == ["tempo"]


def test_at_block_with_two_chains_still_reports_exactly_one_chain(monkeypatch, capsys):
    monkeypatch.delenv("BASE_RPC_URL", raising=False)

    with pytest.raises(SystemExit):
        cli.main(["reconcile", "--at-block", "5"])

    assert "exactly one --chain" in capsys.readouterr().err


# Solana: the key sits in a path segment or in a query value, as the providers put it.


def solana_rpc(url: str, handler) -> SolanaRpc:
    return SolanaRpc(make_client(handler, label="solana"), url, sleep=lambda _: None)


@pytest.mark.parametrize("url", PARAMS)
def test_a_solana_401_echoing_the_url_is_clean(url, caplog):
    rpc = solana_rpc(url, lambda request: httpx.Response(401, text=f"denied {url} {KEY}"))

    with pytest.raises(HttpError) as raised:
        rpc.finalized_slot()

    assert "denied" in str(raised.value)
    assert_clean(raised.value, caplog)


@pytest.mark.parametrize("url", PARAMS)
@pytest.mark.parametrize("echo", ["url", "key"])
def test_a_solana_json_rpc_error_on_http_200_is_clean(url, echo, caplog):
    message = url if echo == "url" else KEY
    error = {"code": -32005, "message": f"unauthorized {message}"}
    rpc = solana_rpc(url, lambda request: httpx.Response(200, json={"id": 1, "error": error}))

    with pytest.raises(SolanaRpcError) as raised:
        rpc.transaction("sig")

    assert raised.value.code == -32005
    assert "getTransaction" in str(raised.value)
    assert_clean(raised.value, caplog)


@pytest.mark.parametrize("url", PARAMS)
def test_a_solana_error_is_cut_at_200_characters_after_scrubbing(url, caplog):
    error = {"code": -32005, "message": "x" * 180 + KEY}
    rpc = solana_rpc(url, lambda request: httpx.Response(200, json={"id": 1, "error": error}))

    with pytest.raises(SolanaRpcError) as raised:
        rpc.finalized_slot()

    assert len(str(raised.value)) <= 200
    assert not any(prefix in str(raised.value) for prefix in shown(KEY))
    assert_clean(raised.value, caplog)


@pytest.mark.parametrize("url", PARAMS)
def test_a_solana_error_message_drops_control_characters(url):
    error = {"code": -32005, "message": "line one\nline\x1b[31m two"}
    rpc = solana_rpc(url, lambda request: httpx.Response(200, json={"id": 1, "error": error}))

    with pytest.raises(SolanaRpcError) as raised:
        rpc.finalized_slot()

    assert "\n" not in str(raised.value)
    assert "\x1b" not in str(raised.value)


@pytest.mark.parametrize("url", PARAMS)
@pytest.mark.parametrize("echo", ["url", "key"])
def test_a_solana_parse_failure_quoting_the_key_is_clean(url, echo, caplog):
    poisoned = url if echo == "url" else KEY
    rpc = solana_rpc(url, lambda request: httpx.Response(200, json={"id": 1, "result": poisoned}))

    with pytest.raises(SolanaDataError) as raised:
        rpc.finalized_slot()

    assert "getSlot" in str(raised.value)
    assert_clean(raised.value, caplog)


@pytest.mark.parametrize("url", PARAMS)
def test_a_solana_reply_missing_its_result_is_clean(url, caplog):
    rpc = solana_rpc(url, lambda request: httpx.Response(200, json={"id": 1, "note": KEY}))

    with pytest.raises(SolanaDataError) as raised:
        rpc.genesis_hash()

    assert_clean(raised.value, caplog)


@pytest.mark.parametrize("url", PARAMS)
def test_the_solana_chain_and_client_reprs_hide_the_keyed_url(url):
    chain = SolanaChain("solana", "mint", url)
    rpc = solana_rpc(url, lambda request: httpx.Response(200))

    assert KEY not in repr(chain)
    assert KEY not in repr(rpc)
