import logging
import math
import random
import socket
from typing import Any

import httpx
import pytest
from ousd.http import (
    MAX_SERVER_WAIT,
    RATE_LIMIT_WAITS,
    HttpError,
    PoliteClient,
    WaitBudget,
    rate_limit_waits_capped,
    scrub_secrets,
)


class TopOfRange(random.Random):
    """Jitter that always picks the longest wait, so tests can name exact delays."""

    def uniform(self, a: float, b: float) -> float:
        return b


def client_for(responses: list, sleeps: list[float] | None = None, **options: Any) -> PoliteClient:
    queue = iter(responses)

    def handler(request: httpx.Request) -> httpx.Response:
        item = next(queue)
        if isinstance(item, Exception):
            raise item
        return item

    recorder = sleeps if sleeps is not None else []
    return PoliteClient(
        min_interval=0,
        transport=httpx.MockTransport(handler),
        sleep=recorder.append,
        rng=TopOfRange(),
        **options,
    )


def test_retries_transient_failures_with_exponential_backoff():
    sleeps: list[float] = []
    client = client_for(
        [
            httpx.Response(503),
            httpx.ConnectError("boom"),
            httpx.Response(200, text="<html>not json</html>"),
            httpx.Response(200, json={"ok": True}),
        ],
        sleeps,
    )

    assert client.request_json("GET", "http://x.invalid") == {"ok": True}
    assert sleeps == [1.0, 2.0, 4.0]


def test_waits_as_long_as_the_rate_limit_reset_asks():
    sleeps: list[float] = []
    limited = httpx.Response(
        429, headers={"x-ratelimit-remaining": "0", "x-ratelimit-reset": "90000"}
    )
    client = client_for([limited, httpx.Response(200, json={})], sleeps)

    client.request_json("GET", "http://x.invalid")

    assert sleeps == [90.0]


def test_pauses_before_the_next_request_when_a_success_spends_the_window():
    sleeps: list[float] = []
    last_in_window = httpx.Response(
        200, json={}, headers={"x-ratelimit-remaining": "0", "x-ratelimit-reset": "5000"}
    )
    client = client_for([last_in_window, httpx.Response(200, json={})], sleeps)

    client.request_json("GET", "http://x.invalid")
    assert sleeps == []

    client.request_json("GET", "http://x.invalid")
    assert sleeps == [5.0]


def test_a_long_pause_is_logged_and_a_short_one_is_not(caplog):
    def spends_window(reset_ms: str) -> httpx.Response:
        headers = {"x-ratelimit-remaining": "0", "x-ratelimit-reset": reset_ms}
        return httpx.Response(200, json={}, headers=headers)

    client = client_for(
        [spends_window("4000"), spends_window("90000"), httpx.Response(200, json={})]
    )

    with caplog.at_level(logging.WARNING):
        client.request_json("GET", "http://x.invalid")
        client.request_json("GET", "http://x.invalid")
        assert caplog.messages == []
        client.request_json("GET", "http://x.invalid")

    assert caplog.messages == ["http: rate limit window spent, pausing 90s"]


def test_a_rate_limit_hint_does_not_outlive_its_response():
    sleeps: list[float] = []
    client = client_for(
        [
            httpx.Response(429, headers={"retry-after": "600"}),
            httpx.ConnectError("boom"),
            httpx.Response(200, json={}),
        ],
        sleeps,
    )

    client.request_json("GET", "http://x.invalid")

    assert sleeps == [600.0, 2.0]


@pytest.mark.parametrize(
    "headers",
    [{"x-ratelimit-remaining": "-1", "x-ratelimit-reset": "-1"}, {"retry-after": "-1"}],
)
def test_negative_rate_limit_headers_mean_no_information(headers):
    sleeps: list[float] = []
    client = client_for(
        [httpx.Response(429, headers=headers), httpx.Response(200, json={})], sleeps
    )

    client.request_json("GET", "http://x.invalid")

    assert sleeps == [1.0]


def test_retry_after_is_honored_but_capped():
    sleeps: list[float] = []
    limited = httpx.Response(429, headers={"retry-after": "999999"})
    client = client_for([limited, httpx.Response(200, json={})], sleeps)

    client.request_json("GET", "http://x.invalid")

    assert sleeps == [MAX_SERVER_WAIT]


def test_permanent_errors_are_not_retried():
    sleeps: list[float] = []
    client = client_for([httpx.Response(403, text="archive requires a token")], sleeps)

    with pytest.raises(HttpError, match=r"403.*archive"):
        client.request_json("POST", "http://x.invalid")
    assert sleeps == []


def test_gives_up_after_max_attempts():
    client = client_for([httpx.Response(500)] * 6)

    with pytest.raises(HttpError, match="gave up after 6"):
        client.request_json("GET", "http://x.invalid")


class FakeClock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


class Trickle(httpx.SyncByteStream):
    """A response body whose chunks each take a while to arrive."""

    def __init__(self, clock: FakeClock, chunks: list[bytes], seconds_per_chunk: float) -> None:
        self.clock = clock
        self.chunks = chunks
        self.seconds_per_chunk = seconds_per_chunk

    def __iter__(self):
        for chunk in self.chunks:
            self.clock.now += self.seconds_per_chunk
            yield chunk


def test_a_trickling_response_is_cut_off_at_the_deadline_and_retried():
    clock = FakeClock()
    responses = iter(
        [
            httpx.Response(200, stream=Trickle(clock, [b"{"] * 100, seconds_per_chunk=5)),
            httpx.Response(200, json={"ok": True}),
        ]
    )
    client = PoliteClient(
        min_interval=0,
        transport=httpx.MockTransport(lambda request: next(responses)),
        sleep=lambda _: None,
        clock=clock,
        deadline=60,
    )

    assert client.request_json("GET", "http://x.invalid") == {"ok": True}
    assert clock.now == 1_000 + 65  # Stopped at the first chunk past the deadline.


def test_a_slow_response_inside_the_deadline_succeeds():
    clock = FakeClock()
    stream = Trickle(clock, [b'{"ok":', b" true}"], seconds_per_chunk=25)
    client = PoliteClient(
        min_interval=0,
        transport=httpx.MockTransport(lambda request: httpx.Response(200, stream=stream)),
        clock=clock,
        deadline=60,
    )

    assert client.request_json("GET", "http://x.invalid") == {"ok": True}


SECRET_URL = "https://key-in-host.invalid/v2/KEY-IN-PATH"


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500),
        httpx.Response(403, text=f"bad key for {SECRET_URL}"),
        httpx.ConnectError("cannot reach key-in-host.invalid"),
    ],
)
def test_a_failure_never_reveals_the_url(response, caplog):
    client = PoliteClient(
        label="testnet-rpc",
        min_interval=0,
        max_attempts=2,
        transport=httpx.MockTransport(lambda request: _raise_or_return(response)),
        sleep=lambda _: None,
    )

    with caplog.at_level(logging.DEBUG, logger="ousd"), pytest.raises(HttpError) as failure:
        client.request_json("POST", SECRET_URL)

    text = f"{failure.value!s} {failure.value!r} {caplog.text}"
    assert "testnet-rpc" in str(failure.value)
    assert "KEY-IN-PATH" not in text
    assert "key-in-host" not in text


def _raise_or_return(item):
    if isinstance(item, Exception):
        raise item
    return item


def test_suite_cannot_reach_the_network():
    with pytest.raises(RuntimeError, match="tried to open a connection"):
        socket.create_connection(("127.0.0.1", 9))


def test_backoff_is_fully_jittered_and_repeatable_with_a_seed():
    def delays(seed: int) -> list[float]:
        sleeps: list[float] = []
        client = client_for([httpx.Response(503)] * 4 + [httpx.Response(200, json={})], sleeps)
        client._rng = random.Random(seed)
        client.request_json("GET", "http://x.invalid")
        return sleeps

    first = delays(7)
    assert first == delays(7)
    assert first != delays(8)
    for delay, ceiling in zip(first, [1.0, 2.0, 4.0, 8.0], strict=True):
        assert 0 <= delay <= ceiling
    assert any(delay < ceiling for delay, ceiling in zip(first, [1.0, 2.0, 4.0, 8.0], strict=True))


def test_a_server_hint_is_a_floor_under_the_jitter():
    sleeps: list[float] = []
    limited = httpx.Response(429, headers={"retry-after": "30"})
    client = client_for([limited, httpx.Response(200, json={})], sleeps)
    client._rng = random.Random(0)

    client.request_json("GET", "http://x.invalid")

    assert sleeps == [30.0]


def test_retry_after_as_an_http_date_is_honored():
    sleeps: list[float] = []
    # 1994-11-06 08:49:37 GMT, the RFC example, is 20 s after the fixed "now" below.
    when = "Sun, 06 Nov 1994 08:49:37 GMT"
    now = 784111777.0 - 20
    limited = httpx.Response(503, headers={"retry-after": when})
    client = client_for([limited, httpx.Response(200, json={})], sleeps, wall_clock=lambda: now)

    client.request_json("GET", "http://x.invalid")

    assert sleeps == [20.0]


@pytest.mark.parametrize("value", ["Sun, 06 Nov 1994 08:49:37 GMT", "not a date", "", "-5", "nan"])
def test_a_past_or_unreadable_retry_after_adds_no_wait(value):
    sleeps: list[float] = []
    limited = httpx.Response(503, headers={"retry-after": value})
    client = client_for(
        [limited, httpx.Response(200, json={})], sleeps, wall_clock=lambda: 2_000_000_000.0
    )

    client.request_json("GET", "http://x.invalid")

    assert sleeps == [1.0]


def test_a_far_off_http_date_is_capped():
    sleeps: list[float] = []
    limited = httpx.Response(503, headers={"retry-after": "Fri, 31 Dec 9999 23:59:59 GMT"})
    client = client_for([limited, httpx.Response(200, json={})], sleeps, wall_clock=lambda: 0.0)

    client.request_json("GET", "http://x.invalid")

    assert sleeps == [MAX_SERVER_WAIT]


def test_a_declared_oversize_body_is_refused_without_the_key():
    key = "sk_live_Ab3dEf7hIj"
    big = httpx.Response(200, content=b"x" * 100)
    client = client_for([big], max_bytes=50)

    with pytest.raises(HttpError, match="larger than 50 bytes") as raised:
        client.request_json("GET", f"http://rpc.invalid/v2/{key}")
    assert key not in str(raised.value)
    assert key not in repr(raised.value.__cause__)


def test_an_undeclared_oversize_body_is_cut_off_while_streaming():
    key = "sk_live_Ab3dEf7hIj"

    def chunks():
        for _ in range(100):
            yield b"x" * 10

    big = httpx.Response(200, content=chunks())
    client = client_for([big], max_bytes=50)

    with pytest.raises(HttpError, match="larger than 50 bytes") as raised:
        client.request_json("GET", f"http://rpc.invalid/v2/{key}")
    assert key not in str(raised.value)


def test_a_body_at_the_limit_is_read_and_the_default_is_64_mb():
    client = client_for([httpx.Response(200, content=b'{"a": 1}')], max_bytes=8)
    assert client.request_json("GET", "http://x.invalid") == {"a": 1}
    assert PoliteClient()._max_bytes == 64 * 1024 * 1024


def test_a_non_ascii_digit_content_length_is_ignored_not_a_crash():
    ok = httpx.Response(200, json={"a": 1}, headers=[(b"content-length", "\u00b2".encode("utf-8"))])
    client = client_for([ok], max_bytes=50)

    assert client.request_json("GET", "http://x.invalid") == {"a": 1}


def test_a_reply_that_is_not_json_is_returned_as_bytes():
    client = client_for([httpx.Response(200, text="OK")])
    assert client.request("GET", "http://hc.invalid/ping") == b"OK"


def test_server_waits_are_spent_from_the_budget_and_refused_past_it():
    budget = WaitBudget()
    budget.remaining = 100
    sleeps: list[float] = []
    client = client_for(
        [
            httpx.Response(429, headers={"retry-after": "60"}),
            httpx.Response(200, json={"ok": True}),
            httpx.Response(429, headers={"retry-after": "60"}),
        ],
        sleeps,
        waits=budget,
    )
    assert client.request_json("GET", "http://api.invalid") == {"ok": True}
    assert budget.remaining == 40
    with pytest.raises(HttpError, match="60s rate limit wait would pass the run's limit"):
        client.request_json("GET", "http://api.invalid")
    # The refused wait is never slept.
    assert sleeps == [60]


def test_a_spent_window_counts_against_the_budget():
    budget = WaitBudget()
    budget.remaining = 10
    sleeps: list[float] = []
    spent = {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "30000"}
    client = client_for([httpx.Response(200, json={}, headers=spent)], sleeps, waits=budget)
    client.request_json("GET", "http://api.invalid")
    with pytest.raises(HttpError, match="30s rate limit wait"):
        client.request_json("GET", "http://api.invalid")
    assert sleeps == []


def test_backoff_without_a_server_hint_costs_nothing():
    budget = WaitBudget()
    budget.remaining = 0
    client = client_for([httpx.Response(503), httpx.Response(200, json={})], waits=budget)
    assert client.request_json("GET", "http://api.invalid") == {}


def test_the_shared_budget_is_unlimited_outside_a_run_and_capped_inside_one():
    assert math.isinf(RATE_LIMIT_WAITS.remaining)
    with rate_limit_waits_capped(120) as budget:
        assert budget is RATE_LIMIT_WAITS
        assert RATE_LIMIT_WAITS.remaining == 120
    assert math.isinf(RATE_LIMIT_WAITS.remaining)


def test_scrub_secrets_removes_any_url_even_one_not_configured():
    text = "redirected to https://elsewhere.invalid/k/abc?token=1 then gave up"
    assert scrub_secrets(text, {}) == "redirected to <url> then gave up"


@pytest.mark.parametrize("status", [301, 304, 308])
def test_a_redirect_is_not_followed_and_not_taken_as_an_answer(status):
    client = client_for([httpx.Response(status, text="moved")])
    with pytest.raises(HttpError, match=f"HTTP {status}"):
        client.request("GET", "http://hc.invalid/ping")
