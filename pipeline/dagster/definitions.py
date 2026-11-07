"""The daily run: ingest, reconcile, build the marts, run the seven checks, publish.

Load it only as a file (`dagster ... -f pipeline/dagster/definitions.py`). This folder has no
`__init__.py` and `pipeline/` is never on PYTHONPATH, or the folder could shadow `dagster`.

Everything the run touches comes in through `Pipeline`, so tests swap the network, dbt and the
clock for fakes. Nothing here puts a URL in run config or in a log: an error is logged and raised
only after every configured URL, and any other URL, is scrubbed from it.

`make run` uses `dagster job execute`, where no sensor runs, so failures are caught in the run
itself: a failure hook writes the alert, and a run resource enforces the time limits.
"""

import logging
import math
import os
import signal
import subprocess
import sys
import threading
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
from ousd.http import PoliteClient, rate_limit_waits_capped, scrubbed_traceback
from ousd.ingest import sync_chain
from ousd.migrations import SchemaOutOfDate
from ousd.probes import build_probes, history_for, rpc_for, solana_rpc_for
from ousd.publish import DEFAULT_PUBLISHED_DIR, mark_stale, publish
from ousd.reconcile import FULL_SCOPE, ChainProbe, RunResult, run_reconciliation
from ousd.solana import SolanaChain, load_solana, sync_solana
from ousd.sources import BridgeSnapshot, bridge_snapshot
from ousd.store import Store, StoreConflict

log = logging.getLogger(__name__)

JOB_NAME = "ousd_daily"
CRON = "0 6 * * *"
DEFAULT_ALERTS_DIR = Path("data/alerts")
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


def _sync_one(chain: AnyChain, store: Store) -> str:
    if isinstance(chain, SolanaChain):
        solana = sync_solana(chain, solana_rpc_for(chain), store)
        return f"{solana.chain}: synced to slot {solana.tip}, {solana.transfers_stored} stored"
    result = sync_chain(chain, rpc_for(chain), store, history_for(chain))
    return f"{result.chain}: synced to {result.tip}, {result.transfers_stored} stored"


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
    sync: Callable[[AnyChain, Store], str] = _sync_one
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
    """Raise RunTimeout wherever the run is once `seconds` pass. It interrupts a sleep, and
    subprocess.run kills its child when interrupted. Yields whether the limit fired.

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
    signal.setitimer(signal.ITIMER_REAL, seconds)
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


def build_definitions(pipeline: Pipeline | None = None) -> dg.Definitions:
    run = pipeline or Pipeline()
    retry = dg.RetryPolicy(max_retries=RETRIES, delay=run.retry_delay)

    @dg.asset(retry_policy=retry, required_resource_keys={RUN_LIMITS})
    def raw_transfers(context: dg.AssetExecutionContext) -> None:
        chains = run.chains()
        store = _open_store(run)
        try:
            for chain in chains:
                try:
                    context.log.info(run.sync(chain, store))
                except StoreConflict as conflict:
                    # Proven disagreement with stored rows: a retry can't fix it.
                    raise dg.Failure(f"{chain.name}: {conflict}", allow_retries=False) from None
                except RunTimeout:
                    raise
                except Exception as exc:
                    raise _scrubbed(context, f"{chain.name}: sync failed", exc) from None
        finally:
            store.close()

    @dg.asset(deps=[raw_transfers], retry_policy=retry, required_resource_keys={RUN_LIMITS})
    def chain_reconciliations(context: dg.AssetExecutionContext) -> None:
        chains = run.chains()
        store = _open_store(run)
        try:
            probes = run.probes(chains, store)
            result: RunResult = run_reconciliation(
                probes,
                store,
                lambda event: None,
                bridge=run.bridge,
            )
        except StoreConflict as conflict:
            _refuse(run, context, "a stored row disagrees with the chain")
            raise dg.Failure(str(conflict), allow_retries=False) from None
        except RunTimeout:
            raise
        except Exception as exc:
            raise _scrubbed(context, "reconciliation failed", exc) from None
        finally:
            store.close()
        for name, status in result.chains.items():
            context.log.info(f"{name}: {status}")
        context.log.info(f"bridge: {result.bridge}")
        if result.status != "pass" or result.scope != FULL_SCOPE:
            # Not a retryable error: a second look at the same data must not turn a fail into a
            # pass, and a person reads this. A programmatic caller gets no exit code, so raise.
            _refuse(run, context, f"reconciliation {result.status}")
            raise dg.Failure(
                f"reconciliation is {result.status} at {result.scope} scope", allow_retries=False
            )

    @dg.asset(deps=[chain_reconciliations], required_resource_keys={RUN_LIMITS})
    def dbt_marts(context: dg.AssetExecutionContext) -> None:
        status = run.dbt_build(run.dbt_timeout)
        if status != 0:
            reason = "dbt build timed out" if status == DBT_TIMED_OUT else "dbt build failed"
            _refuse(run, context, reason)
            raise dg.Failure(reason, allow_retries=False)

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
    def published_dataset(context: dg.AssetExecutionContext) -> None:
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

    @dg.resource
    def run_limits(init_context: dg.InitResourceContext) -> Iterator[None]:
        """Set up once for the whole run by the in-process executor, and torn down at its end,
        however it ends."""
        with (
            _time_limit(run.max_runtime, init_context.log) as timed_out,
            rate_limit_waits_capped(run.rate_limit_wait),
        ):
            try:
                yield
            finally:
                # A limit that fired outside a step leaves no step failure for the hook to see.
                if timed_out() and init_context.run:
                    _alert(init_context.run.run_id, "run", RunTimeout(run.max_runtime))

    def _alert(run_id: str, step: str, exc: BaseException | None) -> Path | None:
        try:
            alert = new_alert(run_id, JOB_NAME, step, describe(exc), run.now())
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
            ping_heartbeat(run.outbound)

    job = dg.define_asset_job(
        JOB_NAME,
        selection=dg.AssetSelection.all() | dg.AssetSelection.all_asset_checks(),
        # One DuckDB writer per file: parallel steps would collide.
        executor_def=dg.in_process_executor,
        hooks={alert_on_step_failure, heartbeat_on_publish},
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
        assets=[raw_transfers, chain_reconciliations, dbt_marts, published_dataset],
        asset_checks=[blocking_checks],
        jobs=[job],
        schedules=[schedule],
        sensors=[alert_on_failure],
        resources={RUN_LIMITS: run_limits},
    )


def _scrubbed(context: dg.AssetExecutionContext, what: str, exc: Exception) -> RuntimeError:
    """Log the scrubbed traceback, and return an error that carries the scrubbed message only.
    Dagster records a raised error's causes as they are, so the caller raises it from None."""
    context.log.error(f"{what}:\n{scrubbed_traceback(exc)}")
    return RuntimeError(f"{what}: {describe(exc)}")


defs = build_definitions()
