"""A keyed RPC URL, or the key alone, must never reach a log line, an exception or a repr. Nor
may the object storage credentials backups use."""

import json
import logging
import re
import subprocess
import sys
import traceback
from pathlib import Path

import httpx
import pytest
from botocore.stub import Stubber
from conftest import make_chain
from ousd import backup, checks, cli, probes
from ousd.backup import BackupError
from ousd.chains import Chain, missing_rpc_keys
from ousd.decode import TRANSFER_TOPIC
from ousd.http import (
    SECRET_URL_VARIABLES,
    HttpError,
    PoliteClient,
    scrub_secrets,
    scrubbed_traceback,
)
from ousd.solana import SolanaChain, SolanaDataError, SolanaRpc, SolanaRpcError
from ousd.sources import BlockscoutClient, RpcClient, RpcError
from test_backup import refuse_every_request

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


# Object storage credentials for backups. The secret key is KEY; the access key ID is treated
# as a secret too.

ACCESS_KEY_ID = "SCWQ7ZK3M9P2X4B8N6V1"
BACKUP_ENV = {
    "OUSD_BACKUP_URL": "s3://ousd-backups/raw",
    "OUSD_BACKUP_ENDPOINT_URL": "https://s3.fr-par.scw.cloud",
    "OUSD_BACKUP_REGION": "fr-par",
    "OUSD_BACKUP_ACCESS_KEY_ID": ACCESS_KEY_ID,
    "OUSD_BACKUP_SECRET_ACCESS_KEY": KEY,
}


def backup_remote() -> backup.Remote:
    remote = backup.settings_from_env(BACKUP_ENV).remote
    assert remote is not None
    return remote


def quoting_failure() -> Exception:
    """An error as a provider or botocore might raise it, quoting both credentials."""
    failure = RuntimeError(f"denied {ACCESS_KEY_ID} {KEY}")
    failure.response = {  # type: ignore[attr-defined]
        "Error": {"Code": "SignatureDoesNotMatch", "Message": f"{ACCESS_KEY_ID} {KEY}"}
    }
    return failure


class FailingS3:
    def __init__(self, operation: str) -> None:
        self.operation = operation

    def _maybe_fail(self, operation: str, reply=None):
        if operation == self.operation:
            raise quoting_failure()
        return reply

    def upload_file(self, **kwargs):
        return self._maybe_fail("upload_file")

    def head_object(self, **kwargs):
        return self._maybe_fail("head_object", {"ContentLength": 4})

    def put_object(self, **kwargs):
        return self._maybe_fail("put_object")

    def list_objects_v2(self, **kwargs):
        return self._maybe_fail("list_objects_v2", {"Contents": [], "IsTruncated": False})

    def delete_object(self, **kwargs):
        return self._maybe_fail("delete_object")


def test_the_backup_settings_and_remote_reprs_hide_the_credentials():
    settings = backup.settings_from_env(BACKUP_ENV)

    for text in (repr(settings), repr(settings.remote), str(settings.remote)):
        assert KEY not in text
        assert ACCESS_KEY_ID not in text


@pytest.mark.parametrize("operation", ["upload_file", "head_object", "put_object"])
def test_a_failing_upload_quoting_the_credentials_is_clean(operation, tmp_path, caplog):
    copy = tmp_path / "ousd-20261106T063005Z.duckdb"
    copy.write_bytes(b"data")
    backup.checksum_path(copy).write_text("0" * 64 + "  " + copy.name + "\n")
    made = backup.Backup(copy, "0" * 64, 4, 1)

    with pytest.raises(BackupError) as raised:
        backup.upload(made, backup_remote(), FailingS3(operation))

    assert "SignatureDoesNotMatch" in str(raised.value)
    assert_clean(raised.value, caplog, KEY, ACCESS_KEY_ID)


@pytest.mark.parametrize("operation", ["list_objects_v2", "delete_object"])
def test_a_failing_prune_quoting_the_credentials_is_clean(operation, caplog):
    s3 = FailingS3(operation)
    if operation == "delete_object":
        names = [f"ousd-2026110{day}T000000Z.duckdb" for day in (1, 2)]
        contents = [{"Key": "raw/" + name} for name in names]
        contents += [{"Key": "raw/" + name + ".sha256"} for name in names]
        s3.list_objects_v2 = lambda **kwargs: {"Contents": contents, "IsTruncated": False}  # type: ignore[method-assign]

    with pytest.raises(BackupError) as raised:
        backup.prune_remote(backup_remote(), s3, keep_daily=1, keep_weekly=0)

    assert_clean(raised.value, caplog, KEY, ACCESS_KEY_ID)


def test_a_real_botocore_client_error_quoting_the_credentials_is_clean(caplog):
    remote = backup_remote()
    client = backup.make_client(remote)
    stubber = Stubber(client)
    stubber.add_client_error(
        "list_objects_v2",
        service_error_code="AccessDenied",
        service_message=f"denied for {ACCESS_KEY_ID} with {KEY}",
        http_status_code=403,
    )

    with stubber, pytest.raises(BackupError) as raised:
        backup.prune_remote(remote, client, keep_daily=1, keep_weekly=0)

    assert str(raised.value) == "object storage listing failed: AccessDenied"
    assert_clean(raised.value, caplog, KEY, ACCESS_KEY_ID)


@pytest.mark.parametrize("operation", ["upload", "listing"])
def test_a_signed_request_refused_with_a_403_quoting_the_credentials_is_clean(
    operation, tmp_path, caplog, capfd
):
    copy = tmp_path / "ousd-20261106T063005Z.duckdb"
    copy.write_bytes(b"data")
    backup.checksum_path(copy).write_text("0" * 64 + "  " + copy.name + "\n")
    made = backup.Backup(copy, "0" * 64, 4, 1)
    remote = backup_remote()
    client = backup.make_client(remote)
    sent = refuse_every_request(client, f"denied for {ACCESS_KEY_ID} with {KEY}")

    with pytest.raises(BackupError) as raised:
        if operation == "upload":
            backup.upload(made, remote, client)
        else:
            backup.prune_remote(remote, client, keep_daily=1, keep_weekly=0)

    # botocore signed a real request, which names the access key, and got the reply back.
    assert ACCESS_KEY_ID in str(sent[0].headers["Authorization"])
    assert str(raised.value) == f"object storage {operation} failed: AccessDenied"
    assert_clean(raised.value, caplog, KEY, ACCESS_KEY_ID)
    captured = capfd.readouterr()
    records = [record.getMessage() for record in caplog.records]
    for secret in (KEY, ACCESS_KEY_ID):
        assert secret not in captured.out + captured.err
        assert not any(secret in record for record in records)


def test_the_client_is_built_by_a_call_whose_repr_holds_no_credential(monkeypatch):
    passed = []
    call = backup._call

    def spy(remote, operation, build):
        passed.append(build)
        return call(remote, operation, build)

    monkeypatch.setattr(backup, "_call", spy)

    backup.make_client(backup_remote())

    assert len(passed) == 1
    for text in (repr(passed[0]), str(passed[0])):
        assert KEY not in text
        assert ACCESS_KEY_ID not in text


def test_building_the_client_logs_no_credential(caplog):
    client = backup.make_client(backup_remote())

    assert KEY not in caplog.text
    assert ACCESS_KEY_ID not in caplog.text
    assert KEY not in repr(client)
    assert logging.getLogger("botocore").getEffectiveLevel() >= logging.WARNING


def test_the_client_ignores_aws_variables_for_credentials_and_endpoint(monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAAMBIENT000000000")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "ambient-secret")
    monkeypatch.setenv("AWS_ENDPOINT_URL", "https://elsewhere.invalid")
    monkeypatch.setenv("AWS_ENDPOINT_URL_S3", "https://elsewhere-s3.invalid")

    client = backup.make_client(backup_remote())

    assert client.meta.endpoint_url == "https://s3.fr-par.scw.cloud"  # type: ignore[attr-defined]
    credentials = client._request_signer._credentials  # type: ignore[attr-defined]
    assert (credentials.access_key, credentials.secret_key) == (ACCESS_KEY_ID, KEY)


@pytest.mark.parametrize(
    ("name", "value"), [("OUSD_BACKUP_REGION", "not a region!"), ("AWS_PROFILE", "missing")]
)
def test_a_client_that_cannot_be_built_is_a_clean_cli_error(
    name, value, monkeypatch, tmp_path, capsys, caplog
):
    monkeypatch.setenv("OUSD_DB_PATH", str(tmp_path / "ousd.duckdb"))
    monkeypatch.setenv("OUSD_BACKUP_DIR", str(tmp_path / "backups"))
    for key, setting in BACKUP_ENV.items():
        monkeypatch.setenv(key, setting)
    monkeypatch.setenv(name, value)
    cli.Store(tmp_path / "ousd.duckdb").close()

    assert cli.main(["backup"]) == 1

    captured = capsys.readouterr()
    assert "error: object storage client setup failed: " in captured.err
    for secret in (KEY, ACCESS_KEY_ID):
        assert secret not in captured.out + captured.err + caplog.text


def test_an_error_code_quoting_a_credential_is_scrubbed(tmp_path, caplog):
    failure = RuntimeError("x")
    failure.response = {"Error": {"Code": f"Bad{KEY}"}}  # type: ignore[attr-defined]

    class Echo(FailingS3):
        def list_objects_v2(self, **kwargs):
            raise failure

    with pytest.raises(BackupError) as raised:
        backup.prune_remote(backup_remote(), Echo("none"), keep_daily=1, keep_weekly=0)

    assert "[credential]" in str(raised.value)
    assert_clean(raised.value, caplog, KEY)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("OUSD_BACKUP_URL", f"s3://{ACCESS_KEY_ID}:{KEY}@ousd-backups/raw"),
        ("OUSD_BACKUP_URL", f"s3://ousd-backups/raw?secret={KEY}"),
        ("OUSD_BACKUP_ENDPOINT_URL", f"https://{ACCESS_KEY_ID}:{KEY}@s3.fr-par.scw.cloud"),
    ],
)
def test_a_url_holding_a_credential_is_refused_without_echoing_it(name, value, caplog):
    with pytest.raises(BackupError) as raised:
        backup.settings_from_env({**BACKUP_ENV, name: value})

    assert name in str(raised.value)
    assert_clean(raised.value, caplog, KEY, ACCESS_KEY_ID)


def test_a_failing_backup_through_the_cli_never_shows_the_credentials(
    monkeypatch, tmp_path, capsys, caplog
):
    monkeypatch.setenv("OUSD_DB_PATH", str(tmp_path / "ousd.duckdb"))
    monkeypatch.setenv("OUSD_BACKUP_DIR", str(tmp_path / "backups"))
    for name, value in BACKUP_ENV.items():
        monkeypatch.setenv(name, value)
    cli.Store(tmp_path / "ousd.duckdb").close()
    monkeypatch.setattr(backup, "make_client", lambda remote: FailingS3("upload_file"))

    assert cli.main(["-v", "backup"]) == 1

    captured = capsys.readouterr()
    for secret in (KEY, ACCESS_KEY_ID):
        assert secret not in captured.out + captured.err + caplog.text
    assert "the local copy is kept" in captured.err


def keyed_chain(url: str) -> BaseException:
    """An error whose cause and context both carry the keyed URL and the bare key."""
    try:
        try:
            raise ConnectionError(f"cannot reach {url}")
        except ConnectionError as inner:
            raise HttpError(f"rpc: denied for {KEY}") from inner
    except HttpError:
        try:
            raise ValueError("decoding the reply failed")
        except ValueError as outer:
            return outer


@pytest.mark.parametrize("url", PARAMS)
def test_a_scrubbed_traceback_keeps_the_chain_but_not_the_key(url, monkeypatch):
    monkeypatch.setenv("BASE_RPC_URL", url)
    text = scrubbed_traceback(keyed_chain(url))
    assert "Traceback" in text
    assert "ConnectionError: cannot reach <BASE_RPC_URL>" in text
    assert "HttpError: rpc: denied for <BASE_RPC_URL>" in text
    assert "ValueError: decoding the reply failed" in text
    assert not any(prefix in text for prefix in shown(KEY))


@pytest.mark.parametrize("url", PARAMS)
def test_a_check_that_cannot_run_logs_a_scrubbed_traceback_and_publishes_the_class(
    url, monkeypatch, caplog
):
    monkeypatch.setenv("SOLANA_RPC_URL", url)
    error = keyed_chain(url)

    def broken():
        raise error

    result = checks._guarded("freshness", broken)

    assert (result.status, result.detail) == ("failed", "could not run: ValueError")
    assert "freshness could not run" in caplog.text
    assert "ConnectionError: cannot reach <SOLANA_RPC_URL>" in caplog.text
    assert not any(prefix in caplog.text for prefix in shown(KEY))


@pytest.mark.parametrize("name", ["OUSD_ALERT_WEBHOOK_URL", "OUSD_HEARTBEAT_URL"])
@pytest.mark.parametrize("url", PARAMS)
def test_the_alert_and_heartbeat_urls_are_scrubbed_like_rpc_urls(name, url, monkeypatch):
    monkeypatch.setenv(name, url)
    assert scrub_secrets(f"posting to {url} with {KEY}") == f"posting to <{name}> with <{name}>"


def test_every_url_variable_the_pipeline_reads_is_scrubbed():
    root = Path(__file__).resolve().parent.parent / "pipeline"
    named = {
        name
        for path in root.rglob("*.py")
        for name in re.findall(r'"([A-Z][A-Z0-9_]*_URL)"', path.read_text())
    }
    assert named
    assert named <= set(SECRET_URL_VARIABLES)


@pytest.mark.parametrize("url", PARAMS)
def test_json_log_lines_and_alert_summaries_hide_a_keyed_url(url, monkeypatch):
    from ousd.alerts import clean_summary
    from ousd.logs import JsonFormatter

    monkeypatch.setenv("BASE_RPC_URL", url)
    try:
        raise ConnectionError(f"cannot reach {url}: key {KEY} refused")
    except ConnectionError as exc:
        record = logging.LogRecord(
            "ousd.test", logging.ERROR, __file__, 1, "failed %s", (url,), (type(exc), exc, None)
        )
    line = JsonFormatter().format(record)
    summary = json.dumps(clean_summary({"base": {"error": f"failed at {url} {KEY}"}}))
    for text in (line, summary):
        assert KEY not in text
        assert KEY[:12] not in text
        assert "provider.invalid" not in text
