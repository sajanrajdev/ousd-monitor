import random
from datetime import date
from pathlib import Path

import duckdb
import pytest
from dbt_helpers import build_marts, failed_tests, run_dbt
from ousd.decode import ZERO_ADDRESS, Transfer

DAY = 1_700_006_400  # 2023-11-15 00:00:00 UTC
SECS = 86_400
OUSD = 10**6
LARGE = 10**12
FEE_MANAGER = "0xfeec000000000000000000000000000000000000"
DEX_POOL = "0x" + "d1" * 20
LENDING = "0x" + "1e" * 20
ISSUER = "0x" + "15" * 20
ROUTE_1 = "0x" + "a1" * 20
ROUTE_2 = "0x" + "a2" * 20
EXCHANGE = "0x" + "ec" * 20
ENTITY_A = "0x" + "e1" * 20
ENTITY_B = "0x" + "e2" * 20
SOLANA_DEX = "DexPooLoWnerAbCdEfGhJkMnPqRsTuVwXyZ123456789"
SOLANA_A = "AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa"
SOLANA_TEMP = "TmPoWnErAbCdEfGhJkMnPqRsTuVwXyZ1234567890Ab"
SOLANA_B = "BbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb"


def addr(n: int) -> str:
    return "0x" + f"{n:040x}"


A, B, C, D = addr(0xA), addr(0xB), addr(0xC), addr(0xD)


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


LABELS = [
    label("tempo", DEX_POOL, "Test DEX", "dex"),
    label("tempo", LENDING, "Test Lending", "lending"),
    label("tempo", ISSUER, "Test Issuer", "issuer"),
    label("tempo", ROUTE_1, "", "issuer_route"),
    label("tempo", ROUTE_2, "", "issuer_route"),
    label("tempo", EXCHANGE, "Test Exchange", "exchange"),
    label("tempo", ENTITY_A, "Same Org", "exchange"),
    label("tempo", ENTITY_B, "Same Org", "exchange"),
    label("tempo", FEE_MANAGER, "Tempo Fee Manager", "system"),
    label("solana", SOLANA_DEX, "Test DEX", "dex"),
]


def route(block, tx, legs, chain="tempo", day=0, offset=100):
    """One transaction: `legs` is a list of (from, to, value) in log order."""
    ts = DAY + day * SECS + offset
    return [
        (
            chain,
            Transfer(
                block_number=block,
                block_hash=None,
                block_timestamp=ts,
                tx_hash=tx,
                log_index=index,
                from_address=frm,
                to_address=to,
                value=value,
            ),
        )
        for index, (frm, to, value) in enumerate(legs)
    ]


def fund(chain, block, wallets, amount=10**20):
    """Mint to every wallet the day before the scenarios, so no balance goes negative."""
    legs = [(ZERO_ADDRESS, wallet, amount) for wallet in wallets]
    return route(block, f"fund-{chain}-{block}", legs, chain=chain, day=-1)


def filler(chain, block, day):
    """A transfer on the day after the last one under test, so earlier days are complete."""
    return route(block, f"filler-{chain}", [(A, B, 1)], chain=chain, day=day)


# Each scenario owns one transaction hash, so its parts can be read back from the tables.
SCENARIOS = {
    "mint_to_issuer": [(ZERO_ADDRESS, ISSUER, 100 * OUSD)],
    "burn_from_exchange": [(EXCHANGE, ZERO_ADDRESS, 30 * OUSD)],
    "fee_last": [(A, B, 20 * OUSD), (A, FEE_MANAGER, 43)],
    "fee_exception": [(A, FEE_MANAGER, 50 * OUSD), (A, FEE_MANAGER, 500)],
    "fee_not_last": [(A, FEE_MANAGER, 7), (A, B, 3 * OUSD)],
    "from_fee_manager": [(FEE_MANAGER, A, 9 * OUSD)],
    "issuer_flow": [(ISSUER, A, 8 * OUSD), (B, ROUTE_1, 6 * OUSD)],
    "route_to_route": [(ROUTE_1, ROUTE_2, 4 * OUSD)],
    "same_entity": [(ENTITY_A, ENTITY_B, 12 * OUSD)],
    "unlabeled": [(A, B, 11 * OUSD)],
    "loop": [(A, B, 10 * OUSD), (B, A, 10 * OUSD)] * 4,
    "multi_hop": [(A, B, 10 * OUSD), (B, C, 10 * OUSD), (C, D, 10 * OUSD)],
    "split": [(A, B, 10 * OUSD), (A, C, 5 * OUSD)],
    "partial_pass_through": [(A, B, 10 * OUSD), (B, C, 7 * OUSD)],
    "dex_in": [(A, DEX_POOL, 10 * OUSD)],
    "dex_out": [(DEX_POOL, A, 10 * OUSD)],
    "router_to_lending": [(A, B, 10 * OUSD), (B, LENDING, 10 * OUSD)],
    "both_venues": [(A, DEX_POOL, 10 * OUSD), (LENDING, A, 4 * OUSD)],
    "both_venues_deposit": [(A, DEX_POOL, 10 * OUSD), (A, LENDING, 6 * OUSD), (A, B, 2 * OUSD)],
    "solana_via_temp": [(SOLANA_A, SOLANA_TEMP, 100 * OUSD), (SOLANA_TEMP, SOLANA_B, 100 * OUSD)],
    "solana_mint_via_temp": [
        (ZERO_ADDRESS, SOLANA_TEMP, 40 * OUSD),
        (SOLANA_TEMP, SOLANA_B, 40 * OUSD),
    ],
    "solana_case": [(SOLANA_A, SOLANA_B, 5 * OUSD), (SOLANA_B.lower(), SOLANA_A, 5 * OUSD)],
    "solana_dex": [(SOLANA_A, SOLANA_DEX, 9 * OUSD), (SOLANA_A, SOLANA_DEX.lower(), 2 * OUSD)],
    "eth_fee_address": [(A, FEE_MANAGER, 43)],
}
SOLANA_TXS = {name for name in SCENARIOS if name.startswith("solana")}
ETHEREUM_TXS = {"eth_fee_address"}


def build_rows():
    rows = []
    for block, (name, legs) in enumerate(SCENARIOS.items(), start=10):
        chain = "solana" if name in SOLANA_TXS else "ethereum" if name in ETHEREUM_TXS else "tempo"
        rows += route(block, name, legs, chain=chain)
    rows += fund("tempo", 1, [A, B, C, D, DEX_POOL, LENDING, ISSUER, ROUTE_1, ROUTE_2])
    rows += fund("tempo", 2, [EXCHANGE, ENTITY_A, ENTITY_B, FEE_MANAGER])
    rows += fund("ethereum", 1, [A])
    rows += fund("solana", 1, [SOLANA_A, SOLANA_B, SOLANA_B.lower(), SOLANA_TEMP, SOLANA_DEX, A])
    # Day 1 holds the threshold transactions.
    rows += route(100, "threshold_exact", [(A, B, LARGE)], day=1)
    rows += route(101, "threshold_below", [(C, D, LARGE - 1)], day=1)
    for chain, block in (("tempo", 200), ("ethereum", 201), ("solana", 202)):
        rows += filler(chain, block, day=2)
    return rows


SYNC = {"tempo": 1000, "ethereum": 1000, "solana": 1000}


@pytest.fixture(scope="module")
def marts(tmp_path_factory):
    conn = build_marts(tmp_path_factory.mktemp("waterfall"), build_rows(), LABELS, SYNC)
    yield conn
    conn.close()


def classes(marts, tx):
    return [
        row[0]
        for row in marts.execute(
            "select transfer_class from int_transfer_classes where tx_hash = ? order by log_index",
            [tx],
        ).fetchall()
    ]


def parts(marts, tx):
    row = marts.execute(
        "select gross_value, same_tx_netting, dex_flow, lending_flow, clean_value "
        "from int_tx_decomposition where tx_hash = ?",
        [tx],
    ).fetchone()
    return dict(zip(["gross", "netting", "dex", "lending", "clean"], row, strict=True))


# Classification


def test_mint_and_burn_class_even_when_other_side_is_labeled(marts):
    assert classes(marts, "mint_to_issuer") == ["mint"]
    assert classes(marts, "burn_from_exchange") == ["burn"]


def test_last_transfer_to_fee_manager_is_the_fee(marts):
    assert classes(marts, "fee_last") == ["remaining", "fee"]


def test_large_earlier_transfer_to_fee_manager_is_liquidity_not_fee(marts):
    assert classes(marts, "fee_exception") == ["fee_liquidity", "fee"]


def test_fee_manager_transfer_that_is_not_last_in_its_tx_is_not_a_fee(marts):
    assert classes(marts, "fee_not_last") == ["fee_liquidity", "remaining"]


def test_transfer_from_fee_manager_is_fee_liquidity(marts):
    assert classes(marts, "from_fee_manager") == ["fee_liquidity"]


def test_fee_rule_is_tempo_only(marts):
    assert classes(marts, "eth_fee_address") == ["remaining"]


def test_issuer_or_route_wallet_on_either_side_is_issuer_flow(marts):
    assert classes(marts, "issuer_flow") == ["issuer_flow", "issuer_flow"]


def test_two_empty_entity_route_wallets_are_issuer_flow_not_same_entity(marts):
    assert classes(marts, "route_to_route") == ["issuer_flow"]


def test_same_named_entity_is_same_entity_and_unlabeled_wallets_are_not(marts):
    assert classes(marts, "same_entity") == ["same_entity"]
    assert classes(marts, "unlabeled") == ["remaining"]


# Decomposition


def test_loop_nets_to_the_full_gross(marts):
    p = parts(marts, "loop")
    assert p["gross"] == 80 * OUSD
    assert (p["netting"], p["clean"]) == (80 * OUSD, 0)


def test_multi_hop_counts_one_value(marts):
    p = parts(marts, "multi_hop")
    assert (p["gross"], p["netting"], p["clean"]) == (30 * OUSD, 20 * OUSD, 10 * OUSD)


def test_split_is_all_clean(marts):
    p = parts(marts, "split")
    assert (p["clean"], p["netting"]) == (15 * OUSD, 0)


def test_partial_pass_through_nets_what_the_middle_wallet_passed_on(marts):
    p = parts(marts, "partial_pass_through")
    assert (p["gross"], p["netting"], p["clean"]) == (17 * OUSD, 7 * OUSD, 10 * OUSD)


def test_dex_flow_in_either_direction_is_not_clean(marts):
    for tx in ("dex_in", "dex_out"):
        p = parts(marts, tx)
        assert (p["dex"], p["clean"]) == (10 * OUSD, 0)


def test_deposit_through_a_router_is_lending_flow_and_netting(marts):
    p = parts(marts, "router_to_lending")
    assert (p["lending"], p["netting"], p["clean"]) == (10 * OUSD, 10 * OUSD, 0)


def test_both_venues_in_one_tx_never_exceed_moved(marts):
    capped = parts(marts, "both_venues")
    assert (capped["dex"], capped["lending"], capped["clean"]) == (10 * OUSD, 0, 0)
    deposit = parts(marts, "both_venues_deposit")
    assert (deposit["dex"], deposit["lending"], deposit["clean"]) == (
        10 * OUSD,
        6 * OUSD,
        2 * OUSD,
    )
    (negative,) = marts.execute(
        "select count(*) from int_tx_decomposition "
        "where clean_value < 0 or dex_flow < 0 or lending_flow < 0"
    ).fetchone()
    assert negative == 0


def test_split_at_the_large_threshold(marts):
    row = marts.execute(
        "select clean_large, clean_everyday from mart_activity_waterfall "
        "where chain = 'tempo' and day_utc = ?",
        [date(2023, 11, 16)],
    ).fetchone()
    assert row == (LARGE, LARGE - 1)


# Solana: one route appears as several transfers through a temporary account


def test_solana_route_through_a_temporary_account_is_one_movement(marts):
    p = parts(marts, "solana_via_temp")
    assert (p["gross"], p["netting"], p["clean"]) == (200 * OUSD, 100 * OUSD, 100 * OUSD)


def test_solana_mint_forwarded_from_a_temporary_account(marts):
    assert classes(marts, "solana_mint_via_temp") == ["mint", "remaining"]
    p = parts(marts, "solana_mint_via_temp")
    assert (p["gross"], p["netting"], p["clean"]) == (40 * OUSD, 0, 40 * OUSD)


def test_solana_owners_keep_their_case_and_are_not_netted_across_case(marts):
    p = parts(marts, "solana_case")
    # Folding case would make this A to B and back: netting 10, clean 0.
    assert (p["netting"], p["clean"]) == (5 * OUSD, 5 * OUSD)


def test_solana_label_matches_the_exact_case_only(marts):
    assert classes(marts, "solana_dex") == ["remaining", "remaining"]
    p = parts(marts, "solana_dex")
    # Only the exact-case pool is a dex wallet.
    assert (p["dex"], p["clean"]) == (9 * OUSD, 2 * OUSD)


# Marts


def test_waterfall_parts_add_back_to_headline_in_integers(marts):
    rows = marts.execute(
        "select headline_value, minted + burned + fees + fee_liquidity + issuer_flows "
        "+ same_entity + same_tx_netting + dex_flow + lending_flow + clean_large "
        "+ clean_everyday from mart_activity_waterfall"
    ).fetchall()
    assert rows
    assert all(headline == total for headline, total in rows)


def test_headline_equals_all_transfers_up_to_the_last_complete_day(marts):
    for chain in ("tempo", "ethereum", "solana"):
        (mart,) = marts.execute(
            "select sum(headline_value) from mart_activity_waterfall where chain = ?", [chain]
        ).fetchone()
        (staged,) = marts.execute(
            "select sum(value) from stg_transfers where chain = ? and day_utc <= date '2023-11-16'",
            [chain],
        ).fetchone()
        assert mart == staged


def test_no_rows_after_the_last_complete_day(marts):
    (latest,) = marts.execute("select max(day_utc) from mart_activity_waterfall").fetchone()
    assert latest == date(2023, 11, 16)


def test_fee_counts_and_totals_on_tempo_day_zero(marts):
    row = marts.execute(
        "select fees, fee_count, fee_liquidity from mart_activity_waterfall "
        "where chain = 'tempo' and day_utc = ?",
        [date(2023, 11, 15)],
    ).fetchone()
    # fee_last 43 + fee_exception 500; liquidity is the 50 OUSD, the not-last 7 and the 9 OUSD.
    assert row == (543, 2, 50 * OUSD + 7 + 9 * OUSD)


def test_amount_above_2_pow_64_survives_the_waterfall(tmp_path):
    big = 2**70 + 12345
    rows = fund("tempo", 0, [A], 2**72) + route(1, "big", [(A, B, big)]) + filler("tempo", 2, day=1)
    conn = build_marts(tmp_path, rows, [], {"tempo": 10})
    try:
        row = conn.execute(
            "select headline_value, clean_everyday, clean_large from mart_activity_waterfall"
        ).fetchone()
    finally:
        conn.close()
    assert row == (big, 0, big)


# The identity under random input


def random_transactions(seed):
    rng = random.Random(seed)
    wallets = [
        A,
        B,
        C,
        D,
        DEX_POOL,
        LENDING,
        ISSUER,
        ROUTE_1,
        ROUTE_2,
        EXCHANGE,
        ENTITY_A,
        ENTITY_B,
    ]
    wallets += [FEE_MANAGER, ZERO_ADDRESS]
    rows = []
    for index in range(200):
        legs = []
        for _ in range(rng.randint(1, 5)):
            frm, to = rng.choice(wallets), rng.choice(wallets)
            if frm == to:
                continue
            if to == FEE_MANAGER:  # keep fee-sized, or the fee shape test rightly fails
                value = rng.choice([1, 43, 500])
            else:
                value = rng.choice([1, 43, 500, OUSD, 3 * OUSD, LARGE - 1, LARGE, 2 * LARGE])
            legs.append((frm, to, value + rng.randint(0, 7)))
        if legs:
            day = rng.randint(0, 3)
            rows += route(
                1000 + day * 1000 + index,  # blocks must grow with time
                f"rand-{index}",
                legs,
                day=day,
                offset=rng.randint(0, 999),
            )
    funded = fund("tempo", 1, [w for w in wallets if w != ZERO_ADDRESS], 10**24)
    return funded + rows + filler("tempo", 5000, day=5)


def test_random_transactions_keep_the_identity(tmp_path):
    rows = random_transactions(seed=7)
    conn = build_marts(tmp_path, rows, LABELS, {"tempo": 1000})  # raises on any failed test
    try:
        bad = conn.execute(
            "select count(*) from mart_activity_waterfall where headline_value <> minted + burned "
            "+ fees + fee_liquidity + issuer_flows + same_entity + same_tx_netting + dex_flow "
            "+ lending_flow + clean_large + clean_everyday"
        ).fetchone()
        classes_seen = conn.execute(
            "select count(distinct transfer_class) from int_transfer_classes"
        ).fetchone()
    finally:
        conn.close()
    assert bad == (0,)
    assert classes_seen == (7,)


# The tests themselves can fail


def test_waterfall_identity_test_reports_a_tampered_row():
    sql = Path("dbt/tests/assert_waterfall_adds_up.sql").read_text()
    sql = sql.replace("{{ ref('mart_activity_waterfall') }}", "waterfall")
    conn = duckdb.connect()
    conn.execute(
        "create table waterfall (chain varchar, day_utc date, headline_value hugeint, "
        "minted hugeint, burned hugeint, fees hugeint, fee_liquidity hugeint, "
        "issuer_flows hugeint, same_entity hugeint, same_tx_netting hugeint, dex_flow hugeint, "
        "lending_flow hugeint, clean_large hugeint, clean_everyday hugeint)"
    )
    conn.execute(
        "insert into waterfall values ('tempo', date '2023-11-15', 100, 10,0,0,0,0,0,0,0,0,0,90)"
    )
    assert conn.execute(sql).fetchall() == []
    conn.execute("update waterfall set clean_everyday = 89")
    assert conn.execute(sql).fetchall() == [("tempo", date(2023, 11, 15))]


def test_fee_shape_test_fails_when_a_large_transfer_is_caught_as_a_fee(tmp_path):
    rows = (
        fund("tempo", 0, [A])
        + route(1, "big-fee", [(A, FEE_MANAGER, 50 * OUSD)])
        + filler("tempo", 2, day=1)
    )
    result = run_dbt(tmp_path, rows, [], {"tempo": 10})
    assert "assert_fee_rule_shape" in failed_tests(result)


def test_fee_shape_test_passes_on_real_sized_fees(tmp_path):
    rows = (
        fund("tempo", 0, [A])
        + route(1, "small-fee", [(A, FEE_MANAGER, 1_070_000)])
        + filler("tempo", 2, day=1)
    )
    result = run_dbt(tmp_path, rows, [], {"tempo": 10})
    assert result.success


def test_clean_tx_count_counts_transactions_at_or_above_the_minimum(marts):
    (count,) = marts.execute(
        "select clean_tx_count from mart_activity_waterfall where chain = 'tempo' and day_utc = ?",
        [date(2023, 11, 16)],
    ).fetchone()
    assert count == 2
    (below,) = marts.execute(
        "select count(*) from int_tx_decomposition where clean_value > 0 and clean_value < 1000000"
    ).fetchone()
    assert below >= 1  # the fixture has clean transactions under the minimum, on other days
