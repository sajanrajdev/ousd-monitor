"""mart_chain_roles scenarios. Every case builds the dbt project over a throwaway database."""

from datetime import date

import pytest
from dbt_helpers import build_marts
from ousd.decode import ZERO_ADDRESS, Transfer

DAY = 1_700_006_400  # 2023-11-15 00:00:00 UTC
SECS = 86_400
OUSD = 10**6
DAY_ONE = date(2023, 11, 15)


def addr(n: int) -> str:
    return "0x" + f"{n:040x}"


A, B, DEX = addr(1), addr(2), addr(3)
SOL_A = "SoLaNaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa"
SOL_DEX = "SoLDexPooLoWnerAbCdEfGhJkMnPqRsTuVwXyZ12345"


def label(chain, address, category):
    return {
        "chain": chain,
        "address": address,
        "entity": "Test DEX",
        "category": category,
        "source_type": "project_docs",
        "source_url": "https://example.org/docs",
        "confidence": "high",
        "date_checked": "2026-11-01",
    }


LABELS = [label("tempo", DEX, "dex"), label("solana", SOL_DEX, "dex")]


def chain_rows(chain, events, last_day, sender=A):
    """`events` is a list of (day, legs) with legs as (from, to, value).

    A heartbeat on `last_day` makes it the chain's as-of day, and one more transfer the day
    after makes that day complete.
    """
    events = [*events, (last_day, [(sender, B, OUSD)]), (last_day + 1, [(sender, B, 1)])]
    out = []
    for block, (day, legs) in enumerate(sorted(events, key=lambda e: e[0]), start=1):
        for index, (frm, to, value) in enumerate(legs):
            out.append(
                (
                    chain,
                    Transfer(
                        block_number=block,
                        block_hash=None,
                        block_timestamp=DAY + day * SECS + 100,
                        tx_hash=f"{chain}-{block}",
                        log_index=index,
                        from_address=frm,
                        to_address=to,
                        value=value,
                    ),
                )
            )
    return out


def fund(wallet, value):
    return (0, [(ZERO_ADDRESS, wallet, value)])


def roles(marts):
    cursor = marts.execute("select * from mart_chain_roles")
    names = [d[0] for d in cursor.description]
    return {r[0]: dict(zip(names, r, strict=True)) for r in cursor.fetchall()}


@pytest.fixture(scope="module")
def marts(tmp_path_factory):
    tempo = chain_rows(
        "tempo",
        [
            fund(A, 600 * OUSD),
            (10, [(ZERO_ADDRESS, B, 7 * OUSD)]),  # exactly 30 days before as-of day 40: out
            (11, [(ZERO_ADDRESS, B, 3 * OUSD)]),  # 29 days before: in
            (35, [(A, DEX, 3 * OUSD)]),
        ],
        last_day=40,
    )
    ethereum = chain_rows("ethereum", [fund(A, 300 * OUSD)], last_day=20)
    solana = chain_rows(
        "solana",
        [
            fund(SOL_A, 100 * OUSD),
            (30, [(SOL_A, SOL_DEX, OUSD)]),
            (30, [(SOL_A, SOL_DEX.lower(), 2 * OUSD)]),  # a different account on Solana
        ],
        last_day=30,
        sender=SOL_A,
    )
    conn = build_marts(
        tmp_path_factory.mktemp("roles"),
        tempo + ethereum + solana,
        LABELS,
        {"tempo": 1000, "ethereum": 1000, "solana": 1000},
    )
    yield conn
    conn.close()


def test_each_chain_reports_its_own_as_of_day(marts):
    days = {chain: (row["as_of_day"] - DAY_ONE).days for chain, row in roles(marts).items()}
    assert days == {"tempo": 40, "ethereum": 20, "solana": 30}


def test_supply_shares_floor_and_sum_to_at_most_10000(marts):
    rows = roles(marts)
    total = sum(r["total_supply"] for r in rows.values())
    for row in rows.values():
        assert row["supply_share_bps"] == row["total_supply"] * 10_000 // total
    assert sum(r["supply_share_bps"] for r in rows.values()) <= 10_000


def test_mint_exactly_30_days_before_as_of_day_is_out_and_29_days_is_in(marts):
    assert roles(marts)["tempo"]["minted_30d"] == 3 * OUSD


def test_chain_without_dex_flow_gets_zero_and_the_others_share_the_total(marts):
    rows = roles(marts)
    assert rows["ethereum"]["dex_flow_30d"] == 0
    assert rows["ethereum"]["dex_flow_share_bps"] == 0
    assert rows["tempo"]["dex_flow_30d"] == 3 * OUSD
    assert rows["tempo"]["dex_flow_share_bps"] == 7_500
    assert rows["solana"]["dex_flow_share_bps"] == 2_500


def test_solana_addresses_keep_their_case_and_block_hash_is_null(marts):
    # Only the exactly-cased pool counts; its lower-cased twin is another account.
    assert roles(marts)["solana"]["dex_flow_30d"] == OUSD
    (hashed,) = marts.execute(
        "select count(*) from stg_transfers where chain = 'solana' and block_hash is not null"
    ).fetchone()
    (cased,) = marts.execute(
        "select count(*) from stg_transfers "
        "where chain = 'solana' and from_address <> lower(from_address)"
    ).fetchone()
    assert hashed == 0
    assert cased > 0


def test_share_is_null_when_no_chain_has_any_dex_flow(tmp_path):
    conn = build_marts(
        tmp_path,
        chain_rows("ethereum", [fund(A, 300 * OUSD)], last_day=20),
        [],
        {"ethereum": 1000},
    )
    try:
        row = roles(conn)["ethereum"]
    finally:
        conn.close()
    assert row["dex_flow_30d"] == 0
    assert row["dex_flow_share_bps"] is None
    assert row["supply_share_bps"] == 10_000
