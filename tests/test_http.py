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
