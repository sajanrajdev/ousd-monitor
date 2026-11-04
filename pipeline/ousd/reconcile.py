"""The key check: do stored events explain the supply each chain reports?"""

import time
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from typing import NamedTuple, Protocol

from ousd.chains import REQUIRED_CHAINS, Chain
from ousd.http import HttpError
from ousd.sources import RpcClient, RpcError, TransactionProof
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

    def pin_timestamp(self, height: int) -> int: ...

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
        self, store: Store, run_id: str, report: Callable[[CheckOutcome | BridgeWait], None]
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
    ) -> CheckOutcome:
        attempt = self._attempts.get((check_name, subject), 0) + 1
        self._attempts[check_name, subject] = attempt
        fixed = reason if reason is None or reason in REASONS else "source_error"
        # The class name only: an exception's message can hold a URL with a key in it.
        detail = {"error": type(cause).__name__} if cause else {}
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
            reference_value=reading.onchain_supply if reading else None,
            observed_value=reading.event_supply if reading else None,
            detail=detail,
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


def run_reconciliation(
    probes: Sequence[ChainProbe],
    store: Store,
    report: Callable[[CheckOutcome | BridgeWait], None],
    *,
    bridge: Callable[[Sequence[ChainReconciliation]], tuple[Status, str | None]] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.time,
) -> RunResult:
    """Run the checks and record the result, which is what the publish gate reads.

    `report` hears each outcome as it happens. Only a chain that can't be read, or a store
    conflict, is caught around a chain. Anything else is a bug, so it raises, and the run row
    stays unfinished so it can't read as a pass.
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

    bridge_attempts: list[Status] = []
    for attempt in range(1, BRIDGE_ATTEMPTS + 1):
        readings: list[ChainReconciliation] = []
        # One chain being unchecked doesn't stop the others, so a failure can't hide what the
        # rest found. A retry repeats every chain, so a final pin never holds unchecked rows.
        for probe in probes:
            supply = _check_supply(probe, store, recorder)
            chains[probe.name] = _worst(supply.status, _check_census(probe, store, recorder))
            if supply.reconciliation:
                readings.append(supply.reconciliation)

        if any(status != "pass" for status in chains.values()):
            bridge_attempts.append(
                recorder.record("bridge", BRIDGE_SUBJECT, "unchecked", "chains_not_passed").status
            )
            break
        if bridge is None:
            bridge_attempts.append(
                recorder.record("bridge", BRIDGE_SUBJECT, "unchecked", "not_configured").status
            )
            break
        status, reason = bridge(readings)
        bridge_attempts.append(recorder.record("bridge", BRIDGE_SUBJECT, status, reason).status)
        if status == "pass":
            break
        if attempt < BRIDGE_ATTEMPTS:
            report(BridgeWait(attempt, BRIDGE_RETRY_DELAY, clock() + BRIDGE_RETRY_DELAY))
            sleep(BRIDGE_RETRY_DELAY)

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
