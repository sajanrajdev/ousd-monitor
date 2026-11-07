"""An HTTP client that is polite to free APIs: it throttles and retries with backoff."""

import json
import logging
import math
import random
import re
import time
from collections.abc import Callable
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import parse_qsl, quote, quote_plus, unquote, urlsplit

import httpx

log = logging.getLogger(__name__)
# httpx and httpcore log every request URL at INFO and DEBUG, and a URL can hold an API key.
# Setting this here covers every caller that imports the client, not only the CLI.
for _name in ("httpx", "httpcore"):
    logging.getLogger(_name).setLevel(logging.WARNING)

USER_AGENT = "open-usd-monitor/0.1"
RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}
# Upper bound on honoring a server's "come back later" hint. Blockscout has asked for 36 minutes.
MAX_SERVER_WAIT = 3600.0
# Longest one attempt may run. The read timeout only limits the gap between bytes, so without
# this a server trickling data could hold a request open indefinitely.
REQUEST_DEADLINE = 120.0
# Shortest URL part worth hiding on its own. Shorter parts are words like "v2" or "base".
MIN_SECRET_PART = 8
# Largest response body read by default. A client can set its own limit.
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
# Pauses at least this long are logged, so a quiet process means a hang and not a wait.
VISIBLE_WAIT = 5.0


def _retry_after(value: str, now: float) -> float:
    """A Retry-After value as seconds: either a number or an HTTP date."""
    try:
        seconds = float(value)
    except ValueError:
        pass
    else:
        if math.isnan(seconds):
            raise ValueError(f"bad Retry-After: {value!r}")
        return seconds
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        raise ValueError(f"bad Retry-After: {value!r}") from None
    if when.tzinfo is None:
        raise ValueError(f"bad Retry-After: {value!r}")
    return when.timestamp() - now


def _server_wait(response: httpx.Response, now: float) -> float:
    """Seconds the server asked us to wait, or 0 if it did not say."""
    try:
        if "retry-after" in response.headers:
            seconds = _retry_after(response.headers["retry-after"], now)
            return min(max(seconds, 0.0), MAX_SERVER_WAIT)
        if response.headers.get("x-ratelimit-remaining") == "0":
            # Blockscout reports the time until reset in milliseconds.
            return min(float(response.headers["x-ratelimit-reset"]) / 1000, MAX_SERVER_WAIT)
    except (KeyError, ValueError):
        pass
    return 0.0


def _url_parts(url: str) -> set[str] | None:
    """The pieces of a URL that could carry or reveal a key, longer than a bare word.

    None when the URL can't be taken apart, so the caller can't tell what to hide.
    """
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
    except ValueError:
        return None
    long_parts = [parts.path, *host.split("."), *parts.path.split("/"), parts.fragment]
    for pair in parts.query.split("&"):
        long_parts += pair.partition("=")[::2]
    for name, value in parse_qsl(parts.query, keep_blank_values=True):
        long_parts += [name, value]
    long_parts += [parts.username or "", parts.password or ""]
    # A key can sit inside a larger part: "/apikey=KEY", "/KEY.json", ";apikey=KEY", "#token=KEY",
    # "/token:KEY", "/tok|KEY". Not "-" or "_": those would break up hyphenated text and UUID keys.
    decoded = [unquote(part) for part in long_parts]
    pieces = [piece for part in (*long_parts, *decoded) for piece in re.split(r"[;=,.:|]", part)]
    found = {host, *long_parts, *decoded, *pieces}
    for part in list(found):
        found.update(variant for variant in (quote(part, safe=""), quote_plus(part)))
    return {part for part in found if len(part) >= MIN_SECRET_PART or part == host}


class HttpError(RuntimeError):
    """A response that retrying will not fix, or the last failure after all retries."""


class PoliteClient:
    """Callers name each client with a label. URLs can hold API keys, so they are never logged."""

    def __init__(
        self,
        label: str = "http",
        min_interval: float = 0.1,
        max_attempts: int = 6,
        backoff: float = 1.0,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        deadline: float = REQUEST_DEADLINE,
        max_bytes: int = MAX_RESPONSE_BYTES,
        rng: random.Random | None = None,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self._client = httpx.Client(
            headers={"User-Agent": USER_AGENT}, timeout=60.0, transport=transport
        )
        self._label = label
        self._min_interval = min_interval
        self._max_attempts = max_attempts
        self._backoff = backoff
        self._sleep = sleep
        self._clock = clock
        self._deadline = deadline
        self._max_bytes = max_bytes
        # Tests seed this to make the jittered delays repeatable.
        self._rng = rng or random.Random()
        self._wall_clock = wall_clock
        self._last_request = 0.0
        self._pause_next = 0.0

    def request_json(self, method: str, url: str, **kwargs: Any) -> Any:
        failure = ""
        server_wait = 0.0
        for attempt in range(self._max_attempts):
            if attempt:
                # Full jitter: a random wait up to the exponential step, so clients that failed
                # together do not retry together. A server's own hint is still a floor.
                jittered = self._rng.uniform(0, self._backoff * 2 ** (attempt - 1))
                delay = max(jittered, server_wait)
                log.warning("%s: retrying in %.0fs: %s", self._label, delay, failure)
                self._sleep(delay)
            # A hint only applies to the response that gave it, not to later failures.
            server_wait = 0.0
            self._throttle()
            invalid_url = False
            try:
                response, body = self._fetch(method, url, **kwargs)
            except httpx.InvalidURL:
                # Its text can quote part of the URL, so only the label is kept.
                invalid_url = True
            except httpx.RequestError as exc:
                failure = self.scrub(repr(exc), url)
                continue
            if invalid_url:
                # Raised outside the except block so that no cause or context is attached.
                raise HttpError(f"{self._label}: invalid URL")
            # Spending the last request in a window: wait it out instead of earning a 429.
            now = self._wall_clock()
            self._pause_next = _server_wait(response, now) if response.is_success else 0.0
            if response.status_code in RETRYABLE_STATUS:
                failure = f"HTTP {response.status_code}"
                server_wait = _server_wait(response, now)
                continue
            if response.is_error:
                # Scrub the whole body first: a cut at 200 bytes could split a key in two.
                detail = self.scrub(body.decode(errors="replace"), url)[:200]
                raise HttpError(f"{self._label}: HTTP {response.status_code}: {detail}")
            try:
                return json.loads(body)
            except ValueError:
                failure = "response was not JSON"
        raise HttpError(f"{self._label}: gave up after {self._max_attempts} attempts: {failure}")

    def scrub(self, text: str, url: str) -> str:
        """Remove a URL and its parts from text a server or library produced.

        Besides the URL, host and path, this hides each host label, path segment, query value,
        username and password of 8 or more characters, because a provider may echo the bare key.
        Longer parts go first and everything is replaced in one pass, so inserted labels are
        never rewritten.
        """
        parts = _url_parts(url)
        if parts is None:
            # Nothing says what to hide, so none of the text is trusted.
            return f"<{self._label}> error (details withheld)"
        secrets = {part for part in (url, *parts) if len(part) > 1}
        if not secrets:
            return text
        pattern = "|".join(re.escape(part) for part in sorted(secrets, key=len, reverse=True))
        return re.sub(pattern, lambda _: f"<{self._label}>", text, flags=re.IGNORECASE)

    def _fetch(self, method: str, url: str, **kwargs: Any) -> tuple[httpx.Response, bytes]:
        """Read a whole response, raising a retryable timeout once the deadline passes."""
        started = self._clock()
        body = bytearray()
        with self._client.stream(method, url, **kwargs) as response:
            declared = response.headers.get("content-length", "")
            if declared.isascii() and declared.isdigit() and int(declared) > self._max_bytes:
                raise self._too_large(url)
            for chunk in response.iter_bytes():
                body += chunk
                if len(body) > self._max_bytes:
                    raise self._too_large(url)
                if self._clock() - started > self._deadline:
                    raise httpx.ReadTimeout(f"no full response within {self._deadline:.0f}s")
        return response, bytes(body)

    def _too_large(self, url: str) -> HttpError:
        message = f"{self._label}: response larger than {self._max_bytes} bytes"
        return HttpError(self.scrub(message, url))

    def _throttle(self) -> None:
        wait = max(self._pause_next, self._last_request + self._min_interval - self._clock())
        self._pause_next = 0.0
        if wait >= VISIBLE_WAIT:
            log.warning("%s: rate limit window spent, pausing %.0fs", self._label, wait)
        if wait > 0:
            self._sleep(wait)
        self._last_request = self._clock()
