"""The key check: do stored events explain the supply each chain reports?"""

import hashlib
import itertools
import math
import time
from collections import Counter
from collections.abc import Callable, Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Literal, NamedTuple, Protocol

from ousd.chains import REQUIRED_CHAINS, Chain
from ousd.decode import ZERO_ADDRESS, Transfer
from ousd.http import HttpError
from ousd.sources import BridgeSnapshot, ProofTransfer, RpcClient, RpcError, TransactionProof
from ousd.store import BalanceSample, SameLookingGroup, Status, Store, StoreConflict

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
# Each sampled balance check reads this many wallets. The top count matches unit 2.8's.
TOP_WALLETS = 20
RANDOM_WALLETS = 30
# One read returns every wallet at one slot, so a sample would save nothing. Blocking check 3 has
# these chains check every wallet.
CHAINS_READ_WHOLE = frozenset({"solana"})
# These chains' group proofs are decoded transactions. Every other chain's are receipts, or
# Blockscout's listing, the only source that reports no status.
CHAINS_PROVEN_BY_TRANSACTION = frozenset({"solana"})
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
        report: Report,
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
        pin: int | None = None,
        reference: int | None = None,
        observed: int | None = None,
        detail: Mapping[str, object] | None = None,
        samples: Sequence[BalanceSample] = (),
    ) -> CheckOutcome:
        attempt = self._attempts.get((check_name, subject), 0) + 1
        self._attempts[check_name, subject] = attempt
        fixed = reason if reason is None or reason in REASONS else "source_error"
        # The class name only: an exception's message can hold a URL with a key in it.
        error = {"error": type(cause).__name__} if cause else {}
        height = reading.block_number if reading else pin
        self._store.record_check(
            self._run_id,
            check_name,
            subject,
            attempt,
            status,
            fixed,
            pin_height=height,
            pin_hash=None if height is None else self._store.block_hashes(subject).get(height),
            transfer_count=None if height is None else self._store.transfer_count(subject),
            reference_value=reading.onchain_supply if reading else reference,
            observed_value=reading.event_supply if reading else observed,
            detail={**(detail or {}), **error},
            samples=samples,
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


def sample_seed(chain: str, date: str) -> str:
    return f"v1|{chain}|{date}"


def choose_sample(
    chain: str, date: str, candidates: Iterable[str], top: Sequence[str], census: bool = False
) -> dict[str, str]:
    """The wallets to read, each with its stratum, in the order the strata are listed.

    `candidates` is every address through the pin, and `date` is a UTC date. Ranked by hash, so the
    same date and rows give the same wallets on any Python, and a new wallet barely changes the
    rest. A wallet in `top` isn't also drawn, so `random` keeps its full count.
    """
    seed = sample_seed(chain, date)
    eligible = set(candidates) - {ZERO_ADDRESS}
    chosen = {address: "top" for address in top if address in eligible}
    ranked = sorted(
        eligible - chosen.keys(),
        key=lambda address: hashlib.sha256(f"{seed}|{address}".encode()).hexdigest(),
    )
    chosen.update(dict.fromkeys(ranked[:RANDOM_WALLETS], "random"))
    if census:
        chosen.update(dict.fromkeys(ranked[RANDOM_WALLETS:], "census"))
    return chosen


@dataclass(frozen=True)
class _ChainRun:
    """What the checks on one chain share."""

    probe: ChainProbe
    store: Store
    recorder: _RunRecorder
    report: Report
    run_id: str


@dataclass(frozen=True)
class _Coverage:
    """How far a chain's wallets are checked, kept across Bridge retries, which don't read the
    sample again."""

    seed: str
    through: int
    # The block hash at `through`, so a fork below it shows. None on a chain that stores none.
    through_hash: str | None


@dataclass(frozen=True)
class _WalletRead:
    status: Status
    reason: str | None = None
    # The wallets that differed, with their strata. Non-empty only for a proven difference.
    mismatched: Mapping[str, str] = field(default_factory=dict)
    # How far this read covers. Only a pass sets these, and 0 would just mean reading more.
    covers: int = 0
    covers_hash: str | None = None


def _pin(supply: CheckOutcome) -> int:
    if supply.reconciliation is None:
        raise ValueError(f"{supply.subject}: a chain_supply outcome with no reading has no pin")
    return supply.reconciliation.block_number


def _read_wallets(
    run: _ChainRun, wallets: Mapping[str, str], seed: str, pin: int, kind: str
) -> _WalletRead:
    """Compare each wallet with the model at the height its reading reports, and record it."""
    name = run.probe.name

    def unusable(status: Status, reason: str, cause: BaseException | None = None) -> _WalletRead:
        run.recorder.record("sampled_balances", name, status, reason, cause=cause, pin=pin)
        return _WalletRead(status, reason)

    try:
        reads = run.probe.read_balances(list(wallets), pin)
    except ChainUnavailable as exc:
        return unusable("unchecked", exc.reason, exc.__cause__)
    except StoreConflict as exc:
        return unusable("fail", "store_conflict", exc)
    if isinstance(reads, Unchecked):
        return unusable("unchecked", reads.reason)
    if not reads or sorted(read.address for read in reads) != sorted(wallets):
        return unusable("unchecked", "sample_incomplete")
    # Rows above the cursor aren't stored, so a model at that height would be short of them.
    cursor = run.store.synced_through(name)
    if cursor is None or any(read.height > cursor for read in reads):
        return unusable("unchecked", "above_cursor")

    by_height: dict[int, list[str]] = {}
    for read in reads:
        by_height.setdefault(read.height, []).append(read.address)
    model = {
        (height, address): balance
        for height, addresses in by_height.items()
        for address, balance in run.store.balances_at(name, addresses, height).items()
    }
    samples = [
        BalanceSample(
            read.address,
            wallets[read.address],
            seed,
            read.height,
            model[read.height, read.address],
            read.amount,
        )
        for read in reads
    ]
    differing = [sample for sample in samples if sample.model_balance != sample.observed_balance]
    status: Status = "fail" if differing else "pass"
    outcome = run.recorder.record(
        "sampled_balances",
        name,
        status,
        "balance_mismatch" if differing else None,
        pin=pin,
        # Counts only, as an address must not reach this table.
        detail={
            "kind": kind,
            "seed": seed,
            "wallets": len(samples),
            "mismatched": len(differing),
            "strata": dict(Counter(sample.stratum for sample in samples)),
            "lowest_height": min(by_height),
            "highest_height": max(by_height),
        },
        samples=samples,
    )
    for sample in differing:
        run.report(
            BalanceFinding(
                name,
                outcome.attempt or 0,
                sample.address,
                sample.height,
                sample.model_balance,
                sample.observed_balance,
            )
        )
    # No further than the pin, even when the read landed past it. Rows above the pin can hold a
    # wallet this read wasn't asked about.
    covers = min(*by_height, pin)
    return _WalletRead(
        status,
        outcome.reason,
        {sample.address: sample.stratum for sample in differing},
        covers,
        # Taken now, so a fork in the resync that a mismatch sets off still shows.
        run.store.block_hashes(name).get(covers),
    )


def _read_with_retry(
    run: _ChainRun, wallets: Mapping[str, str], seed: str, supply: CheckOutcome, kind: str
) -> tuple[_WalletRead, CheckOutcome]:
    """A mismatch gets one resync, a supply check and a read of only the wallets that differed,
    as a lagging node heals and a real loss doesn't. Solana's read and sync are one call, so it
    gets the same."""
    first = _read_wallets(run, wallets, seed, _pin(supply), kind)
    if not first.mismatched:
        return first, supply
    supply = _check_supply(run.probe, run.store, run.recorder)
    if supply.status != "pass":
        return _WalletRead(supply.status, supply.reason), supply
    second = _read_wallets(run, first.mismatched, seed, _pin(supply), "recheck")
    # The wallets that matched keep their first reading, so coverage stays with it. With hashes, a
    # lower second read can only mean a shorter fork, and keeping the first is what makes that show.
    # With none, a lagging read really is the lower bound.
    kept = first if first.covers_hash else min(first, second, key=lambda read: read.covers)
    return replace(second, covers=kept.covers, covers_hash=kept.covers_hash), supply


def _read_sample(
    run: _ChainRun, supply: CheckOutcome, census: bool, clock: Callable[[], float]
) -> tuple[str, _WalletRead, CheckOutcome]:
    name = run.probe.name
    pin = _pin(supply)
    date = datetime.fromtimestamp(clock(), UTC).date().isoformat()
    seed = sample_seed(name, date)
    top = [address for address, _ in run.store.top_wallets(name, pin, TOP_WALLETS)]
    wallets = choose_sample(name, date, run.store.wallets(name, pin), top, census)
    read, supply = _read_with_retry(run, wallets, seed, supply, "census" if census else "sample")
    if census:
        # After the mismatch retry, so one row says how the whole read ended.
        run.recorder.record(
            "balance_census",
            name,
            read.status,
            read.reason,
            pin=pin,
            detail={"wallets": len(wallets)},
        )
    return seed, read, supply


def _rows_replaced(store: Store, chain: str, covered: _Coverage) -> bool:
    """Did a fork replace rows at or below the covered height? A delta only reads above it.

    A fork below a block changes that block's hash. A hash that's gone was pruned as final, unless
    the chain is now shorter than it.
    """
    if covered.through_hash is None:
        return False
    cursor = store.synced_through(chain)
    if cursor is None or cursor < covered.through:
        return True
    current = store.block_hashes(chain).get(covered.through)
    return current is not None and current != covered.through_hash


def _check_balances(
    run: _ChainRun,
    supply: CheckOutcome,
    coverage: dict[str, _Coverage],
    census: bool,
    clock: Callable[[], float],
) -> tuple[Status, CheckOutcome]:
    """Blocking check 3, ending with the last supply check's pin equal to the cursor and every
    wallet touched since the sample read at that pin.

    The sample is read once a run, unless a fork replaced the rows it was compared with. Every
    later pin, whether from a Bridge retry or from a read that moved the cursor, is covered by the
    wallets its rows touched. A wallet with no row since keeps its reading, so a loss between two
    wallets with no other row by then waits for a later run. Returns the balance status and the
    newest supply outcome.
    """
    name = run.probe.name
    # One more than PIN_ROUNDS, for the sample itself.
    for _ in range(PIN_ROUNDS + 2):
        if run.store.synced_through(name) != _pin(supply):
            supply = _check_supply(run.probe, run.store, run.recorder)
            if supply.status != "pass":
                return supply.status, supply
        pin = _pin(supply)
        covered = coverage.get(name)
        if covered is None or _rows_replaced(run.store, name, covered):
            seed, read, supply = _read_sample(run, supply, census, clock)
        elif covered.through >= pin:
            return "pass", supply
        else:
            seed = covered.seed
            touched = run.store.wallets_touched(name, covered.through, pin)
            if touched:
                read, supply = _read_with_retry(
                    run, dict.fromkeys(touched, "delta"), seed, supply, "delta"
                )
            else:
                run.recorder.record(
                    "sampled_balances",
                    name,
                    "pass",
                    pin=pin,
                    detail={"kind": "delta", "seed": seed, "wallets": 0},
                )
                read = _WalletRead("pass", None, {}, pin, run.store.block_hashes(name).get(pin))
        if read.status != "pass":
            return read.status, supply
        coverage[name] = _Coverage(seed, read.covers, read.covers_hash)
    status = run.recorder.record(
        "sampled_balances", name, "unchecked", "pin_behind_cursor", pin=_pin(supply)
    ).status
    return status, supply


def _proof_source(chain: str, proof: TransactionProof) -> str:
    if proof.success is None:
        return "blockscout"
    return "transaction" if chain in CHAINS_PROVEN_BY_TRANSACTION else "receipt"


def _is_real(rows: Sequence[Transfer], proof: TransactionProof) -> bool:
    """The transaction succeeded, and its logs are the stored rows: a row too many or too few, or
    one at another position, is not real. A source that reports no status is judged on the rows."""
    stored = [
        ProofTransfer(row.log_index, row.from_address, row.to_address, row.value) for row in rows
    ]
    return (
        proof.success is not False
        and sorted(stored) == sorted(proof.transfers)
        and all(row.block_number == proof.block_number for row in rows)
    )


def _check_groups(run: _ChainRun, through: int) -> Status:
    """Is every same-looking group a real set of transfers? Only the transaction can say: a loop
    between two wallets nets to zero, so losing rows from it leaves every balance unchanged.

    Each verdict commits as it's reached, so a stopped run resumes. Rows that aren't real stay
    where they are, as nothing here changes `transfers`, and the maintainer decides what happens.
    """
    name = run.probe.name
    transactions: dict[str, list[SameLookingGroup]] = {}
    for group in run.store.same_looking_groups(name, through):
        transactions.setdefault(group.tx_hash, []).append(group)

    verdicts: Counter[str] = Counter()
    sources: Counter[str] = Counter()
    mixed_groups = 0

    def note(tx_hash: str, verdict: GroupVerdict, stored: list[int], proven: list[int]) -> None:
        nonlocal mixed_groups
        mixed = sum(
            0 < group.null_hash_count < len(group.positions) for group in transactions[tx_hash]
        )
        mixed_groups += mixed
        verdicts[verdict] += 1
        if verdict != "real" or mixed:
            run.report(
                GroupFinding(name, tx_hash, verdict, tuple(stored), tuple(proven), mixed > 0)
            )

    cause: BaseException | None = None
    for tx_hash, groups in transactions.items():
        block = groups[0].block_number
        rows = run.store.transaction_rows(name, tx_hash)
        # Every position in the transaction, as the skip list compares all of them. Only the group's
        # would bring a transaction with other rows back on every run.
        stored = [row.log_index for row in rows]
        try:
            proof = run.probe.read_transaction_proof(tx_hash)
        except ChainUnavailable as exc:
            # The source is down, and every transaction left would wait out its retries too.
            cause = exc.__cause__
            note(tx_hash, "unavailable", stored, [])
            break
        # Any stored block will do. Rows that span two blocks can't all match, which is not_real.
        stored_blocks = {row.block_number for row in rows}
        if proof is None or proof.tx_hash != tx_hash or proof.block_number not in stored_blocks:
            note(tx_hash, "unavailable", stored, [])
            continue
        source = _proof_source(name, proof)
        proven = sorted(transfer.log_index for transfer in proof.transfers)
        verdict: Literal["real", "not_real"] = "real" if _is_real(rows, proof) else "not_real"
        run.store.record_group_audit(
            name, tx_hash, block, verdict, source, stored, proven, run.run_id
        )
        sources[source] += 1
        note(tx_hash, verdict, stored, proven)

    status: Status = "pass"
    reason = None
    if verdicts["not_real"]:
        status, reason = "fail", "group_not_real"
    elif verdicts["unavailable"]:
        status, reason = "unchecked", "group_proof_unavailable"
    return run.recorder.record(
        "same_looking",
        name,
        status,
        reason,
        cause=cause,
        pin=through,
        # Counts only. The transactions themselves are in transfer_group_audits and the report.
        detail={
            "transactions": len(transactions),
            "real": verdicts["real"],
            "not_real": verdicts["not_real"],
            "unavailable": verdicts["unavailable"],
            # Left when a source went down, so a stop on the first can be told from one on the last.
            "not_attempted": len(transactions) - sum(verdicts.values()),
            "proof_sources": dict(sources),
            "mixed_hash_groups": mixed_groups,
        },
    ).status


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


def compare_with_bridge(results: list[ChainReconciliation], bridge_total: int) -> BridgeComparison:
    included = tuple(result.chain for result in results)
    return BridgeComparison(
        chains_included=included,
        # Derived from what was checked, so `--chain tempo` can never read as a full comparison.
        chains_missing=tuple(chain for chain in REQUIRED_CHAINS if chain not in included),
        chains_total=sum(result.onchain_supply for result in results),
        bridge_total=bridge_total,
    )
