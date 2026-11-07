"""The raw store's schema, as numbered migrations applied in order and recorded in
schema_migrations.

Every schema change is a new migration at the end of MIGRATIONS. A migration that has shipped is
never edited, because a database that already applied it would never see the edit.
"""

import contextlib
from dataclasses import dataclass

import duckdb


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    statements: tuple[str, ...]


class SchemaOutOfDate(RuntimeError):
    """A reader found migrations it may not apply, or a schema newer than this code."""


VERSION_TABLE = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name VARCHAR NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
"""

# The schema as it stood before schema_migrations existed. Every statement is safe on a database
# made by any earlier version, so a database with no version table is brought to this state in
# place, and adds nothing it already has.
_BASELINE = Migration(
    0,
    "baseline",
    (
        """
        CREATE TABLE IF NOT EXISTS transfers (
            chain VARCHAR NOT NULL,
            block_number BIGINT NOT NULL,
            log_index INTEGER NOT NULL,
            block_hash VARCHAR,
            block_timestamp BIGINT NOT NULL,
            tx_hash VARCHAR NOT NULL,
            from_address VARCHAR NOT NULL,
            to_address VARCHAR NOT NULL,
            value HUGEINT NOT NULL,
            PRIMARY KEY (chain, block_number, log_index)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS blocks (
            chain VARCHAR NOT NULL,
            block_number BIGINT NOT NULL,
            block_hash VARCHAR NOT NULL,
            PRIMARY KEY (chain, block_number)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS sync_state (
            chain VARCHAR PRIMARY KEY,
            synced_through BIGINT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS reconciliations (
            checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            chain VARCHAR NOT NULL,
            block_number BIGINT NOT NULL,
            minted HUGEINT NOT NULL,
            burned HUGEINT NOT NULL,
            onchain_supply HUGEINT NOT NULL,
            matched BOOLEAN NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS bridge_comparisons (
            checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            chains_included VARCHAR NOT NULL,
            chains_missing VARCHAR NOT NULL,
            chains_total HUGEINT NOT NULL,
            bridge_total HUGEINT NOT NULL,
            tolerance HUGEINT NOT NULL,
            passed BOOLEAN NOT NULL
        )
        """,
        # A bridge_comparisons table made with its first seven columns gains its run.
        "ALTER TABLE bridge_comparisons ADD COLUMN IF NOT EXISTS run_id VARCHAR",
        """
        CREATE TABLE IF NOT EXISTS reconciliation_runs (
            run_id VARCHAR PRIMARY KEY,
            started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            finished_at TIMESTAMPTZ,  -- Null means unfinished, and is the only marker of that.
            scope VARCHAR NOT NULL,
            status VARCHAR,
            exit_code INTEGER
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS reconciliation_checks (
            run_id VARCHAR NOT NULL,
            check_name VARCHAR NOT NULL,
            subject VARCHAR NOT NULL,
            attempt INTEGER NOT NULL,
            status VARCHAR NOT NULL,
            reason VARCHAR,
            pin_height BIGINT,
            pin_hash VARCHAR,
            transfer_count BIGINT,
            reference_value HUGEINT,
            observed_value HUGEINT,
            detail VARCHAR NOT NULL,
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (run_id, check_name, subject, attempt)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS balance_samples (
            run_id VARCHAR NOT NULL,
            chain VARCHAR NOT NULL,
            attempt INTEGER NOT NULL,
            address VARCHAR NOT NULL,
            stratum VARCHAR NOT NULL,
            seed VARCHAR NOT NULL,
            height BIGINT NOT NULL,
            model_balance HUGEINT NOT NULL,
            observed_balance HUGEINT NOT NULL,
            PRIMARY KEY (run_id, chain, attempt, address)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS transfer_group_audits (
            chain VARCHAR NOT NULL,
            tx_hash VARCHAR NOT NULL,
            block_number BIGINT NOT NULL,
            status VARCHAR NOT NULL,
            proof_source VARCHAR NOT NULL,
            stored_positions INTEGER[] NOT NULL,
            proven_positions INTEGER[] NOT NULL,
            run_id VARCHAR,
            audited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (chain, tx_hash)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS check_results (
            run_id VARCHAR NOT NULL,
            check_name VARCHAR NOT NULL,
            status VARCHAR NOT NULL,  -- passed, failed, skipped
            blocking BOOLEAN NOT NULL,
            detail VARCHAR NOT NULL,
            checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            data_fingerprint VARCHAR,  -- What the checks saw, so publish can refuse moved data.
            PRIMARY KEY (run_id, check_name)
        )
        """,
    ),
)

# Additive changes only where a table is large: DuckDB adds a column without rewriting rows, and
# transfers holds millions of them.
MIGRATIONS: tuple[Migration, ...] = (
    _BASELINE,
    # Older rows keep NULL, and publish falls back to matching their figures to a supply check.
    Migration(
        1,
        "reconciliations_run_id",
        ("ALTER TABLE reconciliations ADD COLUMN IF NOT EXISTS run_id VARCHAR",),
    ),
)

LATEST = MIGRATIONS[-1].version


def applied(db: duckdb.DuckDBPyConnection) -> dict[int, str]:
    """Each version recorded as applied, with its recorded name. A database without the table has
    applied none."""
    exists = db.execute(
        "SELECT count(*) FROM duckdb_tables() "
        "WHERE database_name = current_database() AND schema_name = 'main' "
        "AND table_name = 'schema_migrations'"
    ).fetchone()
    if not exists or exists[0] == 0:
        return {}
    return dict(db.execute("SELECT version, name FROM schema_migrations").fetchall())


def pending(db: duckdb.DuckDBPyConnection) -> list[Migration]:
    """Migrations this database still needs, in order. Refuses a schema newer than this code, and
    a recorded version whose name isn't this code's, as that database took a different path."""
    recorded = applied(db)
    if recorded and max(recorded) > LATEST:
        raise SchemaOutOfDate(
            f"the raw database is at schema version {max(recorded)}, newer than this code's "
            f"{LATEST}; update the code before opening it"
        )
    names = {migration.version: migration.name for migration in MIGRATIONS}
    if differ := sorted(v for v, name in recorded.items() if names.get(v) != name):
        versions = ", ".join(f"{v} as {recorded[v]!r}, not {names.get(v)!r}" for v in differ)
        raise SchemaOutOfDate(
            f"the raw database recorded schema migrations {versions}; its schema isn't the one "
            "this code's migrations make, so it isn't opened"
        )
    return [migration for migration in MIGRATIONS if migration.version not in recorded]


def migrate(db: duckdb.DuckDBPyConnection) -> list[Migration]:
    """Apply every pending migration in one transaction, and return them. None pending writes
    nothing. What's pending is read inside the transaction, so it is what gets applied."""
    db.begin()
    try:
        todo = pending(db)
        if todo:
            db.execute(VERSION_TABLE)
        for migration in todo:
            for statement in migration.statements:
                db.execute(statement)
            db.execute(
                "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
                [migration.version, migration.name],
            )
        db.commit()
    except BaseException:
        # Ctrl-C included: a half-applied schema must not commit, nor hold the connection. A
        # rollback that fails must not replace the error that got us here.
        with contextlib.suppress(duckdb.Error):
            db.rollback()
        raise
    return todo


def refuse_pending(db: duckdb.DuckDBPyConnection) -> None:
    """For a reader, which may not change the schema."""
    if todo := pending(db):
        versions = ", ".join(f"{m.version} ({m.name})" for m in todo)
        raise SchemaOutOfDate(
            f"the raw database needs schema migrations {versions}; "
            "run `ousd migrate`, or any writer such as `ousd sync`, first"
        )
