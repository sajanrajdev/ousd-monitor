"""The Dagster run, driven with fakes: no network, no .env, and dbt either fake or run on a
throwaway database. The module is loaded as a file, the way `dagster -f` loads it."""

import csv
import hashlib
import importlib.util
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import time
from datetime import timedelta
from pathlib import Path

import dagster as dg
import httpx
import pytest
from conftest import FakeRpc, make_chain, rows
from dagster._core.execution.plan.active import ActiveExecution
from dbt_helpers import invoke_dbt
from ousd import checks as ousd_checks
from ousd.chains import REQUIRED_CHAINS
from ousd.checks import CHECK_NAMES, CheckResult
from ousd.http import RATE_LIMIT_WAITS, SECRET_URL_VARIABLES, PoliteClient
from ousd.ingest import SyncResult, sync_chain
from ousd.reconcile import (
    BridgeComparison,
    BridgeFigures,
    ChainReconciliation,
    CheckOutcome,
    RunResult,
)
from ousd.sources import BridgeSnapshot
from ousd.store import Status, Store
from publish_world import NOW, World, build_world

DEFINITIONS = Path(__file__).resolve().parent.parent / "pipeline" / "dagster" / "definitions.py"
KEYS = ["raw_transfers", "chain_reconciliations", "dbt_marts", "published_dataset"]
LEAK = "https://rpc.example.invalid/v2/not-a-real-key"
KEY = "k3y9aZ7QwErTyUiOpAsDfGhJkLzXcVbNm1234567890"
KEYED_URL = f"https://base-rpc.provider.invalid/v2/{KEY}"
WEBHOOK = "https://hooks.example.invalid/services/T000/B000/w3bh00kS3cr3tT0k3n"
HEARTBEAT = "https://hc-ping.example.invalid/5f0e1d2c-3b4a-4968-8776-655443322110"


def load_definitions():
    spec = importlib.util.spec_from_file_location("ousd_dagster_definitions", DEFINITIONS)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def module():
    return load_definitions()


@pytest.fixture(scope="module")
def template(tmp_path_factory):
    return build_world(tmp_path_factory.mktemp("dagster-world"))


@pytest.fixture
def world(template, tmp_path):
    yield template.copy(tmp_path / "world")
    shutil.rmtree(tmp_path)


class Calls:
    """Counts what the run asked of each fake."""

    def __init__(self):
        self.sync = 0
        self.reconcile = 0
        self.dbt = 0
        self.checks = 0
        self.fail_sync_times = 0
        self.reconcile_status: Status = "pass"
        self.reconcile_scope = "full"
        self.dbt_exit = 0


@pytest.fixture
def calls(module, monkeypatch):
    calls = Calls()

    def fake_reconciliation(probes, store, report, **kwargs):
        calls.reconcile += 1
        if calls.reconcile_status == "pass":
            # The world already holds a passing run its marts were built from. A second run with
            # the same figures would make the marts ambiguous about which run they came from.
            latest = store.latest_reconciliation()
            assert latest
            run_id = latest.run_id
        else:
            run_id = store.start_run("full")
            store.finish_run(run_id, "fail", 1)
        status = calls.reconcile_status
        return RunResult(
            run_id, calls.reconcile_scope, status, 0 if status == "pass" else 1, {}, status, []
        )

    real_run_checks = module.run_checks

    def counted_run_checks(*args, **kwargs):
        calls.checks += 1
        return real_run_checks(*args, **kwargs)

    monkeypatch.setattr(module, "run_reconciliation", fake_reconciliation)
    monkeypatch.setattr(module, "run_checks", counted_run_checks)
    return calls


def pipeline_for(module, world: World, calls: Calls, **overrides):
    def sync(chain, store):
        calls.sync += 1
        if calls.fail_sync_times:
            calls.fail_sync_times -= 1
            raise RuntimeError(f"{LEAK} refused")
        return SyncResult(chain.name, 120, 120, None, 0)

    def dbt_build(timeout):
        calls.dbt += 1
        if calls.dbt_exit:
            return calls.dbt_exit
        # The marts must come from the run just recorded, as the real build's do.
        with open(world.path / "labels.csv", newline="") as handle:
            labels = list(csv.DictReader(handle))
        return 0 if invoke_dbt(world.path, labels).success else 1

    settings = {
        "raw_path": world.raw,
        "marts_path": world.marts_file,
        "published_dir": world.out,
        "alerts_dir": world.path / "alerts",
        "sources": world.sources,
        "chains": lambda: [make_chain(name="tempo")],
        "sync": sync,
        "probes": lambda chains, store: [],
        "dbt_build": dbt_build,
        "now": lambda: NOW,
        "retry_delay": 0,
    }
    return module.Pipeline(**{**settings, **overrides})


def run_job(module, pipeline, raise_on_error=False):
    job = module.build_definitions(pipeline).resolve_job_def(module.JOB_NAME)
    return job.execute_in_process(raise_on_error=raise_on_error)


def materialized(result) -> set[str]:
    return {
        event.asset_key.to_user_string()
        for event in result.get_asset_materialization_events()
        if event.asset_key
    }


def everything_logged(result) -> str:
    return "\n".join(repr(event) for event in result.all_events)


def latest_files(world: World) -> dict[str, bytes]:
    folder = (world.out / "latest").resolve()
    return {path.name: path.read_bytes() for path in sorted(folder.iterdir())}


def publish_once(world: World) -> None:
    world.run_checks()
    world.publish()


def test_there_is_no_package_file_to_shadow_dagster():
    assert not (DEFINITIONS.parent / "__init__.py").exists()
    assert dg.__file__ and "site-packages" in dg.__file__


def test_definitions_load_with_the_job_schedule_and_seven_blocking_checks(module):
    defs = module.build_definitions()
    job = defs.resolve_job_def("ousd_daily")
    assert {key.to_user_string() for key in defs.resolve_asset_graph().get_all_asset_keys()} == set(
        KEYS
    )
    specs = [spec for check in defs.asset_checks for spec in check.check_specs]
    assert sorted(spec.name for spec in specs) == sorted(CHECK_NAMES)
    assert len(specs) == 7
    assert all(spec.blocking for spec in specs)
    assert {spec.key.asset_key.to_user_string() for spec in specs} == {"dbt_marts"}
    assert job.executor_def is dg.in_process_executor
    assert [s.name for s in defs.schedules] == ["ousd_daily_schedule"]
    assert module.defs.resolve_job_def("ousd_daily")


def test_the_schedule_is_six_utc_every_day(module):
    schedule = module.build_definitions().schedules[0]
    assert schedule.cron_schedule == "0 6 * * *"
    assert schedule.execution_timezone == "UTC"


def test_retries_are_only_on_ingest_and_reconciliation(module):
    defs = module.build_definitions()
    by_name = {a.key.to_user_string(): a for a in defs.assets}
    assert by_name["raw_transfers"].op.retry_policy.max_retries == 2
    assert by_name["raw_transfers"].op.retry_policy.delay == 300
    assert by_name["chain_reconciliations"].op.retry_policy.max_retries == 2
    assert by_name["dbt_marts"].op.retry_policy is None
    assert by_name["published_dataset"].op.retry_policy is None


def test_happy_path_runs_ingest_to_publish(module, world, calls):
    result = run_job(module, pipeline_for(module, world, calls))
    assert result.success
    assert materialized(result) == set(KEYS)
    assert (world.out / "latest" / "manifest.json").exists()
    manifest = json.loads((world.out / "latest" / "manifest.json").read_text())
    assert manifest["stale"] is False
    assert calls.reconcile == 1
    assert calls.checks == 1
    with world.store() as store:
        recorded = {c.check_name: c.status for c in store.check_results(result.run_id)}
    assert recorded == dict.fromkeys(CHECK_NAMES, "passed")


def test_a_failed_blocking_check_stops_publishing_and_marks_the_last_dataset_stale(
    module, world, calls, monkeypatch
):
    publish_once(world)
    before = latest_files(world)
    before_manifest = json.loads(before["manifest.json"])
    monkeypatch.setattr(
        ousd_checks,
        "volume_waterfall",
        lambda marts, chains: CheckResult("volume_waterfall", "failed", True, "forced"),
    )

    result = run_job(module, pipeline_for(module, world, calls, now=lambda: NOW + timedelta(1)))

    assert not result.success
    assert "published_dataset" not in materialized(result)
    assert calls.checks == 1
    after = latest_files(world)
    assert {k: v for k, v in after.items() if k != "manifest.json"} == {
        k: v for k, v in before.items() if k != "manifest.json"
    }
    manifest = json.loads(after["manifest.json"])
    assert manifest["stale"] is True
    assert manifest["dataset_version"] == before_manifest["dataset_version"]
    with world.store() as store:
        recorded = {c.check_name: c.status for c in store.check_results(result.run_id)}
    assert recorded["volume_waterfall"] == "failed"


def test_a_failed_check_is_never_retried(module, world, calls, monkeypatch):
    monkeypatch.setattr(
        ousd_checks,
        "freshness",
        lambda store, chains, now: CheckResult("freshness", "failed", True, "forced"),
    )
    result = run_job(module, pipeline_for(module, world, calls))
    assert not result.success
    assert calls.checks == 1
    assert calls.sync == 1


def test_a_reconciliation_that_is_not_a_pass_fails_the_asset_once_and_runs_nothing_after(
    module, world, calls
):
    publish_once(world)
    calls.reconcile_status = "fail"
    result = run_job(module, pipeline_for(module, world, calls))
    assert not result.success
    assert calls.reconcile == 1
    assert calls.dbt == 0
    assert calls.checks == 0
    assert materialized(result) == {"raw_transfers"}
    assert json.loads(latest_files(world)["manifest.json"])["stale"] is True


def test_unchecked_reconciliation_is_not_a_pass_either(module, world, calls):
    calls.reconcile_status = "unchecked"
    result = run_job(module, pipeline_for(module, world, calls))
    assert not result.success
    assert calls.reconcile == 1
    assert calls.dbt == 0


def test_a_dbt_failure_stops_everything_downstream(module, world, calls):
    publish_once(world)
    before = latest_files(world)
    calls.dbt_exit = 1
    result = run_job(module, pipeline_for(module, world, calls))
    assert not result.success
    assert materialized(result) == {"raw_transfers", "chain_reconciliations"}
    assert calls.checks == 0
    assert {k: v for k, v in latest_files(world).items() if k != "manifest.json"} == {
        k: v for k, v in before.items() if k != "manifest.json"
    }


def test_a_negative_balance_makes_the_real_dbt_build_fail_the_asset(module, world, calls, tmp_path):
    from dbt_helpers import failed_tests, run_dbt
    from test_supply_journey import SINK, WALLET, at, transfers

    outcome = {}

    def dbt_build(timeout):
        result = run_dbt(
            tmp_path / "negative",
            transfers("tempo", [at(5, WALLET, SINK, 10)]),
            labels=[],
            sync_state={"tempo": 10_000},
        )
        outcome["failed"] = failed_tests(result)
        return 0 if result.success else 1

    (tmp_path / "negative").mkdir()
    result = run_job(module, pipeline_for(module, world, calls, dbt_build=dbt_build))
    assert not result.success
    assert "assert_no_negative_balances" in outcome["failed"]
    assert "dbt_marts" not in materialized(result)
    assert "published_dataset" not in materialized(result)
    assert calls.checks == 0
    assert not (world.out / "latest").exists()


def test_a_transient_source_error_is_retried_and_then_succeeds(module, world, calls):
    calls.fail_sync_times = 1
    result = run_job(module, pipeline_for(module, world, calls))
    assert result.success
    assert calls.sync == 2
    assert materialized(result) == set(KEYS)
    # A retried attempt is not a failure.
    assert not (world.path / "alerts").exists()


def test_a_source_that_keeps_failing_gives_up_after_two_retries(module, world, calls):
    calls.fail_sync_times = 99
    result = run_job(module, pipeline_for(module, world, calls))
    assert not result.success
    assert calls.sync == 3
    assert calls.reconcile == 0


def test_no_url_from_a_provider_reaches_the_event_log(module, world, calls):
    calls.fail_sync_times = 99
    result = run_job(module, pipeline_for(module, world, calls))
    text = everything_logged(result)
    assert "RuntimeError" in text
    assert LEAK not in text
    assert "rpc.example.invalid" not in text


def test_a_second_run_with_no_new_data_changes_no_raw_rows(module, tmp_path, monkeypatch):
    chain = make_chain()
    rpc = FakeRpc(tip=120)
    rpc.add_transfer(105, 1)
    rpc.add_transfer(118, 2)
    raw = tmp_path / "ousd.duckdb"

    def sync(chain, store):
        return sync_chain(chain, rpc, store)

    pipeline = module.Pipeline(
        raw_path=raw,
        marts_path=tmp_path / "marts.duckdb",
        published_dir=tmp_path / "published",
        alerts_dir=tmp_path / "alerts",
        chains=lambda: [chain],
        sync=sync,
        retry_delay=0,
    )
    only_ingest = module.build_definitions(pipeline).resolve_implicit_global_asset_job_def()

    assert only_ingest.execute_in_process(asset_selection=[dg.AssetKey("raw_transfers")]).success
    store = Store(raw)
    first = rows(store)
    store.close()
    assert first

    assert only_ingest.execute_in_process(asset_selection=[dg.AssetKey("raw_transfers")]).success
    store = Store(raw)
    try:
        assert rows(store) == first
        assert store.synced_through("testnet") == 120
    finally:
        store.close()


def test_the_store_is_closed_between_assets(module, world, calls):
    result = run_job(module, pipeline_for(module, world, calls))
    assert result.success
    # Another process can open the file for writing once the run is over.
    Store(world.raw).close()


def test_a_schema_newer_than_the_code_fails_the_asset_once_and_names_no_path(module, world, calls):
    with world.store() as store:
        store.db.execute("INSERT INTO schema_migrations (version, name) VALUES (999, 'later')")
    pipeline = pipeline_for(module, world, calls)
    with pytest.raises(dg.Failure) as stopped:
        module._open_store(pipeline)
    assert stopped.value.allow_retries is False
    assert "newer than this code" in str(stopped.value.description)
    assert str(world.path) not in str(stopped.value.description)

    result = run_job(module, pipeline)
    assert not result.success
    assert calls.sync == 0
    assert str(world.path) not in everything_logged(result)


def test_the_failure_sensor_stays_for_dagster_dev_and_alerts_only_once(
    module, world, calls, outbound
):
    calls.dbt_exit = 1
    pipeline = pipeline_for(module, world, calls, outbound=outbound)
    defs = module.build_definitions(pipeline)
    assert [s.name for s in defs.sensors] == ["alert_on_failure"]
    with dg.instance_for_test() as instance:
        result = defs.resolve_job_def(module.JOB_NAME).execute_in_process(
            instance=instance, raise_on_error=False
        )
        assert not result.success
        failure = next(
            e for e in result.all_events if e.event_type == dg.DagsterEventType.RUN_FAILURE
        )

        def evaluate():
            context = dg.build_run_status_sensor_context(
                sensor_name="alert_on_failure",
                dagster_event=failure,
                dagster_instance=instance,
                dagster_run=result.dagster_run,
            ).for_run_failure()
            defs.sensors[0](context)

        # The hook already alerted, so the sensor adds nothing.
        evaluate()
        assert [a["step"] for a in alerts_in(world)] == ["dbt_marts"]
        assert len(outbound.to(WEBHOOK)) == 1
        # A run that died outside a step left no alert, and then the sensor writes one.
        (world.path / "alerts" / f"{result.run_id}.json").unlink()
        evaluate()
    [alert] = alerts_in(world)
    assert alert["step"] == "run"
    assert "Steps failed" in alert["reason"]
    assert len(outbound.to(WEBHOOK)) == 2


def test_the_real_dbt_command_builds_the_project_with_the_repo_profile(module, monkeypatch):
    seen = {}

    def fake_run(command, check, timeout):
        seen["command"] = command
        seen["check"] = check
        seen["timeout"] = timeout

        class Done:
            returncode = 3

        return Done()

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    assert module.run_dbt_build() == 3
    assert seen["command"][1:] == [
        "build",
        "--project-dir",
        "dbt",
        "--profiles-dir",
        "dbt",
    ]
    assert seen["check"] is False
    assert seen["timeout"] == 1800


def test_missing_keys_stop_the_run_before_any_sync_and_name_only_variables(module, monkeypatch):
    monkeypatch.delenv("BASE_RPC_URL", raising=False)
    monkeypatch.delenv("SOLANA_RPC_URL", raising=False)
    with pytest.raises(dg.Failure) as stopped:
        module._load_chains()
    assert "BASE_RPC_URL" in str(stopped.value.description)
    assert "http" not in str(stopped.value.description)


def test_every_required_chain_is_a_chain_the_run_loads(module, monkeypatch):
    monkeypatch.setenv("BASE_RPC_URL", "http://base.invalid")
    monkeypatch.setenv("SOLANA_RPC_URL", "http://solana.invalid")
    assert {chain.name for chain in module._load_chains()} == set(REQUIRED_CHAINS)


def test_a_pass_over_a_partial_scope_is_not_a_pass(module, world, calls):
    calls.reconcile_scope = "partial"
    result = run_job(module, pipeline_for(module, world, calls))
    assert not result.success
    assert calls.reconcile == 1
    assert calls.dbt == 0


class Outbound:
    """Records every outbound request instead of sending it."""

    def __init__(self, status: int = 200):
        self.status = status
        self.requests: list[httpx.Request] = []

    def __call__(self, label: str) -> PoliteClient:
        return PoliteClient(
            label=label,
            min_interval=0,
            max_attempts=3,
            transport=httpx.MockTransport(self.handle),
            sleep=lambda seconds: None,
        )

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status, text="ok")

    def to(self, url: str) -> list[httpx.Request]:
        return [request for request in self.requests if str(request.url) == url]


def alerts_in(world: World) -> list[dict]:
    folder = world.path / "alerts"
    return [json.loads(path.read_text()) for path in sorted(folder.glob("*.json"))]


@pytest.fixture
def outbound(monkeypatch):
    monkeypatch.setenv("OUSD_ALERT_WEBHOOK_URL", WEBHOOK)
    monkeypatch.setenv("OUSD_HEARTBEAT_URL", HEARTBEAT)
    return Outbound()


def test_a_failed_run_writes_the_alert_in_process(module, world, calls):
    calls.dbt_exit = 1
    result = run_job(module, pipeline_for(module, world, calls))
    assert not result.success
    [alert] = alerts_in(world)
    chains = alert.pop("chains")
    assert alert == {
        "run_id": result.run_id,
        "job": "ousd_daily",
        "step": "dbt_marts",
        "reason": "Failure: dbt build failed",
        "failed_at": "2026-11-04T06:00:00Z",
    }
    # The sync and the reconciliation that came before the failure are in the summary.
    assert chains["tempo"]["sync"] == "ok"
    assert chains["bridge"] == {"reconciliation": "pass"}


def test_a_failed_blocking_check_alerts_too(module, world, calls, monkeypatch):
    monkeypatch.setattr(
        ousd_checks,
        "freshness",
        lambda store, chains, now: CheckResult("freshness", "failed", True, "forced"),
    )
    result = run_job(module, pipeline_for(module, world, calls))
    assert not result.success
    [alert] = alerts_in(world)
    assert alert["step"] == "blocking_checks"
    assert "freshness" in alert["reason"]


def test_a_failure_posts_the_summary_and_never_pings_the_heartbeat(
    module, world, calls, outbound, capsys, caplog
):
    calls.fail_sync_times = 99
    result = run_job(module, pipeline_for(module, world, calls, outbound=outbound))
    assert not result.success
    assert outbound.to(HEARTBEAT) == []
    [posted] = outbound.to(WEBHOOK)
    assert posted.method == "POST"
    body = json.loads(posted.content)
    assert body["run_id"] == result.run_id
    assert body["step"] == "raw_transfers"
    assert body["failed_at"] == "2026-11-04T06:00:00Z"
    assert body["reason"].startswith("RuntimeError: tempo: sync failed: RuntimeError: <url>")
    assert body["text"].startswith(f"ousd_daily run {result.run_id} failed at raw_transfers")
    assert body["chains"] == {"tempo": {"sync": "failed"}}
    assert LEAK not in posted.content.decode()
    # Retried attempts are not failures: one alert, for the last.
    assert calls.sync == 3
    assert len(alerts_in(world)) == 1
    captured = capsys.readouterr()
    for text in (everything_logged(result), caplog.text, captured.out, captured.err):
        assert WEBHOOK not in text
        assert "w3bh00kS3cr3tT0k3n" not in text
        assert HEARTBEAT not in text


def test_an_undeliverable_webhook_never_shows_its_url_or_hides_the_failure(
    module, world, calls, monkeypatch, capsys, caplog
):
    monkeypatch.setenv("OUSD_ALERT_WEBHOOK_URL", WEBHOOK)
    outbound = Outbound(status=500)
    calls.dbt_exit = 1
    result = run_job(module, pipeline_for(module, world, calls, outbound=outbound))
    assert not result.success
    assert len(outbound.to(WEBHOOK)) == 3
    assert alerts_in(world)[0]["step"] == "dbt_marts"
    assert "alert webhook: not delivered" in caplog.text
    captured = capsys.readouterr()
    for text in (everything_logged(result), caplog.text, captured.out, captured.err):
        assert "w3bh00kS3cr3tT0k3n" not in text
        assert "hooks.example.invalid" not in text


def test_a_successful_run_pings_the_heartbeat_once_and_alerts_nothing(
    module, world, calls, outbound
):
    result = run_job(module, pipeline_for(module, world, calls, outbound=outbound))
    assert result.success
    [ping] = outbound.requests
    assert str(ping.url) == HEARTBEAT
    # The ping carries the per-chain summary, so it is a POST.
    assert ping.method == "POST"
    chains = json.loads(ping.content)["chains"]
    assert chains["tempo"]["sync"] == "ok"
    assert set(chains["tempo"]) <= {"sync", "cursor", "tip", "lag", "reorg_depth", "rows_added"}
    assert alerts_in(world) == []


def test_without_the_urls_nothing_is_sent(module, world, calls, monkeypatch):
    monkeypatch.delenv("OUSD_ALERT_WEBHOOK_URL", raising=False)
    monkeypatch.delenv("OUSD_HEARTBEAT_URL", raising=False)
    outbound = Outbound()
    assert run_job(module, pipeline_for(module, world, calls, outbound=outbound)).success
    calls.dbt_exit = 1
    assert not run_job(module, pipeline_for(module, world, calls, outbound=outbound)).success
    assert outbound.requests == []
    assert len(alerts_in(world)) == 1


def test_a_keyed_url_inside_an_exception_chain_never_reaches_the_log(
    module, world, calls, monkeypatch, capsys, caplog
):
    monkeypatch.setenv("BASE_RPC_URL", KEYED_URL)

    def sync(chain, store):
        try:
            raise ConnectionError(f"cannot reach {KEYED_URL}: key {KEY} refused")
        except ConnectionError as exc:
            raise ValueError("upstream said no") from exc

    result = run_job(module, pipeline_for(module, world, calls, sync=sync))
    assert not result.success
    captured = capsys.readouterr()
    # Dagster's console log, where context.log writes.
    logged = captured.err
    # The traceback is kept, with its cause, so the log says where the error came from.
    assert "Traceback" in logged
    assert "ConnectionError: cannot reach <BASE_RPC_URL>: key <BASE_RPC_URL> refused" in logged
    assert "direct cause" in logged
    events = everything_logged(result)
    for text in (events, logged, caplog.text, captured.out, json.dumps(alerts_in(world))):
        assert KEY not in text
        assert KEY[:12] not in text
        assert "base-rpc.provider.invalid" not in text


def test_the_run_time_limit_fires_stops_the_step_without_a_retry_and_alerts(
    module, world, calls, outbound
):
    def stuck_sync(chain, store):
        calls.sync += 1
        time.sleep(120)
        return "never"

    started = time.monotonic()
    result = run_job(
        module,
        pipeline_for(module, world, calls, sync=stuck_sync, outbound=outbound, max_runtime=3),
    )
    assert time.monotonic() - started < 60
    assert not result.success
    assert calls.sync == 1
    [alert] = alerts_in(world)
    assert alert["step"] == "raw_transfers"
    assert alert["reason"] == "RunTimeout: the run passed its 3s time limit"
    assert len(outbound.to(WEBHOOK)) == 1
    assert outbound.to(HEARTBEAT) == []


def test_a_time_limit_that_fires_between_steps_still_alerts(
    module, world, calls, outbound, monkeypatch
):
    # The limit lands in Dagster's own wait before a retry, outside any step. The signal is sent
    # from inside that wait instead of timed to arrive there, so a busy machine can't move it.
    # The limit itself is an hour, so the timer never fires on its own here.
    waiting = ActiveExecution.sleep_til_ready

    def expire_while_waiting(self):
        if self.sleep_interval() > 0:
            signal.raise_signal(signal.SIGALRM)
        waiting(self)

    monkeypatch.setattr(ActiveExecution, "sleep_til_ready", expire_while_waiting)
    timers = []

    def recording(label):
        timers.append(signal.getitimer(signal.ITIMER_REAL))
        return outbound(label)

    calls.fail_sync_times = 99
    result = run_job(
        module,
        pipeline_for(module, world, calls, retry_delay=120, max_runtime=3600, outbound=recording),
    )
    assert not result.success
    assert calls.sync == 1
    [alert] = alerts_in(world)
    assert alert["run_id"] == result.run_id
    assert alert["step"] == "run"
    assert alert["reason"] == "RunTimeout: the run passed its 3600s time limit"
    assert len(outbound.to(WEBHOOK)) == 1
    # The teardown stopped the timer before it alerted, so it couldn't cut the alert short.
    assert timers == [(0.0, 0.0)]


def test_once_fired_the_time_limit_fires_again_until_the_run_ends(module):
    # A broad handler can swallow the first RunTimeout. The kernel re-arms the timer, so the
    # next one lands within a minute, until the limit is lifted.
    with module._time_limit(module.LONGEST_LIMIT, None):
        assert signal.getitimer(signal.ITIMER_REAL)[1] == module.REFIRE_INTERVAL == 60
        for _ in range(2):
            with pytest.raises(module.RunTimeout):
                signal.raise_signal(signal.SIGALRM)
    assert signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0)


@pytest.mark.parametrize("ending", ["success", "failure", "timeout"])
def test_the_limits_are_lifted_however_the_run_ends(module, world, calls, ending):
    def stuck_sync(chain, store):
        time.sleep(30)
        return "never"

    overrides: dict = {"rate_limit_wait": 5}
    if ending == "failure":
        calls.dbt_exit = 1
    if ending == "timeout":
        overrides.update(sync=stuck_sync, max_runtime=0.5)
    before = signal.getsignal(signal.SIGALRM)
    result = run_job(module, pipeline_for(module, world, calls, **overrides))
    assert result.success is (ending == "success")
    assert signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0)
    assert signal.getsignal(signal.SIGALRM) == before
    assert math.isinf(RATE_LIMIT_WAITS.remaining)


@pytest.mark.parametrize("step", ["raw_transfers", "chain_reconciliations"])
def test_a_spent_rate_limit_budget_fails_the_step_once_without_a_retry(module, world, calls, step):
    slept: list[float] = []
    client = PoliteClient(
        label="rpc",
        min_interval=0,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(429, headers={"retry-after": "1800"})
        ),
        sleep=slept.append,
    )
    attempts = []

    def spend(*args):
        attempts.append(step)
        client.request_json("POST", KEYED_URL, json={})

    overrides = {"sync": spend} if step == "raw_transfers" else {"probes": spend}
    # A retry would wait five minutes and meet the same spent budget. The run limit is far
    # shorter, so a retry fails this test as a timeout instead of hanging it.
    result = run_job(
        module,
        pipeline_for(
            module,
            world,
            calls,
            rate_limit_wait=600,
            retry_delay=300,
            max_runtime=120,
            **overrides,
        ),
    )
    assert not result.success
    assert attempts == [step]
    assert slept == []
    [alert] = alerts_in(world)
    assert alert["step"] == step
    assert "Failure: " in alert["reason"]
    assert "RateLimitBudgetSpent: rpc: a 1800s rate limit wait would pass" in alert["reason"]
    for text in (everything_logged(result), json.dumps(alert)):
        assert KEY not in text
        assert "base-rpc.provider.invalid" not in text


def test_the_job_carries_the_max_runtime_tag_for_the_daemon(module, monkeypatch):
    monkeypatch.setenv("OUSD_MAX_RUNTIME_SECONDS", "5400")
    job = module.build_definitions(module.Pipeline()).resolve_job_def("ousd_daily")
    assert job.tags[dg.MAX_RUNTIME_SECONDS_TAG] == "5400"
    # Rounded up: a 0 would read as no time at all.
    job = module.build_definitions(module.Pipeline(max_runtime=0.5)).resolve_job_def("ousd_daily")
    assert job.tags[dg.MAX_RUNTIME_SECONDS_TAG] == "1"
    monkeypatch.delenv("OUSD_MAX_RUNTIME_SECONDS")
    job = module.build_definitions(module.Pipeline()).resolve_job_def("ousd_daily")
    assert job.tags[dg.MAX_RUNTIME_SECONDS_TAG] == str(3 * 3600)


@pytest.mark.parametrize(
    "name",
    ["OUSD_MAX_RUNTIME_SECONDS", "OUSD_DBT_TIMEOUT_SECONDS", "OUSD_RATE_LIMIT_WAIT_SECONDS"],
)
@pytest.mark.parametrize("value", ["0", "-5", "soon", "inf", "nan", "604801", "1e10"])
def test_a_limit_out_of_range_stops_loading_and_names_the_variable(
    module, monkeypatch, name, value
):
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match=f"{name} must be a number of seconds above 0"):
        module.Pipeline()


def test_the_longest_limit_is_one_setitimer_accepts(module):
    with module._time_limit(module.LONGEST_LIMIT, None) as timed_out:
        assert signal.getitimer(signal.ITIMER_REAL)[0] > 0
    assert not timed_out()
    assert signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0)


def test_off_the_main_thread_the_limit_is_not_set_and_says_so(module):
    import threading

    seen: dict = {}

    class Log:
        def warning(self, message):
            seen["warning"] = message

    def body():
        with module._time_limit(0.1, Log()) as timed_out:
            time.sleep(0.3)
            seen["fired"] = timed_out()

    worker = threading.Thread(target=body)
    worker.start()
    worker.join()
    assert seen == {
        "warning": "the run time limit is not enforced off the main thread",
        "fired": False,
    }


def test_a_blank_limit_means_the_default(module, monkeypatch):
    monkeypatch.setenv("OUSD_RATE_LIMIT_WAIT_SECONDS", " ")
    assert module.Pipeline().rate_limit_wait == 3600


def test_a_dbt_build_past_its_timeout_is_reported_as_timed_out(module, world, calls, monkeypatch):
    monkeypatch.setenv("OUSD_DBT_TIMEOUT_SECONDS", "90")
    assert module.Pipeline().dbt_timeout == 90

    def too_slow(command, check, timeout):
        assert timeout == 90
        raise subprocess.TimeoutExpired(command, timeout)

    with monkeypatch.context() as patched:
        patched.setattr(module.subprocess, "run", too_slow)
        assert module.run_dbt_build(90) == module.DBT_TIMED_OUT

    publish_once(world)
    seen = []

    def dbt_build(timeout):
        seen.append(timeout)
        return module.DBT_TIMED_OUT

    timed_out = pipeline_for(module, world, calls, dbt_build=dbt_build, dbt_timeout=42)
    result = run_job(module, timed_out)
    assert seen == [42]
    assert not result.success
    assert alerts_in(world)[0]["reason"] == "Failure: dbt build timed out"
    assert json.loads(latest_files(world)["manifest.json"])["stale"] is True


def test_dagster_job_execute_writes_the_alert_file(tmp_path):
    """The scheduled path: `make run` runs exactly this, where no sensor is evaluated."""
    env = {name: value for name, value in os.environ.items() if name not in SECRET_URL_VARIABLES}
    env["DAGSTER_HOME"] = str(tmp_path / ".dagster")
    (tmp_path / ".dagster").mkdir()
    dagster = Path(sys.executable).with_name("dagster")
    # Without the keys the run fails in its first step, before any network or database.
    finished = subprocess.run(
        [str(dagster), "job", "execute", "-f", str(DEFINITIONS), "-j", "ousd_daily"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    assert finished.returncode != 0
    [path] = (tmp_path / "data" / "alerts").glob("*.json")
    alert = json.loads(path.read_text())
    assert path.stem == alert["run_id"]
    assert alert["job"] == "ousd_daily"
    assert alert["step"] == "raw_transfers"
    assert "BASE_RPC_URL" in alert["reason"]
    assert not (tmp_path / "data" / "ousd.duckdb").exists()


def test_an_unwritable_alerts_folder_still_posts_and_never_hides_the_failure(
    module, world, calls, outbound, caplog
):
    blocked = world.path / "alerts"
    blocked.write_text("a file where the folder should be")
    calls.dbt_exit = 1
    result = run_job(module, pipeline_for(module, world, calls, outbound=outbound))
    assert not result.success
    assert len(outbound.to(WEBHOOK)) == 1
    assert "alert file not written" in caplog.text


def test_a_failed_check_or_reconciliation_never_pings_the_heartbeat(
    module, world, calls, outbound, monkeypatch
):
    calls.reconcile_status = "fail"
    assert not run_job(module, pipeline_for(module, world, calls, outbound=outbound)).success
    calls.reconcile_status = "pass"
    monkeypatch.setattr(
        ousd_checks,
        "freshness",
        lambda store, chains, now: CheckResult("freshness", "failed", True, "forced"),
    )
    assert not run_job(module, pipeline_for(module, world, calls, outbound=outbound)).success
    assert outbound.to(HEARTBEAT) == []
    assert len(outbound.to(WEBHOOK)) == 2


def metadata_of(result, key: str) -> dict:
    [event] = result.asset_materializations_for_node(key)
    return {
        name: value.value if hasattr(value, "value") else value
        for name, value in event.metadata.items()
    }


def test_the_assets_record_what_the_run_did(module, world, calls):
    result = run_job(module, pipeline_for(module, world, calls))
    assert result.success

    raw = metadata_of(result, "raw_transfers")
    tempo = raw["chains"]["tempo"]
    assert set(tempo) == {
        "unit",
        "rows_added",
        "cursor",
        "tip",
        "lag",
        "reorg_depth",
        "duration_seconds",
    }
    assert tempo["unit"] == "block"
    assert tempo["reorg_depth"] == 0
    assert tempo["rows_added"] == 0
    assert tempo["lag"] == max(0, tempo["tip"] - tempo["cursor"])
    assert raw["duration_seconds"] >= 0

    dbt = metadata_of(result, "dbt_marts")
    assert dbt["tests_passed"] > 0
    assert dbt["tests_failed"] == 0
    assert dbt["models"]
    assert {"status", "seconds"} == set(next(iter(dbt["models"].values())))
    assert all(model["status"] == "success" for model in dbt["models"].values())
    assert dbt["invocation_id"]

    published = metadata_of(result, "published_dataset")
    folder = (world.out / "latest").resolve()
    manifest_bytes = (folder / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    assert published["dataset_version"] == manifest["dataset_version"] == folder.name
    assert published["manifest_sha256"] == hashlib.sha256(manifest_bytes).hexdigest()
    assert published["rows"] == {name: f["rows"] for name, f in manifest["files"].items()}


def test_a_repaired_reorg_shows_its_depth_and_the_lag_behind_the_tip(module, world, calls):
    store = Store(world.raw, read_only=True)
    cursor = store.synced_through("tempo")
    store.close()
    assert cursor is not None

    def sync(chain, store):
        return SyncResult(chain.name, cursor + 40, cursor + 40, cursor - 3, 0)

    result = run_job(module, pipeline_for(module, world, calls, sync=sync))
    tempo = metadata_of(result, "raw_transfers")["chains"]["tempo"]
    assert tempo["reorg_depth"] == 3
    assert tempo["lag"] == 40


def test_reconciliation_records_each_chain_and_the_bridge_comparison(
    module, world, calls, monkeypatch
):
    reading = ChainReconciliation("tempo", 777, 10, 3, 7)
    comparison = BridgeComparison(("tempo",), ("base",), 7, 9)

    def reconcile(probes, store, report, **kwargs):
        latest = store.latest_reconciliation()
        assert latest
        report(BridgeFigures(2, BridgeSnapshot(9, 0), 0.0, comparison))
        outcome = CheckOutcome("chain_supply", "tempo", "pass", None, 1, reading)
        return RunResult(latest.run_id, "full", "pass", 0, {"tempo": "pass"}, "pass", [outcome])

    monkeypatch.setattr(module, "run_reconciliation", reconcile)
    result = run_job(module, pipeline_for(module, world, calls))
    recorded = metadata_of(result, "chain_reconciliations")
    assert recorded["status"] == "pass"
    assert recorded["chains"] == {"tempo": {"status": "pass", "checked": 777, "difference": 0}}
    assert recorded["bridge"] == {
        "status": "pass",
        "difference": -2,
        "chains_missing": 1,
        "attempt": 2,
    }


def test_a_missing_run_results_file_is_recorded_not_fatal(module, tmp_path):
    metadata = module._dbt_metadata(tmp_path / "absent.json", 1.5)
    assert metadata == {"duration_seconds": 1.5, "run_results": "missing or unreadable"}


def test_dbt_metadata_counts_models_and_tests_by_status(module, tmp_path):
    path = tmp_path / "run_results.json"
    path.write_text(
        json.dumps(
            {
                "metadata": {"invocation_id": "abc"},
                "elapsed_time": 2.5,
                "results": [
                    {"unique_id": "model.ousd.stg_a", "status": "success", "execution_time": 0.5},
                    {"unique_id": "test.ousd.t1.1f", "status": "pass", "execution_time": 0.1},
                    {"unique_id": "test.ousd.t2.2f", "status": "fail", "execution_time": 0.1},
                    {"unique_id": "unit_test.ousd.m.u1", "status": "pass", "execution_time": 0},
                ],
            }
        )
    )
    metadata = module._dbt_metadata(path, 3.0)
    assert metadata["models"].value == {"stg_a": {"status": "success", "seconds": 0.5}}
    assert (metadata["tests_passed"], metadata["tests_failed"]) == (2, 1)
    assert metadata["invocation_id"] == "abc"


def test_no_metadata_or_summary_holds_a_secret(module, world, calls, outbound, monkeypatch):
    monkeypatch.setenv("BASE_RPC_URL", KEYED_URL)
    result = run_job(module, pipeline_for(module, world, calls, outbound=outbound))
    assert result.success
    texts = [json.dumps(metadata_of(result, key), default=str) for key in KEYS]
    texts += [request.content.decode() for request in outbound.requests]
    for text in texts:
        for secret in (KEY, "base-rpc.provider.invalid", "w3bh00kS3cr3tT0k3n", "hc-ping.example"):
            assert secret not in text


def test_a_failure_summary_has_no_secret_either(module, world, calls, outbound, monkeypatch):
    monkeypatch.setenv("BASE_RPC_URL", KEYED_URL)

    def sync(chain, store):
        raise ConnectionError(f"cannot reach {KEYED_URL}")

    result = run_job(module, pipeline_for(module, world, calls, sync=sync, outbound=outbound))
    assert not result.success
    for text in [request.content.decode() for request in outbound.requests] + [
        json.dumps(alerts_in(world))
    ]:
        assert KEY not in text
        assert "base-rpc.provider.invalid" not in text


def test_json_logs_make_dagsters_console_logger_json(module, monkeypatch):
    monkeypatch.setenv("OUSD_LOG_FORMAT", "json")
    defs = module.build_definitions()
    assert "console" in (defs.loggers or {})
    monkeypatch.delenv("OUSD_LOG_FORMAT")
    assert not module.build_definitions().loggers


def test_a_json_run_logs_json_lines_without_the_key(module, world, calls, monkeypatch, capsys):
    monkeypatch.setenv("OUSD_LOG_FORMAT", "json")
    monkeypatch.setenv("BASE_RPC_URL", KEYED_URL)

    def sync(chain, store):
        raise ConnectionError(f"cannot reach {KEYED_URL}: key {KEY} refused")

    job = module.build_definitions(pipeline_for(module, world, calls, sync=sync)).resolve_job_def(
        module.JOB_NAME
    )
    assert not job.execute_in_process(raise_on_error=False).success
    err = capsys.readouterr().err
    lines = [line for line in err.splitlines() if line.strip()]
    entries = [json.loads(line) for line in lines]
    assert entries
    assert all({"time", "level", "logger", "message"} <= set(entry) for entry in entries)
    assert any(entry.get("run_id") for entry in entries)
    assert KEY not in err
    assert "base-rpc.provider.invalid" not in err


def test_malformed_run_results_and_manifest_never_fail_the_asset(module, tmp_path):
    path = tmp_path / "run_results.json"
    path.write_text(json.dumps({"results": ["not a dict", 3]}))
    assert module._dbt_metadata(path, 1.0)["run_results"] == "missing or unreadable"
    (tmp_path / "manifest.json").write_text("{not json")
    assert module._published_metadata(tmp_path) == {"manifest": "missing or unreadable"}


def test_a_bad_log_format_still_loads_the_definitions(module, monkeypatch):
    monkeypatch.setenv("OUSD_LOG_FORMAT", "yaml")
    assert not module.build_definitions().loggers
