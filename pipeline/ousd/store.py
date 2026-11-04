"""DuckDB storage. Every write that spans tables is one transaction."""

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

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


class StoreConflict(RuntimeError):
    """A row disagrees with the row already stored at the same position."""


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
        transfers: Sequence[Transfer],
        block_hashes: Mapping[int, str],
        synced_through: int,
    ) -> None:
        """Store one ingested range and advance the cursor, all or nothing."""
        self.db.begin()
        try:
            if transfers:
                self._refuse_conflicts(chain, transfers)
                self._insert_transfers(chain, transfers)
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

    def _refuse_conflicts(self, chain: str, transfers: Sequence[Transfer]) -> None:
        """Re-reading a row is fine. A different row at the same position is a data problem."""
        blocks = [t.block_number for t in transfers]
        stored = {
            (block_number, log_index): content
            for block_number, log_index, *content in self.db.execute(
                """
                SELECT block_number, log_index, block_hash, block_timestamp, tx_hash,
                       from_address, to_address, value
                FROM transfers WHERE chain = ? AND block_number BETWEEN ? AND ?
                """,
                [chain, min(blocks), max(blocks)],
            ).fetchall()
        }
        for t in transfers:
            old = stored.get((t.block_number, t.log_index))
            if old is None:
                continue
            new = [
                t.block_hash,
                t.block_timestamp,
                t.tx_hash,
                t.from_address,
                t.to_address,
                t.value,
            ]
            # Blockscout rows have no hash, so a missing hash on either side is not a difference.
            hashes_agree = old[0] is None or new[0] is None or old[0] == new[0]
            if not hashes_agree or old[1:] != new[1:]:
                raise StoreConflict(
                    f"{chain}: block {t.block_number}, log {t.log_index} is stored as {old} "
                    f"but was just read as {new}"
                )

    def _insert_transfers(self, chain: str, transfers: Sequence[Transfer]) -> None:
        # One list per column is far faster than executemany. Values travel as text
        # because a list of Python ints has no single type DuckDB can bind to HUGEINT.
        self.db.execute(
            """
            INSERT INTO transfers
            SELECT
                $chain, unnest($block_number::BIGINT[]), unnest($log_index::INTEGER[]),
                unnest($block_hash::VARCHAR[]), unnest($block_timestamp::BIGINT[]),
                unnest($tx_hash::VARCHAR[]), unnest($from_address::VARCHAR[]),
                unnest($to_address::VARCHAR[]), unnest($value::VARCHAR[])::HUGEINT
            ON CONFLICT DO NOTHING
            """,
            {
                "chain": chain,
                "block_number": [t.block_number for t in transfers],
                "log_index": [t.log_index for t in transfers],
                "block_hash": [t.block_hash for t in transfers],
                "block_timestamp": [t.block_timestamp for t in transfers],
                "tx_hash": [t.tx_hash for t in transfers],
                "from_address": [t.from_address for t in transfers],
                "to_address": [t.to_address for t in transfers],
                "value": [str(t.value) for t in transfers],
            },
        )

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
        minted, burned = self._aggregate_row(
            """
            SELECT
                coalesce(sum(value) FILTER (WHERE from_address = $zero), 0)::HUGEINT,
                coalesce(sum(value) FILTER (WHERE to_address = $zero), 0)::HUGEINT
            FROM transfers
            WHERE chain = $chain AND block_number <= $block
            """,
            {"zero": ZERO_ADDRESS, "chain": chain, "block": through_block},
        )
        return int(minted), int(burned)

    def transfer_count(self, chain: str) -> int:
        row = self._aggregate_row("SELECT count(*) FROM transfers WHERE chain = ?", [chain])
        return int(row[0])

    def _aggregate_row(
        self, query: str, parameters: Sequence[Any] | Mapping[str, Any]
    ) -> tuple[Any, ...]:
        """Run an aggregate without GROUP BY, which returns one row even when nothing matches."""
        row = self.db.execute(query, parameters).fetchone()
        if row is None:
            raise RuntimeError(f"aggregate query returned no row: {query}")
        return row

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
