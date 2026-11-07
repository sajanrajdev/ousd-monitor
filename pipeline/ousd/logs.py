"""Log output: plain text by default, one JSON object per line with OUSD_LOG_FORMAT=json.

In JSON, every message and exception is scrubbed of configured and other URLs before it is
encoded, so a keyed URL cannot reach a line. Plain text is the format it always was.
"""

import contextvars
import json
import logging
import os
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

from ousd.http import scrub_secrets

FORMAT_VARIABLE = "OUSD_LOG_FORMAT"
PLAIN_FORMAT = "%(asctime)s %(levelname)s %(message)s"
# Set on the handler configure_logging installs, so a later call replaces that one and no other.
OWN_HANDLER_MARK = "_ousd_log_handler"

# Set by whoever knows them, read by the formatter. Both are absent from a line until then.
run_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("ousd_run_id", default=None)
chain_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("ousd_chain", default=None)


@contextmanager
def chain_context(name: str) -> Iterator[None]:
    """Lines logged inside carry this chain."""
    token = chain_var.set(name)
    try:
        yield
    finally:
        chain_var.reset(token)


class UnknownLogFormat(ValueError):
    pass


def log_format(env: Mapping[str, str] | None = None) -> str:
    """ "plain" or "json". Blank means plain. Anything else is refused, naming the variable."""
    text = (os.environ if env is None else env).get(FORMAT_VARIABLE, "").strip().lower()
    if text in ("", "plain", "text"):
        return "plain"
    if text == "json":
        return "json"
    raise UnknownLogFormat(f"{FORMAT_VARIABLE} must be plain or json")


class JsonFormatter(logging.Formatter):
    """One JSON object per record: time, level, logger, message, run_id and chain when known,
    and the exception text when there is one. Strings are scrubbed first, then encoded."""

    def format(self, record: logging.LogRecord) -> str:
        meta = getattr(record, "dagster_meta", None)
        meta = meta if isinstance(meta, dict) else {}
        entry: dict[str, Any] = {
            "time": datetime.fromtimestamp(record.created, UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "level": record.levelname,
            "logger": record.name,
            "message": scrub_secrets(record.getMessage()),
        }
        run_id = getattr(record, "run_id", None) or meta.get("run_id") or run_id_var.get()
        chain = getattr(record, "chain", None) or chain_var.get()
        if run_id:
            entry["run_id"] = scrub_secrets(str(run_id))
        if chain:
            entry["chain"] = scrub_secrets(str(chain))
        if record.exc_info and record.exc_info[1] is not None:
            entry["exception"] = scrub_secrets(self.formatException(record.exc_info))
        return json.dumps(entry, ensure_ascii=False, default=str)


def formatter(env: Mapping[str, str] | None = None) -> logging.Formatter:
    return JsonFormatter() if log_format(env) == "json" else logging.Formatter(PLAIN_FORMAT)


def configure_logging(verbose: bool, env: Mapping[str, str] | None = None) -> None:
    """Install one stderr handler on the root logger, replacing only the one this function put
    there before. Handlers someone else added stay."""
    handler = logging.StreamHandler()
    handler.setFormatter(formatter(env))
    setattr(handler, OWN_HANDLER_MARK, True)
    root = logging.getLogger()
    for existing in list(root.handlers):
        if getattr(existing, OWN_HANDLER_MARK, False):
            root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(logging.INFO if verbose else logging.WARNING)
