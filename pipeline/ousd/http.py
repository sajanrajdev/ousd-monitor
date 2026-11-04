"""An HTTP client that is polite to free APIs: it throttles and retries with backoff."""

import json
import logging
import time
from collections.abc import Callable
from typing import Any

import httpx

log = logging.getLogger(__name__)

USER_AGENT = "open-usd-monitor/0.1"
RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}
# Upper bound on honoring a server's "come back later" hint. Blockscout has asked for 36 minutes.
MAX_SERVER_WAIT = 3600.0
# Longest one attempt may run. The read timeout only limits the gap between bytes, so without
# this a server trickling data could hold a request open indefinitely.
REQUEST_DEADLINE = 120.0
# Pauses at least this long are logged, so a quiet process means a hang and not a wait.
VISIBLE_WAIT = 5.0


def _server_wait(response: httpx.Response) -> float:
    """Seconds the server asked us to wait, or 0 if it did not say."""
    try:
        if "retry-after" in response.headers:
            return min(float(response.headers["retry-after"]), MAX_SERVER_WAIT)
        if response.headers.get("x-ratelimit-remaining") == "0":
            # Blockscout reports the time until reset in milliseconds.
            return min(float(response.headers["x-ratelimit-reset"]) / 1000, MAX_SERVER_WAIT)
    except (KeyError, ValueError):
        pass
    return 0.0


def _snippet(body: bytes) -> str:
    return body[:200].decode(errors="replace")


class HttpError(RuntimeError):
    """A response that retrying will not fix, or the last failure after all retries."""


class PoliteClient:
    def __init__(
        self,
        min_interval: float = 0.1,
        max_attempts: int = 6,
        backoff: float = 1.0,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        deadline: float = REQUEST_DEADLINE,
    ) -> None:
        self._client = httpx.Client(
            headers={"User-Agent": USER_AGENT}, timeout=60.0, transport=transport
        )
        self._min_interval = min_interval
        self._max_attempts = max_attempts
        self._backoff = backoff
        self._sleep = sleep
        self._clock = clock
        self._deadline = deadline
        self._last_request = 0.0
        self._pause_next = 0.0

    def request_json(self, method: str, url: str, **kwargs: Any) -> Any:
        failure = ""
        server_wait = 0.0
        for attempt in range(self._max_attempts):
            if attempt:
                delay = max(self._backoff * 2 ** (attempt - 1), server_wait)
                log.warning("retrying %s in %.0fs: %s", url, delay, failure)
                self._sleep(delay)
            # A hint only applies to the response that gave it, not to later failures.
            server_wait = 0.0
            self._throttle()
            try:
                response, body = self._fetch(method, url, **kwargs)
            except httpx.TransportError as exc:
                failure = repr(exc)
                continue
            # Spending the last request in a window: wait it out instead of earning a 429.
            self._pause_next = _server_wait(response) if response.is_success else 0.0
            if response.status_code in RETRYABLE_STATUS:
                failure = f"HTTP {response.status_code}"
                server_wait = _server_wait(response)
                continue
            if response.is_error:
                raise HttpError(f"{url}: HTTP {response.status_code}: {_snippet(body)}")
            try:
                return json.loads(body)
            except ValueError:
                failure = "response was not JSON"
        raise HttpError(f"{url}: gave up after {self._max_attempts} attempts: {failure}")

    def _fetch(self, method: str, url: str, **kwargs: Any) -> tuple[httpx.Response, bytes]:
        """Read a whole response, raising a retryable timeout once the deadline passes."""
        started = self._clock()
        body = bytearray()
        with self._client.stream(method, url, **kwargs) as response:
            for chunk in response.iter_bytes():
                body += chunk
                if self._clock() - started > self._deadline:
                    raise httpx.ReadTimeout(f"no full response within {self._deadline:.0f}s")
        return response, bytes(body)

    def _throttle(self) -> None:
        wait = max(self._pause_next, self._last_request + self._min_interval - self._clock())
        self._pause_next = 0.0
        if wait >= VISIBLE_WAIT:
            log.warning("rate limit window spent, pausing %.0fs", wait)
        if wait > 0:
            self._sleep(wait)
        self._last_request = self._clock()
