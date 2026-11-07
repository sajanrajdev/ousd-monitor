"""Telling someone how the daily run went: a file per failed run, and two optional outbound calls.

A failure always writes `data/alerts/<run_id>.json`. With OUSD_ALERT_WEBHOOK_URL set it is also
posted there, and with OUSD_HEARTBEAT_URL set a run that published pings that URL, so a dead-man
check notices a run that failed before it could alert, or never started. Both URLs are secrets:
they are read from the environment when used, sent only through PoliteClient, which never logs a
URL, and scrubbed from any error.
"""

import json
import logging
import os
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

from ousd.http import HttpError, PoliteClient, scrub_secrets

log = logging.getLogger(__name__)

WEBHOOK_VARIABLE = "OUSD_ALERT_WEBHOOK_URL"
HEARTBEAT_VARIABLE = "OUSD_HEARTBEAT_URL"
# Enough to say what broke. The traceback is in the run's log.
REASON_LIMIT = 500
# An alert must not hold up a run that has already failed for long.
OUTBOUND_ATTEMPTS = 3

type ClientFactory = Callable[[str], PoliteClient]


def outbound_client(label: str) -> PoliteClient:
    return PoliteClient(label=label, max_attempts=OUTBOUND_ATTEMPTS)


@dataclass(frozen=True)
class Alert:
    """What failed, and when. Every text in it has been scrubbed."""

    run_id: str
    job: str
    step: str
    reason: str
    failed_at: str

    def summary(self) -> str:
        return f"{self.job} run {self.run_id} failed at {self.step}: {self.reason}"


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
) -> Alert:
    return Alert(
        run_id=run_id,
        job=job,
        step=step,
        reason=scrub_secrets(reason, env)[:REASON_LIMIT],
        failed_at=moment.strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


def write_alert(alerts_dir: Path, alert: Alert) -> Path | None:
    """The run's alert file, or None when the run already has one: the first failure is the
    cause, and anything after it is a consequence."""
    alerts_dir.mkdir(parents=True, exist_ok=True)
    path = alerts_dir / f"{alert.run_id}.json"
    try:
        with path.open("x") as handle:
            handle.write(json.dumps(asdict(alert), indent=2) + "\n")
    except FileExistsError:
        return None
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
    payload = {"text": alert.summary(), **asdict(alert)}
    try:
        client("alert webhook").request("POST", url, json=payload)
    except HttpError as exc:
        log.warning("alert webhook: not delivered: %s", scrub_secrets(str(exc), env))
        return False
    return True


def raise_alert(
    alerts_dir: Path,
    alert: Alert,
    client: ClientFactory = outbound_client,
    env: Mapping[str, str] | None = None,
) -> Path | None:
    """Write the alert and post it, once per run. A run that already alerted is left alone, so a
    second failure, or the sensor after the hook, sends nothing more."""
    path = write_alert(alerts_dir, alert)
    if path is not None:
        post_alert(alert, client, env)
    return path


def ping_heartbeat(
    client: ClientFactory = outbound_client, env: Mapping[str, str] | None = None
) -> bool:
    """Ping the heartbeat when one is set. Only a run that published calls this. Never raises: a
    missed ping is what the dead-man check is for."""
    url = _secret_url(HEARTBEAT_VARIABLE, env)
    if not url:
        return False
    try:
        client("heartbeat").request("GET", url)
    except HttpError as exc:
        log.warning("heartbeat: not delivered: %s", scrub_secrets(str(exc), env))
        return False
    return True
