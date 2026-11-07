"""A small four-chain world for the check and publish tests, built by the real dbt project.

Raw rows, a recorded full pass and real labels, then one `dbt build`. Tests copy it and change one
thing, so each failure they see comes from that one thing. Nothing touches the network.
"""

import csv
import shutil
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import duckdb
from dbt_helpers import invoke_dbt
from ousd import checks
from ousd import publish as publisher
from ousd.chains import REQUIRED_CHAINS
from ousd.checks import Sources
from ousd.decode import ZERO_ADDRESS, Transfer
from ousd.store import BalanceSample, Status, Store

ROOT = Path(__file__).resolve().parent.parent
REAL_LABELS = ROOT / "labels" / "labels.csv"
OUSD = 10**6
DAY_ZERO = datetime(2026, 9, 30, tzinfo=UTC)
# The newest transfer, at 01:00 on 2026-11-04, makes 2026-11-03 each chain's last complete day.
NEWEST_TRANSFER = datetime(2026, 11, 4, 1, 0, tzinfo=UTC)
RECONCILED_AT = datetime(2026, 11, 4, 5, 30, tzinfo=UTC)
NOW = datetime(2026, 11, 4, 6, 0, tzinfo=UTC)
RUN = "check-run-1"
LAST_DAY = 34
# Above 2^53, so a float anywhere on the way would lose the last digit.
HUGE = 2**60 + 1
PLACED = {"tempo": HUGE, "ethereum": 900_000_000 * OUSD, "base": 200_000_000 * OUSD}
EVERYDAY = 500_000 * OUSD
ISSUERS = {
    "tempo": "0x4c2c0f0bb2631b02ac9299c59690914ee7a200b8",
    "ethereum": "0x4c2c0f0bb2631b02ac9299c59690914ee7a200b8",
    "base": "0x4c2c0f0bb2631b02ac9299c59690914ee7a200b8",
    # Solana has only route wallets in the labels file, and no wallet labeled as the issuer.
    "solana": "3ZGf3ERiitfTR9RCChchfo7QWmSfH1WArJ3jjrtMXnKa",
}


def wallets(chain: str) -> dict[str, str]:
    if chain == "solana":
        return {
            "placed": "So1P1acedWa11etAaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "payer": "So1PayerWa11etBbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "receiver": "So1ReceiverWa11etCccccccccccccccccccccccccc",
        }
    return {"placed": "0x" + "a1" * 20, "payer": "0x" + "a2" * 20, "receiver": "0x" + "a3" * 20}


def chain_transfers(chain: str) -> list[Transfer]:
    who = wallets(chain)
    start = int(DAY_ZERO.timestamp())

    def row(block: int, timestamp: int, sender: str, receiver: str, value: int) -> Transfer:
        block_hash = None if chain == "solana" else f"0xhash{block}"
        return Transfer(
            block, block_hash, timestamp, f"{chain}-tx-{block}", 0, sender, receiver, value
        )

    rows = [
        row(100, start + 60, ZERO_ADDRESS, who["placed"], PLACED.get(chain, 100_000_000 * OUSD)),
        row(101, start + 120, ZERO_ADDRESS, ISSUERS[chain], 100_000_000 * OUSD),
        row(102, start + 180, ZERO_ADDRESS, who["payer"], 50_000_000 * OUSD),
    ]
    for day in range(1, LAST_DAY + 1):
        timestamp = start + day * 86_400 + 600
        rows.append(row(200 + day, timestamp, who["payer"], who["receiver"], EVERYDAY))
    rows.append(row(300, int(NEWEST_TRANSFER.timestamp()), who["payer"], who["receiver"], OUSD))
    return rows


def tip(chain: str) -> int:
    return chain_transfers(chain)[-1].block_number + 3


def tip_hash(chain: str) -> str | None:
    return None if chain == "solana" else f"0xhash{tip(chain)}"


def record_run(
    store: Store,
    chains: Sequence[str] = REQUIRED_CHAINS,
    status: Status = "pass",
    scope: str = "full",
    exit_code: int = 0,
    bridge: Status | None = "pass",
    at: datetime = RECONCILED_AT,
) -> str:
    """Record what a finished run leaves behind, at a fixed time, for the data as stored."""
    run_id = store.start_run(scope)
    total = 0
    for chain in chains:
        height = store.synced_through(chain)
        assert height is not None
        minted, burned = store.minted_and_burned(chain, height)
        supply = minted - burned
        total += supply
        store.record_reconciliation(chain, height, minted, burned, supply, True)
        store.record_check(
            run_id,
            "chain_supply",
            chain,
            1,
            "pass",
            pin_height=height,
            pin_hash=store.block_hashes(chain).get(height),
            transfer_count=store.transfer_count(chain),
            reference_value=supply,
            observed_value=supply,
        )
        held = store.balances_at(chain, list(wallets(chain).values()), height)
        store.record_check(
            run_id,
            "sampled_balances",
            chain,
            1,
            "pass",
            pin_height=height,
            samples=[
                BalanceSample(address, "top", "seed", height, balance, balance)
                for address, balance in held.items()
            ],
        )
    if bridge:
        store.record_check(
            run_id, "bridge", "all", 1, bridge, reference_value=total, observed_value=total
        )
    if bridge == "pass":
        store.record_bridge_comparison(run_id, chains, total, total, True)
    store.finish_run(run_id, status, exit_code)
    store.db.execute(
        "UPDATE reconciliation_runs SET started_at = ?, finished_at = ? WHERE run_id = ?",
        [at - timedelta(minutes=5), at, run_id],
    )
    store.db.execute(
        "UPDATE reconciliation_checks SET recorded_at = ? WHERE run_id = ?", [at, run_id]
    )
    store.db.execute("UPDATE reconciliations SET checked_at = ?", [at])
    store.db.execute("UPDATE bridge_comparisons SET checked_at = ? WHERE run_id = ?", [at, run_id])
    return run_id


@dataclass(frozen=True)
class World:
    path: Path

    @property
    def raw(self) -> Path:
        return self.path / "ousd.duckdb"

    @property
    def marts_file(self) -> Path:
        return self.path / "marts.duckdb"

    @property
    def out(self) -> Path:
        return self.path / "published"

    @property
    def preview_root(self) -> Path:
        return self.path / publisher.PREVIEW_DIRNAME

    @property
    def sources(self) -> Sources:
        return Sources(
            run_results=self.path / "target" / "run_results.json",
            labels=self.path / "labels.csv",
            legend=ROOT / "labels" / "README.md",
            dbt_project=self.path / "dbt_project.yml",
        )

    @contextmanager
    def store(self) -> Iterator[Store]:
        store = Store(self.raw)
        try:
            yield store
        finally:
            store.close()

    @contextmanager
    def marts(self) -> Iterator[duckdb.DuckDBPyConnection]:
        connection = duckdb.connect(str(self.marts_file), read_only=True)
        try:
            yield connection
        finally:
            connection.close()

    def raw_sql(self, query: str, parameters: Sequence[object] = ()) -> None:
        with self.store() as store:
            store.db.execute(query, parameters)

    def mart_sql(self, query: str, parameters: Sequence[object] = ()) -> None:
        connection = duckdb.connect(str(self.marts_file))
        try:
            connection.execute(query, parameters)
        finally:
            connection.close()

    def run_checks(
        self, allow_partial: bool = False, now: datetime = NOW, run_id: str = RUN
    ) -> dict[str, checks.CheckResult]:
        with self.store() as store, self.marts() as marts:
            results = checks.run_checks(store, marts, run_id, allow_partial, now, self.sources)
        return {result.name: result for result in results}

    def publish(self, allow_partial: bool = False, now: datetime = NOW, run_id: str = RUN) -> Path:
        return publisher.publish(
            run_id, self.marts_file, self.raw, self.out, allow_partial, now, self.sources
        )

    def copy(self, destination: Path) -> "World":
        destination.mkdir(parents=True, exist_ok=True)
        for name in ("ousd.duckdb", "marts.duckdb", "labels.csv", "dbt_project.yml"):
            shutil.copy(self.path / name, destination / name)
        (destination / "target").mkdir(exist_ok=True)
        for name in ("run_results.json", "manifest.json"):
            shutil.copy(self.path / "target" / name, destination / "target")
        return World(destination)


def build_world(path: Path, chains: Sequence[str] = REQUIRED_CHAINS) -> World:
    world = World(path)
    shutil.copy(ROOT / "dbt" / "dbt_project.yml", path / "dbt_project.yml")
    with world.store() as store:
        for chain in chains:
            blocks = {} if chain == "solana" else {tip(chain): f"0xhash{tip(chain)}"}
            store.write_range(chain, chain_transfers(chain), blocks, tip(chain))
        record_run(
            store,
            chains,
            status="pass" if set(chains) == set(REQUIRED_CHAINS) else "unchecked",
            scope="full" if set(chains) == set(REQUIRED_CHAINS) else "partial",
            exit_code=0 if set(chains) == set(REQUIRED_CHAINS) else 3,
        )
    with REAL_LABELS.open(newline="") as handle:
        labels = list(csv.DictReader(handle))
    result = invoke_dbt(path, labels)
    if not result.success:
        raise RuntimeError(f"dbt build failed: {result.exception}")
    return world
