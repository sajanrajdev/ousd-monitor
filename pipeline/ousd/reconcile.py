"""The key check: do stored events explain the supply each chain reports?"""

import itertools
import math
import time
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass, field
from typing import NamedTuple, Protocol

from ousd.chains import REQUIRED_CHAINS, Chain
from ousd.http import HttpError
from ousd.sources import BridgeSnapshot, RpcClient, RpcError, TransactionProof
from ousd.store import Status, Store, StoreConflict

FULL_SCOPE = "full"
PARTIAL_SCOPE = "partial"
# The subject of a bridge row, which is about all the chains together.
BRIDGE_SUBJECT = "all"
# Rereads after the first, for a pin that lands below the cursor.
PIN_ROUNDS = 3
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
# Solana reads only finalized blocks, so it stores no block hashes. Store.latest_reconciliation
# accepts a missing pin hash for these chains and no others.
CHAINS_WITHOUT_BLOCK_HASHES = frozenset({"solana"})
EXIT_CODES: Mapping[Status, int] = {"pass": 0, "fail": 1, "unchecked": 3}

# Every reason a check can record. Provider text is never stored, as a key echoed in an error
# would then be persisted, so anything else is recorded as source_error.
REASONS = frozenset(
    {
        "above_cursor",
        "bridge_malformed",
        "bridge_mismatch",
        "bridge_same_snapshot",
        "bridge_stale",
        "bridge_unavailable",
        "bridge_window_too_busy",
        "census_missing",
        "chains_not_passed",
        "coverage_gap",
        "diagnostic_only",
        "group_proof_unavailable",
        "not_configured",
        "not_synced",
        "pin_behind_cursor",
        "pin_hash_missing",
        "sample_incomplete",
        "source_error",
        "state_unavailable",
        "store_conflict",
        "supply_mismatch",
        "sync_failed",
    }
)


@dataclass(frozen=True)
class ChainReconciliation:
    chain: str
    block_number: int
    minted: int
    burned: int
    onchain_supply: int

    @property
    def event_supply(self) -> int:
        return self.minted - self.burned

    @property
    def difference(self) -> int:
        return self.event_supply - self.onchain_supply

    @property
    def matched(self) -> bool:
        return self.difference == 0


@dataclass(frozen=True)
class BridgeComparison:
    """Our chain sum against Bridge. Partial until every chain is ingested."""

    chains_included: tuple[str, ...]
    chains_missing: tuple[str, ...]
    chains_total: int
    bridge_total: int

    @property
    def difference(self) -> int:
        return self.chains_total - self.bridge_total

    @property
    def is_partial(self) -> bool:
        return bool(self.chains_missing)


@dataclass(frozen=True)
class Unchecked:
    """A chain's supply couldn't be read. Nothing is proven wrong, and nothing is proven right."""

    chain: str
    reason: str


class ChainUnavailable(Exception):
    """A probe couldn't read something. `reason` is a code from REASONS, never provider text."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class BalanceRead(NamedTuple):
    address: str
    height: int
    amount: int  # Base units.


class ChainProbe(Protocol):
    """All reconcile knows about a chain, so it never has to import a chain family's code."""

    name: str
    needs_census: bool

    def supply_check(self) -> ChainReconciliation | Unchecked:
        """Sync to the tip, then compare events with the chain's supply at that pin."""
        ...

    def pin_timestamp(self, height: int) -> int:
        """Unix seconds of this block or slot. A failed read raises ChainUnavailable."""
        ...

    def read_balances(self, addresses: Sequence[str], height: int) -> list[BalanceRead]: ...

    def read_transaction_proof(self, tx_hash: str) -> TransactionProof | None: ...


@dataclass(frozen=True)
class CheckOutcome:
    check_name: str
    subject: str
    status: Status
    reason: str | None = None
    # None when nothing was recorded, as for check_at_block.
    attempt: int | None = None
    reconciliation: ChainReconciliation | None = None


@dataclass(frozen=True)
class BridgeWait:
    """The run is sleeping before another Bridge attempt, so a long run isn't silent."""

    attempt: int
    seconds: int
    resume_at: float  # Unix seconds.


@dataclass(frozen=True)
class BridgeFigures:
    """What an attempt found against Bridge, for the terminal. The status is on the check row."""

    attempt: int
    snapshot: BridgeSnapshot
    fetched_at: float  # Unix seconds.
    comparison: BridgeComparison


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


@dataclass(frozen=True)
class RunResult:
    run_id: str
    scope: str
    status: Status
    exit_code: int
    chains: dict[str, Status]
    bridge: Status
    outcomes: list[CheckOutcome]


def overall_status(scope: Collection[str], chains: Mapping[str, Status], bridge: Status) -> Status:
    """The run's status. Only every required chain and Bridge passing, in scope, is a pass."""
    statuses = [*chains.values(), bridge]
    if "fail" in statuses:
        return "fail"
    in_scope = set(REQUIRED_CHAINS) <= set(scope)
    scope_passed = all(chains.get(name) == "pass" for name in scope)
    every_part_passed = all(status == "pass" for status in statuses)
    return "pass" if in_scope and scope_passed and every_part_passed else "unchecked"


def exit_code(status: Status) -> int:
    return EXIT_CODES[status]


def _worst(*statuses: Status) -> Status:
    if "fail" in statuses:
        return "fail"
    return "unchecked" if "unchecked" in statuses else "pass"


def _bridge_status(attempts: Collection[Status]) -> Status:
    """Any pass counts. Without one, a single compared and unmatched attempt is a fail."""
    if "pass" in attempts:
        return "pass"
    return "fail" if "fail" in attempts else "unchecked"


def _read_supply(chain: Chain, rpc: RpcClient, block_number: int, stored_hash: str | None) -> int:
    """totalSupply() at one block, the only part of a check that talks to a node.

    A past block's hash has been pruned from the store, so it is fetched, and the block is read
    by number only if the node can't find it. Hash reads reach far deeper on public nodes.
    """
    pinned_hash = stored_hash
    if pinned_hash is None:
        block = rpc.block(block_number)
        pinned_hash = block.hash if block else None
    return rpc.total_supply(chain.token, pinned_hash or block_number)


def reconcile_chain(
    chain: Chain, rpc: RpcClient, store: Store, at_block: int | None = None
) -> ChainReconciliation:
    """Compare events with totalSupply() at one block, and record it.

    By default that is the last synced block, pinned by its hash. A past block can be given
    to check history.
    """
    synced = store.synced_through(chain.name)
    if synced is None:
        raise RuntimeError(f"{chain.name}: nothing synced yet, run sync first")
    block_number = synced if at_block is None else at_block
    if block_number > synced:
        raise ValueError(f"{chain.name}: block {block_number} is above synced block {synced}")

    stored_hash = store.block_hashes(chain.name).get(block_number)
    onchain = _read_supply(chain, rpc, block_number, stored_hash)
    minted, burned = store.minted_and_burned(chain.name, block_number)
    result = ChainReconciliation(chain.name, block_number, minted, burned, onchain)
    store.record_reconciliation(chain.name, block_number, minted, burned, onchain, result.matched)
    return result


def check_at_block(chain: Chain, rpc: RpcClient, store: Store, block: int) -> CheckOutcome:
    """The `--at-block` diagnostic. It records nothing, so it can't affect the publish gate.

    A match is `unchecked`, as one past block says nothing about the data as it stands.
    """

    def outcome(
        status: Status, reason: str, reading: ChainReconciliation | None = None
    ) -> CheckOutcome:
        return CheckOutcome("chain_supply", chain.name, status, reason, None, reading)

    synced = store.synced_through(chain.name)
    if synced is None:
        return outcome("unchecked", "not_synced")
    if block > synced:
        return outcome("unchecked", "above_cursor")
    stored_hash = store.block_hashes(chain.name).get(block)
    try:
        onchain = _read_supply(chain, rpc, block, stored_hash)
    except (HttpError, RpcError, ValueError):
        # A node refusing old state, or answering "0x" for it, proves nothing about the events.
        # Only the node reads are inside this, so a store error or a bug still raises.
        return outcome("unchecked", "state_unavailable")
    minted, burned = store.minted_and_burned(chain.name, block)
    reading = ChainReconciliation(chain.name, block, minted, burned, onchain)
    if reading.matched:
        return outcome("unchecked", "diagnostic_only", reading)
    return outcome("fail", "supply_mismatch", reading)


class _RunRecorder:
    """One run's checks. Every row goes through record, so `attempt` is one rising counter per
    check and subject across every kind of retry, and `reason` can only be a fixed code."""

    def __init__(
        self,
        store: Store,
        run_id: str,
        report: Callable[[CheckOutcome | BridgeWait | BridgeFigures], None],
    ) -> None:
        self._store = store
        self._run_id = run_id
        self._report = report
        self._attempts: dict[tuple[str, str], int] = {}
        self.outcomes: list[CheckOutcome] = []

    def record(
        self,
        check_name: str,
        subject: str,
        status: Status,
        reason: str | None = None,
        *,
        cause: BaseException | None = None,
        reading: ChainReconciliation | None = None,
        reference: int | None = None,
        observed: int | None = None,
        detail: Mapping[str, object] | None = None,
    ) -> CheckOutcome:
        attempt = self._attempts.get((check_name, subject), 0) + 1
        self._attempts[check_name, subject] = attempt
        fixed = reason if reason is None or reason in REASONS else "source_error"
        # The class name only: an exception's message can hold a URL with a key in it.
        error = {"error": type(cause).__name__} if cause else {}
        self._store.record_check(
            self._run_id,
            check_name,
            subject,
            attempt,
            status,
            fixed,
            pin_height=reading.block_number if reading else None,
            pin_hash=self._store.block_hashes(subject).get(reading.block_number)
            if reading
            else None,
            transfer_count=self._store.transfer_count(subject) if reading else None,
            reference_value=reading.onchain_supply if reading else reference,
            observed_value=reading.event_supply if reading else observed,
            detail={**(detail or {}), **error},
        )
        outcome = CheckOutcome(check_name, subject, status, fixed, attempt, reading)
        self.outcomes.append(outcome)
        self._report(outcome)
        return outcome


def _judge_supply(
    probe: ChainProbe, reading: ChainReconciliation, store: Store
) -> tuple[Status, str | None]:
    if not reading.matched:
        return "fail", "supply_mismatch"
    if reading.block_number != store.synced_through(probe.name):
        return "unchecked", "pin_behind_cursor"
    # The gate treats a missing hash as changed data, so a pass here would never be usable.
    if (
        probe.name not in CHAINS_WITHOUT_BLOCK_HASHES
        and reading.block_number not in store.block_hashes(probe.name)
    ):
        return "unchecked", "pin_hash_missing"
    return "pass", None


def _check_supply(probe: ChainProbe, store: Store, recorder: _RunRecorder) -> CheckOutcome:
    """Blocking check 1, ending at a pin equal to the cursor.

    A mismatch gets one more sync and read, since a load-balanced node can serve a block's hash
    before another returns its logs, and a real loss doesn't heal. A second mismatch is a fail.
    A probe's supply_check syncs first, so each read here is at a fresh tip.
    """
    mismatch_retried = False
    pin_rounds = 0
    while True:
        try:
            reading = probe.supply_check()
        except ChainUnavailable as exc:
            return recorder.record(
                "chain_supply", probe.name, "unchecked", exc.reason, cause=exc.__cause__
            )
        except StoreConflict as exc:
            return recorder.record("chain_supply", probe.name, "fail", "store_conflict", cause=exc)
        if reading.chain != probe.name:
            # A bug in the probe. Recording it would file another chain's figures under this name.
            raise ValueError(f"{probe.name} probe answered for {reading.chain}")
        if isinstance(reading, Unchecked):
            return recorder.record("chain_supply", probe.name, "unchecked", reading.reason)

        status, reason = _judge_supply(probe, reading, store)
        outcome = recorder.record("chain_supply", probe.name, status, reason, reading=reading)
        if reason == "supply_mismatch" and not mismatch_retried:
            mismatch_retried = True
        elif reason == "pin_behind_cursor" and pin_rounds < PIN_ROUNDS:
            pin_rounds += 1
        else:
            return outcome


def _check_census(probe: ChainProbe, store: Store, recorder: _RunRecorder) -> Status:
    if probe.needs_census and not store.census_complete(probe.name):
        return recorder.record("balance_census", probe.name, "unchecked", "census_missing").status
    return "pass"


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
    report: Callable[[CheckOutcome | BridgeWait | BridgeFigures], None],
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
    if check.status != "unchecked" and chains_total is not None:
        # A row for each comparison actually made, so never for an outage or a stale snapshot.
        store.record_bridge_comparison(
            run_id, REQUIRED_CHAINS, chains_total, snapshot.total, check.status == "pass"
        )
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
    return check


def run_reconciliation(
    probes: Sequence[ChainProbe],
    store: Store,
    report: Callable[[CheckOutcome | BridgeWait | BridgeFigures], None],
    *,
    bridge: Callable[[], BridgeSnapshot] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.time,
) -> RunResult:
    """Run the checks and record the result, which is what the publish gate reads.

    `report` hears each outcome as it happens. Only a chain that can't be read, or a store
    conflict, is caught around a chain. Anything else is a bug, so it raises, and the run row
    stays unfinished so it can't read as a pass. `bridge` fetches Bridge's snapshot, and raises
    HttpError or ValueError when it can't.
    """
    names = [probe.name for probe in probes]
    if len(set(names)) != len(names):
        raise ValueError(f"more than one probe for a chain: {names}")
    # From the probes, so a run can't claim a scope it didn't check.
    scope = FULL_SCOPE if set(REQUIRED_CHAINS) <= set(names) else PARTIAL_SCOPE
    run_id = store.start_run(scope)
    recorder = _RunRecorder(store, run_id, report)

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
            supply = _check_supply(probe, store, recorder)
            chains[probe.name] = _worst(supply.status, _check_census(probe, store, recorder))
            if supply.reconciliation:
                readings[probe.name] = supply.reconciliation

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
            break
        if check.status == "fail" and fetched.snapshot:
            compared.add(fetched.snapshot.last_updated)
        if attempt < BRIDGE_ATTEMPTS:
            wait(attempt, BRIDGE_RETRY_DELAY)

    bridge_final = _bridge_status(bridge_attempts)
    status = overall_status(names, chains, bridge_final)
    code = exit_code(status)
    store.finish_run(run_id, status, code)
    return RunResult(run_id, scope, status, code, chains, bridge_final, recorder.outcomes)


def compare_with_bridge(results: list[ChainReconciliation], bridge_total: int) -> BridgeComparison:
    included = tuple(result.chain for result in results)
    return BridgeComparison(
        chains_included=included,
        # Derived from what was checked, so `--chain tempo` can never read as a full comparison.
        chains_missing=tuple(chain for chain in REQUIRED_CHAINS if chain not in included),
        chains_total=sum(result.onchain_supply for result in results),
        bridge_total=bridge_total,
    )
