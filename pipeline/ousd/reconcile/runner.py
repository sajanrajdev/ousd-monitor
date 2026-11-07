"""A reconciliation run: each chain's checks, then Bridge with its retries, recorded as one run
that the publish gate reads.
"""

import time
from collections.abc import Callable, Collection, Sequence

from ousd.chains import REQUIRED_CHAINS
from ousd.reconcile.balances import CHAINS_READ_WHOLE, _check_balances, _check_census, _Coverage
from ousd.reconcile.bridge import (
    BRIDGE_ATTEMPTS,
    BRIDGE_RETRY_DELAY,
    BRIDGE_SUBJECT,
    _bridge_status,
    _fetch_bridge,
    _judge_bridge,
    compare_with_bridge,
)
from ousd.reconcile.groups import _check_groups
from ousd.reconcile.recorder import _ChainRun, _RunRecorder
from ousd.reconcile.status import (
    FULL_SCOPE,
    PARTIAL_SCOPE,
    BridgeFigures,
    BridgeWait,
    ChainProbe,
    ChainReconciliation,
    Report,
    RunResult,
    _worst,
    exit_code,
    overall_status,
)
from ousd.reconcile.supply import _check_supply
from ousd.sources import BridgeSnapshot
from ousd.store import Status, Store


def _finish_run(
    store: Store, run_id: str, status: Status, code: int, matched_total: int | None
) -> None:
    """End the run, with a passing comparison in the same transaction.

    Unit 2.6 reads the newest comparison whatever its run, so a passing row must not exist before
    its run has finished. A Bridge pass only happens with every chain passing, so its run passes.
    """
    if matched_total is None:
        store.finish_run(run_id, status, code)
        return
    store.db.begin()
    try:
        store.record_bridge_comparison(run_id, REQUIRED_CHAINS, matched_total, matched_total, True)
        store.finish_run(run_id, status, code)
        store.db.commit()
    except BaseException:  # Ctrl-C too, or this connection stays inside the transaction.
        store.db.rollback()
        raise


def run_reconciliation(
    probes: Sequence[ChainProbe],
    store: Store,
    report: Report,
    *,
    bridge: Callable[[], BridgeSnapshot] | None = None,
    census: Collection[str] = (),
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.time,
) -> RunResult:
    """Run the checks and record the result, as _run_reconciliation explains. Afterwards the store
    files nothing under the run, even one that raised and so stays unfinished."""
    try:
        return _run_reconciliation(
            probes, store, report, bridge=bridge, census=census, sleep=sleep, clock=clock
        )
    finally:
        store.leave_run()


def _run_reconciliation(
    probes: Sequence[ChainProbe],
    store: Store,
    report: Report,
    *,
    bridge: Callable[[], BridgeSnapshot] | None = None,
    census: Collection[str] = (),
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.time,
) -> RunResult:
    """Run the checks and record the result, which is what the publish gate reads.

    `report` hears each outcome as it happens. Only a chain that can't be read, or a store
    conflict, is caught around a chain. Anything else is a bug, so it raises, and the run row
    stays unfinished so it can't read as a pass. `bridge` fetches Bridge's snapshot, and raises
    HttpError or ValueError when it can't. `census` names the chains to read every wallet of.
    """
    names = [probe.name for probe in probes]
    if len(set(names)) != len(names):
        raise ValueError(f"more than one probe for a chain: {names}")
    if unknown := set(census) - set(names):
        raise ValueError(f"a census of a chain with no probe: {sorted(unknown)}")
    # From the probes, so a run can't claim a scope it didn't check.
    scope = FULL_SCOPE if set(REQUIRED_CHAINS) <= set(names) else PARTIAL_SCOPE
    run_id = store.start_run(scope)
    recorder = _RunRecorder(store, run_id, report)

    coverage: dict[str, _Coverage] = {}
    chains: dict[str, Status] = {}
    for name in REQUIRED_CHAINS:
        if name not in names:
            chains[name] = recorder.record(
                "chain_supply", name, "unchecked", "not_configured"
            ).status

    def wait(attempt: int, seconds: int) -> None:
        report(BridgeWait(attempt, seconds, clock() + seconds))
        sleep(seconds)

    bridge_attempts: list[Status] = []
    compared: set[int] = set()
    matched_total: int | None = None
    for attempt in range(1, BRIDGE_ATTEMPTS + 1):
        # Before any chain syncs, so every pin is at or after what Bridge has seen. A partial run
        # can't pass whatever Bridge says, so it doesn't ask.
        fetched = None
        if bridge is not None and scope == FULL_SCOPE:
            fetched = _fetch_bridge(bridge, compared, attempt, wait, clock)

        readings: dict[str, ChainReconciliation] = {}
        # One chain being unchecked doesn't stop the others, so a failure can't hide what the
        # rest found. A retry repeats every chain, so a final pin never holds unchecked rows.
        for probe in probes:
            run = _ChainRun(probe, store, recorder, report, run_id)
            supply = _check_supply(probe, store, recorder)
            reading = supply.reconciliation
            balances: Status = "pass"
            if supply.status == "pass":
                every_wallet = probe.name in census or probe.name in CHAINS_READ_WHOLE
                balances, supply = _check_balances(run, supply, coverage, every_wallet, clock)
                reading = supply.reconciliation or reading
            parts = [supply.status, balances, _check_census(probe, store, recorder)]
            # With a failed supply too, as a duplicated mint shows up here and in nothing else.
            if reading:
                readings[probe.name] = reading
                parts.append(_check_groups(run, reading.block_number))
            chains[probe.name] = _worst(*parts)

        if any(status != "pass" for status in chains.values()):
            if fetched and fetched.snapshot:
                comparison = compare_with_bridge(list(readings.values()), fetched.snapshot.total)
                report(BridgeFigures(attempt, fetched.snapshot, fetched.fetched_at, comparison))
            bridge_attempts.append(
                recorder.record("bridge", BRIDGE_SUBJECT, "unchecked", "chains_not_passed").status
            )
            break
        if fetched is None:
            bridge_attempts.append(
                recorder.record("bridge", BRIDGE_SUBJECT, "unchecked", "not_configured").status
            )
            break
        check = _judge_bridge(fetched, attempt, probes, readings, store, run_id, recorder, report)
        bridge_attempts.append(check.status)
        if check.status == "pass":
            matched_total = check.matched_sum
            break
        if check.status == "fail" and fetched.snapshot:
            compared.add(fetched.snapshot.last_updated)
        if attempt < BRIDGE_ATTEMPTS:
            wait(attempt, BRIDGE_RETRY_DELAY)

    bridge_final = _bridge_status(bridge_attempts)
    status = overall_status(names, chains, bridge_final)
    code = exit_code(status)
    _finish_run(store, run_id, status, code, matched_total)
    return RunResult(run_id, scope, status, code, chains, bridge_final, recorder.outcomes)
