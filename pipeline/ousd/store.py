"""DuckDB storage. Every write that spans tables is one transaction."""

import contextlib
import json
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

import duckdb

from ousd.chains import REQUIRED_CHAINS
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
CREATE TABLE IF NOT EXISTS bridge_comparisons (
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    chains_included VARCHAR NOT NULL,
    chains_missing VARCHAR NOT NULL,
    chains_total HUGEINT NOT NULL,
    bridge_total HUGEINT NOT NULL,
    tolerance HUGEINT NOT NULL,
    passed BOOLEAN NOT NULL
);
CREATE TABLE IF NOT EXISTS reconciliation_runs (
    run_id VARCHAR PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,  -- Null means unfinished, and is the only marker of that.
    scope VARCHAR NOT NULL,
    status VARCHAR,
    exit_code INTEGER
);
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
);
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
);
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
);
"""

# Applied after SCHEMA, so a bridge_comparisons table made with its seven columns is upgraded.
# Safe to run on every open: it adds nothing when the column is already there.
MIGRATIONS = ("ALTER TABLE bridge_comparisons ADD COLUMN IF NOT EXISTS run_id VARCHAR",)

Status = Literal["pass", "fail", "unchecked"]
CHECK_NAMES = ("chain_supply", "sampled_balances", "balance_census", "same_looking", "bridge")


class StoreConflict(RuntimeError):
    """A row disagrees with the row already stored at the same position."""


@dataclass(frozen=True)
class BalanceSample:
    """One wallet read in a sampled-balance check, with the model's and the chain's figure."""

    address: str
    stratum: str
    seed: str
    height: int
    model_balance: int
    observed_balance: int


@dataclass(frozen=True)
class SameLookingGroup:
    """Rows of one transaction sharing sender, receiver and value at different log positions."""

    tx_hash: str
    block_number: int
    sender: str
    receiver: str
    value: int
    positions: list[int]
    null_hash_count: int


@dataclass(frozen=True)
class ChainPin:
    """What a run recorded for a chain at its final pin, and whether the store still matches."""

    pin_height: int | None
    pin_hash: str | None
    transfer_count: int | None
    current: bool


@dataclass(frozen=True)
class LatestReconciliation:
    """The newest finished run, with times as naive UTC.

    `usable` is the publish gate, as Store.latest_reconciliation explains.
    """

    run_id: str
    scope: str
    status: str | None
    exit_code: int | None
    started_at: datetime
    finished_at: datetime
    chains: dict[str, ChainPin]
    usable: bool


# One row per balance change: received is positive, sent is negative. Shared by balance queries.
_DELTAS = """
    deltas AS (
        SELECT block_number, to_address AS address, value AS delta
        FROM transfers WHERE chain = $chain AND block_number <= $block
        UNION ALL
        SELECT block_number, from_address, -value
        FROM transfers WHERE chain = $chain AND block_number <= $block
    )
"""

# A transfer's effect on supply: a mint adds, a burn subtracts.
_NET = (
    "(CASE WHEN from_address = $zero THEN value ELSE 0 END)"
    " - (CASE WHEN to_address = $zero THEN value ELSE 0 END)"
)


def _text(value: int | None) -> str | None:
    """Amounts travel as text so DuckDB can cast them to HUGEINT."""
    return None if value is None else str(value)


class Store:
    def __init__(self, path: str | Path = ":memory:") -> None:
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = duckdb.connect(str(path))
        self.db.execute(SCHEMA)
        for migration in MIGRATIONS:
            self.db.execute(migration)

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
        except BaseException:
            # Ctrl-C included: a transaction left open would hold the connection.
            self._rollback()
            raise

    def _rollback(self) -> None:
        # A rollback that fails must not replace the error that got us here.
        with contextlib.suppress(duckdb.Error):
            self.db.rollback()

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
        # Positions this write returned, per block. A stored row at one of them is accounted for.
        returned: dict[int, set[int]] = {}
        for t in transfers:
            returned.setdefault(t.block_number, set()).add(t.log_index)
        twins: dict[tuple[int, str, str, str, int], list[int]] | None = None
        for t in transfers:
            old = stored.get((t.block_number, t.log_index))
            if old is None:
                # A new position. If a same-looking row is stored at a position this write did
                # not return, the row did not move on the chain: the index scheme changed.
                if twins is None:
                    twins = {}
                    for (block_number, log_index), content in stored.items():
                        key = (block_number, content[2], content[3], content[4], content[5])
                        twins.setdefault(key, []).append(log_index)
                key = (t.block_number, t.tx_hash, t.from_address, t.to_address, t.value)
                missing = [
                    index for index in twins.get(key, []) if index not in returned[t.block_number]
                ]
                if missing:
                    raise StoreConflict(
                        f"{chain}: block {t.block_number}, log {t.log_index} was just read, "
                        f"but the same transfer is stored at log {min(missing)}, which was not "
                        f"returned. The log index scheme has changed"
                    )
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
            for table in ("transfers", "blocks", "transfer_group_audits"):
                self.db.execute(
                    f"DELETE FROM {table} WHERE chain = ? AND block_number > ?",
                    [chain, block_number],
                )
            self.db.execute(
                "UPDATE sync_state SET synced_through = ? WHERE chain = ? AND synced_through > ?",
                [block_number, chain, block_number],
            )
            self.db.commit()
        except BaseException:
            # Ctrl-C included: a transaction left open would hold the connection.
            self._rollback()
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

    def balances_at(
        self, chain: str, addresses: Sequence[str], through_block: int
    ) -> dict[str, int]:
        """Received minus sent through the block. An address with no rows is 0."""
        balances = dict.fromkeys(addresses, 0)
        if not balances:
            return balances
        found = self.db.execute(
            f"""
            WITH wanted AS (SELECT unnest($addresses::VARCHAR[]) AS address),
            {_DELTAS}
            SELECT address, sum(delta)::HUGEINT
            FROM deltas WHERE address IN (SELECT address FROM wanted)
            GROUP BY address
            """,
            {"chain": chain, "block": through_block, "addresses": list(balances)},
        ).fetchall()
        for address, balance in found:
            balances[address] = int(balance)
        return balances

    def wallets(self, chain: str, through_block: int) -> list[str]:
        """Every address that sent or received, ZERO_ADDRESS excluded, in address order."""
        return [
            address
            for (address,) in self.db.execute(
                f"""
                WITH {_DELTAS}
                SELECT DISTINCT address FROM deltas WHERE address <> $zero ORDER BY address
                """,
                {"chain": chain, "block": through_block, "zero": ZERO_ADDRESS},
            ).fetchall()
        ]

    def top_wallets(self, chain: str, through_block: int, n: int) -> list[tuple[str, int]]:
        """The n largest balances, ties in address order."""
        if n <= 0:
            return []
        rows = self.db.execute(
            f"""
            WITH {_DELTAS}
            SELECT address, sum(delta)::HUGEINT AS balance
            FROM deltas WHERE address <> $zero
            GROUP BY address ORDER BY balance DESC, address LIMIT $n
            """,
            {"chain": chain, "block": through_block, "zero": ZERO_ADDRESS, "n": n},
        ).fetchall()
        return [(address, int(balance)) for address, balance in rows]

    def wallets_touched(self, chain: str, after_block: int, through_block: int) -> list[str]:
        """Addresses in rows above after_block and up to through_block, in address order."""
        return [
            address
            for (address,) in self.db.execute(
                f"""
                WITH {_DELTAS}
                SELECT DISTINCT address FROM deltas
                WHERE address <> $zero AND block_number > $after
                ORDER BY address
                """,
                {
                    "chain": chain,
                    "block": through_block,
                    "after": after_block,
                    "zero": ZERO_ADDRESS,
                },
            ).fetchall()
        ]

    def supply_values(
        self, chain: str, start_ts: int, end_ts: int, through_block: int
    ) -> list[tuple[int, int]]:
        """Supply after each block with a mint or burn in [start_ts, end_ts], by block.

        The first entry is the supply just before the range, stamped start_ts. A block's mint
        and burn count once, as their net. Blocks, not seconds, because a chain can fit two
        blocks in one second.
        """
        before = {
            "chain": chain,
            "block": through_block,
            "zero": ZERO_ADDRESS,
            "start": start_ts,
        }
        prior = self._aggregate_row(
            f"""
            SELECT coalesce(sum({_NET}), 0)::HUGEINT
            FROM transfers
            WHERE chain = $chain AND block_number <= $block AND block_timestamp < $start
            """,
            before,
        )
        supply = int(prior[0])
        values = [(start_ts, supply)]
        for timestamp, net in self.db.execute(
            f"""
            SELECT block_timestamp, sum({_NET})::HUGEINT
            FROM transfers
            WHERE chain = $chain AND block_number <= $block
              AND block_timestamp BETWEEN $start AND $end
              AND (from_address = $zero OR to_address = $zero)
            GROUP BY block_number, block_timestamp ORDER BY block_number
            """,
            {**before, "end": end_ts},
        ).fetchall():
            supply += int(net)
            values.append((int(timestamp), supply))
        return values

    def supply_at_time(self, chain: str, ts: int) -> int:
        """Supply after every block stamped at or before ts."""
        row = self._aggregate_row(
            f"""
            SELECT coalesce(sum({_NET}), 0)::HUGEINT
            FROM transfers WHERE chain = $chain AND block_timestamp <= $ts
            """,
            {"chain": chain, "zero": ZERO_ADDRESS, "ts": ts},
        )
        return int(row[0])

    def same_looking_groups(self, chain: str, through_block: int) -> list[SameLookingGroup]:
        """Groups to prove from their transaction.

        A transaction with a `real` audit is left out only while its stored log positions are
        exactly the ones audited, so a transaction that gains or loses a row comes back.
        """
        rows = self.db.execute(
            """
            WITH groups AS (
                SELECT tx_hash, block_number, from_address, to_address, value,
                       list(log_index ORDER BY log_index) AS positions,
                       count(*) FILTER (WHERE block_hash IS NULL) AS null_hashes
                FROM transfers
                WHERE chain = $chain AND block_number <= $block
                GROUP BY tx_hash, block_number, from_address, to_address, value
                HAVING count(*) > 1
            ),
            current AS (
                SELECT tx_hash, list(log_index ORDER BY log_index) AS positions
                FROM transfers
                WHERE chain = $chain AND tx_hash IN (SELECT tx_hash FROM groups)
                GROUP BY tx_hash
            )
            SELECT g.tx_hash, g.block_number, g.from_address, g.to_address, g.value,
                   g.positions, g.null_hashes
            FROM groups g JOIN current c ON c.tx_hash = g.tx_hash
            WHERE NOT EXISTS (
                SELECT 1 FROM transfer_group_audits a
                WHERE a.chain = $chain AND a.tx_hash = g.tx_hash AND a.status = 'real'
                  AND a.stored_positions = c.positions
            )
            ORDER BY g.block_number, g.tx_hash, g.from_address, g.to_address, g.value
            """,
            {"chain": chain, "block": through_block},
        ).fetchall()
        return [
            SameLookingGroup(
                tx_hash, int(block), sender, receiver, int(value), list(positions), int(nulls)
            )
            for tx_hash, block, sender, receiver, value, positions, nulls in rows
        ]

    def transaction_rows(self, chain: str, tx_hash: str) -> list[Transfer]:
        """Every stored row of one transaction, in log order."""
        return [
            Transfer(*row)
            for row in self.db.execute(
                """
                SELECT block_number, block_hash, block_timestamp, tx_hash, log_index,
                       from_address, to_address, value
                FROM transfers WHERE chain = ? AND tx_hash = ? ORDER BY log_index
                """,
                [chain, tx_hash],
            ).fetchall()
        ]

    def start_run(self, scope: str) -> str:
        """Open a run. It stays unfinished, and so can't be read as a pass, until finish_run."""
        run_id = uuid.uuid4().hex
        self.db.execute(
            "INSERT INTO reconciliation_runs (run_id, scope) VALUES (?, ?)", [run_id, scope]
        )
        return run_id

    def finish_run(self, run_id: str, status: Status, exit_code: int) -> None:
        updated = self.db.execute(
            """
            UPDATE reconciliation_runs
            SET finished_at = now(), status = ?, exit_code = ?
            WHERE run_id = ? AND finished_at IS NULL
            RETURNING run_id
            """,
            [status, exit_code, run_id],
        ).fetchall()
        if not updated:
            raise KeyError(f"no unfinished run {run_id}")

    def record_check(
        self,
        run_id: str,
        check_name: str,
        subject: str,
        attempt: int,
        status: Status,
        reason: str | None = None,
        *,
        pin_height: int | None = None,
        pin_hash: str | None = None,
        transfer_count: int | None = None,
        reference_value: int | None = None,
        observed_value: int | None = None,
        detail: Mapping[str, Any] | None = None,
        samples: Sequence[BalanceSample] = (),
    ) -> None:
        """Record one check, with its wallet samples in the same transaction.

        `reason` is a fixed code and `detail` is JSON the caller builds from counts and heights,
        never provider text, so a key echoed in an error can't be stored.
        """
        if check_name not in CHECK_NAMES:
            raise ValueError(f"unknown check {check_name!r}")
        self.db.begin()
        try:
            self.db.execute(
                """
                INSERT INTO reconciliation_checks
                    (run_id, check_name, subject, attempt, status, reason, pin_height, pin_hash,
                     transfer_count, reference_value, observed_value, detail)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS HUGEINT), CAST(? AS HUGEINT), ?)
                """,
                [
                    run_id,
                    check_name,
                    subject,
                    attempt,
                    status,
                    reason,
                    pin_height,
                    pin_hash,
                    transfer_count,
                    _text(reference_value),
                    _text(observed_value),
                    json.dumps(detail or {}, sort_keys=True),
                ],
            )
            if samples:
                self.db.execute(
                    """
                    INSERT INTO balance_samples
                    SELECT
                        $run_id, $chain, $attempt, unnest($address::VARCHAR[]),
                        unnest($stratum::VARCHAR[]), unnest($seed::VARCHAR[]),
                        unnest($height::BIGINT[]), unnest($model::VARCHAR[])::HUGEINT,
                        unnest($observed::VARCHAR[])::HUGEINT
                    """,
                    {
                        "run_id": run_id,
                        "chain": subject,
                        "attempt": attempt,
                        "address": [s.address for s in samples],
                        "stratum": [s.stratum for s in samples],
                        "seed": [s.seed for s in samples],
                        "height": [s.height for s in samples],
                        "model": [str(s.model_balance) for s in samples],
                        "observed": [str(s.observed_balance) for s in samples],
                    },
                )
            self.db.commit()
        except BaseException:
            # Ctrl-C included: a transaction left open would hold the connection.
            self._rollback()
            raise

    def record_group_audit(
        self,
        chain: str,
        tx_hash: str,
        block_number: int,
        status: Literal["real", "not_real"],
        proof_source: str,
        stored_positions: Sequence[int],
        proven_positions: Sequence[int],
        run_id: str | None = None,
    ) -> None:
        """Keep the latest verdict on a transaction. A later audit replaces an earlier one."""
        self.db.execute(
            """
            INSERT OR REPLACE INTO transfer_group_audits
                (chain, tx_hash, block_number, status, proof_source, stored_positions,
                 proven_positions, run_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                chain,
                tx_hash,
                block_number,
                status,
                proof_source,
                sorted(stored_positions),
                sorted(proven_positions),
                run_id,
            ],
        )

    def record_bridge_comparison(
        self,
        run_id: str,
        chains_included: Sequence[str],
        chains_total: int,
        bridge_total: int,
        passed: bool,
        chains_missing: Sequence[str] = (),
        tolerance: int = 0,
    ) -> None:
        self.db.execute(
            """
            INSERT INTO bridge_comparisons
                (chains_included, chains_missing, chains_total, bridge_total, tolerance, passed,
                 run_id)
            VALUES (?, ?, CAST(? AS HUGEINT), CAST(? AS HUGEINT), CAST(? AS HUGEINT), ?, ?)
            """,
            [
                ",".join(chains_included),
                ",".join(chains_missing),
                str(chains_total),
                str(bridge_total),
                str(tolerance),
                passed,
                run_id,
            ],
        )

    def census_complete(self, chain: str) -> bool:
        """True once the newest census of every wallet has passed. Partial reads never count."""
        row = self.db.execute(
            """
            SELECT status FROM reconciliation_checks
            WHERE check_name = 'balance_census' AND subject = ?
            ORDER BY recorded_at DESC, attempt DESC LIMIT 1
            """,
            [chain],
        ).fetchone()
        return row is not None and row[0] == "pass"

    def latest_reconciliation(self) -> LatestReconciliation | None:
        """The newest finished run, and whether its pass still describes the stored data.

        `usable` is the publish gate and fails closed. It is true only when all of these hold:
        the run is finished, scope `full`, status `pass` and exit_code 0; every chain in
        REQUIRED_CHAINS has a pin (its final `chain_supply` row); for each (check_name, subject)
        the row with the highest `attempt` has status `pass`, and a final `bridge` row exists;
        and each pinned chain's cursor and transfer count equal the pin and the stored block hash
        at the pin height equals the pin hash. A NULL pin hash counts as changed on every chain
        except solana, which stores no block hashes by design and relies on cursor and count.
        """
        run = self.db.execute(
            """
            SELECT run_id, scope, status, exit_code,
                   started_at AT TIME ZONE 'UTC', finished_at AT TIME ZONE 'UTC'
            FROM reconciliation_runs WHERE finished_at IS NOT NULL
            ORDER BY finished_at DESC, started_at DESC, run_id DESC LIMIT 1
            """
        ).fetchone()
        if run is None:
            return None
        run_id, scope, status, exit_code, started_at, finished_at = run
        finals = self.db.execute(
            """
            SELECT check_name, subject, status, pin_height, pin_hash, transfer_count
            FROM reconciliation_checks WHERE run_id = ?
            QUALIFY row_number() OVER (
                PARTITION BY check_name, subject ORDER BY attempt DESC
            ) = 1
            ORDER BY check_name, subject
            """,
            [run_id],
        ).fetchall()
        chains = {
            subject: ChainPin(
                height,
                pin_hash,
                count,
                self._pin_is_current(subject, height, pin_hash, count),
            )
            for check_name, subject, _, height, pin_hash, count in finals
            if check_name == "chain_supply"
        }
        usable = (
            scope == "full"
            and status == "pass"
            and exit_code == 0
            and all(chain in chains for chain in REQUIRED_CHAINS)
            and all(state == "pass" for _, _, state, *_ in finals)
            and any(check_name == "bridge" for check_name, *_ in finals)
            and all(chains[chain].current for chain in chains)
        )
        return LatestReconciliation(
            run_id, scope, status, exit_code, started_at, finished_at, chains, usable
        )

    def _pin_is_current(
        self, chain: str, height: int | None, pin_hash: str | None, count: int | None
    ) -> bool:
        if height is None or count is None:
            return False
        if self.synced_through(chain) != height or self.transfer_count(chain) != count:
            return False
        if pin_hash is None:
            return chain == "solana"
        return self.block_hashes(chain).get(height) == pin_hash
