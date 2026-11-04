"""The Dagster run, driven with fakes: no network, no .env, and dbt either fake or run on a
throwaway database. The module is loaded as a file, the way `dagster -f` loads it."""

import csv
import importlib.util
import json
import shutil
from datetime import timedelta
from pathlib import Path

import dagster as dg
import pytest
from conftest import FakeRpc, make_chain, rows
from dbt_helpers import invoke_dbt
from ousd import checks as ousd_checks
from ousd.chains import REQUIRED_CHAINS
from ousd.checks import CHECK_NAMES, CheckResult
from ousd.ingest import sync_chain
from ousd.reconcile import RunResult
from ousd.store import Status, Store
from publish_world import NOW, World, build_world

DEFINITIONS = Path(__file__).resolve().parent.parent / "pipeline" / "dagster" / "definitions.py"
KEYS = ["raw_transfers", "chain_reconciliations", "dbt_marts", "published_dataset"]
LEAK = "https://rpc.example.invalid/v2/not-a-real-key"


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
        return f"{chain.name}: synced"

    def dbt_build():
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

    def dbt_build():
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
        sync_chain(chain, rpc, store)
        return f"{chain.name}: synced"

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


def test_the_run_failure_alert_holds_no_message(module, tmp_path):
    class Failed:
        run_id = "run-1"
        job_name = "ousd_daily"
        message = LEAK

    path = module.write_alert(tmp_path / "alerts", Failed(), NOW)
    assert path == tmp_path / "alerts" / "run-1.json"
    alert = json.loads(path.read_text())
    assert alert == {"run_id": "run-1", "job": "ousd_daily", "failed_at": "2026-11-04T06:00:00Z"}
    assert LEAK not in path.read_text()
    assert [s.name for s in module.build_definitions().sensors] == ["alert_on_failure"]


def test_the_real_dbt_command_builds_the_project_with_the_repo_profile(module, monkeypatch):
    seen = {}

    def fake_run(command, check):
        seen["command"] = command
        seen["check"] = check

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
