"""An HTTP client that is polite to free APIs: it throttles and retries with backoff."""

import logging
import time
from collections.abc import Callable
from typing import Any

import httpx

log = logging.getLogger(__name__)

USER_AGENT = "open-usd-monitor/0.1"
RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}
# Upper bound on honoring a server's "come back later" hint. Blockscout's window is ~22 minutes.
MAX_SERVER_WAIT = 1800.0


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
    ) -> None:
        self._client = httpx.Client(
            headers={"User-Agent": USER_AGENT}, timeout=60.0, transport=transport
        )
        self._min_interval = min_interval
        self._max_attempts = max_attempts
        self._backoff = backoff
        self._sleep = sleep
        self._last_request = 0.0

    def request_json(self, method: str, url: str, **kwargs: Any) -> Any:
        failure = ""
        server_wait = 0.0
        for attempt in range(self._max_attempts):
            if attempt:
                delay = max(self._backoff * 2 ** (attempt - 1), server_wait)
                log.warning("retrying %s in %.0fs: %s", url, delay, failure)
                self._sleep(delay)
            self._throttle()
            try:
                response = self._client.request(method, url, **kwargs)
            except httpx.TransportError as exc:
                failure = repr(exc)
                continue
            if response.status_code in RETRYABLE_STATUS:
                failure = f"HTTP {response.status_code}"
                server_wait = _server_wait(response)
                continue
            if response.is_error:
                raise HttpError(f"{url}: HTTP {response.status_code}: {response.text[:200]}")
            try:
                return response.json()
            except ValueError:
                failure = "response was not JSON"
        raise HttpError(f"{url}: gave up after {self._max_attempts} attempts: {failure}")

    def _throttle(self) -> None:
        wait = self._last_request + self._min_interval - time.monotonic()
        if wait > 0:
            self._sleep(wait)
        self._last_request = time.monotonic()
