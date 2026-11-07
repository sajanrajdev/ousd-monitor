"""Fakes and helpers the reconcile tests share: probes over a real store and a fake chain,
Bridge snapshots, and readers of what a run recorded."""

import json
from dataclasses import dataclass, replace
from typing import Any

from conftest import ALICE, BOB, FakeRpc, make_chain
from ousd.chains import REQUIRED_CHAINS
from ousd.decode import ZERO_ADDRESS
from ousd.ingest import sync_chain
from ousd.reconcile import BalanceRead, Unchecked, reconcile_chain, run_reconciliation
from ousd.sources import BridgeSnapshot

# Above 2**53 on purpose: a float anywhere in the path would break equality.
LARGE = 2**60 + 1


def synced_chain(store):
    chain = make_chain()
    rpc = FakeRpc(tip=120)
    rpc.add_transfer(101, LARGE)
    rpc.add_transfer(102, 7, sender=ALICE, to=BOB)
    rpc.add_transfer(103, 3, sender=BOB, to=ZERO_ADDRESS)
    sync_chain(chain, rpc, store)
    return chain, rpc


# A probe over a real store and real sync_chain and reconcile_chain, on a fake chain.


@dataclass(frozen=True)
class Drift:
    """totalSupply reads this far from the events until the next read."""

    offset: int


@dataclass(frozen=True)
class PinBehind:
    """The read lands this many blocks below the cursor."""

    blocks: int


@dataclass(frozen=True)
class NoPinHash:
    """The block hash at the cursor isn't stored."""


@dataclass(frozen=True)
class WrongChain:
    """The read names another chain, at the same height."""

    chain: str


class DriftingRpc(FakeRpc):
    offset = 0

    def total_supply(self, token, block):
        return super().total_supply(token, block) + self.offset


class FakeProbe:
    def __init__(self, store, name="tempo", steps=(), needs_census=False):
        self.name = name
        self.needs_census = needs_census
        self.store = store
        self.chain = make_chain(name=name)
        self.rpc = DriftingRpc(tip=120)
        self.rpc.add_transfer(101, LARGE)
        self.rpc.add_transfer(102, 7, sender=ALICE, to=BOB)
        self.steps = list(steps)
        self.events = []
        # Each balance read takes the next step: an error to raise, an Unchecked to return, or a
        # function over the true readings.
        self.balance_steps = []
        self.balance_reads = []
        # A proof to answer with in place of the chain's, by transaction. An error is raised.
        self.proofs = {}
        self.proof_reads = []

    def supply_check(self):
        step = self.steps.pop(0) if self.steps else None
        if isinstance(step, Exception):
            raise step
        if isinstance(step, Unchecked):
            return step
        self.events.append("sync")
        self._sync()
        self.events.append("read")
        self.rpc.offset = step.offset if isinstance(step, Drift) else 0
        at_block = None
        if isinstance(step, PinBehind):
            at_block = self.store.synced_through(self.name) - step.blocks
        if isinstance(step, NoPinHash):
            self.store.db.execute(
                "DELETE FROM blocks WHERE chain = ? AND block_number = ?",
                [self.name, self.store.synced_through(self.name)],
            )
        reading = reconcile_chain(self.chain, self.rpc, self.store, at_block)
        return replace(reading, chain=step.chain) if isinstance(step, WrongChain) else reading

    def _sync(self):
        if self.name == "solana":
            # Solana reads only finalized blocks, so it stores no block hashes.
            tip = self.rpc.tip()
            rows = self.rpc.transfers(self.chain.token, self.chain.start_block, tip)
            self.store.write_range(self.name, rows, {}, tip)
        else:
            sync_chain(self.chain, self.rpc, self.store)

    def syncs(self):
        return self.events.count("sync")

    def pin_timestamp(self, height: int) -> int:
        return self.rpc.block_timestamp(height)

    def read_balances(self, addresses, height):
        self.events.append("balances")
        self.balance_reads.append((list(addresses), height))
        step = self.balance_steps.pop(0) if self.balance_steps else None
        if isinstance(step, Exception):
            raise step
        if isinstance(step, Unchecked):
            return step
        reads = self._true_balances(addresses, height)
        return step(reads) if step else reads

    def _true_balances(self, addresses, height):
        block = self.store.block_hashes(self.name).get(height, height)
        return [
            BalanceRead(address, height, self.rpc.balance_of(self.chain.token, address, block))
            for address in addresses
        ]

    def read_transaction_proof(self, tx_hash):
        self.proof_reads.append(tx_hash)
        if tx_hash in self.proofs:
            proof = self.proofs[tx_hash]
            if isinstance(proof, Exception):
                raise proof
            return proof
        return self.rpc.transaction_receipt(tx_hash, self.chain.token)


def four_probes(store, **steps):
    return [FakeProbe(store, name, steps.get(name, ())) for name in REQUIRED_CHAINS]


# FakeProbe's chains hold LARGE each from block 101, stamped 1_101, and pin at 1_120.
BRIDGE_T = 1_110
NOW = 1_200.0
FOUR_CHAINS = 4 * LARGE
GOOD = BridgeSnapshot(FOUR_CHAINS, BRIDGE_T)
# One base unit off, so no value in the window can match.
BAD = BridgeSnapshot(FOUR_CHAINS + 1, BRIDGE_T)
STALE = BridgeSnapshot(FOUR_CHAINS, int(NOW) - 1_801)


def bridge_passes():
    return GOOD


def bad_at(offset):
    return BAD._replace(last_updated=BRIDGE_T + offset)


def good_at(offset):
    return GOOD._replace(last_updated=BRIDGE_T + offset)


class BridgeFeed:
    """Each fetch gives the next snapshot, or raises the next error."""

    def __init__(self, *items):
        self.remaining = list(items)

    def __call__(self):
        item = self.remaining.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def no_sleep(seconds):
    pass


def run_it(store, probes, bridge=bridge_passes, sleep=no_sleep, clock=lambda: NOW, census=()):
    reported: list[Any] = []
    result = run_reconciliation(
        probes, store, reported.append, bridge=bridge, census=census, sleep=sleep, clock=clock
    )
    return result, reported


def comparisons(store):
    return store.db.execute(
        """
        SELECT chains_included, chains_missing, chains_total, bridge_total, tolerance, passed
        FROM bridge_comparisons ORDER BY checked_at
        """
    ).fetchall()


def checks(store, check_name, subject):
    return store.db.execute(
        """
        SELECT attempt, status, reason FROM reconciliation_checks
        WHERE check_name = ? AND subject = ? ORDER BY attempt
        """,
        [check_name, subject],
    ).fetchall()


NEWEST_RUN = "(SELECT run_id FROM reconciliation_runs ORDER BY started_at DESC LIMIT 1)"


def newest_run_checks(store, check_name, subject):
    return store.db.execute(
        f"""
        SELECT attempt, status, reason FROM reconciliation_checks
        WHERE check_name = ? AND subject = ? AND run_id = {NEWEST_RUN} ORDER BY attempt
        """,
        [check_name, subject],
    ).fetchall()


def runs(store):
    return store.db.execute(
        "SELECT scope, status, exit_code, finished_at IS NULL FROM reconciliation_runs"
    ).fetchall()


# For secrets.

KEY = "sk_live_abcdef0123456789"


def caused_by(error, cause):
    error.__cause__ = cause
    return error


def stored_check_text(store):
    return repr(
        store.db.execute("SELECT * EXCLUDE (recorded_at) FROM reconciliation_checks").fetchall()
    )


CAROL = "0x" + "d" * 40


# For sampled balances, over the same fake chain.


def tempo_probes(store):
    probes = four_probes(store)
    return probes, probes[0]


def check_detail(store, check_name, subject, attempt=1):
    row = store.db.execute(
        f"""
        SELECT detail FROM reconciliation_checks
        WHERE check_name = ? AND subject = ? AND attempt = ? AND run_id = {NEWEST_RUN}
        """,
        [check_name, subject, attempt],
    ).fetchone()
    return json.loads(row[0])


def off_by(address, amount):
    def lie(reads):
        return [
            read._replace(amount=read.amount + amount) if read.address == address else read
            for read in reads
        ]

    return lie


# A chain like Solana: no past-state read, and a read that syncs through the slot it reports.


class SlotProbe(FakeProbe):
    """Each balance read lands `ahead` slots past the tip and syncs through it, or `behind` slots
    below the tip. With `spread`, the first read lands each wallet on a slot of its own."""

    def __init__(self, store, ahead=0, behind=0, spread=False, name="solana"):
        super().__init__(store, name)
        self.ahead, self.behind, self.spread = ahead, behind, spread
        # Runs before each supply check, to add movement the check will land past.
        self.before_supply = lambda: None

    def supply_check(self):
        self.before_supply()
        return super().supply_check()

    def _true_balances(self, addresses, height):
        tip = self.rpc.tip() + self.ahead
        self.rpc.extend(tip)
        self._sync()
        slot = tip - self.behind
        slots = [slot - index if self.spread else slot for index in range(len(addresses))]
        self.spread = False
        return [
            BalanceRead(address, at, self.rpc.balance_of(self.chain.token, address, at))
            for address, at in zip(addresses, slots, strict=True)
        ]


def slot_probes(store, **options):
    probes = four_probes(store)
    probes[3] = SlotProbe(store, **options)
    return probes, probes[3]


def only_the_first_read_moves_the_cursor(probe):
    real = probe._true_balances

    def once(addresses, height):
        reads = real(addresses, height)
        probe.ahead = 0
        return reads

    probe._true_balances = once


# For same-looking transfers.

TX = "0x" + "1" * 64


def same_transaction(probe, block, tx_hash, *moves):
    """Add moves to a block as one transaction. Every log in that block joins it."""
    for sender, to, value in moves:
        probe.rpc.add_transfer(block, value, sender=sender, to=to)
    probe.rpc.logs[block] = [replace(row, tx_hash=tx_hash) for row in probe.rpc.logs[block]]


def proof_of(probe, asked, positions=None, **changes):
    proof = probe.rpc.transaction_receipt(asked, probe.chain.token)
    assert proof is not None
    transfers = [
        transfer
        for transfer in proof.transfers
        if positions is None or transfer.log_index in positions
    ]
    return proof._replace(**{"transfers": transfers, **changes})


def audit(store, tx_hash, chain="tempo"):
    return store.db.execute(
        """
        SELECT status, proof_source, stored_positions, proven_positions, block_number
        FROM transfer_group_audits WHERE chain = ? AND tx_hash = ?
        """,
        [chain, tx_hash],
    ).fetchone()
