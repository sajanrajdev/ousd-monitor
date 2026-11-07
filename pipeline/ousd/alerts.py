"""Telling someone how the daily run went: a file per failed run, and two optional outbound calls.

A failure always writes `data/alerts/<run_id>.json`. With OUSD_ALERT_WEBHOOK_URL set it is also
posted there. With OUSD_HEARTBEAT_URL set a fully successful run pings that URL, so a dead-man
check notices a run that failed before it could alert, or never started: a pipeline run once it
publishes, or under scripts/daily.sh, which blanks the URL for the pipeline, once it deploys.
Both URLs are secrets: they are read from the environment when used, sent only through
PoliteClient, which never logs a URL, and scrubbed from any error.
"""

import json
import logging
import math
import os
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from ousd.http import HttpError, PoliteClient, WaitBudget, scrub_secrets

log = logging.getLogger(__name__)

DEFAULT_ALERTS_DIR = Path("data/alerts")
WEBHOOK_VARIABLE = "OUSD_ALERT_WEBHOOK_URL"
HEARTBEAT_VARIABLE = "OUSD_HEARTBEAT_URL"
# Enough to say what broke. The traceback is in the run's log.
REASON_LIMIT = 500
# A per-chain summary stays small: a few chains, a few short facts each.
SUMMARY_CHAINS = 8
SUMMARY_FIELDS = 10
SUMMARY_TEXT = 80

type ChainSummary = Mapping[str, Mapping[str, Any]]

# An alert must not hold up a run that has already failed for long: a few short attempts, each
# bounded from connecting to the last byte, and no waiting out a server's rate limit, however
# long it asks for.
OUTBOUND_ATTEMPTS = 3
OUTBOUND_DEADLINE = 15.0

type ClientFactory = Callable[[str], PoliteClient]


def outbound_client(label: str) -> PoliteClient:
    no_waits = WaitBudget()
    no_waits.remaining = 0
    return PoliteClient(
        label=label,
        max_attempts=OUTBOUND_ATTEMPTS,
        deadline=OUTBOUND_DEADLINE,
        timeout=OUTBOUND_DEADLINE,
        waits=no_waits,
    )


def clean_summary(
    chains: ChainSummary | None, env: Mapping[str, str] | None = None
) -> dict[str, dict[str, Any]]:
    """What a payload may carry about each chain: numbers, flags and short scrubbed words, for a
    few chains. Nested values, long text and the rest are dropped, so the payload stays small."""
    cleaned: dict[str, dict[str, Any]] = {}
    for name, facts in list((chains or {}).items())[:SUMMARY_CHAINS]:
        kept: dict[str, Any] = {}
        for key, value in list(facts.items())[:SUMMARY_FIELDS]:
            if isinstance(value, float) and not math.isfinite(value):
                continue
            if isinstance(value, bool) or value is None or isinstance(value, int | float):
                kept[str(key)] = value
            elif isinstance(value, str):
                kept[str(key)] = scrub_secrets(value, env)[:SUMMARY_TEXT]
        cleaned[scrub_secrets(str(name), env)[:SUMMARY_TEXT]] = kept
    return cleaned


@dataclass(frozen=True)
class Alert:
    """What failed, and when. Every text in it has been scrubbed. `chains` is the per-chain
    summary of the run so far, when there is one."""

    run_id: str
    job: str
    step: str
    reason: str
    failed_at: str
    chains: dict[str, dict[str, Any]] = field(default_factory=dict)

    def summary(self) -> str:
        return f"{self.job} run {self.run_id} failed at {self.step}: {self.reason}"

    def payload(self) -> dict[str, Any]:
        """The fields, with no empty `chains`, so a run without a summary reads as it always did."""
        fields = asdict(self)
        if not fields["chains"]:
            del fields["chains"]
        return fields


def describe(exc: BaseException | None, env: Mapping[str, str] | None = None) -> str:
    """One scrubbed line: the error's class and message, cut to a readable length."""
    if exc is None:
        return "unknown error"
    message = " ".join(str(exc).split())
    text = f"{type(exc).__name__}: {message}" if message else type(exc).__name__
    return scrub_secrets(text, env)[:REASON_LIMIT]


def new_alert(
    run_id: str,
    job: str,
    step: str,
    reason: str,
    moment: datetime,
    env: Mapping[str, str] | None = None,
    chains: ChainSummary | None = None,
) -> Alert:
    return Alert(
        run_id=run_id,
        job=job,
        step=step,
        reason=scrub_secrets(reason, env)[:REASON_LIMIT],
        failed_at=moment.strftime("%Y-%m-%dT%H:%M:%SZ"),
        chains=clean_summary(chains, env),
    )


def write_alert(alerts_dir: Path, alert: Alert) -> Path | None:
    """The run's alert file, or None when the run already has one: the first failure is the
    cause, and anything after it is a consequence."""
    alerts_dir.mkdir(parents=True, exist_ok=True)
    path = alerts_dir / f"{alert.run_id}.json"
    # Written whole, then linked into place, so a crash never leaves a partial file that would
    # claim the run. The link fails if the run already has one. The temporary file goes however
    # this ends, a failed write included.
    with tempfile.NamedTemporaryFile("w", dir=alerts_dir, suffix=".tmp", delete=False) as handle:
        try:
            handle.write(json.dumps(alert.payload(), indent=2) + "\n")
            handle.close()
            os.link(handle.name, path)
        except FileExistsError:
            return None
        finally:
            os.unlink(handle.name)
    return path


def _secret_url(name: str, env: Mapping[str, str] | None) -> str:
    return (os.environ if env is None else env).get(name, "").strip()


def post_alert(
    alert: Alert,
    client: ClientFactory = outbound_client,
    env: Mapping[str, str] | None = None,
) -> bool:
    """POST the alert to the webhook when one is set. Never raises: the run's failure is what
    matters, and the file is already written."""
    url = _secret_url(WEBHOOK_VARIABLE, env)
    if not url:
        return False
    # "text" is what chat webhooks show. The rest is for anything that reads the fields.
    payload = {"text": alert.summary(), **alert.payload()}
    try:
        client("alert webhook").request("POST", url, json=payload)
    except Exception as exc:
        log.warning("alert webhook: not delivered: %s", _undelivered(exc, env))
        return False
    return True


def _undelivered(exc: Exception, env: Mapping[str, str] | None) -> str:
    """PoliteClient's own errors are scrubbed against the URL already. Anything else may quote
    it, so only its class is shown."""
    if isinstance(exc, HttpError):
        return scrub_secrets(str(exc), env)
    return type(exc).__name__


def raise_alert(
    alerts_dir: Path,
    alert: Alert,
    client: ClientFactory = outbound_client,
    env: Mapping[str, str] | None = None,
) -> Path | None:
    """Write the alert and post it, once per run. A run that already alerted is left alone, so a
    second failure, or the sensor after the hook, sends nothing more. A file that can't be
    written is logged and the alert still posted: the webhook is the copy someone reads."""
    try:
        path = write_alert(alerts_dir, alert)
    except OSError as exc:
        log.error("alert file not written: %s", type(exc).__name__)
        post_alert(alert, client, env)
        return None
    if path is not None:
        post_alert(alert, client, env)
    return path


def ping_heartbeat(
    client: ClientFactory = outbound_client,
    env: Mapping[str, str] | None = None,
    chains: ChainSummary | None = None,
) -> bool:
    """Ping the heartbeat when one is set. Only a run that published calls this. With a per-chain
    summary the ping is a POST of JSON, and a bare GET if that fails; without one, a bare GET.
    Never raises: a missed ping is what the dead-man check is for."""
    url = _secret_url(HEARTBEAT_VARIABLE, env)
    if not url:
        return False
    try:
        summary = clean_summary(chains, env)
        if summary:
            try:
                client("heartbeat").request("POST", url, json={"chains": summary})
                return True
            except Exception:
                # A dead-man endpoint that takes only GET still gets its ping.
                pass
        client("heartbeat").request("GET", url)
    except Exception as exc:
        log.warning("heartbeat: not delivered: %s", _undelivered(exc, env))
        return False
    return True
