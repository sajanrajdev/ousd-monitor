"""The status model: what a check can find, what a run reports as it goes, and the probe
interface, which is all reconcile knows about a chain.
"""

from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, NamedTuple, Protocol

from ousd.chains import REQUIRED_CHAINS
from ousd.sources import BridgeSnapshot, TransactionProof
from ousd.store import Status

FULL_SCOPE = "full"
PARTIAL_SCOPE = "partial"
EXIT_CODES: Mapping[Status, int] = {"pass": 0, "fail": 1, "unchecked": 3}

# Every reason a check can record. Provider text is never stored, as a key echoed in an error
# would then be persisted, so anything else is recorded as source_error.
REASONS = frozenset(
    {
        "above_cursor",
        "balance_mismatch",
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
        "group_not_real",
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

    def read_balances(self, addresses: Sequence[str], height: int) -> list[BalanceRead] | Unchecked:
        """Each wallet's balance, at the height each reading reports.

        A chain with no past-state read answers at a height of its own and syncs through it, so
        this can move the cursor. A read that fails raises ChainUnavailable or returns Unchecked.
        """
        ...

    def read_transaction_proof(self, tx_hash: str) -> TransactionProof | None:
        """The token's Transfer logs in one transaction, or None if no source has it."""
        ...


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
class BalanceFinding:
    """A wallet the chain and the model disagree on. Addresses reach only the terminal and the
    raw tables, so this never goes in a check's detail."""

    chain: str
    attempt: int
    address: str
    height: int
    model_balance: int
    observed_balance: int


GroupVerdict = Literal["real", "not_real", "unavailable"]


@dataclass(frozen=True)
class GroupFinding:
    """A transaction someone should look at: not real, unproven, or mixing hashed and unhashed
    rows, which is the signature of an index mismatch."""

    chain: str
    tx_hash: str
    verdict: GroupVerdict
    stored_positions: tuple[int, ...]
    proven_positions: tuple[int, ...]
    mixed_hash: bool


Report = Callable[[CheckOutcome | BridgeWait | BridgeFigures | BalanceFinding | GroupFinding], None]


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
