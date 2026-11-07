"""Blocking check 2: does Bridge's total equal one supply from each chain, added together?"""

import itertools
import math
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass, field

from ousd.chains import REQUIRED_CHAINS
from ousd.http import HttpError
from ousd.reconcile.recorder import _RunRecorder
from ousd.reconcile.status import (
    BridgeComparison,
    BridgeFigures,
    ChainProbe,
    ChainReconciliation,
    ChainUnavailable,
    Report,
)
from ousd.sources import BridgeSnapshot
from ousd.store import Status, Store

# The subject of a bridge row, which is about all the chains together.
BRIDGE_SUBJECT = "all"
# Any of these attempts may pass, on Bridge snapshots about 10 minutes apart.
BRIDGE_ATTEMPTS = 3
BRIDGE_RETRY_DELAY = 600
# How far from last_updated a chain may be read. The evidence puts Bridge's read no earlier than
# about 223 s before it and under 30 s after. 300 s is the earliest edge those offsets support,
# and 60 s adds a margin. Width costs little, as a pass still needs an exact match.
BRIDGE_WINDOW_BEFORE = 300
BRIDGE_WINDOW_AFTER = 60
# Three update cycles, when the largest age seen was under 15 minutes. A frozen feed would still
# match history, so a stale one must not count as agreement.
BRIDGE_MAX_AGE = 1800
# More ahead of our clock than this, and last_updated can't be believed.
BRIDGE_MAX_AHEAD = 60
# Far above what the measured event rates reach, and low enough to finish in about a second.
BRIDGE_MAX_SUMS = 1_000_000
# A repeat of a snapshot already compared proves nothing new, so wait for Bridge's next one.
BRIDGE_SAME_SNAPSHOT_WAIT = 60
BRIDGE_SAME_SNAPSHOT_TRIES = 5


@dataclass(frozen=True)
class BridgeCheck:
    status: Status
    reason: str | None = None
    sum_at_t: int | None = None
    matched_sum: int | None = None
    # When each chain's matched value began to hold, as stamped by Store.supply_values, so a chain
    # with no movement in the window shows the window's start.
    matched_times: Mapping[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class _BridgeFetch:
    """A fetched snapshot, or the reason an attempt has nothing to compare."""

    snapshot: BridgeSnapshot | None = None
    fetched_at: float = 0.0
    reason: str | None = None
    cause: BaseException | None = None


def _bridge_status(attempts: Collection[Status]) -> Status:
    """Any pass counts. Without one, a single compared and unmatched attempt is a fail."""
    if "pass" in attempts:
        return "pass"
    return "fail" if "fail" in attempts else "unchecked"


def bridge_window(last_updated: int, pin_time: int) -> tuple[int, int]:
    """The times a chain may be taken at. Past the pin, the chain hasn't been checked."""
    return last_updated - BRIDGE_WINDOW_BEFORE, min(last_updated + BRIDGE_WINDOW_AFTER, pin_time)


def check_bridge(
    snapshot: BridgeSnapshot,
    fetched_at: float,
    pins: Mapping[str, int | None],
    values: Mapping[str, Sequence[tuple[int, int]]],
) -> BridgeCheck:
    """Blocking check 2: does Bridge's total equal one value from each chain, added together?

    `pins` holds each chain's pin time, or None if it couldn't be read. `values` holds each
    chain's Store.supply_values over bridge_window. A pass needs a difference of exactly 0: the
    only tolerance is in time. `fetched_at` is the fetch time, so a slow run can't make its own
    snapshot stale.
    """
    last_updated = snapshot.last_updated
    if last_updated - fetched_at > BRIDGE_MAX_AHEAD:
        return BridgeCheck("unchecked", "bridge_malformed")
    if fetched_at - last_updated > BRIDGE_MAX_AGE:
        return BridgeCheck("unchecked", "bridge_stale")
    for name in REQUIRED_CHAINS:
        pin_time = pins.get(name)
        if pin_time is None or pin_time < last_updated or not values.get(name):
            return BridgeCheck("unchecked", "coverage_gap")

    sum_at_t = sum(
        [supply for stamp, supply in values[name] if stamp <= last_updated][-1]
        for name in REQUIRED_CHAINS
    )
    # Each chain's distinct values, nearest T first, so a value held twice records the nearer time.
    choices = [_nearest_first(values[name], last_updated) for name in REQUIRED_CHAINS]
    # Counted before any sum is built. Distinct values per chain bound the attainable sums.
    if math.prod(len(chain_values) for chain_values in choices) > BRIDGE_MAX_SUMS:
        return BridgeCheck("unchecked", "bridge_window_too_busy", sum_at_t)
    for combination in itertools.product(*choices):
        if sum(supply for _, supply in combination) == snapshot.total:
            times = {
                name: stamp for name, (stamp, _) in zip(REQUIRED_CHAINS, combination, strict=True)
            }
            return BridgeCheck("pass", None, sum_at_t, snapshot.total, times)
    return BridgeCheck("fail", "bridge_mismatch", sum_at_t)


def _nearest_first(values: Sequence[tuple[int, int]], last_updated: int) -> list[tuple[int, int]]:
    nearest: dict[int, int] = {}
    for stamp, supply in values:
        held = nearest.get(supply)
        if held is None or abs(stamp - last_updated) < abs(held - last_updated):
            nearest[supply] = stamp
    return sorted(
        ((stamp, supply) for supply, stamp in nearest.items()),
        key=lambda value: abs(value[0] - last_updated),
    )


def _fetch_bridge(
    fetch: Callable[[], BridgeSnapshot],
    compared: Collection[int],
    attempt: int,
    wait: Callable[[int, int], None],
    clock: Callable[[], float],
) -> _BridgeFetch:
    """The snapshot for one attempt, refetched while it repeats one already compared."""
    refetches = 0
    while True:
        try:
            snapshot = fetch()
        except HttpError as exc:
            return _BridgeFetch(reason="bridge_unavailable", cause=exc)
        except ValueError as exc:
            return _BridgeFetch(reason="bridge_malformed", cause=exc)
        fetched_at = clock()
        if snapshot.last_updated not in compared:
            return _BridgeFetch(snapshot, fetched_at)
        if refetches == BRIDGE_SAME_SNAPSHOT_TRIES:
            return _BridgeFetch(snapshot, fetched_at, "bridge_same_snapshot")
        refetches += 1
        wait(attempt, BRIDGE_SAME_SNAPSHOT_WAIT)


def _judge_bridge(
    fetched: _BridgeFetch,
    attempt: int,
    probes: Sequence[ChainProbe],
    readings: Mapping[str, ChainReconciliation],
    store: Store,
    run_id: str,
    recorder: _RunRecorder,
    report: Report,
) -> BridgeCheck:
    """Compare one attempt's snapshot with the events through this attempt's pins, and record it.

    Runs only once every chain has passed, so there is a reading for each probe.
    """
    snapshot = fetched.snapshot
    if snapshot is None or fetched.reason:
        status = recorder.record(
            "bridge", BRIDGE_SUBJECT, "unchecked", fetched.reason, cause=fetched.cause
        ).status
        return BridgeCheck(status, fetched.reason)

    pins: dict[str, int | None] = {}
    values: dict[str, list[tuple[int, int]]] = {}
    for probe in probes:
        height = readings[probe.name].block_number
        try:
            pin_time = probe.pin_timestamp(height)
        except ChainUnavailable:
            pins[probe.name] = None
            continue
        pins[probe.name] = pin_time
        if pin_time >= snapshot.last_updated:
            start, end = bridge_window(snapshot.last_updated, pin_time)
            values[probe.name] = store.supply_values(probe.name, start, end, height)

    check = check_bridge(snapshot, fetched.fetched_at, pins, values)
    chains_total = check.sum_at_t if check.matched_sum is None else check.matched_sum
    if chains_total is not None:
        comparison = BridgeComparison(REQUIRED_CHAINS, (), chains_total, snapshot.total)
        report(BridgeFigures(attempt, snapshot, fetched.fetched_at, comparison))
    recorder.record(
        "bridge",
        BRIDGE_SUBJECT,
        check.status,
        check.reason,
        reference=snapshot.total,
        observed=chains_total,
        detail={
            "last_updated": snapshot.last_updated,
            "window_before": BRIDGE_WINDOW_BEFORE,
            "window_after": BRIDGE_WINDOW_AFTER,
            "pin_times": pins,
            "matched_times": check.matched_times,
            # Text, as JSON readers often lose exactness above 2**53.
            "sum_at_t": None if check.sum_at_t is None else str(check.sum_at_t),
        },
    )
    # After the check row, so a comparison always has one. A row for each comparison actually made,
    # so never for an outage or a stale snapshot. A pass is written by _finish_run.
    if check.status == "fail" and chains_total is not None:
        store.record_bridge_comparison(run_id, REQUIRED_CHAINS, chains_total, snapshot.total, False)
    return check


def compare_with_bridge(results: list[ChainReconciliation], bridge_total: int) -> BridgeComparison:
    included = tuple(result.chain for result in results)
    return BridgeComparison(
        chains_included=included,
        # Derived from what was checked, so `--chain tempo` can never read as a full comparison.
        chains_missing=tuple(chain for chain in REQUIRED_CHAINS if chain not in included),
        chains_total=sum(result.onchain_supply for result in results),
        bridge_total=bridge_total,
    )
