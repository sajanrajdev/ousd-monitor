import itertools
import json

import pytest
from ousd.chains import REQUIRED_CHAINS
from ousd.http import HttpError
from ousd.reconcile import (
    BridgeFigures,
    BridgeWait,
    ChainReconciliation,
    ChainUnavailable,
    bridge_window,
    check_bridge,
    compare_with_bridge,
)
from ousd.sources import BridgeSnapshot, RpcError
from reconcile_fakes import (
    BAD,
    BRIDGE_T,
    FOUR_CHAINS,
    GOOD,
    LARGE,
    NOW,
    STALE,
    BridgeFeed,
    Drift,
    bad_at,
    checks,
    comparisons,
    four_probes,
    good_at,
    run_it,
    runs,
)


def test_bridge_comparison_counts_any_unchecked_chain_as_missing():
    comparison = compare_with_bridge([ChainReconciliation("tempo", 1, 100, 10, 90)], 200)

    assert comparison.is_partial
    assert comparison.chains_missing == ("ethereum", "base", "solana")


def test_bridge_comparison_is_full_only_with_every_chain():
    results = [
        ChainReconciliation(name, 1, 1, 0, 1) for name in ("tempo", "ethereum", "base", "solana")
    ]

    assert not compare_with_bridge(results, 4).is_partial


def test_bridge_comparison_is_partial_while_chains_are_missing():
    results = [
        ChainReconciliation("tempo", 1, 100, 10, 90),
        ChainReconciliation("ethereum", 2, 30, 0, 30),
    ]

    comparison = compare_with_bridge(results, bridge_total=200)

    assert comparison.is_partial
    assert comparison.chains_missing == ("base", "solana")
    assert comparison.chains_total == 120
    assert comparison.difference == -80


def bridge_detail(store, attempt=1):
    row = store.db.execute(
        """
        SELECT detail FROM reconciliation_checks
        WHERE check_name = 'bridge' AND attempt = ?
        """,
        [attempt],
    ).fetchone()
    return json.loads(row[0])


# The Bridge check. See "The Bridge check" in the reconciliation plan. Its limits are written out
# as figures in these tests, not by their names, so changing a limit has to fail one.

T = 10_000
# No chain moves: each holds 10, 20, 30 and 40.
STILL = {
    name: [(T - 300, supply)]
    for name, supply in zip(REQUIRED_CHAINS, (10, 20, 30, 40), strict=True)
}
STILL_TOTAL = 100
PINS: dict[str, int | None] = dict.fromkeys(REQUIRED_CHAINS, T + 60)


def judge(total, values=None, fetched_at=T + 5, pins=None, last_updated=T):
    return check_bridge(
        BridgeSnapshot(total, last_updated),
        fetched_at,
        PINS if pins is None else pins,
        STILL if values is None else values,
    )


def test_bridge_equal_with_no_movement_passes():
    check = judge(STILL_TOTAL)

    assert (check.status, check.reason) == ("pass", None)
    assert check.sum_at_t == check.matched_sum == STILL_TOTAL
    assert check.matched_times == dict.fromkeys(REQUIRED_CHAINS, T - 300)


@pytest.mark.parametrize("off", [1, -1], ids=["above", "below"])
def test_bridge_one_base_unit_off_with_no_movement_fails(off):
    check = judge(STILL_TOTAL + off)

    assert (check.status, check.reason) == ("fail", "bridge_mismatch")
    assert check.sum_at_t == STILL_TOTAL
    assert check.matched_sum is None
    assert check.matched_times == {}


MINT_AT_T_MINUS_10 = {**STILL, "tempo": [(T - 300, 10), (T - 10, 15)]}


@pytest.mark.parametrize("total", [100, 105], ids=["before", "after"])
def test_bridge_equal_to_either_side_of_a_mint_passes(total):
    assert judge(total, MINT_AT_T_MINUS_10).status == "pass"


def test_bridge_between_the_before_and_after_figures_fails():
    # A range test would pass this, and that is why the rule isn't one.
    assert judge(103, MINT_AT_T_MINUS_10).reason == "bridge_mismatch"


def test_the_sum_at_t_takes_each_chain_after_its_last_block_at_or_before_t():
    values = {
        **STILL,
        "tempo": [(T - 300, 10), (T, 11), (T + 1, 12)],
    }

    assert judge(0, values).sum_at_t == 101


def test_chains_read_at_different_moments_pass_and_record_each_time():
    values = {
        **STILL,
        "tempo": [(T - 300, 10), (T - 20, 15)],
        "base": [(T - 300, 30), (T + 20, 37)],
    }

    # Tempo after its mint, plus Base before its own.
    check = judge(15 + 20 + 30 + 40, values)

    assert check.status == "pass"
    assert check.sum_at_t == 105
    assert check.matched_times == {
        "tempo": T - 20,
        "ethereum": T - 300,
        "base": T - 300,
        "solana": T - 300,
    }


def test_a_value_held_twice_records_the_time_nearer_t():
    values = {**STILL, "tempo": [(T - 300, 10), (T - 40, 15), (T - 5, 10)]}

    assert judge(STILL_TOTAL, values).matched_times["tempo"] == T - 5


def test_bridge_arithmetic_stays_exact_above_2_to_the_60():
    values = {name: [(T - 300, LARGE)] for name in REQUIRED_CHAINS}

    assert judge(4 * LARGE, values).status == "pass"
    assert judge(4 * LARGE + 1, values).reason == "bridge_mismatch"
    assert judge(4 * LARGE - 1, values).sum_at_t == 4 * LARGE


def busy(count):
    return [(T - 300 + index, index) for index in range(count)]


def test_too_many_combinations_are_refused_without_building_them():
    # 10**16 sums: building them would never finish, so this returning at all is the proof.
    values = {name: busy(10_000) for name in REQUIRED_CHAINS}

    check = judge(-1, values)

    assert (check.status, check.reason) == ("unchecked", "bridge_window_too_busy")


def test_the_limit_on_combinations_is_inclusive():
    allowed = {**STILL, "tempo": busy(1_000), "ethereum": busy(1_000)}
    # 101 * 9_901 is 1_000_001, so a limit any higher lets this through.
    over = {**STILL, "tempo": busy(101), "ethereum": busy(9_901)}
    # Out of reach, so the whole allowed space is searched.
    assert judge(10**9, allowed).reason == "bridge_mismatch"
    assert judge(10**9, over).reason == "bridge_window_too_busy"


def test_a_supply_returning_to_a_value_adds_no_combination():
    bouncing = [(T - 300 + i, i % 2) for i in range(300)]

    check = judge(-1, {name: bouncing for name in REQUIRED_CHAINS})

    assert check.reason == "bridge_mismatch"


@pytest.mark.parametrize(
    ("age", "status", "reason"),
    [
        (1_800, "pass", None),
        (1_801, "unchecked", "bridge_stale"),
        (-59, "pass", None),
        (-60, "pass", None),
        (-61, "unchecked", "bridge_malformed"),
    ],
    ids=["30-minutes", "a-second-more", "59s-ahead", "60s-ahead", "61s-ahead"],
)
def test_a_snapshots_age_is_taken_at_fetch(age, status, reason):
    check = judge(STILL_TOTAL, fetched_at=T + age)

    assert (check.status, check.reason) == (status, reason)


def test_a_slow_run_does_not_make_its_own_snapshot_stale(store):
    # The fetch is at NOW. Syncing then takes well past the age limit.
    times = itertools.chain([NOW], itertools.repeat(NOW + 3_600))

    result, _ = run_it(store, four_probes(store), clock=lambda: next(times))

    assert result.bridge == "pass"


@pytest.mark.parametrize(
    "pin",
    [T - 1, None],
    ids=["before-t", "unreadable"],
)
def test_a_pin_that_does_not_reach_t_is_a_coverage_gap(pin):
    check = judge(STILL_TOTAL, pins={**PINS, "base": pin})

    assert (check.status, check.reason) == ("unchecked", "coverage_gap")


def test_a_pin_exactly_at_t_is_covered():
    assert judge(STILL_TOTAL, pins={**PINS, "base": T}).status == "pass"


@pytest.mark.parametrize("missing", REQUIRED_CHAINS)
def test_a_chain_left_out_is_a_coverage_gap_and_never_a_pass(missing):
    pins = {name: pin for name, pin in PINS.items() if name != missing}
    values = {name: value for name, value in STILL.items() if name != missing}

    assert judge(STILL_TOTAL, pins=pins).reason == "coverage_gap"
    assert judge(STILL_TOTAL, values).reason == "coverage_gap"
    assert judge(STILL_TOTAL, {**STILL, missing: []}).reason == "coverage_gap"


def test_the_window_stops_at_the_pin():
    assert bridge_window(T, T + 1_000) == (T - 300, T + 60)
    assert bridge_window(T, T + 59) == (
        T - 300,
        T + 59,
    )


def test_a_pin_before_the_window_end_limits_what_is_read(store, monkeypatch):
    seen = []
    real = store.supply_values

    def spy(chain, start_ts, end_ts, through_block):
        seen.append((chain, start_ts, end_ts, through_block))
        return real(chain, start_ts, end_ts, through_block)

    monkeypatch.setattr(store, "supply_values", spy)

    # T + 60 is 1_170, and the pins are at 1_120.
    run_it(store, four_probes(store))

    assert seen == [(name, BRIDGE_T - 300, 1_120, 120) for name in REQUIRED_CHAINS]


WINDOW_T = 1_500


@pytest.mark.parametrize(
    ("mint_at", "total", "status"),
    [
        (WINDOW_T - 301, FOUR_CHAINS, "fail"),
        (WINDOW_T - 301, FOUR_CHAINS + 5, "pass"),
        (WINDOW_T - 300, FOUR_CHAINS, "pass"),
        (WINDOW_T - 300, FOUR_CHAINS + 5, "pass"),
        (WINDOW_T + 60, FOUR_CHAINS, "pass"),
        (WINDOW_T + 60, FOUR_CHAINS + 5, "pass"),
        (WINDOW_T + 61, FOUR_CHAINS, "pass"),
        (WINDOW_T + 61, FOUR_CHAINS + 5, "fail"),
    ],
    ids=[
        "T-301-before",
        "T-301-after",
        "T-300-before",
        "T-300-after",
        "T+60-before",
        "T+60-after",
        "T+61-before",
        "T+61-after",
    ],
)
def test_window_edges_show_in_which_values_can_match(store, mint_at, total, status):
    # Tempo mints 5 at mint_at, and every chain's pin is past the window. Block n is stamped
    # 1_000 + n. Later attempts see their own T, and only the first is under test.
    probes = four_probes(store)
    for probe in probes:
        probe.rpc.extend(600)
    probes[0].rpc.add_transfer(mint_at - 1_000, 5)
    snapshots = [BridgeSnapshot(total, WINDOW_T + offset) for offset in range(3)]

    run_it(store, probes, BridgeFeed(*snapshots), clock=lambda: float(WINDOW_T))

    assert checks(store, "bridge", "all")[0][1] == status


def test_an_unreadable_pin_time_is_a_coverage_gap_and_writes_no_comparison(store):
    probes = four_probes(store)

    def refuse(height):
        raise ChainUnavailable("state_unavailable")

    probes[2].pin_timestamp = refuse

    result, _ = run_it(store, probes, BridgeFeed(good_at(0), good_at(1), good_at(2)))

    assert result.bridge == "unchecked"
    assert result.exit_code == 3
    assert checks(store, "bridge", "all")[0] == (1, "unchecked", "coverage_gap")
    assert comparisons(store) == []


def test_a_pin_time_error_a_probe_failed_to_map_leaves_the_run_unfinished(store):
    probes = four_probes(store)

    def refuse(height):
        raise RpcError("block not found")

    probes[2].pin_timestamp = refuse

    with pytest.raises(RpcError):
        run_it(store, probes)

    assert runs(store) == [("full", None, None, True)]
    assert store.latest_reconciliation() is None


def test_a_pin_before_t_in_a_run_is_a_coverage_gap(store):
    ahead = GOOD._replace(last_updated=1_121)

    result, _ = run_it(store, four_probes(store), BridgeFeed(ahead, ahead, ahead))

    assert result.exit_code == 3
    assert checks(store, "bridge", "all") == [(n, "unchecked", "coverage_gap") for n in (1, 2, 3)]


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (HttpError("bridge: HTTP 500"), "bridge_unavailable"),
        (ValueError("bad"), "bridge_malformed"),
    ],
    ids=["unavailable", "malformed"],
)
def test_a_bridge_that_cannot_be_read_is_unchecked_and_writes_no_comparison(store, error, reason):
    slept: list[float] = []

    result, _ = run_it(
        store, four_probes(store), BridgeFeed(error, error, error), sleep=slept.append
    )

    assert (result.bridge, result.status, result.exit_code) == ("unchecked", "unchecked", 3)
    assert checks(store, "bridge", "all") == [(n, "unchecked", reason) for n in (1, 2, 3)]
    assert slept == [600] * 2
    assert comparisons(store) == []
    assert not store.latest_reconciliation().usable


def test_a_read_error_records_its_class_and_no_message(store):
    error = HttpError("bridge: HTTP 500")

    run_it(store, four_probes(store), BridgeFeed(error, error, error))

    assert bridge_detail(store) == {"error": "HttpError"}


def test_the_snapshot_is_fetched_before_any_chain_syncs_on_every_attempt(store):
    probes = four_probes(store)
    syncs_at_fetch = []

    def bridge():
        syncs_at_fetch.append(sum(probe.syncs() for probe in probes))
        return bad_at(len(syncs_at_fetch))

    run_it(store, probes, bridge)

    assert syncs_at_fetch == [0, 4, 8]


def test_a_repeated_snapshot_is_not_counted_and_is_refetched_after_a_minute(store):
    slept: list[float] = []
    feed = BridgeFeed(bad_at(0), bad_at(0), good_at(1))

    result, reported = run_it(store, four_probes(store), feed, sleep=slept.append)

    assert result.status == "pass"
    assert slept == [600, 60]
    assert checks(store, "bridge", "all") == [(1, "fail", "bridge_mismatch"), (2, "pass", None)]
    waits = [item for item in reported if isinstance(item, BridgeWait)]
    assert [wait.attempt for wait in waits] == [1, 2]
    assert feed.remaining == []


def test_a_fetch_that_fails_while_refetching_is_unchecked_for_that_attempt(store):
    feed = BridgeFeed(bad_at(0), bad_at(0), HttpError("bridge: HTTP 500"), good_at(1))

    result, _ = run_it(store, four_probes(store), feed)

    assert result.status == "pass"
    assert checks(store, "bridge", "all") == [
        (1, "fail", "bridge_mismatch"),
        (2, "unchecked", "bridge_unavailable"),
        (3, "pass", None),
    ]


def test_a_snapshot_that_never_changes_ends_as_same_snapshot(store):
    slept: list[float] = []
    fetches = []

    def bridge():
        fetches.append(1)
        return bad_at(0)

    result, _ = run_it(store, four_probes(store), bridge, sleep=slept.append)

    assert (result.bridge, result.status, result.exit_code) == ("fail", "fail", 1)
    assert checks(store, "bridge", "all") == [
        (1, "fail", "bridge_mismatch"),
        (2, "unchecked", "bridge_same_snapshot"),
        (3, "unchecked", "bridge_same_snapshot"),
    ]
    refetching = [60] * 5
    assert slept == [600, *refetching, 600, *refetching]
    # The most a run can wait on Bridge.
    assert sum(slept) == 1_800
    assert len(fetches) == 13
    assert len(comparisons(store)) == 1


def test_only_a_compared_snapshot_counts_as_already_seen(store):
    # Nothing was compared on a coverage gap, and a later pin can cover the same T.
    ahead = GOOD._replace(last_updated=1_121)
    slept: list[float] = []
    probes = four_probes(store)

    def bridge():
        return ahead

    def extend(seconds):
        slept.append(seconds)
        for probe in probes:
            probe.rpc.extend(130)

    result, _ = run_it(store, probes, bridge, sleep=extend)

    assert result.status == "pass"
    assert slept == [600]
    assert checks(store, "bridge", "all") == [(1, "unchecked", "coverage_gap"), (2, "pass", None)]


def test_a_retry_compares_against_its_new_pin(store):
    # This total exists only above the first pin, so a stale reading of the pin can't reach it.
    probes = four_probes(store)
    tempo = probes[0]
    second = BridgeSnapshot(FOUR_CHAINS + 5, 1_125)
    slept: list[float] = []

    def mint_while_waiting(seconds):
        slept.append(seconds)
        for probe in probes:
            probe.rpc.extend(130)
        tempo.rpc.add_transfer(123, 5)

    result, _ = run_it(store, probes, BridgeFeed(BAD, second), sleep=mint_while_waiting)

    assert (result.bridge, result.exit_code) == ("pass", 0)
    assert slept == [600]
    assert checks(store, "chain_supply", "tempo") == [(1, "pass", None), (2, "pass", None)]
    latest = store.latest_reconciliation()
    assert latest.usable
    assert latest.chains["tempo"].pin_height == 130
    assert bridge_detail(store, attempt=2)["matched_times"]["tempo"] == 1_123


def test_a_mint_lost_between_two_pins_fails_the_run_and_never_exits_zero(store):
    probes = four_probes(store)
    tempo = probes[0]
    real = tempo.rpc.transfers

    def lose_it(seconds):
        tempo.rpc.extend(130)
        tempo.rpc.add_transfer(123, 5)
        tempo.rpc.transfers = lambda token, start, end: [
            transfer for transfer in real(token, start, end) if transfer.block_number != 123
        ]

    # The second snapshot would pass, were it not for the check on the new pin.
    feed = BridgeFeed(BAD, good_at(1))

    result, _ = run_it(store, probes, feed, sleep=lose_it)

    assert result.chains["tempo"] == "fail"
    assert (result.status, result.exit_code) == ("fail", 1)
    assert checks(store, "chain_supply", "tempo") == [
        (1, "pass", None),
        (2, "fail", "supply_mismatch"),
        (3, "fail", "supply_mismatch"),
    ]
    assert checks(store, "bridge", "all") == [
        (1, "fail", "bridge_mismatch"),
        (2, "unchecked", "chains_not_passed"),
    ]
    assert not store.latest_reconciliation().usable


def test_every_retry_repeats_the_supply_check_through_the_new_tip(store):
    probes = four_probes(store)

    def advance(seconds):
        for probe in probes:
            probe.rpc.extend(probe.rpc.tip() + 5)

    run_it(store, probes, BridgeFeed(BAD, bad_at(1), good_at(2)), sleep=advance)

    assert all(probe.syncs() == 3 for probe in probes)
    pins = store.db.execute(
        """
        SELECT pin_height FROM reconciliation_checks
        WHERE check_name = 'chain_supply' AND subject = 'base' ORDER BY attempt
        """
    ).fetchall()
    assert pins == [(120,), (125,), (130,)]


def test_a_failed_chain_stops_the_retries_and_still_reports_the_difference(store):
    slept: list[float] = []

    result, reported = run_it(
        store,
        four_probes(store, tempo=[Drift(1), Drift(1)]),
        BridgeFeed(BridgeSnapshot(FOUR_CHAINS + 9, BRIDGE_T)),
        sleep=slept.append,
    )

    assert (result.status, result.exit_code) == ("fail", 1)
    assert result.bridge == "unchecked"
    assert checks(store, "bridge", "all") == [(1, "unchecked", "chains_not_passed")]
    assert slept == []
    assert comparisons(store) == []
    figures = [item for item in reported if isinstance(item, BridgeFigures)]
    assert len(figures) == 1
    # Each chain's totalSupply: tempo reads one high.
    assert figures[0].comparison.difference == 1 - 9


def test_an_unread_chain_is_shown_as_missing_from_the_difference(store):
    _, reported = run_it(
        store,
        four_probes(store, base=[ChainUnavailable("sync_failed")]),
        BridgeFeed(GOOD),
    )

    figures = [item for item in reported if isinstance(item, BridgeFigures)]
    assert figures[0].comparison.chains_missing == ("base",)
    assert figures[0].comparison.is_partial


def test_a_bridge_outage_with_a_failed_chain_reports_no_figures(store):
    _, reported = run_it(
        store,
        four_probes(store, tempo=[Drift(1), Drift(1)]),
        BridgeFeed(HttpError("bridge: HTTP 500")),
    )

    assert not [item for item in reported if isinstance(item, BridgeFigures)]
    assert checks(store, "bridge", "all") == [(1, "unchecked", "chains_not_passed")]


def test_a_pass_records_the_matched_sum_with_no_amount_tolerance(store):
    result, reported = run_it(store, four_probes(store))

    assert comparisons(store) == [
        ("tempo,ethereum,base,solana", "", FOUR_CHAINS, FOUR_CHAINS, 0, True)
    ]
    run_id = store.db.execute("SELECT run_id FROM bridge_comparisons").fetchone()[0]
    assert run_id == result.run_id
    assert bridge_detail(store) == {
        "last_updated": BRIDGE_T,
        "window_before": 300,
        "window_after": 60,
        "pin_times": dict.fromkeys(REQUIRED_CHAINS, 1_120),
        "matched_times": dict.fromkeys(REQUIRED_CHAINS, 1_101),
        "sum_at_t": str(FOUR_CHAINS),
    }
    figures = [item for item in reported if isinstance(item, BridgeFigures)]
    assert [(item.attempt, item.snapshot, item.fetched_at) for item in figures] == [(1, GOOD, NOW)]
    assert figures[0].comparison.difference == 0
    assert not figures[0].comparison.is_partial


def test_a_pass_on_a_value_other_than_t_records_the_matched_sum(store):
    # Tempo mints at 1_105, before T, and Bridge equals the figure from before that mint.
    probes = four_probes(store)
    probes[0].rpc.add_transfer(105, 5)

    result, _ = run_it(store, probes)

    assert result.exit_code == 0
    assert comparisons(store) == [
        ("tempo,ethereum,base,solana", "", FOUR_CHAINS, FOUR_CHAINS, 0, True)
    ]
    assert bridge_detail(store)["sum_at_t"] == str(FOUR_CHAINS + 5)
    assert bridge_detail(store)["matched_times"]["tempo"] == 1_101


def test_a_fail_records_the_sum_at_t(store):
    feed = BridgeFeed(bad_at(0), bad_at(1), bad_at(2))

    run_it(store, four_probes(store), feed)

    assert (
        comparisons(store)
        == [("tempo,ethereum,base,solana", "", FOUR_CHAINS, FOUR_CHAINS + 1, 0, False)] * 3
    )
    row = store.db.execute(
        """
        SELECT reference_value, observed_value, pin_height FROM reconciliation_checks
        WHERE check_name = 'bridge' AND attempt = 1
        """
    ).fetchone()
    assert row == (FOUR_CHAINS + 1, FOUR_CHAINS, None)


def test_the_sum_at_t_agrees_with_the_store(store):
    probes = four_probes(store)

    run_it(store, probes)

    expected = sum(store.supply_at_time(name, BRIDGE_T) for name in REQUIRED_CHAINS)
    assert bridge_detail(store)["sum_at_t"] == str(expected)


@pytest.mark.parametrize(
    "bridge",
    [
        BridgeFeed(*[STALE] * 3),
        BridgeFeed(*[HttpError("bridge: HTTP 500")] * 3),
        BridgeFeed(*[ValueError("bad")] * 3),
    ],
    ids=["stale", "outage", "malformed"],
)
def test_nothing_compared_writes_no_comparison_row(store, bridge):
    result, _ = run_it(store, four_probes(store), bridge)

    assert result.exit_code == 3
    assert comparisons(store) == []


def test_a_busy_window_in_a_run_is_unchecked_and_writes_no_comparison(store, monkeypatch):
    monkeypatch.setattr(
        store,
        "supply_values",
        lambda chain, start, end, through: [(start + i, i) for i in range(10_000)],
    )
    feed = BridgeFeed(good_at(0), good_at(1), good_at(2))

    result, _ = run_it(store, four_probes(store), feed)

    assert result.exit_code == 3
    assert checks(store, "bridge", "all")[0] == (1, "unchecked", "bridge_window_too_busy")
    assert comparisons(store) == []
