"""The daily run: ingest, reconcile, build the marts, run the seven checks, publish.

Load it only as a file (`dagster ... -f pipeline/dagster/definitions.py`). This folder has no
`__init__.py` and `pipeline/` is never on PYTHONPATH, or the folder could shadow `dagster`.

Everything the run touches comes in through `Pipeline`, so tests swap the network, dbt and the
clock for fakes. Nothing here puts a URL in run config or in a log: logs name a chain and an
error class, never a message from a provider.
"""

import json
import os
import subprocess
import sys
from collections.abc import Callable, Iterator, Sequence
from contextlib import closing
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import dagster as dg
import duckdb
from ousd.chains import DEFAULT_BRIDGE_URL, DEFAULT_DB_PATH, Chain, load_chains, missing_rpc_keys
from ousd.checks import (
    CHECK_NAMES,
    DEFAULT_MARTS_PATH,
    Sources,
    run_checks,
    unacceptable,
)
from ousd.http import PoliteClient
from ousd.ingest import sync_chain
from ousd.migrations import SchemaOutOfDate
from ousd.probes import build_probes, history_for, rpc_for, solana_rpc_for
from ousd.publish import DEFAULT_PUBLISHED_DIR, mark_stale, publish
from ousd.reconcile import FULL_SCOPE, ChainProbe, RunResult, run_reconciliation
from ousd.solana import SolanaChain, load_solana, sync_solana
from ousd.sources import BridgeSnapshot, bridge_snapshot
from ousd.store import Store, StoreConflict

JOB_NAME = "ousd_daily"
CRON = "0 6 * * *"
DEFAULT_ALERTS_DIR = Path("data/alerts")

# Public nodes only serve recent state, so reconciliation follows sync directly. Two retries,
# five minutes apart, are for a node that is briefly down. A failed check is never retried.
RETRIES = 2
RETRY_DELAY = 300

type AnyChain = Chain | SolanaChain


def _dbt_executable() -> str:
    beside_python = Path(sys.executable).with_name("dbt")
    return str(beside_python) if beside_python.exists() else "dbt"


def run_dbt_build() -> int:
    """`dbt build` over the project, in the repo root, where every command runs."""
    command = [_dbt_executable(), "build", "--project-dir", "dbt", "--profiles-dir", "dbt"]
    return subprocess.run(command, check=False).returncode


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
    dbt_build: Callable[[], int] = run_dbt_build
    now: Callable[[], datetime] = _now
    retry_delay: int = RETRY_DELAY


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

    @dg.asset(retry_policy=retry)
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
                except Exception as exc:
                    # The class only: a provider's message can hold a URL.
                    raise RuntimeError(
                        f"{chain.name}: sync failed ({type(exc).__name__})"
                    ) from None
        finally:
            store.close()

    @dg.asset(deps=[raw_transfers], retry_policy=retry)
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
        except Exception as exc:
            raise RuntimeError(f"reconciliation failed ({type(exc).__name__})") from None
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

    @dg.asset(deps=[chain_reconciliations])
    def dbt_marts(context: dg.AssetExecutionContext) -> None:
        if run.dbt_build() != 0:
            _refuse(run, context, "dbt build failed")
            raise dg.Failure("dbt build failed", allow_retries=False)

    @dg.multi_asset_check(
        specs=[
            dg.AssetCheckSpec(name=name, asset=dbt_marts, blocking=True) for name in CHECK_NAMES
        ],
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

    @dg.asset(deps=[dbt_marts])
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

    job = dg.define_asset_job(
        JOB_NAME,
        selection=dg.AssetSelection.all() | dg.AssetSelection.all_asset_checks(),
        # One DuckDB writer per file: parallel steps would collide.
        executor_def=dg.in_process_executor,
    )
    schedule = dg.ScheduleDefinition(job=job, cron_schedule=CRON, execution_timezone="UTC")

    @dg.run_failure_sensor
    def alert_on_failure(context: dg.RunFailureSensorContext) -> None:
        # Outbound alerts wait for the maintainer, so this only logs and writes a file.
        write_alert(run.alerts_dir, context.dagster_run, run.now())
        context.log.error(f"run {context.dagster_run.run_id} of {JOB_NAME} failed")

    return dg.Definitions(
        assets=[raw_transfers, chain_reconciliations, dbt_marts, published_dataset],
        asset_checks=[blocking_checks],
        jobs=[job],
        schedules=[schedule],
        sensors=[alert_on_failure],
    )


def write_alert(alerts_dir: Path, failed: Any, moment: datetime) -> Path:
    """One file per failed run. It holds the run, the job and when: no message and no config, as
    either can carry a provider's text."""
    alerts_dir.mkdir(parents=True, exist_ok=True)
    path = alerts_dir / f"{failed.run_id}.json"
    alert = {
        "run_id": failed.run_id,
        "job": failed.job_name,
        "failed_at": moment.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    path.write_text(json.dumps(alert, indent=2) + "\n")
    return path


defs = build_definitions()
