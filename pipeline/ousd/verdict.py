"""The verdict sentence, built only from checked figures, and the limits a reader should know.

It states no more than the data supports: when the data can't carry a sentence, it says so. Fact,
estimate and opinion stay in separate lists, and no partner or issuer is named. All wording is
reviewed by the maintainer before release.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Literal

from ousd.chains import DECIMALS, REQUIRED_CHAINS
from ousd.checks import unacceptable

VerdictState = Literal["mostly_placed", "moving", "mixed", "no_clear_statement"]

# Placed at or above this share of supply is `mostly_placed`.
PLACED_THRESHOLD_BPS = 5_000
# Seven-day everyday volume at or above this share of supply, with placed below, is `moving`.
EVERYDAY_THRESHOLD_BPS = 500

_UNIT = 10**DECIMALS


@dataclass(frozen=True)
class ChainFigures:
    chain: str
    day: date
    total_supply: int
    placed_supply: int
    clean_everyday_7d: int
    full_window: bool
    # A wallet here carries the `issuer` label. Route wallets alone don't settle it.
    has_issuer_label: bool


@dataclass(frozen=True)
class VerdictInputs:
    chains: Sequence[ChainFigures]
    check_statuses: Mapping[str, str]
    placed_days: int
    placed_min_base_units: int
    large_transfer_base_units: int
    journey_first_day: date
    bridge_total: int | None
    # --allow-partial was used. With every chain present nothing is skipped, but it isn't real.
    preview: bool = False


@dataclass(frozen=True)
class Verdict:
    state: VerdictState
    scope: list[str]
    as_of: dict[str, str]
    text: str
    facts: list[str]
    estimates: list[str]
    opinions: list[str]


@dataclass(frozen=True)
class KnownLimit:
    id: str
    text: str


def _title(chain: str) -> str:
    return chain.capitalize()


def _chain_list(chains: Sequence[str]) -> str:
    names = [_title(chain) for chain in chains]
    if len(names) < 2:
        return "".join(names)
    return f"{', '.join(names[:-1])} and {names[-1]}"


def _in_tenths(tenths: int, suffix: str) -> str:
    whole, fraction = divmod(tenths, 10)
    return f"${whole}{suffix}" if fraction == 0 else f"${whole}.{fraction}{suffix}"


def format_dollars(base_units: int) -> str:
    """$4.6M, by integer arithmetic. One OUSD is written as one dollar."""
    dollars = (base_units + _UNIT // 2) // _UNIT
    if dollars < 1_000:
        return f"${dollars}"
    # A unit that rounds up to 1000 gives way to the next, so 999,960 reads $1M and not $1000K.
    for size, suffix in ((10**3, "K"), (10**6, "M")):
        tenths = (dollars * 10 + size // 2) // size
        if tenths < 10_000:
            return _in_tenths(tenths, suffix)
    return _in_tenths((dollars * 10 + 10**9 // 2) // 10**9, "B")


def _percent_two_places(bps: int) -> str:
    return f"{bps // 100}.{bps % 100:02d}"


def _where(scope: Sequence[str], total: int, bridge_total: int | None) -> tuple[str, str | None]:
    """How the sentence opens, and the estimate of the share of OUSD it covers, if any."""
    names = _chain_list(scope)
    if set(scope) == set(REQUIRED_CHAINS):
        return f"On {names},", None
    if not bridge_total:
        return f"On {names}, whose share of OUSD is not known here,", None
    share = (2 * 100 * total + bridge_total) // (2 * bridge_total)
    verb = "holds" if len(scope) == 1 else "hold"
    return (
        f"On {names}, which {verb} about {share}% of OUSD,",
        f"About {share}% of OUSD is on {names}: end-of-day balances against the issuer's "
        "newest reported total, so this is approximate.",
    )


def _why_unclear(inputs: VerdictInputs) -> list[str]:
    if unacceptable(inputs.check_statuses, allow_partial=True):
        return ["a blocking check did not pass"]
    if not inputs.chains:
        return ["no chain has data"]
    reasons = []
    if sum(figures.total_supply for figures in inputs.chains) <= 0:
        reasons.append("supply on these chains is zero")
    if early := [f.chain for f in inputs.chains if f.day < inputs.journey_first_day]:
        reasons.append(
            f"{_chain_list(early)} is too early, as placed reads low until wallets are "
            f"{inputs.placed_days} days old"
        )
    if short := [f.chain for f in inputs.chains if not f.full_window]:
        reasons.append(f"{_chain_list(short)} has less than seven full days of history")
    return reasons


def _labels_change_the_answer(inputs: VerdictInputs) -> bool:
    """A chain with no wallet labeled as the issuer may be counting its inventory as placed. If
    leaving that chain's placed supply out would change the answer, the data doesn't settle it."""
    total = sum(f.total_supply for f in inputs.chains)
    placed = sum(f.placed_supply for f in inputs.chains)
    sure = sum(f.placed_supply for f in inputs.chains if f.has_issuer_label)
    return (placed * 10_000 >= PLACED_THRESHOLD_BPS * total) != (
        sure * 10_000 >= PLACED_THRESHOLD_BPS * total
    )


_PREVIEW_PREFIX = "Local preview, not a finding. "


def build_verdict(rows: VerdictInputs) -> Verdict:
    preview = rows.preview or "skipped" in rows.check_statuses.values()
    prefix = _PREVIEW_PREFIX if preview else ""
    order = {chain: index for index, chain in enumerate(REQUIRED_CHAINS)}
    chains = sorted(rows.chains, key=lambda figures: order.get(figures.chain, len(order)))
    scope = [figures.chain for figures in chains]
    as_of = {figures.chain: figures.day.isoformat() for figures in chains}

    reasons = _why_unclear(rows)
    total = sum(figures.total_supply for figures in chains)
    placed = sum(figures.placed_supply for figures in chains)
    everyday = sum(figures.clean_everyday_7d for figures in chains)
    if not reasons and _labels_change_the_answer(rows):
        unlabeled = [figures.chain for figures in chains if not figures.has_issuer_label]
        reasons = [
            f"{_chain_list(unlabeled)} has no wallet labeled as the issuer, "
            "which could change the answer"
        ]
    if reasons:
        where = f"On {_chain_list(scope)}, the" if scope else "The"
        return Verdict(
            "no_clear_statement",
            scope,
            as_of,
            f"{prefix}{where} data doesn't support a clear statement yet: {'; '.join(reasons)}.",
            [],
            [],
            [],
        )

    where, share_estimate = _where(scope, total, rows.bridge_total)
    placed_bps = placed * 10_000 // total
    everyday_bps = everyday * 10_000 // total
    # Floors, so a figure never reads as past a threshold it hasn't reached.
    placed_part = (
        f"{placed_bps // 100}% of supply has sat still for at least {rows.placed_days} days in "
        f"unlabeled wallets of {format_dollars(rows.placed_min_base_units)} or more"
    )
    moved_part = (
        f"transfers under {format_dollars(rows.large_transfer_base_units)} moved "
        f"{format_dollars(everyday)} in the last week, "
        f"{_percent_two_places(everyday_bps)}% of supply"
    )
    state: VerdictState
    opinions: list[str] = []
    if placed_bps >= PLACED_THRESHOLD_BPS:
        state = "mostly_placed"
        text = f"{where} {placed_part}, and {moved_part}."
        opinions = [
            "So far this reads mostly like balance-sheet supply. "
            "The chain can't show why balances stay put."
        ]
    elif everyday_bps >= EVERYDAY_THRESHOLD_BPS:
        state = "moving"
        text = f"{where} {moved_part}, and {placed_part}."
        opinions = [
            "So far this reads like supply in use, "
            "though a transfer's size doesn't show that it is a payment."
        ]
    else:
        state = "mixed"
        text = (
            f"{where} {placed_part}, and {moved_part}. "
            "That is neither mostly placed nor clearly moving, "
            "so the data doesn't support a clear statement either way."
        )

    days = sorted(set(as_of.values()))
    day_text = days[0] if len(days) == 1 else f"{days[0]} to {days[-1]}"
    facts = [
        f"The figures cover {_chain_list(scope)} and end on {day_text}, UTC.",
        f"Total supply on these chains is {format_dollars(total)}, and each chain's mints minus "
        "burns equal its reported supply to the base unit.",
    ]
    # Both rest on public labels, which can be incomplete, so neither can be a fact.
    estimates = [
        f"Placed supply is {_percent_two_places(placed_bps)}% of supply on these chains. It counts "
        "wallets with no public label, so an unlabeled issuer or venue wallet can count as placed.",
        f"Seven-day everyday volume is {_percent_two_places(everyday_bps)}% of supply on these "
        "chains. It leaves out flows to and from labeled wallets, so a missing label adds to it.",
    ]
    if share_estimate:
        estimates.insert(0, share_estimate)
    unlabeled = [figures.chain for figures in chains if not figures.has_issuer_label]
    if unlabeled:
        estimates.append(
            f"{_chain_list(unlabeled)} has no wallet labeled as the issuer, so its placed figure "
            "may include issuer inventory."
        )
    if preview:
        # Nothing here is proven for release, so nothing may read as a fact.
        return Verdict(state, scope, as_of, f"{prefix}{text}", [], [*facts, *estimates], opinions)
    return Verdict(state, scope, as_of, text, facts, estimates, opinions)


def known_limits(
    large_transfer_base_units: int,
    *,
    chains_without_issuer_row: Sequence[str],
    chains_not_issuer_labeled: Sequence[str],
    chains_missing: Sequence[str],
    preview: bool = False,
) -> list[KnownLimit]:
    """What the published figures can't show. Written for a reader, and shipped with the data."""
    limits = [
        KnownLimit(
            "not_an_attestation",
            "This is not a reserve attestation. It reads chain data and says nothing about the "
            "reserves. See Bridge's own reports for those.",
        ),
        KnownLimit(
            "placed_is_not_intent",
            "Placed supply measures dollars that stayed in a wallet. It doesn't show why they "
            "stayed, and the chain can't show intent.",
        ),
        KnownLimit(
            "everyday_is_only_a_size",
            f"Everyday volume means clean transfers under "
            f"{format_dollars(large_transfer_base_units)}, nothing more. A payment can't be told "
            "from a bot or a treasury sweep.",
        ),
        KnownLimit(
            "clean_volume_counts_hops",
            "Clean volume nets each transaction, but a chain of transfers across several "
            "transactions counts at every hop, so it can overstate.",
        ),
        KnownLimit("wallets_not_people", "Active wallets count wallets, not people."),
        KnownLimit(
            "labels_are_partial",
            "Issuer inventory and venue supply count only wallets a public source labels. "
            "Unlabeled custody isn't counted as a venue, and can count as placed.",
        ),
        KnownLimit(
            "short_history",
            "Day 0 was 2026-09-30, so this is weeks of history: a direction at most, not a trend.",
        ),
        KnownLimit(
            "velocity_denominators",
            "Velocity divides clean volume by circulating supply, and headline velocity divides "
            "all volume by total supply. Circulating supply is smaller, so velocity can exceed "
            "headline velocity. Both denominators are published beside them.",
        ),
        KnownLimit(
            "chains_end_on_their_own_day",
            "Each chain stops at its own last complete UTC day, so chains can end on different "
            "days. A chain's KPIs end on its last day with a transfer, and each row names its "
            "day.",
        ),
        KnownLimit(
            "lost_transfer_can_pass",
            "A transfer lost between two wallets, with no later rows, passes until one of them is "
            "drawn into a balance sample. On Tempo that is about 3% a run.",
        ),
        KnownLimit(
            "bridge_error_can_pass",
            "An error in Bridge's total that exactly equals the moves inside the comparison "
            "window matches one of the attainable sums.",
        ),
        KnownLimit(
            "reorgs_tested_by_simulation",
            "Reorg repair is tested with simulated reorgs. Solana reads finalized data only, so "
            "it has no reorg test.",
        ),
    ]
    if chains_without_issuer_row:
        limits.append(
            KnownLimit(
                "no_issuer_row",
                f"{_chain_list(chains_without_issuer_row)} has no wallet labeled as the issuer. "
                "Its issuer inventory counts only unnamed redemption-route wallets, if any, so it "
                "may be understated.",
            )
        )
    if chains_not_issuer_labeled:
        limits.append(
            KnownLimit(
                "no_issuer_label",
                f"{_chain_list(chains_not_issuer_labeled)} has no issuer or redemption-route "
                "label at all, so its issuer inventory reads as zero.",
            )
        )
    if preview:
        limits.append(
            KnownLimit(
                "local_preview",
                "This is a local preview, never a release. It may leave out chains and checks.",
            )
        )
    if chains_missing:
        limits.append(
            KnownLimit(
                "chains_missing",
                f"{_chain_list(chains_missing)} is not covered by this local preview, and the "
                "full reconciliation was not checked.",
            )
        )
    return limits
