"""mart_supply_journey scenarios. Every case builds the dbt project over a throwaway database."""

from datetime import date, timedelta

import duckdb
import pytest
from dbt_helpers import build_marts, failed_tests, invoke_dbt, run_dbt
from ousd.decode import ZERO_ADDRESS, Transfer

USD = 10**6  # base units per dollar
DAY_S = 86_400
TODAY_TS = 1_700_006_400 + 40 * DAY_S  # 00:00 UTC of the day under test
TODAY = date(2023, 11, 15) + timedelta(days=40)

WALLET = "0x" + "a" * 40
SINK = "0x" + "b" * 40
OTHER = "0x" + "c" * 40
LABEL_DATE = "2026-11-03"


def label(chain, address, category):
    return {
        "chain": chain,
        "address": address,
        "entity": "",
        "category": category,
        "source_type": "derived_rule",
        "source_url": "docs/methodology.md",
        "confidence": "medium",
        "date_checked": LABEL_DATE,
    }


def at(days_ago, frm, to, value, hour=1, log=0):
    return (days_ago, hour, log, frm, to, value)


def transfers(chain, events, marker=True):
    """Turn (days_ago, hour, log, from, to, value) tuples into rows with ordered blocks.

    A zero-value marker one day later makes the day under test the last complete day.
    """
    rows = sorted(events, key=lambda e: (-e[0], e[1], e[2]))
    out = []
    for i, (days_ago, hour, log, frm, to, value) in enumerate(rows, start=1):
        ts = TODAY_TS - days_ago * DAY_S + hour * 3600
        out.append(
            (
                chain,
                Transfer(
                    block_number=i,
                    block_hash=None,
                    block_timestamp=ts,
                    tx_hash=f"tx{i:062d}",
                    log_index=log,
                    from_address=frm,
                    to_address=to,
                    value=value,
                ),
            )
        )
    if marker:
        out.append(
            (
                chain,
                Transfer(
                    block_number=len(rows) + 1,
                    block_hash=None,
                    block_timestamp=TODAY_TS + DAY_S + 3600,
                    tx_hash="tx" + "9" * 62,
                    log_index=0,
                    from_address=ZERO_ADDRESS,
                    to_address="0x" + "d" * 40,
                    value=0,
                ),
            )
        )
    return out


def journey(tmp_path, events, labels=(), chain="tempo", dbt_vars=None, day=TODAY):
    """Build the marts and return the mart row for `day` as a dict."""
    conn = build_marts(
        tmp_path,
        transfers(chain, events),
        labels=list(labels),
        sync_state={chain: 10_000},
        dbt_vars={"placed_days": 14, "placed_min_base_units": 1_000_000 * USD, **(dbt_vars or {})},
    )
    try:
        return row(conn, chain, day)
    finally:
        conn.close()


def scalar(cursor):
    found = cursor.fetchone()
    assert found is not None
    return found[0]


def row(conn, chain, day):
    cursor = conn.execute(
        "select * from mart_supply_journey where chain = ? and day_utc = ?", [chain, day]
    )
    names = [d[0] for d in cursor.description]
    found = cursor.fetchone()
    assert found is not None, f"no mart row for {chain} {day}"
    return dict(zip(names, found, strict=True))


def sub(tmp_path, name):
    path = tmp_path / name
    path.mkdir()
    return path


def fund(days_ago, value=5_000_000 * USD, to=WALLET, log=0):
    return at(days_ago, ZERO_ADDRESS, to, value, hour=0, log=log)


SINK_LABEL = [label("tempo", SINK, "exchange")]


def test_full_stay(tmp_path):
    r = journey(tmp_path, [fund(20)])
    assert r["placed_supply"] == 5_000_000 * USD
    assert r["free_floating"] == 0
    assert r["placed_wallets"] == 1


def test_too_new_counts_as_free_floating(tmp_path):
    r = journey(tmp_path, [fund(10)])
    assert r["placed_supply"] == 0
    assert r["free_floating"] == 5_000_000 * USD


@pytest.mark.parametrize(("age", "placed"), [(13, 0), (14, 5_000_000 * USD)])
def test_becomes_placed_exactly_on_day_14(tmp_path, age, placed):
    r = journey(tmp_path, [fund(age)])
    assert r["placed_supply"] == placed
    assert r["free_floating"] == 5_000_000 * USD - placed


def test_dust_out_keeps_the_rest_placed(tmp_path):
    r = journey(tmp_path, [fund(20), at(1, WALLET, SINK, 1 * USD)], SINK_LABEL)
    assert r["placed_supply"] == 4_999_999 * USD
    assert r["free_floating"] == 0
    assert r["venue_exchange"] == 1 * USD


def test_exchange_linked_stays_in_placed_and_is_marked(tmp_path):
    linked = [label("tempo", WALLET, "exchange_linked")]
    r = journey(tmp_path, [fund(20)], linked)
    assert r["placed_supply"] == 5_000_000 * USD
    assert r["placed_exchange_linked"] == 5_000_000 * USD
    assert r["placed_wallets"] == 1
    assert r["venue_exchange"] == 0


def test_exchange_linked_counts_only_what_stayed(tmp_path):
    linked = [label("tempo", WALLET, "exchange_linked")]
    r = journey(tmp_path, [fund(20), at(5, WALLET, SINK, 3_000_000 * USD)], linked)
    assert r["placed_exchange_linked"] == 2_000_000 * USD
    assert r["free_floating"] == 3_000_000 * USD


def test_exchange_linked_too_new_is_free_floating(tmp_path):
    linked = [label("tempo", WALLET, "exchange_linked")]
    r = journey(tmp_path, [fund(3)], linked)
    assert r["placed_exchange_linked"] == 0
    assert r["free_floating"] == 5_000_000 * USD


def test_exchange_holdings_sum_named_wallets_by_exchange(tmp_path):
    named = [
        {**label("tempo", WALLET, "exchange"), "entity": "Named Exchange"},
        {**label("tempo", OTHER, "exchange"), "entity": "Named Exchange"},
        label("tempo", SINK, "exchange_linked"),
    ]
    events = [fund(20), fund(20, 2_000_000 * USD, OTHER, 1), fund(20, 3_000_000 * USD, SINK, 2)]
    conn = build_marts(
        tmp_path,
        transfers("tempo", events),
        labels=named,
        sync_state={"tempo": 10_000},
        dbt_vars={"placed_days": 14, "placed_min_base_units": 1_000_000 * USD},
    )
    try:
        held = conn.execute(
            "select entity, balance, wallets from mart_exchange_holdings "
            "where chain = 'tempo' and day_utc = ?",
            [TODAY],
        ).fetchall()
        linked = conn.execute(
            "select venue_exchange, placed_exchange_linked from mart_supply_journey "
            "where chain = 'tempo' and day_utc = ?",
            [TODAY],
        ).fetchone()
    finally:
        conn.close()
    assert held == [("Named Exchange", 7_000_000 * USD, 2)]
    assert linked == (7_000_000 * USD, 3_000_000 * USD)


def test_an_exchange_linked_sender_counts_as_active(tmp_path):
    linked = [label("tempo", WALLET, "exchange_linked")]
    conn = build_marts(
        tmp_path,
        transfers("tempo", [fund(20), at(1, WALLET, SINK, 5 * USD)]),
        labels=linked,
        sync_state={"tempo": 10_000},
        dbt_vars={"placed_days": 14, "placed_min_base_units": 1_000_000 * USD},
    )
    try:
        active = conn.execute(
            "select active_wallets_7d from mart_activity_kpis "
            "where chain = 'tempo' and day_utc = ?",
            [TODAY - timedelta(days=1)],
        ).fetchone()
    finally:
        conn.close()
    assert active == (1,)


def test_half_moved(tmp_path):
    r = journey(tmp_path, [fund(20), at(5, WALLET, SINK, 3_000_000 * USD)], SINK_LABEL)
    assert r["placed_supply"] == 2_000_000 * USD
    assert r["free_floating"] == 0
    assert r["venue_exchange"] == 3_000_000 * USD


def test_below_threshold_after_moving(tmp_path):
    r = journey(tmp_path, [fund(20), at(5, WALLET, SINK, 4_500_000 * USD)], SINK_LABEL)
    assert r["placed_supply"] == 0
    assert r["free_floating"] == 500_000 * USD


def test_dip_inside_a_day_drives_placed(tmp_path):
    events = [
        fund(20),
        at(3, WALLET, SINK, 4_000_000 * USD, hour=2, log=0),
        at(3, SINK, WALLET, 4_000_000 * USD, hour=2, log=1),
    ]
    r = journey(tmp_path, events, SINK_LABEL)
    assert r["placed_supply"] == 1_000_000 * USD
    assert r["free_floating"] == 4_000_000 * USD


def test_dip_on_the_boundary_day_does_not_count(tmp_path):
    events = [
        fund(20),
        at(14, WALLET, SINK, 4_000_000 * USD, hour=2, log=0),
        at(14, SINK, WALLET, 4_000_000 * USD, hour=2, log=1),
    ]
    r = journey(tmp_path, events, SINK_LABEL)
    assert r["placed_supply"] == 5_000_000 * USD
    assert r["free_floating"] == 0


def test_refill_adds_free_floating_only(tmp_path):
    r = journey(tmp_path, [fund(20), fund(1, 3_000_000 * USD)])
    assert r["placed_supply"] == 5_000_000 * USD
    assert r["free_floating"] == 3_000_000 * USD


@pytest.mark.parametrize(
    "category", ["dex", "lending", "exchange", "issuer", "issuer_route", "system"]
)
def test_labeled_wallets_are_never_placed(tmp_path, category):
    r = journey(tmp_path, [fund(20)], [label("tempo", WALLET, category)])
    assert r["placed_supply"] == 0
    assert r["placed_wallets"] == 0
    assert r["total_supply"] == 5_000_000 * USD


def test_labeled_balances_land_in_their_own_columns(tmp_path):
    value = 5_000_000 * USD
    labels = [
        label("tempo", WALLET, "dex"),
        label("tempo", SINK, "lending"),
        label("tempo", OTHER, "issuer_route"),
    ]
    events = [fund(20), fund(20, value, SINK), fund(20, value, OTHER)]
    r = journey(tmp_path, events, labels)
    assert (r["venue_dex"], r["venue_lending"], r["issuer_inventory"]) == (value,) * 3
    assert r["total_supply"] == 3 * value


def test_system_wallet_counts_as_free_floating(tmp_path):
    r = journey(tmp_path, [fund(20, 117_500_000)], [label("tempo", WALLET, "system")])
    assert r["free_floating"] == 117_500_000
    assert r["placed_supply"] == 0


def test_silent_days_keep_the_old_balance(tmp_path):
    r = journey(tmp_path, [fund(20)], day=TODAY - timedelta(days=2))
    assert r["total_supply"] == 5_000_000 * USD
    assert r["holders"] == 1


def test_zero_address_never_appears_as_a_wallet(tmp_path):
    conn = build_marts(
        tmp_path,
        transfers("tempo", [fund(20), at(2, WALLET, ZERO_ADDRESS, 1 * USD)]),
        labels=[],
        sync_state={"tempo": 10_000},
    )
    try:
        found = scalar(
            conn.execute("select count(*) from int_wallet_events where address = ?", [ZERO_ADDRESS])
        )
        days = scalar(
            conn.execute("select count(*) from int_wallet_days where address = ?", [ZERO_ADDRESS])
        )
    finally:
        conn.close()
    assert found == 0
    assert days == 0


def test_no_rows_after_last_complete_day(tmp_path):
    conn = build_marts(
        tmp_path,
        transfers("tempo", [fund(20)]),
        labels=[],
        sync_state={"tempo": 10_000},
    )
    try:
        latest = scalar(conn.execute("select max(day_utc) from mart_supply_journey"))
    finally:
        conn.close()
    assert latest == TODAY


def test_precision_above_2_pow_64(tmp_path):
    big = 2**70
    r = journey(tmp_path, [fund(20, big), at(1, WALLET, SINK, 1)], SINK_LABEL)
    assert r["placed_supply"] == big - 1
    assert r["total_supply"] == big


def test_placed_days_variable_changes_the_result(tmp_path):
    assert journey(tmp_path, [fund(10)])["placed_supply"] == 0
    r = journey(sub(tmp_path, "week"), [fund(10)], dbt_vars={"placed_days": 7})
    assert r["placed_supply"] == 5_000_000 * USD


def test_ranking_and_holder_counts(tmp_path):
    events = [fund(20, 5_000_000 * USD, f"0x{i:040x}") for i in range(1, 11)]
    events += [fund(20, 10, SINK), fund(20, 2_000_000 * USD, OTHER)]
    r = journey(tmp_path, events)
    assert r["holders"] == 12
    assert r["holders_over_1m"] == 11
    # Twelve holders: the top ten are the ten 5M wallets, so OTHER and the dust fall outside.
    assert r["top10_value"] == 10 * 5_000_000 * USD


# Solana shape: base58 owners keep their case, block_hash is NULL, every leg names the owner
# wallet and never the temporary token account, and there is no issuer label yet.
SOL_MINT_TO = "MintRecipient1111111111111111111111111111111"
SOL_HOLDER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
SOL_HOLDER_LOWER = SOL_HOLDER.lower()
SOL_TEMP_ACCOUNT = "TempTokenAccount11111111111111111111111111"


def solana_events():
    return [
        at(20, ZERO_ADDRESS, SOL_MINT_TO, 8_000_000 * USD, hour=0),
        # A leg through a temporary account is recorded against the real owner on both sides.
        at(20, SOL_MINT_TO, SOL_HOLDER, 5_000_000 * USD, hour=1, log=0),
        at(20, SOL_MINT_TO, SOL_HOLDER, 1, hour=1, log=1),
    ]


def test_solana_without_issuer_label_still_produces_a_number(tmp_path):
    r = journey(tmp_path, solana_events(), chain="solana")
    assert r["total_supply"] == 8_000_000 * USD
    assert r["issuer_labeled"] is False
    assert r["issuer_inventory"] == 0
    # The unlabeled mint recipient is a plain wallet that has held for 20 days, so its
    # remaining balance is counted as placed, not inventory. This is the overstatement
    # the flag exists to disclose.
    assert r["placed_supply"] == 8_000_000 * USD
    assert r["holders"] == 2


def test_solana_issuer_label_moves_the_mint_recipient_to_inventory(tmp_path):
    labels = [label("solana", SOL_MINT_TO, "issuer")]
    r = journey(tmp_path, solana_events(), labels, chain="solana")
    assert r["issuer_labeled"] is True
    assert r["issuer_inventory"] == 3_000_000 * USD - 1
    assert r["placed_supply"] == 5_000_000 * USD + 1


def test_solana_addresses_are_case_sensitive(tmp_path):
    events = [fund(20, 5_000_000 * USD, SOL_HOLDER), fund(20, 5_000_000 * USD, SOL_HOLDER_LOWER)]
    r = journey(tmp_path, events, chain="solana")
    assert r["holders"] == 2
    labeled = journey(
        sub(tmp_path, "labeled"), events, [label("solana", SOL_HOLDER, "dex")], chain="solana"
    )
    assert labeled["venue_dex"] == 5_000_000 * USD
    assert labeled["placed_supply"] == 5_000_000 * USD


def test_only_owner_wallets_appear_for_solana(tmp_path):
    """Legs name owners (decode resolves temporary accounts), so wallets are exactly the owners."""
    conn = build_marts(
        tmp_path,
        transfers("solana", solana_events()),
        labels=[],
        sync_state={"solana": 10_000},
    )
    try:
        wallets = {
            a for (a,) in conn.execute("select distinct address from int_wallet_events").fetchall()
        }
        nulls = scalar(conn.execute("select count(*) from stg_transfers where block_hash is null"))
    finally:
        conn.close()
    assert wallets == {SOL_MINT_TO, SOL_HOLDER, "0x" + "d" * 40}
    assert SOL_TEMP_ACCOUNT not in wallets
    assert nulls > 0


def test_issuer_flag_is_per_chain(tmp_path):
    rows = transfers("ethereum", [fund(20)]) + transfers("solana", solana_events())
    conn = build_marts(
        tmp_path,
        rows,
        labels=[label("ethereum", WALLET, "issuer")],
        sync_state={"ethereum": 10_000, "solana": 10_000},
    )
    try:
        flags = dict(
            conn.execute(
                "select chain, bool_and(issuer_labeled) from mart_supply_journey group by chain"
            ).fetchall()
        )
    finally:
        conn.close()
    assert flags == {"ethereum": True, "solana": False}


def test_negative_balance_fails_the_build(tmp_path):
    result = run_dbt(
        tmp_path,
        transfers("tempo", [at(5, WALLET, SINK, 10)]),
        labels=[],
        sync_state={"tempo": 10_000},
    )
    assert not result.success
    assert "assert_no_negative_balances" in failed_tests(result)


def test_dropped_row_fails_the_event_match(tmp_path):
    conn = build_marts(
        tmp_path,
        transfers(
            "tempo",
            [fund(20), fund(15, 1_000_000 * USD, SINK), at(15, WALLET, OTHER, 1, hour=2)],
        ),
        labels=[],
        sync_state={"tempo": 10_000},
    )
    conn.close()
    # The test only compares days that have transfers, so the day keeps a second transfer.
    raw = duckdb.connect(str(tmp_path / "ousd.duckdb"))
    try:
        raw.execute("delete from transfers where block_number = 2")
    finally:
        raw.close()
    result = invoke_dbt(tmp_path, select=["assert_journey_matches_events"])
    assert "assert_journey_matches_events" in failed_tests(result)
