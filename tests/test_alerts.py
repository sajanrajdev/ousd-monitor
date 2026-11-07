"""The alert file, the optional webhook and the optional heartbeat, with no network."""

import json
import logging
from datetime import UTC, datetime

import httpx
import pytest
from ousd import alerts, cli
from ousd.alerts import Alert, describe, new_alert, ping_heartbeat, post_alert, raise_alert
from ousd.http import PoliteClient

NOW = datetime(2026, 11, 4, 6, 0, tzinfo=UTC)
KEY = "k3y9aZ7QwErTyUiOpAsDfGhJkLzXcVbNm1234567890"
KEYED_URL = f"https://base-rpc.provider.invalid/v2/{KEY}"
WEBHOOK = "https://hooks.example.invalid/services/T000/B000/w3bh00kS3cr3tT0k3n"
HEARTBEAT = "https://hc-ping.example.invalid/5f0e1d2c-3b4a-4968-8776-655443322110"


class Outbound:
    def __init__(self, status: int = 200):
        self.status = status
        self.requests: list[httpx.Request] = []
        self.labels: list[str] = []

    def __call__(self, label: str) -> PoliteClient:
        self.labels.append(label)
        return PoliteClient(
            label=label,
            min_interval=0,
            max_attempts=alerts.OUTBOUND_ATTEMPTS,
            transport=httpx.MockTransport(self.handle),
            sleep=lambda seconds: None,
        )

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status, text="ok")


@pytest.fixture(autouse=True)
def debug_logging(caplog):
    caplog.set_level(logging.DEBUG)


def an_alert(run_id: str = "run-1", reason: str = "Failure: dbt build failed") -> Alert:
    return new_alert(run_id, "ousd_daily", "dbt_marts", reason, NOW, env={})


def test_the_alert_file_holds_the_run_the_step_the_reason_and_when(tmp_path):
    path = alerts.write_alert(tmp_path / "alerts", an_alert())
    assert path is not None
    assert path == tmp_path / "alerts" / "run-1.json"
    assert json.loads(path.read_text()) == {
        "run_id": "run-1",
        "job": "ousd_daily",
        "step": "dbt_marts",
        "reason": "Failure: dbt build failed",
        "failed_at": "2026-11-04T06:00:00Z",
    }


def test_a_run_alerts_once_and_the_first_failure_wins(tmp_path):
    outbound = Outbound()
    env = {"OUSD_ALERT_WEBHOOK_URL": WEBHOOK}
    first = raise_alert(tmp_path, an_alert(reason="first"), outbound, env)
    second = raise_alert(tmp_path, an_alert(reason="second"), outbound, env)
    assert first is not None
    assert second is None
    assert json.loads(first.read_text())["reason"] == "first"
    assert len(outbound.requests) == 1


def test_the_reason_is_scrubbed_of_configured_and_unknown_urls():
    env = {"BASE_RPC_URL": KEYED_URL}
    alert = new_alert(
        "r", "ousd_daily", "s", f"saw {KEYED_URL}, {KEY} and http://x.invalid/a", NOW, env
    )
    assert alert.reason == "saw <BASE_RPC_URL>, <BASE_RPC_URL> and <url>"


def test_describe_names_the_class_scrubs_and_cuts_to_one_line():
    env = {"BASE_RPC_URL": KEYED_URL}
    text = describe(RuntimeError(f"line one\nkey {KEY}\n" + "x" * 900), env)
    assert text.startswith("RuntimeError: line one key <BASE_RPC_URL> x")
    assert "\n" not in text
    assert len(text) == alerts.REASON_LIMIT
    assert describe(TimeoutError(), env) == "TimeoutError"
    assert describe(None, env) == "unknown error"


def test_without_a_webhook_nothing_is_posted(tmp_path):
    outbound = Outbound()
    assert raise_alert(tmp_path, an_alert(), outbound, {}) is not None
    assert post_alert(an_alert(), outbound, {"OUSD_ALERT_WEBHOOK_URL": "  "}) is False
    assert outbound.labels == []


def test_the_webhook_gets_a_short_json_summary():
    outbound = Outbound()
    assert post_alert(an_alert(), outbound, {"OUSD_ALERT_WEBHOOK_URL": WEBHOOK})
    [request] = outbound.requests
    assert request.method == "POST"
    assert str(request.url) == WEBHOOK
    assert json.loads(request.content) == {
        "text": "ousd_daily run run-1 failed at dbt_marts: Failure: dbt build failed",
        "run_id": "run-1",
        "job": "ousd_daily",
        "step": "dbt_marts",
        "reason": "Failure: dbt build failed",
        "failed_at": "2026-11-04T06:00:00Z",
    }


@pytest.mark.parametrize("status", [404, 500])
def test_an_undeliverable_webhook_is_logged_without_its_url_and_never_raises(status, caplog):
    outbound = Outbound(status=status)
    assert post_alert(an_alert(), outbound, {"OUSD_ALERT_WEBHOOK_URL": WEBHOOK}) is False
    assert "alert webhook: not delivered" in caplog.text
    assert "w3bh00kS3cr3tT0k3n" not in caplog.text
    assert "hooks.example.invalid" not in caplog.text


def test_a_webhook_that_echoes_its_url_is_scrubbed(caplog):
    class Echo(Outbound):
        def handle(self, request):
            return httpx.Response(403, text=f"no such hook {request.url}")

    assert post_alert(an_alert(), Echo(), {"OUSD_ALERT_WEBHOOK_URL": WEBHOOK}) is False
    assert "no such hook" in caplog.text
    assert "w3bh00kS3cr3tT0k3n" not in caplog.text


def test_the_heartbeat_pings_only_when_set():
    outbound = Outbound()
    assert ping_heartbeat(outbound, {}) is False
    assert outbound.requests == []
    assert ping_heartbeat(outbound, {"OUSD_HEARTBEAT_URL": HEARTBEAT})
    [request] = outbound.requests
    assert (request.method, str(request.url)) == ("GET", HEARTBEAT)


def test_a_failed_heartbeat_is_logged_without_its_url_and_never_raises(caplog):
    assert ping_heartbeat(Outbound(status=503), {"OUSD_HEARTBEAT_URL": HEARTBEAT}) is False
    assert "heartbeat: not delivered" in caplog.text
    assert "655443322110" not in caplog.text


def test_a_partly_written_alert_never_claims_the_run(tmp_path):
    alerts.write_alert(tmp_path, an_alert())
    assert [path.name for path in tmp_path.iterdir()] == ["run-1.json"]


def test_an_unwritable_alerts_folder_is_logged_and_the_webhook_still_posts(tmp_path, caplog):
    blocked = tmp_path / "alerts"
    blocked.write_text("a file where the folder should be")
    outbound = Outbound()
    path = raise_alert(blocked, an_alert(), outbound, {"OUSD_ALERT_WEBHOOK_URL": WEBHOOK})
    assert path is None
    assert len(outbound.requests) == 1
    assert "alert file not written: FileExistsError" in caplog.text


@pytest.mark.parametrize("status", [301, 302, 307])
def test_a_redirect_is_not_a_delivery(status):
    outbound = Outbound(status=status)
    assert post_alert(an_alert(), outbound, {"OUSD_ALERT_WEBHOOK_URL": WEBHOOK}) is False
    assert ping_heartbeat(outbound, {"OUSD_HEARTBEAT_URL": HEARTBEAT}) is False


def test_an_unexpected_error_quoting_the_url_shows_only_its_class(caplog):
    def broken(label):
        raise RuntimeError(f"cannot build a client for {WEBHOOK}")

    env = {"OUSD_ALERT_WEBHOOK_URL": WEBHOOK, "OUSD_HEARTBEAT_URL": HEARTBEAT}
    assert post_alert(an_alert(), broken, env) is False
    assert ping_heartbeat(broken, env) is False
    assert "not delivered: RuntimeError" in caplog.text
    assert "w3bh00kS3cr3tT0k3n" not in caplog.text


def test_the_real_outbound_client_never_waits_out_a_rate_limit(monkeypatch):
    sleeps: list[float] = []
    requests: list[httpx.Request] = []

    def handle(request):
        requests.append(request)
        return httpx.Response(429, headers={"retry-after": "3600"})

    real = alerts.PoliteClient

    def mocked(**options):
        return real(transport=httpx.MockTransport(handle), sleep=sleeps.append, **options)

    monkeypatch.setattr(alerts, "PoliteClient", mocked)
    assert post_alert(an_alert(), env={"OUSD_ALERT_WEBHOOK_URL": WEBHOOK}) is False
    assert ping_heartbeat(env={"OUSD_HEARTBEAT_URL": HEARTBEAT}) is False
    assert sleeps == []
    assert len(requests) == 2


def mock_outbound(monkeypatch, status: int) -> list[httpx.Request]:
    requests: list[httpx.Request] = []

    def handle(request):
        requests.append(request)
        return httpx.Response(status, text="ok")

    real = alerts.PoliteClient
    monkeypatch.setattr(
        alerts,
        "PoliteClient",
        lambda **options: real(
            transport=httpx.MockTransport(handle), sleep=lambda seconds: None, **options
        ),
    )
    return requests


def test_the_cli_alert_records_a_daily_step_and_posts_it(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OUSD_ALERT_WEBHOOK_URL", WEBHOOK)
    requests = mock_outbound(monkeypatch, 200)
    reason = f"make web-release failed near {KEYED_URL}"
    assert cli.main(["alert", "--step", "release", "--reason", reason]) == 0
    [path] = (tmp_path / "data" / "alerts").glob("daily-*.json")
    alert = json.loads(path.read_text())
    assert (alert["job"], alert["step"]) == ("daily", "release")
    assert alert["reason"] == "make web-release failed near <url>"
    assert path.stem == alert["run_id"]
    assert len(requests) == 1
    assert WEBHOOK not in capsys.readouterr().out


def test_the_cli_alert_exits_0_even_when_nothing_can_be_delivered(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OUSD_ALERT_WEBHOOK_URL", WEBHOOK)
    mock_outbound(monkeypatch, 500)
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "alerts").write_text("not a folder")
    assert cli.main(["alert", "--step", "deploy", "--reason", "vercel deploy exited 1."]) == 0


def test_the_cli_heartbeat_says_what_happened(monkeypatch, capsys):
    monkeypatch.delenv("OUSD_HEARTBEAT_URL", raising=False)
    assert cli.main(["heartbeat"]) == 0
    assert "not set, so nothing was sent" in capsys.readouterr().out

    monkeypatch.setenv("OUSD_HEARTBEAT_URL", HEARTBEAT)
    requests = mock_outbound(monkeypatch, 200)
    assert cli.main(["heartbeat"]) == 0
    assert [str(request.url) for request in requests] == [HEARTBEAT]

    mock_outbound(monkeypatch, 503)
    assert cli.main(["heartbeat"]) == 1
    captured = capsys.readouterr()
    assert "heartbeat: not delivered" in captured.err
    assert "655443322110" not in captured.out + captured.err


@pytest.mark.parametrize("command", [["alert", "--step", "s", "--reason", "r"], ["heartbeat"]])
def test_the_cli_alert_commands_take_no_chain(command):
    with pytest.raises(SystemExit):
        cli.main(["--chain", "tempo", *command])
