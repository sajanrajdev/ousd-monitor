import logging
import socket

import httpx
import pytest
from ousd.http import MAX_SERVER_WAIT, HttpError, PoliteClient


def client_for(responses: list, sleeps: list[float] | None = None) -> PoliteClient:
    queue = iter(responses)

    def handler(request: httpx.Request) -> httpx.Response:
        item = next(queue)
        if isinstance(item, Exception):
            raise item
        return item

    recorder = sleeps if sleeps is not None else []
    return PoliteClient(
        min_interval=0, transport=httpx.MockTransport(handler), sleep=recorder.append
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

    assert caplog.messages == ["rate limit window spent, pausing 90s"]


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


def test_suite_cannot_reach_the_network():
    with pytest.raises(RuntimeError, match="tried to open a connection"):
        socket.create_connection(("127.0.0.1", 9))
