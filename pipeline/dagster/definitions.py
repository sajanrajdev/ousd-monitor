"""The daily run: ingest, reconcile, build the marts, run the seven checks, publish.

Load it only as a file (`dagster ... -f pipeline/dagster/definitions.py`). This folder has no
`__init__.py` and `pipeline/` is never on PYTHONPATH, or the folder could shadow `dagster`.

Everything the run touches comes in through `Pipeline`, so tests swap the network, dbt and the
clock for fakes. Nothing here puts a URL in run config or in a log: an error is logged and raised
only after every configured URL, and any other URL, is scrubbed from it.

`make run` uses `dagster job execute`, where no sensor runs, so failures are caught in the run
itself: a failure hook writes the alert, and a run resource enforces the time limits.
"""

import hashlib
import json
import logging
import math
import os
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import closing, contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from types import FrameType
from typing import Any

import dagster as dg
import duckdb
from ousd.alerts import (
    DEFAULT_ALERTS_DIR,
    ClientFactory,
    describe,
    new_alert,
    outbound_client,
    ping_heartbeat,
    raise_alert,
)
from ousd.chains import DEFAULT_BRIDGE_URL, DEFAULT_DB_PATH, Chain, load_chains, missing_rpc_keys
from ousd.checks import (
    CHECK_NAMES,
    DEFAULT_MARTS_PATH,
    Sources,
    run_checks,
    unacceptable,
)
from ousd.http import (
    PoliteClient,
    RateLimitBudgetSpent,
    rate_limit_waits_capped,
    scrubbed_traceback,
)
from ousd.ingest import SyncResult, sync_chain
from ousd.logs import JsonFormatter, UnknownLogFormat, chain_context, log_format, run_id_var
from ousd.migrations import SchemaOutOfDate
from ousd.probes import build_probes, history_for, rpc_for, solana_rpc_for
from ousd.publish import DEFAULT_PUBLISHED_DIR, mark_stale, publish
from ousd.reconcile import (
    FULL_SCOPE,
    BridgeFigures,
    ChainProbe,
    CheckOutcome,
    RunResult,
    run_reconciliation,
)
from ousd.solana import SolanaChain, load_solana, sync_solana
from ousd.sources import BridgeSnapshot, bridge_snapshot
from ousd.store import Store, StoreConflict

log = logging.getLogger(__name__)

JOB_NAME = "ousd_daily"
CRON = "0 6 * * *"
RUN_LIMITS = "run_limits"

# Public nodes only serve recent state, so reconciliation follows sync directly. Two retries,
# five minutes apart, are for a node that is briefly down. A failed check is never retried.
RETRIES = 2
RETRY_DELAY = 300

# Limits on one run, in seconds, each overridable from the environment. A normal run takes
# minutes. These stop a stuck one long before the next day's run is due.
MAX_RUNTIME_VARIABLE = "OUSD_MAX_RUNTIME_SECONDS"
MAX_RUNTIME = 3 * 3600
# dbt rebuilds in seconds, so a build still going after this is stuck.
DBT_TIMEOUT_VARIABLE = "OUSD_DBT_TIMEOUT_SECONDS"
DBT_TIMEOUT = 1800
# Total time every client may spend waiting out servers' rate limits. One server may ask for up
# to an hour (MAX_SERVER_WAIT), so this allows one such wait and no more.
RATE_LIMIT_WAIT_VARIABLE = "OUSD_RATE_LIMIT_WAIT_SECONDS"
RATE_LIMIT_WAIT = 3600
# The exit status `timeout` uses, for a dbt build stopped at its limit.
DBT_TIMED_OUT = 124
# The sync facts an alert or a heartbeat repeats for each chain.
SUMMARY_SYNC_FIELDS = ("cursor", "tip", "lag", "reorg_depth", "rows_added")
# Once the run limit has fired, it fires again this often until the run ends, in case a broad
# handler swallowed the first one.
REFIRE_INTERVAL = 60
# No limit may be longer than a week. A larger value is a typo, and setitimer refuses huge ones.
LONGEST_LIMIT = 7 * 24 * 3600

type AnyChain = Chain | SolanaChain


def limit_from_env(name: str, default: float) -> float:
    """Seconds from the environment, up to a week. Blank means the default.

    Read when the definitions load, so a bad value stops `make run` at once, naming the variable,
    rather than hours into a run."""
    text = os.environ.get(name, "").strip()
    if not text:
        return default
    try:
        seconds = float(text)
    except ValueError:
        seconds = 0.0
    if not 0 < seconds <= LONGEST_LIMIT:
        raise ValueError(f"{name} must be a number of seconds above 0 and at most {LONGEST_LIMIT}")
    return seconds


def _dbt_executable() -> str:
    beside_python = Path(sys.executable).with_name("dbt")
    return str(beside_python) if beside_python.exists() else "dbt"


def run_dbt_build(timeout: float = DBT_TIMEOUT) -> int:
    """`dbt build` over the project, in the repo root, where every command runs. A build past its
    time limit is killed and reported as DBT_TIMED_OUT."""
    command = [_dbt_executable(), "build", "--project-dir", "dbt", "--profiles-dir", "dbt"]
    try:
        return subprocess.run(command, check=False, timeout=timeout).returncode
    except subprocess.TimeoutExpired:
        return DBT_TIMED_OUT


def _load_chains() -> list[AnyChain]:
    """Solana first: its sync is the slowest, and Ethereum's state must still be recent when
    reconciliation reads it."""
    chains: list[AnyChain] = [load_solana(), *load_chains().values()]
    if missing := missing_rpc_keys([chain.name for chain in chains], os.environ):
        # Names only: the variables are not read for their values here.
        raise dg.Failure(f"set {', '.join(missing)} in .env", allow_retries=False)
    return chains


def _sync_one(chain: AnyChain, store: Store) -> SyncResult:
    if isinstance(chain, SolanaChain):
        return sync_solana(chain, solana_rpc_for(chain), store)
    return sync_chain(chain, rpc_for(chain), store, history_for(chain))


def _sync_line(chain: AnyChain, result: SyncResult) -> str:
    where = "slot " if isinstance(chain, SolanaChain) else ""
    return f"{result.chain}: synced to {where}{result.tip}, {result.transfers_stored} stored"


def _chain_sync_facts(
    chain: AnyChain,
    store: Store,
    result: SyncResult,
    cursor_before: int | None,
    rows_before: int,
    seconds: float,
) -> dict[str, Any]:
    """What one chain's sync did, for the run view. Heights are blocks, or slots on Solana.

    `rows_added` is the net change in stored transfers, so a reorg that dropped more than it
    re-read shows as negative. `lag` is the tip minus the new cursor. `reorg_depth` is the cursor
    before the sync minus the block the chain was rolled back to, 0 when nothing was."""
    cursor = store.synced_through(chain.name)
    fork = result.reorg_fork_block
    depth = 0 if fork is None or cursor_before is None else max(0, cursor_before - fork)
    return {
        "unit": "slot" if isinstance(chain, SolanaChain) else "block",
        "rows_added": store.transfer_count(chain.name) - rows_before,
        "cursor": cursor,
        "tip": result.tip,
        "lag": None if cursor is None else max(0, result.tip - cursor),
        "reorg_depth": depth,
        "duration_seconds": round(seconds, 3),
    }


def _fetch_bridge() -> BridgeSnapshot:
    url = os.environ.get("BRIDGE_API_URL", DEFAULT_BRIDGE_URL)
    return bridge_snapshot(PoliteClient(label="bridge"), url)


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class Pipeline:
    """Where the run reads and writes, and the few things a test replaces."""

    raw_path: Path = field(
        default_factory=lambda: Path(os.environ.get("OUSD_DB_PATH", DEFAULT_DB_PATH))
    )
    marts_path: Path = field(
        default_factory=lambda: Path(os.environ.get("OUSD_MARTS_DB_PATH", DEFAULT_MARTS_PATH))
    )
    published_dir: Path = field(
        default_factory=lambda: Path(os.environ.get("OUSD_PUBLISHED_DIR", DEFAULT_PUBLISHED_DIR))
    )
    alerts_dir: Path = DEFAULT_ALERTS_DIR
    sources: Sources = field(default_factory=Sources)
    chains: Callable[[], Sequence[AnyChain]] = _load_chains
    sync: Callable[[AnyChain, Store], SyncResult] = _sync_one
    probes: Callable[[Sequence[AnyChain], Store], list[ChainProbe]] = build_probes
    bridge: Callable[[], BridgeSnapshot] = _fetch_bridge
    dbt_build: Callable[[float], int] = run_dbt_build
    now: Callable[[], datetime] = _now
    retry_delay: int = RETRY_DELAY
    outbound: ClientFactory = outbound_client
    max_runtime: float = field(
        default_factory=lambda: limit_from_env(MAX_RUNTIME_VARIABLE, MAX_RUNTIME)
    )
    dbt_timeout: float = field(
        default_factory=lambda: limit_from_env(DBT_TIMEOUT_VARIABLE, DBT_TIMEOUT)
    )
    rate_limit_wait: float = field(
        default_factory=lambda: limit_from_env(RATE_LIMIT_WAIT_VARIABLE, RATE_LIMIT_WAIT)
    )


class RunTimeout(dg.Failure):
    """The run passed its time limit. Never retried: a retry would only run longer."""

    def __init__(self, seconds: float) -> None:
        super().__init__(f"the run passed its {seconds:g}s time limit", allow_retries=False)


@contextmanager
def _time_limit(seconds: float, log: Any) -> Iterator[Callable[[], bool]]:
    """Raise RunTimeout wherever the run is once `seconds` pass, and again every REFIRE_INTERVAL
    after that. It interrupts a sleep, and subprocess.run kills its child when interrupted.
    Yields whether the limit fired.

    A signal only reaches the main thread, which is where `dagster job execute` runs. Anywhere
    else only the dagster/max_runtime tag applies, and only with the daemon's run monitoring on.
    """
    fired = False
    if threading.current_thread() is not threading.main_thread():
        if log:
            log.warning("the run time limit is not enforced off the main thread")
        yield lambda: fired
        return

    def expire(signum: int, frame: FrameType | None) -> None:
        nonlocal fired
        fired = True
        raise RunTimeout(seconds)

    previous = signal.signal(signal.SIGALRM, expire)
    signal.setitimer(signal.ITIMER_REAL, seconds, REFIRE_INTERVAL)
    try:
        yield lambda: fired
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def _open_store(pipeline: Pipeline) -> Store:
    try:
        return Store(pipeline.raw_path)
    except duckdb.IOException:
        # No path or message: a locked file says nothing about the data.
        raise dg.Failure(
            "the raw database is in use or cannot be opened", allow_retries=False
        ) from None
    except SchemaOutOfDate as exc:
        # A retry meets the same schema. The message names versions only, never the path.
        raise dg.Failure(str(exc), allow_retries=False) from None


def _refuse(pipeline: Pipeline, context: dg.AssetExecutionContext, reason: str) -> None:
    """Say on the last good dataset that it is no longer current. A failure here is logged and
    never hides the reason the run stopped."""
    try:
        marked = mark_stale(pipeline.published_dir, pipeline.now(), reason)
    except Exception as exc:
        context.log.error(f"could not mark the last dataset stale: {type(exc).__name__}")
        return
    if marked:
        context.log.warning("the last published dataset is marked stale")


@dg.logger
def json_console_logger(init_context: dg.InitLoggerContext) -> logging.Logger:
    """Dagster's console logger with one JSON object per line, scrubbed before it is encoded."""
    logger = logging.Logger("ousd_json_console")
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    return logger


def build_definitions(pipeline: Pipeline | None = None) -> dg.Definitions:
    run = pipeline or Pipeline()
    retry = dg.RetryPolicy(max_retries=RETRIES, delay=run.retry_delay)
    # Per run, then per chain: the few facts an alert or a heartbeat carries. Filled by the
    # assets in this process, so it is empty for a failure the sensor sees from another one.
    summaries: dict[str, dict[str, dict[str, Any]]] = {}

    def note(run_id: str, name: str, **facts: Any) -> None:
        summaries.setdefault(run_id, {}).setdefault(name, {}).update(facts)

    @dg.asset(retry_policy=retry, required_resource_keys={RUN_LIMITS})
    def raw_transfers(context: dg.AssetExecutionContext) -> dg.MaterializeResult:
        chains = run.chains()
        store = _open_store(run)
        per_chain: dict[str, dict[str, Any]] = {}
        started = time.monotonic()
        try:
            for chain in chains:
                note(context.run.run_id, chain.name, sync="failed")
                began = time.monotonic()
                cursor_before = store.synced_through(chain.name)
                rows_before = store.transfer_count(chain.name)
                try:
                    with chain_context(chain.name):
                        result = run.sync(chain, store)
                        context.log.info(_sync_line(chain, result))
                    facts = _chain_sync_facts(
                        chain, store, result, cursor_before, rows_before, time.monotonic() - began
                    )
                    per_chain[chain.name] = facts
                    note(
                        context.run.run_id,
                        chain.name,
                        sync="ok",
                        **{k: facts[k] for k in SUMMARY_SYNC_FIELDS},
                    )
                except StoreConflict as conflict:
                    # Proven disagreement with stored rows: a retry can't fix it.
                    raise dg.Failure(f"{chain.name}: {conflict}", allow_retries=False) from None
                except RunTimeout:
                    raise
                except RateLimitBudgetSpent as exc:
                    raise _final(context, f"{chain.name}: sync failed", exc) from None
                except Exception as exc:
                    raise _scrubbed(context, f"{chain.name}: sync failed", exc) from None
        finally:
            store.close()
        return dg.MaterializeResult(
            metadata={
                "chains": dg.MetadataValue.json(per_chain),
                "duration_seconds": round(time.monotonic() - started, 3),
            }
        )

    @dg.asset(deps=[raw_transfers], retry_policy=retry, required_resource_keys={RUN_LIMITS})
    def chain_reconciliations(context: dg.AssetExecutionContext) -> dg.MaterializeResult:
        chains = run.chains()
        store = _open_store(run)
        bridge_figures: list[BridgeFigures] = []

        def watch(event: Any) -> None:
            if isinstance(event, BridgeFigures):
                bridge_figures.append(event)

        started = time.monotonic()
        try:
            probes = run.probes(chains, store)
            result: RunResult = run_reconciliation(probes, store, watch, bridge=run.bridge)
        except StoreConflict as conflict:
            _refuse(run, context, "a stored row disagrees with the chain")
            raise dg.Failure(str(conflict), allow_retries=False) from None
        except RunTimeout:
            raise
        except RateLimitBudgetSpent as exc:
            raise _final(context, "reconciliation failed", exc) from None
        except Exception as exc:
            raise _scrubbed(context, "reconciliation failed", exc) from None
        finally:
            store.close()
        for name, status in result.chains.items():
            context.log.info(f"{name}: {status}")
        context.log.info(f"bridge: {result.bridge}")
        per_chain = _reconciliation_facts(result, bridge_figures[-1] if bridge_figures else None)
        for name, facts in per_chain["chains"].items():
            note(context.run.run_id, name, reconciliation=facts["status"], checked=facts["checked"])
        note(context.run.run_id, "bridge", reconciliation=result.bridge)
        if result.status != "pass" or result.scope != FULL_SCOPE:
            # Not a retryable error: a second look at the same data must not turn a fail into a
            # pass, and a person reads this. A programmatic caller gets no exit code, so raise.
            _refuse(run, context, f"reconciliation {result.status}")
            raise dg.Failure(
                f"reconciliation is {result.status} at {result.scope} scope", allow_retries=False
            )
        return dg.MaterializeResult(
            metadata={
                "status": result.status,
                "scope": result.scope,
                "chains": dg.MetadataValue.json(per_chain["chains"]),
                "bridge": dg.MetadataValue.json(per_chain["bridge"]),
                "duration_seconds": round(time.monotonic() - started, 3),
            }
        )

    @dg.asset(deps=[chain_reconciliations], required_resource_keys={RUN_LIMITS})
    def dbt_marts(context: dg.AssetExecutionContext) -> dg.MaterializeResult:
        started = time.monotonic()
        status = run.dbt_build(run.dbt_timeout)
        seconds = round(time.monotonic() - started, 3)
        if status != 0:
            reason = "dbt build timed out" if status == DBT_TIMED_OUT else "dbt build failed"
            _refuse(run, context, reason)
            raise dg.Failure(reason, allow_retries=False)
        return dg.MaterializeResult(metadata=_dbt_metadata(run.sources.run_results, seconds))

    @dg.multi_asset_check(
        specs=[
            dg.AssetCheckSpec(name=name, asset=dbt_marts, blocking=True) for name in CHECK_NAMES
        ],
        required_resource_keys={RUN_LIMITS},
    )
    def blocking_checks(context: dg.AssetCheckExecutionContext) -> Iterator[dg.AssetCheckResult]:
        """The seven checks, run once and recorded together under this run's id."""
        if not (run.raw_path.is_file() and run.marts_path.is_file()):
            raise dg.Failure("the raw or marts database is missing", allow_retries=False)
        store = _open_store(run)
        try:
            with closing(duckdb.connect(str(run.marts_path), read_only=True)) as marts:
                results = run_checks(
                    store, marts, context.run.run_id, now=run.now(), sources=run.sources
                )
        finally:
            store.close()
        problems = unacceptable({r.name: r.status for r in results})
        if problems:
            try:
                mark_stale(run.published_dir, run.now(), "; ".join(problems))
            except Exception as exc:
                context.log.error(f"could not mark the last dataset stale: {type(exc).__name__}")
        for result in results:
            passed = result.status == "passed"
            yield dg.AssetCheckResult(
                check_name=result.name,
                asset_key=dbt_marts.key,
                passed=passed,
                severity=dg.AssetCheckSeverity.ERROR,
                description=result.detail,
                metadata={"status": result.status},
            )

    @dg.asset(deps=[dbt_marts], required_resource_keys={RUN_LIMITS})
    def published_dataset(context: dg.AssetExecutionContext) -> dg.MaterializeResult:
        started = time.monotonic()
        # Refuses by itself unless this run's seven recorded checks all passed.
        folder = publish(
            context.run.run_id,
            run.marts_path,
            run.raw_path,
            run.published_dir,
            now=run.now(),
            sources=run.sources,
        )
        context.log.info(f"published {folder.name}")
        metadata = _published_metadata(folder)
        metadata["duration_seconds"] = round(time.monotonic() - started, 3)
        return dg.MaterializeResult(metadata=metadata)

    @dg.resource
    def run_limits(init_context: dg.InitResourceContext) -> Iterator[None]:
        """Set up once for the whole run by the in-process executor, and torn down at its end,
        however it ends."""
        fired: Callable[[], bool] | None = None
        # Lines logged during the run carry its id, and only this run's.
        before = run_id_var.get()
        run_id_var.set(init_context.run.run_id if init_context.run else None)
        try:
            with (
                _time_limit(run.max_runtime, init_context.log) as timed_out,
                rate_limit_waits_capped(run.rate_limit_wait),
            ):
                fired = timed_out
                yield
        finally:
            run_id_var.set(before)
            if init_context.run:
                summaries.pop(init_context.run.run_id, None)
            # The timer is off by now, so it can't interrupt this alert. A limit that fired
            # outside a step leaves no step failure for the hook to see.
            if fired is not None and fired() and init_context.run:
                _alert(init_context.run.run_id, "run", RunTimeout(run.max_runtime))

    def _alert(run_id: str, step: str, exc: BaseException | None) -> Path | None:
        try:
            alert = new_alert(
                run_id, JOB_NAME, step, describe(exc), run.now(), chains=summaries.get(run_id)
            )
            return raise_alert(run.alerts_dir, alert, run.outbound)
        except Exception as error:
            # Never in place of the run's own failure, which Dagster has recorded already.
            log.error("alert not raised: %s", type(error).__name__)
            return None

    @dg.failure_hook
    def alert_on_step_failure(context: dg.HookContext) -> None:
        # In the run itself, so `dagster job execute` alerts too. A retried attempt is not a
        # failure: only the last one is.
        path = _alert(context.run_id, context.step_key or "run", context.op_exception)
        written = f", alert in {path}" if path else ""
        context.log.error(
            f"run {context.run_id} of {JOB_NAME} failed at {context.step_key}{written}"
        )

    @dg.success_hook
    def heartbeat_on_publish(context: dg.HookContext) -> None:
        # Publishing is the last step, and it runs only after every check passed.
        if context.step_key == published_dataset.key.to_python_identifier():
            ping_heartbeat(run.outbound, chains=summaries.get(context.run_id))

    loggers: dict[str, dg.LoggerDefinition] = {}
    run_config: dict[str, Any] = {}
    try:
        wants_json = log_format() == "json"
    except UnknownLogFormat as exc:
        # The job and its failure alerts must still load. The CLI is the strict check.
        log.warning("%s: using plain logs", exc)
        wants_json = False
    if wants_json:
        # Dagster uses its own console logger unless the run config names one, so the job names
        # ours. context.log lines are then JSON too.
        loggers["console"] = json_console_logger
        run_config = {"loggers": {"console": {}}}
    job = dg.define_asset_job(
        JOB_NAME,
        selection=dg.AssetSelection.all() | dg.AssetSelection.all_asset_checks(),
        # One DuckDB writer per file: parallel steps would collide.
        executor_def=dg.in_process_executor,
        hooks={alert_on_step_failure, heartbeat_on_publish},
        config=run_config or None,
        # Only the daemon's run monitoring reads this, under `dagster dev`. `job execute` relies
        # on the run_limits resource.
        tags={dg.MAX_RUNTIME_SECONDS_TAG: str(math.ceil(run.max_runtime))},
    )
    schedule = dg.ScheduleDefinition(job=job, cron_schedule=CRON, execution_timezone="UTC")

    @dg.run_failure_sensor
    def alert_on_failure(context: dg.RunFailureSensorContext) -> None:
        # Under `dagster dev` only. The hook has alerted for any failed step already, so this
        # covers a run that died outside a step. It writes and posts only if nothing has.
        failed = context.dagster_run
        message = context.failure_event.message or "the run failed"
        alert = new_alert(failed.run_id, failed.job_name, "run", message, run.now())
        raise_alert(run.alerts_dir, alert, run.outbound)
        context.log.error(f"run {failed.run_id} of {JOB_NAME} failed")

    return dg.Definitions(
        loggers=loggers,
        assets=[raw_transfers, chain_reconciliations, dbt_marts, published_dataset],
        asset_checks=[blocking_checks],
        jobs=[job],
        schedules=[schedule],
        sensors=[alert_on_failure],
        resources={RUN_LIMITS: run_limits},
    )


def _reconciliation_facts(result: RunResult, figures: BridgeFigures | None) -> dict[str, Any]:
    """Per chain: its status and the block or slot its supply was checked at, with the figures'
    difference in base units. And Bridge: its status and our sum's difference from its total."""
    checked: dict[str, CheckOutcome] = {}
    for outcome in result.outcomes:
        if outcome.check_name == "chain_supply" and outcome.reconciliation is not None:
            checked[outcome.subject] = outcome
    chains: dict[str, dict[str, Any]] = {}
    for name, status in result.chains.items():
        reading = checked[name].reconciliation if name in checked else None
        chains[name] = {
            "status": status,
            "checked": None if reading is None else reading.block_number,
            "difference": None if reading is None else reading.difference,
        }
    bridge: dict[str, Any] = {"status": result.bridge}
    if figures is not None:
        comparison = figures.comparison
        bridge.update(
            difference=comparison.difference,
            chains_missing=len(comparison.chains_missing),
            attempt=figures.attempt,
        )
    return {"chains": chains, "bridge": bridge}


def _dbt_metadata(run_results: Path, seconds: float) -> dict[str, Any]:
    """Each model's status and seconds, and how many tests passed and failed, from the build's own
    run_results.json. A file that is missing or unreadable is said so, and left to the checks,
    which are what decide whether the build counts."""
    metadata: dict[str, Any] = {"duration_seconds": seconds}
    try:
        report = json.loads(run_results.read_text())
        results = report["results"]
    except (OSError, ValueError, KeyError, TypeError):
        metadata["run_results"] = "missing or unreadable"
        return metadata
    try:
        return {**metadata, **_dbt_counts(report, results)}
    except (AttributeError, TypeError, ValueError):
        metadata["run_results"] = "missing or unreadable"
        return metadata


def _dbt_counts(report: dict[str, Any], results: list[dict[str, Any]]) -> dict[str, Any]:
    models: dict[str, dict[str, Any]] = {}
    passed = failed = 0
    for item in results:
        kind, _, name = str(item.get("unique_id", "")).partition(".")
        status = str(item.get("status", "unknown"))
        if kind == "model":
            models[name.rsplit(".", 1)[-1]] = {
                "status": status,
                "seconds": round(float(item.get("execution_time") or 0), 3),
            }
        elif kind in ("test", "unit_test"):
            if status in ("pass", "success"):
                passed += 1
            elif status in ("fail", "error"):
                failed += 1
    return dict(
        models=dg.MetadataValue.json(models),
        tests_passed=passed,
        tests_failed=failed,
        dbt_seconds=round(float(report.get("elapsed_time") or 0), 3),
        invocation_id=str(report.get("metadata", {}).get("invocation_id", "")),
    )


def _published_metadata(folder: Path) -> dict[str, Any]:
    """The dataset's version, its rows per file and the hash of its manifest, read back from the
    folder just written, so the record is what a reader will fetch."""
    try:
        manifest_bytes = (folder / "manifest.json").read_bytes()
        manifest = json.loads(manifest_bytes)
        return _manifest_metadata(manifest, manifest_bytes)
    except (OSError, ValueError, KeyError, TypeError):
        # The dataset is published already. Say the record could not be read, and fail nothing.
        return {"manifest": "missing or unreadable"}


def _manifest_metadata(manifest: dict[str, Any], manifest_bytes: bytes) -> dict[str, Any]:
    return {
        "dataset_version": str(manifest["dataset_version"]),
        "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "rows": dg.MetadataValue.json({n: f["rows"] for n, f in manifest["files"].items()}),
    }


def _scrubbed(context: dg.AssetExecutionContext, what: str, exc: Exception) -> RuntimeError:
    """Log the scrubbed traceback, and return an error that carries the scrubbed message only.
    Dagster records a raised error's causes as they are, so the caller raises it from None."""
    context.log.error(f"{what}:\n{scrubbed_traceback(exc)}")
    return RuntimeError(f"{what}: {describe(exc)}")


def _final(context: dg.AssetExecutionContext, what: str, exc: Exception) -> dg.Failure:
    """The same, as a failure the retry policy skips: a retry would meet the same spent budget."""
    context.log.error(f"{what}:\n{scrubbed_traceback(exc)}")
    return dg.Failure(f"{what}: {describe(exc)}", allow_retries=False)


defs = build_definitions()
