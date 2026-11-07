import re
import subprocess
import sys

import duckdb
import pytest
from ousd import cli, migrations
from ousd.migrations import LATEST, MIGRATIONS, Migration, SchemaOutOfDate
from ousd.store import Store

# The schema as the store made it just before schema_migrations existed, with a row in every
# table. Written out here, not taken from migrations.py, so the baseline is tested against it.
PRE_MIGRATIONS_SCHEMA = """
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
ALTER TABLE bridge_comparisons ADD COLUMN run_id VARCHAR;
CREATE TABLE reconciliation_runs (
    run_id VARCHAR PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ, scope VARCHAR NOT NULL, status VARCHAR, exit_code INTEGER
);
CREATE TABLE reconciliation_checks (
    run_id VARCHAR NOT NULL, check_name VARCHAR NOT NULL, subject VARCHAR NOT NULL,
    attempt INTEGER NOT NULL, status VARCHAR NOT NULL, reason VARCHAR, pin_height BIGINT,
    pin_hash VARCHAR, transfer_count BIGINT, reference_value HUGEINT, observed_value HUGEINT,
    detail VARCHAR NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, check_name, subject, attempt)
);
CREATE TABLE balance_samples (
    run_id VARCHAR NOT NULL, chain VARCHAR NOT NULL, attempt INTEGER NOT NULL,
    address VARCHAR NOT NULL, stratum VARCHAR NOT NULL, seed VARCHAR NOT NULL,
    height BIGINT NOT NULL, model_balance HUGEINT NOT NULL, observed_balance HUGEINT NOT NULL,
    PRIMARY KEY (run_id, chain, attempt, address)
);
CREATE TABLE transfer_group_audits (
    chain VARCHAR NOT NULL, tx_hash VARCHAR NOT NULL, block_number BIGINT NOT NULL,
    status VARCHAR NOT NULL, proof_source VARCHAR NOT NULL, stored_positions INTEGER[] NOT NULL,
    proven_positions INTEGER[] NOT NULL, run_id VARCHAR,
    audited_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (chain, tx_hash)
);
CREATE TABLE check_results (
    run_id VARCHAR NOT NULL, check_name VARCHAR NOT NULL, status VARCHAR NOT NULL,
    blocking BOOLEAN NOT NULL, detail VARCHAR NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(), data_fingerprint VARCHAR,
    PRIMARY KEY (run_id, check_name)
);
INSERT INTO transfers VALUES
    ('old', 7, 0, NULL, 1007, '0xaa', '0xfrom', '0xto', 1152921504606846977),
    ('old', 8, 1, '0xb8', 1008, '0xbb', '0xfrom', '0xto', 5);
INSERT INTO blocks VALUES ('old', 8, '0xb8');
INSERT INTO sync_state VALUES ('old', 8);
INSERT INTO reconciliations VALUES
    ('2026-10-01 00:00:00+00', 'old', 8, 1152921504606846982, 0, 1152921504606846982, true);
INSERT INTO bridge_comparisons VALUES
    ('2026-10-01 00:00:00+00', 'old', '', 5, 5, 0, true, 'r0');
INSERT INTO reconciliation_runs VALUES
    ('r0', '2026-10-01 00:00:00+00', '2026-10-01 00:05:00+00', 'full', 'pass', 0);
INSERT INTO reconciliation_checks VALUES
    ('r0', 'chain_supply', 'old', 1, 'pass', NULL, 8, '0xb8', 2, 5, 5, '{}',
     '2026-10-01 00:01:00+00');
INSERT INTO balance_samples VALUES ('r0', 'old', 1, '0xto', 'top', 's', 8, 5, 5);
INSERT INTO transfer_group_audits VALUES
    ('old', '0xbb', 8, 'real', 'receipt', [1], [1], 'r0', '2026-10-01 00:02:00+00');
INSERT INTO check_results VALUES
    ('c0', 'freshness', 'passed', true, 'ok', '2026-10-01 00:06:00+00', 'f0');
"""
TABLES = (
    "transfers",
    "blocks",
    "sync_state",
    "reconciliations",
    "bridge_comparisons",
    "reconciliation_runs",
    "reconciliation_checks",
    "balance_samples",
    "transfer_group_audits",
    "check_results",
)


def _dump(db, table):
    """Every row as text, in the columns the table had before any migration."""
    columns = [
        c
        for (c,) in db.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = ?"
            " ORDER BY ordinal_position",
            [table],
        ).fetchall()
        if (table, c) != ("reconciliations", "run_id")
    ]
    selected = ", ".join(f"{c}::VARCHAR" for c in columns)
    return db.execute(f"SELECT {selected} FROM {table} ORDER BY ALL").fetchall()


def _versions(db):
    return db.execute("SELECT version, name FROM schema_migrations ORDER BY version").fetchall()


def _applied_at(db):
    return db.execute("SELECT applied_at::VARCHAR FROM schema_migrations ORDER BY ALL").fetchall()


def _has_table(db, name):
    return name in {t for (t,) in db.execute("SHOW TABLES").fetchall()}


def _columns(db, table):
    return [r[0] for r in db.execute(f"DESCRIBE {table}").fetchall()]


@pytest.fixture
def pre_migrations(tmp_path):
    path = tmp_path / "pre.duckdb"
    db = duckdb.connect(str(path))
    db.execute(PRE_MIGRATIONS_SCHEMA)
    db.close()
    return path


@pytest.fixture
def current(tmp_path):
    path = tmp_path / "current.duckdb"
    Store(path).close()
    return path


def test_migrations_are_numbered_in_order_from_the_baseline():
    assert [m.version for m in MIGRATIONS] == list(range(len(MIGRATIONS)))
    assert MIGRATIONS[0].name == "baseline"
    assert len({m.name for m in MIGRATIONS}) == len(MIGRATIONS)
    assert MIGRATIONS[-1].version == LATEST


def test_no_migration_after_the_baseline_touches_transfers():
    # Millions of rows: a change to it must be designed, not slipped into a migration.
    for migration in MIGRATIONS[1:]:
        for statement in migration.statements:
            assert not re.search(r"\btransfers\b", statement, re.IGNORECASE), migration.name


def test_a_fresh_database_records_every_migration(tmp_path):
    store = Store(tmp_path / "fresh.duckdb")
    assert _versions(store.db) == [(m.version, m.name) for m in MIGRATIONS]
    assert store.db.execute(
        "SELECT count(*) FROM schema_migrations WHERE applied_at IS NULL"
    ).fetchone() == (0,)
    assert "run_id" in _columns(store.db, "reconciliations")
    store.close()


def test_an_in_memory_store_is_migrated_too():
    store = Store()
    assert _versions(store.db)[-1] == (LATEST, MIGRATIONS[-1].name)
    store.close()


def test_a_pre_migrations_database_is_migrated_in_place_without_losing_a_row(pre_migrations):
    db = duckdb.connect(str(pre_migrations))
    before = {table: _dump(db, table) for table in TABLES}
    db.close()

    store = Store(pre_migrations)

    assert _versions(store.db) == [(m.version, m.name) for m in MIGRATIONS]
    for table in TABLES:
        assert _dump(store.db, table) == before[table], table
    assert store.db.execute("SELECT run_id FROM reconciliations").fetchall() == [(None,)]
    assert store.db.execute("SELECT max(value) FROM transfers").fetchone() == (2**60 + 1,)
    store.close()


def test_running_the_migrations_twice_is_a_no_op(pre_migrations):
    Store(pre_migrations).close()
    db = duckdb.connect(str(pre_migrations))
    applied, rows = _applied_at(db), {table: _dump(db, table) for table in TABLES}

    assert migrations.migrate(db) == []

    assert _applied_at(db) == applied
    assert {table: _dump(db, table) for table in TABLES} == rows
    db.close()
    Store(pre_migrations).close()
    db = duckdb.connect(str(pre_migrations))
    assert _applied_at(db) == applied
    db.close()


def test_a_column_already_there_without_its_record_is_recorded(current):
    db = duckdb.connect(str(current))
    db.execute("DELETE FROM schema_migrations WHERE version = 1")
    db.close()

    store = Store(current)
    assert _versions(store.db) == [(m.version, m.name) for m in MIGRATIONS]
    store.close()


def test_a_failing_migration_applies_none_of_the_pending_ones(pre_migrations, monkeypatch):
    broken = Migration(LATEST + 1, "broken", ("ALTER TABLE no_such_table ADD COLUMN x INTEGER",))
    monkeypatch.setattr(migrations, "MIGRATIONS", (*MIGRATIONS, broken))
    monkeypatch.setattr(migrations, "LATEST", broken.version)

    with pytest.raises(duckdb.CatalogException):
        Store(pre_migrations)

    db = duckdb.connect(str(pre_migrations))
    assert not _has_table(db, "schema_migrations")
    assert "run_id" not in _columns(db, "reconciliations")
    db.close()


def test_a_later_failure_keeps_what_an_earlier_open_applied(current, monkeypatch):
    broken = Migration(LATEST + 1, "broken", ("ALTER TABLE no_such_table ADD COLUMN x INTEGER",))
    monkeypatch.setattr(migrations, "MIGRATIONS", (*MIGRATIONS, broken))
    monkeypatch.setattr(migrations, "LATEST", broken.version)

    with pytest.raises(duckdb.CatalogException):
        Store(current)

    monkeypatch.undo()
    store = Store(current, read_only=True)
    assert _versions(store.db) == [(m.version, m.name) for m in MIGRATIONS]
    store.close()


def test_a_schema_newer_than_the_code_is_refused_by_writer_and_reader(current):
    db = duckdb.connect(str(current))
    db.execute("INSERT INTO schema_migrations (version, name) VALUES (?, 'later')", [LATEST + 1])
    db.close()

    for read_only in (False, True):
        with pytest.raises(SchemaOutOfDate, match="newer than this code"):
            Store(current, read_only=read_only)


@pytest.mark.parametrize("version", [0, 1])
def test_a_migration_recorded_under_another_name_is_refused_by_writer_and_reader(current, version):
    db = duckdb.connect(str(current))
    db.execute("UPDATE schema_migrations SET name = 'elsewhere' WHERE version = ?", [version])
    db.close()

    for read_only in (False, True):
        with pytest.raises(SchemaOutOfDate, match=rf"{version} as 'elsewhere', not"):
            Store(current, read_only=read_only)
    db = duckdb.connect(str(current), read_only=True)
    assert len(_versions(db)) == len(MIGRATIONS)
    db.close()


def test_a_pending_migration_under_another_name_is_refused_before_anything_is_applied(
    current, monkeypatch
):
    # The database recorded 1 under another name and lacks 2: nothing of 2 may be applied.
    later = Migration(LATEST + 1, "later", ("CREATE TABLE later (x INTEGER)",))
    db = duckdb.connect(str(current))
    db.execute("UPDATE schema_migrations SET name = 'elsewhere' WHERE version = 1")
    db.close()
    monkeypatch.setattr(migrations, "MIGRATIONS", (*MIGRATIONS, later))
    monkeypatch.setattr(migrations, "LATEST", later.version)

    with pytest.raises(SchemaOutOfDate, match="elsewhere"):
        Store(current)
    db = duckdb.connect(str(current), read_only=True)
    assert not _has_table(db, "later")
    db.close()


def test_what_is_pending_is_read_inside_the_transaction_that_applies_it(
    pre_migrations, monkeypatch
):
    real, seen = migrations.pending, []

    def spy(db):
        # Outside a transaction, each statement is its own, with its own id.
        ids = [db.execute("SELECT txid_current()").fetchone() for _ in range(2)]
        seen.append(ids[0] == ids[1])
        return real(db)

    monkeypatch.setattr(migrations, "pending", spy)
    Store(pre_migrations).close()
    assert seen == [True]


# Read-only


def test_a_reader_refuses_pending_migrations_and_changes_nothing(pre_migrations):
    with pytest.raises(SchemaOutOfDate, match=r"ousd migrate.*first"):
        Store(pre_migrations, read_only=True)

    db = duckdb.connect(str(pre_migrations))
    assert not _has_table(db, "schema_migrations")
    assert "run_id" not in _columns(db, "reconciliations")
    db.close()


def test_a_reader_names_each_pending_migration(current):
    db = duckdb.connect(str(current))
    db.execute("DELETE FROM schema_migrations WHERE version = 1")
    db.close()

    with pytest.raises(SchemaOutOfDate, match=r"1 \(reconciliations_run_id\)"):
        Store(current, read_only=True)


def test_a_reader_reads_and_cannot_write(current):
    writer = Store(current)
    writer.write_range("old", [], {8: "0xb8"}, 8)
    writer.close()

    reader = Store(current, read_only=True)
    assert reader.synced_through("old") == 8
    with pytest.raises(duckdb.InvalidInputException, match="read-only"):
        reader.write_range("old", [], {9: "0xb9"}, 9)
    reader.close()


def test_a_reader_never_creates_a_file(tmp_path):
    path = tmp_path / "missing" / "raw.duckdb"
    with pytest.raises(duckdb.IOException):
        Store(path, read_only=True)
    assert not path.parent.exists()


def test_an_in_memory_reader_is_a_mistake():
    with pytest.raises(ValueError, match="read-only"):
        Store(read_only=True)


def _open_elsewhere(path, read_only):
    """Open the file from another process, where DuckDB's file lock applies."""
    code = "import duckdb, sys; duckdb.connect(sys.argv[1], read_only=sys.argv[2] == '1').close()"
    flag = "1" if read_only else "0"
    command = [sys.executable, "-c", code, str(path), flag]
    return subprocess.run(command, capture_output=True, check=False).returncode


def test_a_reader_shares_the_file_with_readers_never_with_a_writer(current):
    reader = Store(current, read_only=True)
    try:
        assert _open_elsewhere(current, read_only=True) == 0
        assert _open_elsewhere(current, read_only=False) != 0
    finally:
        reader.close()


# ousd migrate


def test_migrate_applies_what_is_pending_then_nothing(pre_migrations, monkeypatch, capsys):
    monkeypatch.setenv("OUSD_DB_PATH", str(pre_migrations))

    assert cli.main(["migrate"]) == 0
    first = capsys.readouterr().out
    assert cli.main(["migrate"]) == 0
    second = capsys.readouterr().out

    assert first.splitlines() == [
        *(f"applied: {m.version} {m.name}" for m in MIGRATIONS),
        "schema is up to date",
    ]
    assert second.splitlines() == ["schema is up to date"]
    Store(pre_migrations, read_only=True).close()


def test_migrate_never_creates_a_database(tmp_path, monkeypatch, capsys):
    path = tmp_path / "raw.duckdb"
    monkeypatch.setenv("OUSD_DB_PATH", str(path))
    assert cli.main(["migrate"]) == 1
    assert "does not exist" in capsys.readouterr().err
    assert not path.exists()


def test_migrate_refuses_a_schema_newer_than_the_code(current, monkeypatch, capsys):
    db = duckdb.connect(str(current))
    db.execute("INSERT INTO schema_migrations (version, name) VALUES (?, 'later')", [LATEST + 1])
    db.close()
    monkeypatch.setenv("OUSD_DB_PATH", str(current))
    # Not a verdict on the data, so exit 2, as from check and publish.
    assert cli.main(["migrate"]) == 2
    assert "newer than this code" in capsys.readouterr().err


def test_migrate_refuses_a_migration_recorded_under_another_name(current, monkeypatch, capsys):
    db = duckdb.connect(str(current))
    db.execute("UPDATE schema_migrations SET name = 'elsewhere' WHERE version = 1")
    db.close()
    monkeypatch.setenv("OUSD_DB_PATH", str(current))
    assert cli.main(["migrate"]) == 2
    assert "1 as 'elsewhere', not 'reconciliations_run_id'" in capsys.readouterr().err


def test_migrate_in_use_exits_two(current, monkeypatch, capsys):
    def held(*args, **kwargs):
        raise duckdb.IOException("Could not set lock on file")

    monkeypatch.setenv("OUSD_DB_PATH", str(current))
    monkeypatch.setattr(cli.duckdb, "connect", held)
    assert cli.main(["migrate"]) == 2
    assert "in use" in capsys.readouterr().err


def test_migrate_takes_no_chain(current, monkeypatch):
    monkeypatch.setenv("OUSD_DB_PATH", str(current))
    with pytest.raises(SystemExit):
        cli.main(["--chain", "tempo", "migrate"])
