"""Plain logs by default, one scrubbed JSON object per line with OUSD_LOG_FORMAT=json."""

import io
import json
import logging

import pytest
from ousd import logs
from ousd.logs import JsonFormatter, UnknownLogFormat, chain_context, configure_logging, log_format

KEY = "k3y9aZ7QwErTyUiOpAsDfGhJkLzXcVbNm1234567890"
KEYED_URL = f"https://base-rpc.provider.invalid/v2/{KEY}"


def emit(formatter: logging.Formatter, message: str, *args, exc: BaseException | None = None):
    record = logging.LogRecord(
        "ousd.test",
        logging.WARNING,
        __file__,
        1,
        message,
        args,
        (type(exc), exc, None) if exc else None,
    )
    return formatter.format(record)


def test_a_line_is_one_json_object_with_time_level_logger_and_message():
    line = emit(JsonFormatter(), "synced %s", "tempo")
    entry = json.loads(line)
    assert "\n" not in line
    assert entry["level"] == "WARNING"
    assert entry["logger"] == "ousd.test"
    assert entry["message"] == "synced tempo"
    assert entry["time"].endswith("Z")
    assert "run_id" not in entry
    assert "chain" not in entry


def test_run_id_and_chain_appear_when_known():
    logs.run_id_var.set("run-7")
    try:
        with chain_context("base"):
            entry = json.loads(emit(JsonFormatter(), "reading"))
        after = json.loads(emit(JsonFormatter(), "reading"))
    finally:
        logs.run_id_var.set(None)
    assert (entry["run_id"], entry["chain"]) == ("run-7", "base")
    assert "chain" not in after


def test_dagsters_run_id_is_used_for_its_records():
    record = logging.LogRecord("dagster", logging.INFO, __file__, 1, "hello", (), None)
    record.dagster_meta = {"run_id": "run-9"}
    assert json.loads(JsonFormatter().format(record))["run_id"] == "run-9"


def test_a_keyed_url_never_appears_in_a_json_line(monkeypatch):
    monkeypatch.setenv("BASE_RPC_URL", KEYED_URL)
    line = emit(JsonFormatter(), "cannot reach %s with key %s", KEYED_URL, KEY)
    assert KEY not in line
    assert "base-rpc.provider.invalid" not in line


def test_a_keyed_url_in_exception_text_never_appears_either(monkeypatch):
    monkeypatch.setenv("BASE_RPC_URL", KEYED_URL)
    try:
        try:
            raise ConnectionError(f"cannot reach {KEYED_URL}: key {KEY} refused")
        except ConnectionError as cause:
            raise ValueError("upstream said no") from cause
    except ValueError as exc:
        record = logging.LogRecord(
            "ousd.test",
            logging.ERROR,
            __file__,
            1,
            "failed",
            (),
            (type(exc), exc, exc.__traceback__),
        )
    line = JsonFormatter().format(record)
    entry = json.loads(line)
    assert "ConnectionError" in entry["exception"]
    assert "direct cause" in entry["exception"]
    assert KEY not in line
    assert KEY[:12] not in line
    assert "base-rpc.provider.invalid" not in line


def test_an_unconfigured_url_in_a_json_line_is_hidden_too():
    line = emit(JsonFormatter(), "fetching https://other.example.invalid/path?token=abcdef123456")
    assert "other.example.invalid" not in line


def test_plain_is_the_default_and_unchanged():
    assert log_format({}) == "plain"
    assert log_format({"OUSD_LOG_FORMAT": " "}) == "plain"
    assert log_format({"OUSD_LOG_FORMAT": "JSON"}) == "json"
    assert emit(logs.formatter({}), "hello").endswith("WARNING hello")


def test_an_unknown_format_is_refused_naming_the_variable():
    with pytest.raises(UnknownLogFormat, match="OUSD_LOG_FORMAT"):
        log_format({"OUSD_LOG_FORMAT": "yaml"})


def test_configure_logging_writes_json_to_stderr(monkeypatch, capsys):
    monkeypatch.setenv("OUSD_LOG_FORMAT", "json")
    configure_logging(verbose=True)
    logging.getLogger("ousd.test").info("hello")
    captured = capsys.readouterr()
    assert json.loads(captured.err.strip())["message"] == "hello"
    assert captured.out == ""


def test_configure_logging_replaces_only_its_own_handler():
    root = logging.getLogger()
    other = logging.NullHandler()
    root.addHandler(other)
    configure_logging(verbose=False, env={})
    configure_logging(verbose=False, env={"OUSD_LOG_FORMAT": "json"})
    ours = [h for h in root.handlers if getattr(h, logs.OWN_HANDLER_MARK, False)]
    assert len(ours) == 1
    assert isinstance(ours[0].formatter, JsonFormatter)
    assert other in root.handlers


def test_configure_logging_keeps_plain_text_without_the_variable(monkeypatch, capsys):
    monkeypatch.delenv("OUSD_LOG_FORMAT", raising=False)
    configure_logging(verbose=False)
    log = logging.getLogger("ousd.test")
    log.info("quiet")
    log.warning("loud")
    err = capsys.readouterr().err
    assert "quiet" not in err
    assert err.rstrip().endswith("WARNING loud")


def test_the_cli_refuses_an_unknown_format(monkeypatch, capsys):
    from ousd import cli

    monkeypatch.setenv("OUSD_LOG_FORMAT", "yaml")
    with pytest.raises(SystemExit) as exit_info:
        cli.main(["migrate"])
    assert exit_info.value.code == 2
    assert "OUSD_LOG_FORMAT" in capsys.readouterr().err


def test_a_stream_handler_with_the_formatter_gets_json():
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    log = logging.getLogger("ousd.stream")
    log.addHandler(handler)
    try:
        log.error("boom")
    finally:
        log.removeHandler(handler)
    assert json.loads(stream.getvalue())["message"] == "boom"


def test_a_bad_format_does_not_stop_the_alert_or_heartbeat_commands(monkeypatch, capsys):
    from ousd import cli

    monkeypatch.setenv("OUSD_LOG_FORMAT", "yaml")
    monkeypatch.delenv("OUSD_HEARTBEAT_URL", raising=False)
    assert cli.main(["heartbeat"]) == 0
    assert "using plain logs" in capsys.readouterr().err
