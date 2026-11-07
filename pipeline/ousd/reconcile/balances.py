"""Blocking check 3: the model's balances against the chain's own, for a seeded sample or a
census of every wallet, and then for the wallets each later pin touched.
"""

import hashlib
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime

from ousd.decode import ZERO_ADDRESS
from ousd.reconcile.recorder import _ChainRun, _RunRecorder
from ousd.reconcile.status import (
    BalanceFinding,
    ChainProbe,
    ChainUnavailable,
    CheckOutcome,
    Unchecked,
)
from ousd.reconcile.supply import PIN_ROUNDS, _check_supply, _pin
from ousd.store import BalanceSample, Status, Store, StoreConflict

# Each sampled balance check reads this many wallets. The top count matches unit 2.8's.
TOP_WALLETS = 20
RANDOM_WALLETS = 30
# One read returns every wallet at one slot, so a sample would save nothing. Blocking check 3 has
# these chains check every wallet.
CHAINS_READ_WHOLE = frozenset({"solana"})


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
    wallets its rows touched, in up to PIN_ROUNDS rounds. Returns the balance status and the newest
    supply outcome.

    A wallet with no row since keeps its reading. So a transfer lost between two wallets with no
    later row exits 0 with the gate usable, and a later run catches it only if one of them is
    drawn, about 3% a run on Tempo. The plan accepts this limit.
    """
    name = run.probe.name

    def settled() -> bool:
        pin = _pin(supply)
        return (
            run.store.synced_through(name) == pin
            and coverage[name].through >= pin
            and not _rows_replaced(run.store, name, coverage[name])
        )

    if name not in coverage:
        seed, read, supply = _read_sample(run, supply, census, clock)
        if read.status != "pass":
            return read.status, supply
        coverage[name] = _Coverage(seed, read.covers, read.covers_hash)

    for _ in range(PIN_ROUNDS):
        if settled():
            return "pass", supply
        if run.store.synced_through(name) != _pin(supply):
            supply = _check_supply(run.probe, run.store, run.recorder)
            if supply.status != "pass":
                return supply.status, supply
        pin = _pin(supply)
        covered = coverage[name]
        if _rows_replaced(run.store, name, covered):
            seed, read, supply = _read_sample(run, supply, census, clock)
        elif covered.through >= pin:
            continue
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
    # The last round's read may have settled it, and no further round can.
    if settled():
        return "pass", supply
    status = run.recorder.record(
        "sampled_balances", name, "unchecked", "pin_behind_cursor", pin=_pin(supply)
    ).status
    return status, supply
