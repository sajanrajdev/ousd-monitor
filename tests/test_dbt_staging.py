import hashlib
import json
from datetime import date

import pytest
from dbt_helpers import build_marts, failed_tests, invoke_dbt, run_dbt, write_raw
from ousd.decode import ZERO_ADDRESS, Transfer

ALICE = "0x" + "a" * 40
BOB = "0x" + "b" * 40
DAY = 1_700_006_400  # 2023-11-15 00:00:00 UTC
SOLANA_FROM = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
SOLANA_TO = "7sQwErTyUiOpAsDfGhJkLzXcVbNm1234567890AbCdEf"
BIG = 2**70 + 12345


def tr(block, log, ts, frm, to, value, block_hash=None, tx=None):
    return Transfer(
        block_number=block,
        block_hash=block_hash,
        block_timestamp=ts,
        tx_hash=tx or f"0x{block:064x}",
        log_index=log,
        from_address=frm,
        to_address=to,
        value=value,
    )


ROWS = [
    ("tempo", tr(1, 0, DAY - 1, ZERO_ADDRESS, ALICE, 5_000_000 + BIG, block_hash="0x" + "1" * 64)),
    ("tempo", tr(2, 0, DAY, ALICE, BOB, BIG)),
    ("tempo", tr(3, 0, DAY + 3600, BOB, ALICE, BIG)),
    ("ethereum", tr(10, 0, DAY + 100, ZERO_ADDRESS, ALICE, 7)),
    # Solana: no block hash, base58 addresses that keep their case.
    ("solana", tr(49, 0, DAY + 100, ZERO_ADDRESS, SOLANA_FROM, 42, tx="4" + "Ab" * 40)),
    ("solana", tr(50, 0, DAY + 200, SOLANA_FROM, SOLANA_TO, 42, tx="5" + "Ab" * 40)),
]


@pytest.fixture(scope="module")
def build_dir(tmp_path_factory):
    return tmp_path_factory.mktemp("dbt")


@pytest.fixture(scope="module")
def marts(build_dir):
    # Base has a sync cursor and no transfers yet.
    conn = build_marts(
        build_dir,
        ROWS,
        labels=[],
        sync_state={"tempo": 3, "ethereum": 10, "solana": 50, "base": 7},
    )
    yield conn
    conn.close()


def test_mint_and_transfer_staged_with_utc_day_and_hugeint(marts):
    rows = marts.execute(
        "select block_number, day_utc, typeof(value) from stg_transfers "
        "where chain = 'tempo' order by block_number"
    ).fetchall()
    assert rows == [
        (1, date(2023, 11, 14), "HUGEINT"),  # 23:59:59
        (2, date(2023, 11, 15), "HUGEINT"),  # 00:00:00
        (3, date(2023, 11, 15), "HUGEINT"),
    ]


def test_value_above_2_pow_64_survives(marts):
    (value,) = marts.execute("select value from stg_transfers where block_number = 3").fetchone()
    assert value == BIG
    assert BIG > 2**64


def test_last_complete_day_is_day_before_newest_transfer(marts):
    (day,) = marts.execute(
        "select last_complete_day from int_sync_coverage where chain = 'tempo'"
    ).fetchone()
    assert day == date(2023, 11, 14)


def test_a_chain_with_a_cursor_and_no_transfers_keeps_its_coverage_row(marts):
    row = marts.execute(
        "select synced_through, last_transfer_timestamp, last_complete_day "
        "from int_sync_coverage where chain = 'base'"
    ).fetchone()
    assert row == (7, None, None)
    (days,) = marts.execute("select count(*) from int_chain_days where chain = 'base'").fetchone()
    assert days == 0


def test_labels_are_a_source_in_dbt_lineage(marts, build_dir):
    manifest = json.loads((build_dir / "target" / "manifest.json").read_text())
    assert manifest["nodes"]["model.ousd_monitor.stg_labels"]["depends_on"]["nodes"] == [
        "source.ousd_monitor.labels.labels"
    ]


def test_null_block_hash_passes_all_tests(marts):
    (nulls,) = marts.execute(
        "select count(*) from stg_transfers where block_hash is null"
    ).fetchone()
    assert nulls == 5  # a successful build ran every test, including on these rows


def test_solana_rows_keep_case_and_have_no_hash(marts):
    row = marts.execute(
        "select from_address, to_address, block_hash, value from stg_transfers "
        "where chain = 'solana' and block_number = 50"
    ).fetchone()
    assert row == (SOLANA_FROM, SOLANA_TO, None, 42)
    assert row[0] != row[0].lower()


def test_build_leaves_raw_file_byte_identical(tmp_path):
    raw = tmp_path / "ousd.duckdb"
    write_raw(raw, ROWS, {"tempo": 3, "ethereum": 10, "solana": 50})
    before = hashlib.sha256(raw.read_bytes()).hexdigest()
    assert invoke_dbt(tmp_path).success
    assert hashlib.sha256(raw.read_bytes()).hexdigest() == before


def test_unknown_chain_fails_build(tmp_path):
    result = run_dbt(
        tmp_path,
        [("mars", tr(1, 0, DAY, ALICE, BOB, 1))],
        labels=[],
        sync_state={"mars": 1},
    )
    assert not result.success
    assert any("accepted_values" in name for name in failed_tests(result))
