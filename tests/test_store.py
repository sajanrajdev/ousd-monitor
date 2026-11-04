import duckdb
import pytest
from conftest import ALICE, BOB, make_chain, rows
from ousd.cli import format_units
from ousd.decode import ZERO_ADDRESS, Transfer
from ousd.store import BalanceSample, ChainPin, Store, StoreConflict


def transfer(block: int, index: int = 0, value: int = 1) -> Transfer:
    return Transfer(block, "0x1", 1, "0x2", index, ALICE, ALICE, value)


def test_data_survives_reopening_the_database(tmp_path):
    path = tmp_path / "nested" / "test.duckdb"
    first = Store(path)
    first.write_range("testnet", [transfer(5)], {5: "0xabc"}, 5)
    first.close()

    second = Store(path)

    assert second.synced_through("testnet") == 5
    assert second.block_hashes("testnet") == {5: "0xabc"}
    assert len(rows(second)) == 1
    second.close()


def test_failed_write_leaves_nothing_behind(store):
    bad = transfer(5, value=2**200)  # Too big for HUGEINT, so the insert fails.

    with pytest.raises(duckdb.Error):
        store.write_range("testnet", [transfer(4), bad], {4: "0xabc"}, 5)

    assert rows(store) == []
    assert store.block_hashes("testnet") == {}
    assert store.synced_through("testnet") is None


def test_chains_are_kept_apart(store):
    store.write_range("one", [transfer(1)], {1: "0xa"}, 1)
    store.write_range("two", [transfer(1)], {1: "0xb"}, 1)

    store.rollback_to("one", 0)

    assert rows(store, "one") == []
    assert len(rows(store, "two")) == 1
    assert store.synced_through("two") == 1


def test_format_units_uses_exact_integer_arithmetic():
    assert format_units(872_221_164_606_640) == "872,221,164.606640"
    assert format_units(-1) == "-0.000001"
    assert format_units(0) == "0.000000"


def test_chain_repr_hides_provider_urls():
    chain = make_chain(rpc_url="https://rpc.invalid/KEY", blockscout_url="https://bs.invalid/KEY")

    assert "KEY" not in repr(chain)


def test_same_position_with_different_content_is_refused_and_writes_nothing(store):
    store.write_range("testnet", [transfer(5, value=1)], {}, 5)

    with pytest.raises(StoreConflict, match=r"block 5, log 0"):
        store.write_range("testnet", [transfer(4), transfer(5, value=2)], {4: "0xabc"}, 9)

    assert [(row[0], row[5]) for row in rows(store)] == [(5, 1)]
    assert store.block_hashes("testnet") == {}
    assert store.synced_through("testnet") == 5


def test_same_row_again_changes_nothing(store):
    store.write_range("testnet", [transfer(5)], {}, 5)
    before = rows(store)

    store.write_range("testnet", [transfer(5)], {}, 5)

    assert rows(store) == before


def test_history_and_rpc_copies_of_a_row_may_differ_only_by_the_missing_hash(store):
    without_hash = Transfer(5, None, 1, "0x2", 0, ALICE, ALICE, 1)
    store.write_range("testnet", [without_hash], {}, 5)

    store.write_range("testnet", [transfer(5)], {}, 5)

    assert rows(store)[0][2] is None
    with pytest.raises(StoreConflict):
        store.write_range("testnet", [Transfer(5, None, 1, "0x9", 0, ALICE, ALICE, 1)], {}, 5)


def test_different_block_hashes_at_one_position_are_a_conflict(store):
    store.write_range("testnet", [transfer(5)], {}, 5)

    with pytest.raises(StoreConflict):
        store.write_range("testnet", [Transfer(5, "0xother", 1, "0x2", 0, ALICE, ALICE, 1)], {}, 5)


def test_amounts_above_64_bits_stay_exact_through_the_sums(store):
    big = 2**100 + 1
    mint = Transfer(5, "0x1", 1, "0x2", 0, ZERO_ADDRESS, ALICE, big)
    burn = Transfer(5, "0x1", 1, "0x3", 1, ALICE, ZERO_ADDRESS, big - 1)

    store.write_range("testnet", [mint, burn], {}, 5)

    assert rows(store)[0][5] == big
    assert store.minted_and_burned("testnet", 5) == (big, big - 1)


def ledger(store, *specs, chain="testnet"):
    """Write (block, index, sender, receiver, value[, tx_hash[, block_hash]]) rows."""
    transfers = []
    for spec in specs:
        block, index, sender, receiver, value, *rest = spec
        tx = rest[0] if rest else f"0x{block:064x}"
        block_hash = rest[1] if len(rest) > 1 else f"0xh{block}"
        transfers.append(
            Transfer(block, block_hash, 1_000 + block, tx, index, sender, receiver, value)
        )
    store.write_range(chain, transfers, {}, max(t.block_number for t in transfers))


SOL = "So1anaWalletMixedCASEabcXYZ123456789abcdefg"
SOL_LOWER = SOL.lower()


# The schema as it stood before the reconciliation tables, with a seven column bridge table.
OLD_SCHEMA = """
CREATE TABLE transfers (
    chain VARCHAR NOT NULL, block_number BIGINT NOT NULL, log_index INTEGER NOT NULL,
    block_hash VARCHAR, block_timestamp BIGINT NOT NULL, tx_hash VARCHAR NOT NULL,
    from_address VARCHAR NOT NULL, to_address VARCHAR NOT NULL, value HUGEINT NOT NULL,
    PRIMARY KEY (chain, block_number, log_index)
);
CREATE TABLE blocks (
    chain VARCHAR NOT NULL, block_number BIGINT NOT NULL, block_hash VARCHAR NOT NULL,
    PRIMARY KEY (chain, block_number)
);
CREATE TABLE sync_state (chain VARCHAR PRIMARY KEY, synced_through BIGINT NOT NULL);
CREATE TABLE reconciliations (
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(), chain VARCHAR NOT NULL,
    block_number BIGINT NOT NULL, minted HUGEINT NOT NULL, burned HUGEINT NOT NULL,
    onchain_supply HUGEINT NOT NULL, matched BOOLEAN NOT NULL
);
CREATE TABLE bridge_comparisons (
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(), chains_included VARCHAR NOT NULL,
    chains_missing VARCHAR NOT NULL, chains_total HUGEINT NOT NULL,
    bridge_total HUGEINT NOT NULL, tolerance HUGEINT NOT NULL, passed BOOLEAN NOT NULL
);
INSERT INTO transfers VALUES
    ('old', 7, 0, NULL, 1007, '0xaa', '0xfrom', '0xto', 1152921504606846977),
    ('old', 8, 1, '0xb8', 1008, '0xbb', '0xfrom', '0xto', 5);
INSERT INTO blocks VALUES ('old', 8, '0xb8');
INSERT INTO sync_state VALUES ('old', 8);
INSERT INTO reconciliations VALUES
    ('2026-01-01 00:00:00+00', 'old', 8, 1152921504606846982, 0, 1152921504606846982, true);
INSERT INTO bridge_comparisons VALUES
    ('2026-01-01 00:00:00+00', 'old', '', 1152921504606846977, 1152921504606846977, 0, true);
"""
OLD_TABLES = ("transfers", "blocks", "sync_state", "reconciliations", "bridge_comparisons")
NEW_TABLES = (
    "reconciliation_runs",
    "reconciliation_checks",
    "balance_samples",
    "transfer_group_audits",
)


def _dump(db, table, exclude=None):
    """Every row as text, which also avoids the timezone package TIMESTAMPTZ values need."""
    columns = [
        c
        for (c,) in db.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = ?"
            " ORDER BY ordinal_position",
            [table],
        ).fetchall()
        if c != exclude
    ]
    selected = ", ".join(f"{c}::VARCHAR" for c in columns)
    return db.execute(f"SELECT {selected} FROM {table} ORDER BY ALL").fetchall()


def test_an_older_database_keeps_its_rows_and_gains_the_new_tables(tmp_path):
    path = tmp_path / "old.duckdb"
    old = duckdb.connect(str(path))
    old.execute(OLD_SCHEMA)
    before = {t: _dump(old, t) for t in OLD_TABLES}
    old.close()

    for _ in range(2):
        store = Store(path)
        for table in OLD_TABLES:
            assert _dump(store.db, table, exclude="run_id") == before[table]
        tables = {r[0] for r in store.db.execute("SHOW TABLES").fetchall()}
        assert set(NEW_TABLES) <= tables
        assert store.db.execute("SELECT run_id FROM bridge_comparisons").fetchall() == [(None,)]
        assert store.db.execute("SELECT max(value) FROM transfers").fetchone() == (2**60 + 1,)
        store.close()

    store = Store(path)
    store.record_bridge_comparison("r1", ["old"], 1, 1, True)
    runs = store.db.execute("SELECT run_id FROM bridge_comparisons ORDER BY run_id NULLS FIRST")
    assert runs.fetchall() == [(None,), ("r1",)]
    store.close()


def test_a_fresh_database_has_the_bridge_table_with_a_run_id(store):
    store.record_bridge_comparison("r1", ["a", "b"], 2**70, 2**70 + 1, False)

    row = store.db.execute(
        "SELECT chains_included, chains_missing, chains_total, bridge_total, tolerance, passed,"
        " run_id FROM bridge_comparisons"
    ).fetchone()

    assert row == ("a,b", "", 2**70, 2**70 + 1, 0, False, "r1")


def test_bridge_comparisons_read_in_the_shape_the_mart_uses(store):
    store.record_bridge_comparison("r1", ["a"], 10, 12, False)

    row = store.db.execute(
        "SELECT chains_total, bridge_total, chains_total - bridge_total, passed,"
        " checked_at::VARCHAR FROM bridge_comparisons ORDER BY checked_at DESC"
    ).fetchone()

    assert row[:4] == (10, 12, -2, False)


def test_balances_are_received_minus_sent(store):
    ledger(
        store,
        (1, 0, ZERO_ADDRESS, ALICE, 2**60 + 1),
        (2, 0, ALICE, BOB, 5),
        (3, 0, BOB, BOB, 9),
        (4, 0, ZERO_ADDRESS, BOB, 1000),
    )

    assert store.balances_at("testnet", [ALICE, BOB, "0x" + "d" * 40], 3) == {
        ALICE: 2**60 + 1 - 5,
        BOB: 5,
        "0x" + "d" * 40: 0,
    }
    assert store.balances_at("testnet", [BOB], 4) == {BOB: 1005}
    assert store.balances_at("testnet", [], 4) == {}


def test_wallets_never_include_the_zero_address_and_keep_base58_case(store):
    ledger(store, (1, 0, ZERO_ADDRESS, SOL, 10), (2, 0, SOL, SOL_LOWER, 3))

    assert store.wallets("testnet", 2) == sorted([SOL, SOL_LOWER])
    assert store.wallets("testnet", 1) == [SOL]
    assert store.balances_at("testnet", [SOL, SOL_LOWER], 2) == {SOL: 7, SOL_LOWER: 3}


def test_top_wallets_order_ties_by_address(store):
    ledger(
        store,
        (1, 0, ZERO_ADDRESS, BOB, 10),
        (2, 0, ZERO_ADDRESS, ALICE, 10),
        (3, 0, ZERO_ADDRESS, "0x" + "c" * 40, 50),
    )

    assert store.top_wallets("testnet", 3, 2) == [("0x" + "c" * 40, 50), (ALICE, 10)]
    assert store.top_wallets("testnet", 3, 5)[2:] == [(BOB, 10)]
    assert store.top_wallets("testnet", 3, 0) == []


def test_supply_values_with_nothing_in_range_gives_the_prior_supply(store):
    ledger(store, (1, 0, ZERO_ADDRESS, ALICE, 100))

    assert store.supply_values("testnet", 1_500, 1_600, 1) == [(1_500, 100)]
    assert store.supply_values("testnet", 0, 10, 1) == [(0, 0)]


def test_supply_values_follow_each_block_with_a_mint_or_burn(store):
    ledger(
        store,
        (1, 0, ZERO_ADDRESS, ALICE, 100),
        (2, 0, ZERO_ADDRESS, ALICE, 2**61),
        (3, 0, ALICE, BOB, 7),  # Not a mint or a burn: no value of its own.
        (4, 0, ALICE, ZERO_ADDRESS, 30),
    )

    assert store.supply_values("testnet", 1_002, 1_004, 4) == [
        (1_002, 100),
        (1_002, 100 + 2**61),
        (1_004, 100 + 2**61 - 30),
    ]


def test_supply_values_for_two_blocks_in_one_second_give_two_values(store):
    store.write_range(
        "testnet",
        [
            Transfer(1, "0xa", 5_000, "0x1", 0, ZERO_ADDRESS, ALICE, 10),
            Transfer(2, "0xb", 5_000, "0x2", 0, ZERO_ADDRESS, ALICE, 20),
        ],
        {},
        2,
    )

    assert store.supply_values("testnet", 5_000, 5_000, 2) == [(5_000, 0), (5_000, 10), (5_000, 30)]


def test_supply_values_net_a_mint_and_burn_in_one_block(store):
    ledger(
        store,
        (1, 0, ZERO_ADDRESS, ALICE, 100, "0x1"),
        (1, 1, ALICE, ZERO_ADDRESS, 40, "0x2"),
    )

    assert store.supply_values("testnet", 1_001, 1_001, 1) == [(1_001, 0), (1_001, 60)]


def test_supply_values_include_both_edges_and_stop_at_the_block(store):
    ledger(
        store,
        (1, 0, ZERO_ADDRESS, ALICE, 1),
        (2, 0, ZERO_ADDRESS, ALICE, 2),
        (3, 0, ZERO_ADDRESS, ALICE, 4),
        (4, 0, ZERO_ADDRESS, ALICE, 8),
    )

    assert store.supply_values("testnet", 1_002, 1_003, 4) == [(1_002, 1), (1_002, 3), (1_003, 7)]
    assert store.supply_values("testnet", 1_002, 1_004, 3) == [(1_002, 1), (1_002, 3), (1_003, 7)]
    assert store.supply_at_time("testnet", 1_003) == 7
    assert store.supply_at_time("testnet", 1_002) == 3
    assert store.supply_at_time("testnet", 999) == 0


def test_same_looking_groups(store):
    ledger(
        store,
        (1, 0, ALICE, BOB, 5, "0xt1"),
        (1, 3, ALICE, BOB, 5, "0xt1"),
        (2, 0, ALICE, BOB, 5, "0xt2"),  # A lone row.
        (3, 0, ALICE, BOB, 5, "0xt3"),
        (3, 1, ALICE, ALICE, 5, "0xt3"),  # Same value, another receiver.
    )

    groups = store.same_looking_groups("testnet", 3)

    assert len(groups) == 1
    group = groups[0]
    assert (group.tx_hash, group.block_number, group.sender, group.receiver, group.value) == (
        "0xt1",
        1,
        ALICE,
        BOB,
        5,
    )
    assert group.positions == [0, 3]
    assert store.same_looking_groups("testnet", 0) == []


def test_same_looking_groups_count_null_block_hashes(store):
    store.write_range(
        "testnet",
        [
            Transfer(1, None, 1, "0xt", 0, ALICE, BOB, 5),
            Transfer(1, "0xh", 1, "0xt", 1, ALICE, BOB, 5),
            Transfer(1, None, 1, "0xt", 2, ALICE, BOB, 5),
        ],
        {},
        1,
    )

    assert store.same_looking_groups("testnet", 1)[0].null_hash_count == 2


def test_a_real_audit_skips_a_transaction_until_it_changes(store):
    ledger(store, (1, 0, ALICE, BOB, 5, "0xt"), (1, 1, ALICE, BOB, 5, "0xt"))

    store.record_group_audit("testnet", "0xt", 1, "not_real", "receipt", [0, 1], [0])
    assert len(store.same_looking_groups("testnet", 1)) == 1

    store.record_group_audit("testnet", "0xt", 1, "real", "receipt", [0, 1], [0, 1])
    assert store.same_looking_groups("testnet", 1) == []

    ledger(store, (1, 2, ALICE, BOB, 5, "0xt"))
    assert [g.positions for g in store.same_looking_groups("testnet", 1)] == [[0, 1, 2]]


def test_transaction_rows_returns_every_row_of_the_transaction(store):
    ledger(
        store,
        (1, 1, BOB, ALICE, 6, "0xt"),
        (1, 0, ALICE, BOB, 5, "0xt"),
        (1, 2, ALICE, BOB, 7, "0xother"),
    )

    found = store.transaction_rows("testnet", "0xt")

    assert [(t.log_index, t.value) for t in found] == [(0, 5), (1, 6)]
    assert found[0] == Transfer(1, "0xh1", 1_001, "0xt", 0, ALICE, BOB, 5)
    assert store.transaction_rows("other", "0xt") == []


def test_wallets_touched_covers_only_rows_in_the_range(store):
    carol = "0x" + "c" * 40
    ledger(
        store,
        (1, 0, ZERO_ADDRESS, ALICE, 5),
        (2, 0, ALICE, BOB, 1),
        (3, 0, ZERO_ADDRESS, carol, 1),
        (4, 0, ZERO_ADDRESS, "0x" + "d" * 40, 1),
    )

    assert store.wallets_touched("testnet", 1, 3) == sorted([ALICE, BOB, carol])
    assert store.wallets_touched("testnet", 3, 3) == []
    assert store.wallets_touched("testnet", 2, 3) == [carol]


def test_only_a_passing_census_counts(store):
    run = store.start_run("full")
    store.record_check(run, "balance_census", "ethereum", 1, "unchecked", "census_partial")
    store.record_check(run, "balance_census", "tempo", 1, "fail", "balance_mismatch")
    store.record_check(run, "sampled_balances", "ethereum", 1, "pass")

    assert not store.census_complete("ethereum")
    assert not store.census_complete("tempo")

    store.record_check(run, "balance_census", "ethereum", 2, "pass")

    assert store.census_complete("ethereum")
    assert not store.census_complete("tempo")


def test_rollback_removes_audits_above_the_fork_only(store):
    ledger(store, (1, 0, ALICE, BOB, 5, "0xlow"), (9, 0, ALICE, BOB, 5, "0xhigh"))
    store.record_group_audit("testnet", "0xlow", 1, "real", "receipt", [0, 1], [0, 1])
    store.record_group_audit("testnet", "0xhigh", 9, "real", "receipt", [0, 1], [0, 1])
    store.record_group_audit("other", "0xhigh", 9, "real", "receipt", [0, 1], [0, 1])

    store.rollback_to("testnet", 5)

    kept = store.db.execute("SELECT chain, tx_hash FROM transfer_group_audits ORDER BY ALL")
    assert kept.fetchall() == [("other", "0xhigh"), ("testnet", "0xlow")]


def test_a_check_and_its_samples_are_recorded_together(store):
    run = store.start_run("full")
    samples = [
        BalanceSample(ALICE, "top", "v1|testnet|2026-11-03", 7, 2**70, 2**70 + 1),
        BalanceSample(BOB, "random", "v1|testnet|2026-11-03", 7, 0, 0),
    ]

    store.record_check(
        run,
        "sampled_balances",
        "testnet",
        1,
        "fail",
        "balance_mismatch",
        pin_height=7,
        observed_value=2**70 + 1,
        detail={"wallets": 2},
        samples=samples,
    )

    assert store.db.execute(
        "SELECT status, reason, pin_height, observed_value, detail FROM reconciliation_checks"
    ).fetchall() == [("fail", "balance_mismatch", 7, 2**70 + 1, '{"wallets": 2}')]
    assert store.db.execute(
        "SELECT address, stratum, height, model_balance, observed_balance FROM balance_samples"
        " ORDER BY address"
    ).fetchall() == [(ALICE, "top", 7, 2**70, 2**70 + 1), (BOB, "random", 7, 0, 0)]


def test_a_failed_check_write_leaves_no_samples(store):
    run = store.start_run("full")
    sample = BalanceSample(ALICE, "top", "seed", 7, 2**200, 0)  # Too big for HUGEINT.

    with pytest.raises(duckdb.Error):
        store.record_check(run, "sampled_balances", "testnet", 1, "pass", samples=[sample])

    assert store.db.execute("SELECT count(*) FROM reconciliation_checks").fetchone() == (0,)
    assert store.db.execute("SELECT count(*) FROM balance_samples").fetchone() == (0,)
    with pytest.raises(ValueError):
        store.record_check(run, "nonsense", "testnet", 1, "pass")


def test_a_run_cannot_be_finished_twice(store):
    run = store.start_run("full")
    store.finish_run(run, "pass", 0)

    with pytest.raises(KeyError):
        store.finish_run(run, "fail", 1)
    with pytest.raises(KeyError):
        store.finish_run("missing", "fail", 1)


def finished_run(store, status="pass", scope="full", chain="testnet", pin_hash="0xh5"):
    ledger(store, (5, 0, ZERO_ADDRESS, ALICE, 10, "0xt", pin_hash))
    store.write_range(chain, [], {5: pin_hash} if pin_hash else {}, 5)
    run = store.start_run(scope)
    store.record_check(
        run, "chain_supply", chain, 1, "fail", "supply_mismatch",
        pin_height=4, pin_hash="0xold", transfer_count=99,
    )  # fmt: skip
    store.record_check(
        run, "chain_supply", chain, 2, "pass",
        pin_height=5, pin_hash=pin_hash, transfer_count=1,
    )  # fmt: skip
    store.finish_run(run, status, 0 if status == "pass" else 1)
    return run


def test_latest_reconciliation_is_none_when_nothing_finished(store):
    assert store.latest_reconciliation() is None

    store.start_run("full")

    assert store.latest_reconciliation() is None


def test_latest_reconciliation_ignores_an_unfinished_run(store):
    finished = finished_run(store)
    store.start_run("full")

    latest = store.latest_reconciliation()

    assert latest is not None
    assert latest.run_id == finished
    assert latest.usable
    assert latest.chains["testnet"] == ChainPin(5, "0xh5", 1, True)  # The highest attempt.


def test_latest_reconciliation_returns_the_newest_finished_run(store):
    finished_run(store, status="pass")
    newer = store.start_run("full")
    store.finish_run(newer, "unchecked", 3)

    latest = store.latest_reconciliation()

    assert latest is not None
    assert (latest.run_id, latest.status, latest.exit_code, latest.usable) == (
        newer,
        "unchecked",
        3,
        False,
    )


@pytest.mark.parametrize(
    ("status", "scope"), [("fail", "full"), ("unchecked", "full"), ("pass", "partial")]
)
def test_only_a_full_pass_is_usable(store, status, scope):
    finished_run(store, status=status, scope=scope)

    latest = store.latest_reconciliation()

    assert latest is not None
    assert not latest.usable


def test_a_pass_with_no_chain_pins_is_not_usable(store):
    store.finish_run(store.start_run("full"), "pass", 0)

    latest = store.latest_reconciliation()

    assert latest is not None
    assert not latest.usable


@pytest.mark.parametrize("change", ["cursor", "hash", "count", "pruned"])
def test_a_pass_stops_being_usable_when_the_data_changes(store, change):
    finished_run(store)
    assert store.latest_reconciliation().usable

    if change == "cursor":
        store.write_range("testnet", [], {}, 6)
    elif change == "hash":
        store.write_range("testnet", [], {5: "0xother"}, 5)
    elif change == "count":
        ledger(store, (4, 0, ALICE, BOB, 1, "0xnew"))
        store.write_range("testnet", [], {}, 5)
    else:
        store.prune_blocks("testnet", 6)

    latest = store.latest_reconciliation()
    assert not latest.usable
    assert not latest.chains["testnet"].current


def test_a_chain_without_a_hash_is_pinned_by_cursor_and_count(store):
    finished_run(store, pin_hash=None)
    store.db.execute("DELETE FROM blocks")

    assert store.latest_reconciliation().usable
