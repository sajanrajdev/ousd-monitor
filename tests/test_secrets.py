"""A keyed RPC URL, or the key alone, must never reach a log line, an exception or a repr."""

import json
import logging
import subprocess
import sys
import traceback

import httpx
import pytest
from conftest import make_chain
from ousd import cli
from ousd.chains import Chain, missing_rpc_keys
from ousd.http import HttpError, PoliteClient
from ousd.sources import BlockscoutClient, RpcClient, RpcError

KEY = "k3y9aZ7QwErTyUiOpAsDfGhJkLzXcVbNm1234567890abcdefghijklmnopqr"
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


def test_a_failing_sync_through_the_cli_never_shows_the_key(monkeypatch, tmp_path, capsys, caplog):
    monkeypatch.setenv("TEMPO_RPC_URL", URLS[0])
    monkeypatch.setenv("OUSD_DB_PATH", str(tmp_path / "ousd.duckdb"))
    transport = httpx.MockTransport(lambda request: httpx.Response(500, text=f"down {URLS[0]}"))

    def polite(**kwargs):
        return PoliteClient(transport=transport, sleep=lambda _: None, **kwargs)

    monkeypatch.setattr(cli, "PoliteClient", polite)

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
