"""DuckDB storage. Every write that spans tables is one transaction."""

from collections.abc import Iterable, Mapping
from pathlib import Path

import duckdb

from ousd.decode import ZERO_ADDRESS, Transfer

SCHEMA = """
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
);
CREATE TABLE IF NOT EXISTS blocks (
    chain VARCHAR NOT NULL,
    block_number BIGINT NOT NULL,
    block_hash VARCHAR NOT NULL,
    PRIMARY KEY (chain, block_number)
);
CREATE TABLE IF NOT EXISTS sync_state (
    chain VARCHAR PRIMARY KEY,
    synced_through BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS reconciliations (
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    chain VARCHAR NOT NULL,
    block_number BIGINT NOT NULL,
    minted HUGEINT NOT NULL,
    burned HUGEINT NOT NULL,
    onchain_supply HUGEINT NOT NULL,
    matched BOOLEAN NOT NULL
);
"""


class Store:
    def __init__(self, path: str | Path = ":memory:") -> None:
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = duckdb.connect(str(path))
        self.db.execute(SCHEMA)

    def close(self) -> None:
        self.db.close()

    def synced_through(self, chain: str) -> int | None:
        row = self.db.execute(
            "SELECT synced_through FROM sync_state WHERE chain = ?", [chain]
        ).fetchone()
        return row[0] if row else None

    def block_hashes(self, chain: str) -> dict[int, str]:
        rows = self.db.execute(
            "SELECT block_number, block_hash FROM blocks WHERE chain = ?", [chain]
        ).fetchall()
        return dict(rows)

    def write_range(
        self,
        chain: str,
        transfers: Iterable[Transfer],
        block_hashes: Mapping[int, str],
        synced_through: int,
    ) -> None:
        """Store one ingested range and advance the cursor, all or nothing."""
        rows = [
            (
                chain,
                t.block_number,
                t.log_index,
                t.block_hash,
                t.block_timestamp,
                t.tx_hash,
                t.from_address,
                t.to_address,
                # As text, because the driver would otherwise guess a type row by row.
                str(t.value),
            )
            for t in transfers
        ]
        self.db.begin()
        try:
            if rows:
                self.db.executemany(
                    """
                    INSERT INTO transfers
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS HUGEINT))
                    ON CONFLICT DO NOTHING
                    """,
                    rows,
                )
            if block_hashes:
                self.db.executemany(
                    "INSERT OR REPLACE INTO blocks VALUES (?, ?, ?)",
                    [(chain, number, value) for number, value in block_hashes.items()],
                )
            self.db.execute(
                "INSERT OR REPLACE INTO sync_state VALUES (?, ?)", [chain, synced_through]
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def rollback_to(self, chain: str, block_number: int) -> None:
        """Forget everything above block_number, so that range is ingested again."""
        self.db.begin()
        try:
            for table in ("transfers", "blocks"):
                self.db.execute(
                    f"DELETE FROM {table} WHERE chain = ? AND block_number > ?",
                    [chain, block_number],
                )
            self.db.execute(
                "UPDATE sync_state SET synced_through = ? WHERE chain = ? AND synced_through > ?",
                [block_number, chain, block_number],
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def prune_blocks(self, chain: str, below: int) -> None:
        self.db.execute("DELETE FROM blocks WHERE chain = ? AND block_number < ?", [chain, below])

    def minted_and_burned(self, chain: str, through_block: int) -> tuple[int, int]:
        minted, burned = self.db.execute(
            """
            SELECT
                coalesce(sum(value) FILTER (WHERE from_address = $zero), 0)::HUGEINT,
                coalesce(sum(value) FILTER (WHERE to_address = $zero), 0)::HUGEINT
            FROM transfers
            WHERE chain = $chain AND block_number <= $block
            """,
            {"zero": ZERO_ADDRESS, "chain": chain, "block": through_block},
        ).fetchone()
        return int(minted), int(burned)

    def transfer_count(self, chain: str) -> int:
        row = self.db.execute("SELECT count(*) FROM transfers WHERE chain = ?", [chain]).fetchone()
        return row[0]

    def record_reconciliation(
        self, chain: str, block_number: int, minted: int, burned: int, onchain: int, matched: bool
    ) -> None:
        self.db.execute(
            """
            INSERT INTO reconciliations
                (chain, block_number, minted, burned, onchain_supply, matched)
            VALUES (?, ?, CAST(? AS HUGEINT), CAST(? AS HUGEINT), CAST(? AS HUGEINT), ?)
            """,
            [chain, block_number, str(minted), str(burned), str(onchain), matched],
        )
