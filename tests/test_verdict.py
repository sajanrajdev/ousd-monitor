"""The verdict sentence: each state at its boundary, and nothing beyond what the data supports."""

import csv
from dataclasses import replace
from datetime import date

import pytest
from ousd.chains import REQUIRED_CHAINS
from ousd.checks import CHECK_NAMES
from ousd.verdict import (
    ChainFigures,
    VerdictInputs,
    build_verdict,
    format_dollars,
    known_limits,
)
from publish_world import REAL_LABELS

OUSD = 10**6
PASSED = dict.fromkeys(CHECK_NAMES, "passed")
PREVIEW = {**PASSED, "cross_chain_supply": "skipped", "reconciliation_gate": "skipped"}
PARTNERS = {
    "Stripe",
    "Visa",
    "Mastercard",
    "BVNK",
    "Wintermute",
    "Morpho",
    "Crystal",
    "Open Standard",
    "Bridge",
}


def figures(chain="tempo", total=1000 * OUSD, placed=0, everyday=0, **changes):
    return ChainFigures(
        chain=chain,
        day=date(2026, 11, 3),
        total_supply=total,
        placed_supply=placed,
        clean_everyday_7d=everyday,
        full_window=changes.get("full_window", True),
        has_issuer_label=changes.get("has_issuer_label", True),
    )


def inputs(*chains, statuses=PASSED, bridge=4000 * OUSD):
    return VerdictInputs(
        chains=chains,
        check_statuses=statuses,
        placed_days=14,
        placed_min_base_units=10**12,
        large_transfer_base_units=10**12,
        journey_first_day=date(2026, 10, 14),
        bridge_total=bridge,
    )


@pytest.mark.parametrize(
    "placed,everyday,state",
    [
        (500, 0, "mostly_placed"),
        (500, 999, "mostly_placed"),
        (499, 50, "moving"),
        (499, 999, "moving"),
        (499, 49, "mixed"),
        (0, 0, "mixed"),
        (1000, 0, "mostly_placed"),
    ],
)
def test_each_state_at_and_around_its_boundary(placed, everyday, state):
    verdict = build_verdict(inputs(figures(placed=placed * OUSD, everyday=everyday * OUSD)))
    assert verdict.state == state


def test_a_share_just_under_half_never_reads_as_half():
    verdict = build_verdict(inputs(figures(placed=500 * OUSD - 1, everyday=0)))
    assert verdict.state == "mixed"
    assert "49%" in verdict.text


def test_the_placed_template_follows_the_plan():
    verdict = build_verdict(
        inputs(
            figures(total=605_516 * OUSD, placed=466_155 * OUSD, everyday=4_627 * OUSD),
            bridge=902_540 * OUSD,
        )
    )
    assert verdict.text == (
        "On Tempo, which holds about 67% of OUSD, 76% of supply has sat still for at least 14 "
        "days in wallets of $1M or more, and transfers under $1M moved $4.6K in the last week, "
        "0.76% of supply."
    )


def test_thresholds_in_the_sentence_come_from_the_definitions():
    rows = replace(
        inputs(figures(placed=900 * OUSD)),
        placed_days=30,
        placed_min_base_units=5 * 10**12,
        large_transfer_base_units=10**11,
    )
    text = build_verdict(rows).text
    assert "at least 30 days" in text
    assert "wallets of $5M or more" in text
    assert "under $100K" in text


def test_mixed_says_the_data_does_not_support_a_clear_statement():
    verdict = build_verdict(inputs(figures(placed=100 * OUSD, everyday=10 * OUSD)))
    assert "doesn't support a clear statement" in verdict.text
    assert verdict.opinions == []


def test_scope_names_each_chain_and_never_claims_all():
    two = build_verdict(
        inputs(figures("ethereum", placed=600 * OUSD), figures("tempo", placed=600 * OUSD))
    )
    assert two.scope == ["tempo", "ethereum"]
    assert two.text.startswith("On Tempo and Ethereum, which hold about 50% of OUSD,")
    assert "all chains" not in two.text.lower()
    assert "all " not in two.text.lower().split("of supply")[0]

    every = build_verdict(
        inputs(
            *(
                figures(chain, placed=600 * OUSD)
                for chain in ("solana", "base", "ethereum", "tempo")
            )
        )
    )
    assert every.scope == ["tempo", "ethereum", "base", "solana"]
    assert every.text.startswith("On Tempo, Ethereum, Base and Solana, ")
    assert "OUSD," not in every.text


def test_with_no_bridge_figure_the_share_is_said_to_be_unknown():
    verdict = build_verdict(inputs(figures(placed=600 * OUSD), bridge=None))
    assert "whose share of OUSD is not known here" in verdict.text
    assert not any("About" in estimate for estimate in verdict.estimates)


def test_no_name_of_any_partner_appears_in_the_verdict():
    with REAL_LABELS.open(newline="") as handle:
        entities = {row["entity"].split()[0] for row in csv.DictReader(handle) if row["entity"]}
    # A chain's own name is how the sentence says where, and Tempo also names a label entity.
    names = (PARTNERS | entities) - {chain.capitalize() for chain in REQUIRED_CHAINS}
    for placed, everyday in ((900, 0), (100, 100), (100, 1)):
        verdict = build_verdict(inputs(figures(placed=placed * OUSD, everyday=everyday * OUSD)))
        words = " ".join([verdict.text, *verdict.facts, *verdict.estimates, *verdict.opinions])
        assert not [name for name in names if name in words], words


def test_fact_estimate_and_opinion_stay_apart():
    verdict = build_verdict(inputs(figures(placed=900 * OUSD, everyday=OUSD)))
    assert verdict.facts and verdict.estimates and verdict.opinions
    assert any("end on 2026-11-03, UTC" in fact for fact in verdict.facts)
    assert any("approximate" in estimate for estimate in verdict.estimates)
    assert all("reads" not in fact for fact in verdict.facts)
    # The opinion isn't in the sentence, so a reader of `text` alone gets numbers.
    assert "reads" not in verdict.text
    assert any("reads mostly like" in opinion for opinion in verdict.opinions)


@pytest.mark.parametrize(
    "rows,word",
    [
        (inputs(), "no chain has data"),
        (inputs(figures(total=0)), "supply on these chains is zero"),
        (inputs(figures(placed=900 * OUSD, full_window=False)), "seven full days"),
        (
            inputs(replace(figures(placed=900 * OUSD), day=date(2026, 10, 13))),
            "too early",
        ),
        (
            inputs(figures(placed=900 * OUSD), statuses={**PASSED, "freshness": "failed"}),
            "did not pass",
        ),
    ],
)
def test_when_the_data_cannot_carry_a_sentence_it_says_so(rows, word):
    verdict = build_verdict(rows)
    assert verdict.state == "no_clear_statement"
    assert "doesn't support a clear statement" in verdict.text
    assert word in verdict.text
    assert verdict.facts == verdict.estimates == verdict.opinions == []


def test_a_chain_with_no_issuer_label_that_could_swing_the_answer_is_not_stated():
    verdict = build_verdict(
        inputs(
            figures("tempo", placed=400 * OUSD),
            figures("base", placed=700 * OUSD, has_issuer_label=False),
        )
    )
    assert verdict.state == "no_clear_statement"
    assert "Base has no wallet labeled as the issuer" in verdict.text


def test_a_chain_with_no_issuer_label_that_changes_nothing_is_only_noted():
    verdict = build_verdict(
        inputs(
            figures("tempo", placed=1000 * OUSD),
            figures("base", placed=200 * OUSD, has_issuer_label=False),
        )
    )
    assert verdict.state == "mostly_placed"
    assert any("Base has no wallet labeled" in estimate for estimate in verdict.estimates)


def test_an_absent_check_is_not_a_passing_one():
    missing_one = {name: "passed" for name in CHECK_NAMES if name != "freshness"}
    assert build_verdict(inputs(figures(placed=900 * OUSD), statuses={})).state == (
        "no_clear_statement"
    )
    assert build_verdict(inputs(figures(placed=900 * OUSD), statuses=missing_one)).state == (
        "no_clear_statement"
    )


def test_a_skip_outside_the_named_two_is_not_a_passing_one():
    statuses = {**PASSED, "freshness": "skipped"}
    assert build_verdict(inputs(figures(placed=900 * OUSD), statuses=statuses)).state == (
        "no_clear_statement"
    )


def test_a_chain_on_the_first_placed_day_is_not_too_early():
    verdict = build_verdict(inputs(replace(figures(placed=900 * OUSD), day=date(2026, 10, 14))))
    assert verdict.state == "mostly_placed"


def test_a_preview_states_no_facts():
    verdict = build_verdict(inputs(figures(placed=900 * OUSD), statuses=PREVIEW))
    assert verdict.text.startswith("Local preview, not fully reconciled. On Tempo")
    assert verdict.facts == []
    assert any("cover Tempo" in estimate for estimate in verdict.estimates)


def test_as_of_is_per_chain_and_the_text_is_built_over_a_range():
    verdict = build_verdict(
        inputs(
            replace(figures("tempo", placed=900 * OUSD), day=date(2026, 11, 3)),
            replace(figures("ethereum", placed=900 * OUSD), day=date(2026, 11, 2)),
        )
    )
    assert verdict.as_of == {"tempo": "2026-11-03", "ethereum": "2026-11-02"}
    assert any("2026-11-02 to 2026-11-03" in fact for fact in verdict.facts)


def test_format_dollars():
    assert format_dollars(4_627_061_301_100) == "$4.6M"
    assert format_dollars(10**12) == "$1M"
    assert format_dollars(1_250_000_000 * OUSD) == "$1.3B"
    assert format_dollars(999 * OUSD) == "$999"
    assert format_dollars(0) == "$0"
    assert format_dollars(1_500 * OUSD) == "$1.5K"
    assert format_dollars(950_000 * OUSD) == "$950K"


@pytest.mark.parametrize(
    "dollars,shown",
    [
        (999_949, "$999.9K"),
        (999_950, "$1M"),
        (999_960, "$1M"),
        (949_999_999, "$950M"),
        (999_950_000, "$1B"),
        (2_400_000_000_000, "$2400B"),
    ],
)
def test_format_dollars_carries_into_the_next_unit(dollars, shown):
    assert format_dollars(dollars * OUSD) == shown


def test_rounding_carries_below_a_thousand_dollars():
    assert format_dollars(999 * OUSD + 600_000) == "$1K"


def test_known_limits_carry_the_chains_that_need_them():
    limits = {
        limit.id: limit.text
        for limit in known_limits(
            10**12,
            chains_without_issuer_row=["solana"],
            chains_not_issuer_labeled=["base"],
            chains_missing=["base", "solana"],
        )
    }
    assert "Solana has no wallet labeled as the issuer" in limits["no_issuer_row"]
    assert "Base has no issuer" in limits["no_issuer_label"]
    assert "Base and Solana" in limits["chains_missing"]
    assert "not a reserve attestation" in limits["not_an_attestation"]
    assert "under $1M" in limits["everyday_is_only_a_size"]
    assert "lost_transfer_can_pass" in limits
    assert "velocity can exceed" in limits["velocity_denominators"]


def test_known_limits_leave_out_what_does_not_apply():
    ids = {
        limit.id
        for limit in known_limits(
            10**12, chains_without_issuer_row=[], chains_not_issuer_labeled=[], chains_missing=[]
        )
    }
    assert not ids & {"no_issuer_row", "no_issuer_label", "chains_missing"}
