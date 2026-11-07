from datetime import date, timedelta

import pytest
from dbt_helpers import build_marts
from ousd.decode import ZERO_ADDRESS, Transfer

DAY = 1_700_006_400  # 2023-11-15 00:00:00 UTC
SECS = 86_400
OUSD = 10**6
FIRST_DAY = date(2023, 11, 15)


def addr(n: int) -> str:
    return "0x" + f"{n:040x}"


HEARTBEAT_FROM, HEARTBEAT_TO, RECEIVER = addr(1), addr(2), addr(3)
S_099, S_100, S_SPLIT = addr(0x10), addr(0x11), addr(0x12)
S_EDGE_IN, S_EDGE_OUT = addr(0x13), addr(0x14)
S_BIG, S_PASS_SRC, PASS_THROUGH = addr(0x15), addr(0x16), addr(0x17)
ZERO_NET_1, ZERO_NET_2 = addr(0x18), addr(0x19)
DEX, LENDING, ISSUER, SYSTEM, EXCHANGE = (addr(n) for n in (0x20, 0x21, 0x22, 0x23, 0x24))
ROUTE = addr(0x25)

LABELED = {
    DEX: ("Test DEX", "dex"),
    LENDING: ("Test Lending", "lending"),
    ISSUER: ("Test Issuer", "issuer"),
    SYSTEM: ("Test System", "system"),
    EXCHANGE: ("Test Exchange", "exchange"),
}


def label(chain, address, entity, category):
    return {
        "chain": chain,
        "address": address,
        "entity": entity,
        "category": category,
        "source_type": "project_docs",
        "source_url": "https://example.org/docs",
        "confidence": "high",
        "date_checked": "2026-11-01",
    }


LABELS = [label("tempo", a, e, c) for a, (e, c) in LABELED.items()]
LABELS += [label("base", ISSUER, "Test Issuer", "issuer"), label("base", ROUTE, "", "issuer_route")]


class Builder:
    def __init__(self, chain):
        self.chain = chain
        self.block = 0
        self.rows = []

    def send(self, day, legs, offset=100):
        """One transaction; `legs` is a list of (from, to, value) in log order."""
        self.block += 1
        block = (day + 1) * 10_000 + self.block  # blocks must grow with time
        for index, (frm, to, value) in enumerate(legs):
            transfer = Transfer(
                block_number=block,
                block_hash=None,
                block_timestamp=DAY + day * SECS + offset,
                tx_hash=f"{self.chain}-{block}",
                log_index=index,
                from_address=frm,
                to_address=to,
                value=value,
            )
            self.rows.append((self.chain, transfer))

    def fund(self, wallet, value):
        self.send(0, [(ZERO_ADDRESS, wallet, value)], offset=1)

    def heartbeat(self, days):
        """Something moves every day, so every day has a waterfall row."""
        for day in range(days):
            self.send(day, [(HEARTBEAT_FROM, HEARTBEAT_TO, 1)], offset=500)


def tempo_rows():
    t = Builder("tempo")
    for wallet in (HEARTBEAT_FROM, S_099, S_100, S_SPLIT, S_EDGE_IN, S_EDGE_OUT, S_BIG):
        t.fund(wallet, 1_000 * OUSD)
    for wallet in (S_PASS_SRC, PASS_THROUGH, ZERO_NET_1, ZERO_NET_2, *LABELED):
        t.fund(wallet, 1_000 * OUSD)
    t.fund(RECEIVER, 123_457)  # an odd total, so velocity does not divide evenly
    t.heartbeat(10)
    t.send(8, [(S_099, RECEIVER, 990_000)])
    t.send(8, [(S_100, RECEIVER, 1_000_000)])
    t.send(7, [(S_SPLIT, RECEIVER, 600_000)])
    t.send(8, [(S_SPLIT, RECEIVER, 400_000)])
    t.send(3, [(S_EDGE_IN, RECEIVER, 2_000_000)])
    t.send(2, [(S_EDGE_OUT, RECEIVER, 2_000_000)])
    t.send(8, [(S_BIG, RECEIVER, 150 * OUSD)])
    for sender in (DEX, LENDING, ISSUER, SYSTEM, EXCHANGE):
        t.send(8, [(sender, RECEIVER, 5 * OUSD)])
    t.send(8, [(S_PASS_SRC, PASS_THROUGH, 5 * OUSD), (PASS_THROUGH, RECEIVER, 5 * OUSD)])
    t.send(8, [(ZERO_NET_1, ZERO_NET_2, 5 * OUSD), (ZERO_NET_2, ZERO_NET_1, 5 * OUSD)])
    for day in (4, 5, 6, 9):  # volume of different sizes, for the velocity checks
        small_sender = addr(0x30 + day)  # one wallet per day, so none passes the dust floor
        t.fund(small_sender, OUSD)
        t.send(day, [(small_sender, HEARTBEAT_TO, 250_000 + day)])
    t.send(10, [(HEARTBEAT_FROM, HEARTBEAT_TO, 1)])  # makes day 9 the last complete day
    return t.rows


def ethereum_rows():
    """Five days of history: too short for a 7-day window."""
    e = Builder("ethereum")
    e.fund(HEARTBEAT_FROM, 1_000 * OUSD)
    e.heartbeat(5)
    e.send(5, [(HEARTBEAT_FROM, HEARTBEAT_TO, 1)])
    return e.rows


def base_rows():
    """All supply sits in issuer wallets, so circulating supply is zero."""
    b = Builder("base")
    b.fund(ISSUER, 100 * OUSD)
    for day in range(10):
        b.send(day, [(ISSUER, ROUTE, OUSD)], offset=500)
    b.send(10, [(ISSUER, ROUTE, OUSD)])
    return b.rows


@pytest.fixture(scope="module")
def marts(tmp_path_factory):
    conn = build_marts(
        tmp_path_factory.mktemp("kpis"),
        tempo_rows() + ethereum_rows() + base_rows(),
        LABELS,
        {"tempo": 1000, "ethereum": 1000, "base": 1000},
    )
    yield conn
    conn.close()


def kpi(marts, chain, day_index):
    row = marts.execute(
        "select velocity_bps, velocity_everyday_bps, headline_velocity_bps, "
        "active_wallets_7d, active_wallets_over_100_7d, circulating_supply, total_supply, "
        "headline_7d, clean_7d, clean_everyday_7d "
        "from mart_activity_kpis where chain = ? and day_utc = ?",
        [chain, FIRST_DAY + timedelta(days=day_index)],
    ).fetchone()
    columns = [
        "velocity",
        "velocity_everyday",
        "headline_velocity",
        "active",
        "active_over_100",
        "circulating",
        "total",
        "headline_7d",
        "clean_7d",
        "clean_everyday_7d",
    ]
    return dict(zip(columns, row, strict=True))


# Velocity


def test_velocity_is_null_until_seven_days_of_history_exist(marts):
    assert kpi(marts, "tempo", 5)["velocity"] is None
    assert kpi(marts, "tempo", 5)["headline_velocity"] is None
    assert kpi(marts, "tempo", 6)["velocity"] is not None


def test_velocity_is_null_for_a_chain_with_a_short_history(marts):
    (rows, with_velocity) = marts.execute(
        "select count(*), count(velocity_bps) from mart_activity_kpis where chain = 'ethereum'"
    ).fetchone()
    assert rows == 5
    assert with_velocity == 0


def test_velocity_is_null_when_circulating_supply_is_zero(marts):
    day = kpi(marts, "base", 9)
    assert day["circulating"] == 0
    assert day["velocity"] is None
    assert day["velocity_everyday"] is None
    # Headline velocity divides by total supply, which is not zero.
    assert day["headline_velocity"] is not None


def test_velocity_is_integer_division_that_floors(marts):
    checked = 0
    rounded_up = 0
    for index in range(6, 10):
        day = kpi(marts, "tempo", index)
        divisor = 7 * day["circulating"]
        exact = day["clean_7d"] * 10_000 / divisor
        assert day["velocity"] == day["clean_7d"] * 10_000 // divisor
        assert day["velocity_everyday"] == day["clean_everyday_7d"] * 10_000 // divisor
        assert day["headline_velocity"] == day["headline_7d"] * 10_000 // (7 * day["total"])
        checked += 1
        rounded_up += round(exact) != day["velocity"]
    assert checked == 4
    assert rounded_up, "fixture should include a value that rounding would change"


# Active wallets


def test_active_wallet_count_applies_the_dust_floor_and_window(marts):
    # Counted: S_100 (exactly $1), S_SPLIT ($0.60 + $0.40), S_EDGE_IN (oldest day in the
    # window), S_BIG, the exchange wallet, and the source wallet of the pass-through.
    # Not counted: $0.99, a pass-through, a zero-net transaction, dex, lending, issuer, system.
    assert kpi(marts, "tempo", 9)["active"] == 6


def test_window_starts_six_days_back_so_a_day_eight_back_is_out(marts):
    # S_EDGE_OUT sent on day 2: inside day 8's window (days 2 to 8), outside day 9's (3 to 9).
    assert kpi(marts, "tempo", 8)["active"] == kpi(marts, "tempo", 9)["active"] + 1


def test_secondary_threshold_counts_only_wallets_with_100_ousd_sent(marts):
    assert kpi(marts, "tempo", 9)["active_over_100"] == 1


def test_active_wallets_are_zero_when_nobody_sent_enough(marts):
    assert kpi(marts, "tempo", 1)["active"] == 0
    assert kpi(marts, "ethereum", 4)["active"] == 0


def test_headline_and_clean_roll_up_over_seven_days(marts):
    (headline,) = marts.execute(
        "select sum(headline_value) from mart_activity_waterfall "
        "where chain = 'tempo' and day_utc between ? and ?",
        [FIRST_DAY + timedelta(days=3), FIRST_DAY + timedelta(days=9)],
    ).fetchone()
    assert kpi(marts, "tempo", 9)["headline_7d"] == headline


# Gaps: a calendar window, not seven rows


def gap_rows():
    """Ethereum-like history with no transfers on days 3 to 5, so a row window would stretch."""
    g = Builder("ethereum")
    g.fund(HEARTBEAT_FROM, 1_000 * OUSD)
    g.fund(RECEIVER, 100 * OUSD)
    for day in (0, 1, 2, 6, 7, 8, 9):
        g.send(day, [(HEARTBEAT_FROM, RECEIVER, 5 * OUSD)])
    g.send(10, [(HEARTBEAT_FROM, RECEIVER, 1)])  # makes day 9 the last complete day
    return g.rows


@pytest.fixture(scope="module")
def gap_marts(tmp_path_factory):
    conn = build_marts(tmp_path_factory.mktemp("kpis_gap"), gap_rows(), [], {"ethereum": 1000})
    yield conn
    conn.close()


def test_a_window_with_gap_days_counts_only_the_days_inside_the_calendar_range(gap_marts):
    day = kpi(gap_marts, "ethereum", 9)
    # Days 3 to 9 hold transfers on 6, 7, 8 and 9 only. Seven rows would reach back to day 0.
    assert day["clean_7d"] == 4 * 5 * OUSD
    assert day["headline_7d"] == 4 * 5 * OUSD
    assert day["velocity"] == day["clean_7d"] * 10_000 // (7 * day["circulating"])


def test_velocity_needs_seven_calendar_days_of_history_not_seven_rows(gap_marts):
    # Day 6 is the first day with a full week behind it, though it is only the fourth row.
    assert kpi(gap_marts, "ethereum", 2)["velocity"] is None
    assert kpi(gap_marts, "ethereum", 6)["velocity"] is not None
    assert kpi(gap_marts, "ethereum", 6)["clean_7d"] == 4 * 5 * OUSD


def test_quiet_days_are_rows_with_zero_activity_and_a_rolling_window(gap_marts):
    # Days 3 to 5 have no transfers: still one row each, with the window carried across them.
    for index in (3, 4, 5):
        day = kpi(gap_marts, "ethereum", index)
        # Active wallets are a rolling count, so the senders from days 0 to 2 still count.
        assert day["active"] == kpi(gap_marts, "ethereum", 2)["active"]
        assert day["clean_7d"] == 3 * 5 * OUSD
    assert kpi(gap_marts, "ethereum", 3)["velocity"] is None  # under a full week of history
    days = [
        r[0]
        for r in gap_marts.execute(
            "select day_utc from mart_activity_kpis where chain = 'ethereum' order by day_utc"
        ).fetchall()
    ]
    assert days == [FIRST_DAY + timedelta(days=i) for i in range(10)]
