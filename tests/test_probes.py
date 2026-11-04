"""The probes connect each chain family to the checks. Each way a source can fail must reach the run
as a fixed code, and only a proven disagreement may reach it as a fail."""

import ast
import dataclasses
import json
import logging
import traceback
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import ALICE, BOB, FakeRpc, make_chain
from ousd import probes, reconcile, solana
from ousd.chains import Chain, load_chains
from ousd.decode import TRANSFER_TOPIC, ZERO_ADDRESS, Transfer
from ousd.http import HttpError, PoliteClient
from ousd.ingest import ReorgError, sync_chain
from ousd.probes import (
    BLOCKSCOUT_INTERVAL,
    EvmProbe,
    SolanaProbe,
    build_probes,
    history_for,
)
from ousd.reconcile import (
    BalanceRead,
    ChainReconciliation,
    ChainUnavailable,
    RunResult,
    Unchecked,
    run_reconciliation,
)
from ousd.solana import (
    OUSD_MINT,
    RPC_INTERVAL,
    BalanceReading,
    BalanceSnapshot,
    SlotReading,
    SolanaChain,
    SolanaDataError,
    SolanaRpcError,
    TailReread,
    decode_transaction,
    load_solana,
    sync_solana,
)
from ousd.sources import BlockscoutClient, ProofTransfer, RpcError, TransactionProof
from ousd.store import Store, StoreConflict
from solana_fakes import FakeSolanaRpc, load, movement

KEY = "k3y9aZ7QwErTyUiOpAsDfGhJkLzXcVbNm1234567890"
KEYED_URL = f"http://rpc.provider.invalid/v2/{KEY}"
ORIGIN_DOLLAR = "0x2a8e1e676ec238d8a992307b495b45b3feaa5e86"
CHAIN = make_chain(name="tempo")
SOLANA = SolanaChain("solana", OUSD_MINT, "http://rpc.invalid/key")
# Above the creation fixture's slot, so a walk that reaches it stays in order.
START = 414_760_000
CURSOR = START + 100
WALLET = "Hmc2dLxZZ4xfHqn2wFCTBu11oCpYiuwsj23JBjJmD4ni"
OTHER_WALLET = "BobWa11et1111111111111111111111111111111111"


class SpyRpc(FakeRpc):
    """FakeRpc that notes each read in order, and raises what `faults` holds for it."""

    def __init__(self, tip: int = 120) -> None:
        self.events: list[str] = []
        self.faults: dict[str, Exception] = {}
        self.block_args: list[int | str] = []
        self.token_args: list[str] = []
        super().__init__(tip)

    def _hit(self, event: str) -> None:
        self.events.append(event)
        if event in self.faults:
            raise self.faults[event]

    def chain_id(self) -> int:
        self._hit("chain_id")
        return super().chain_id()

    def transfers(self, token: str, from_block: int, to_block: int) -> list[Transfer]:
        self._hit("logs")
        return super().transfers(token, from_block, to_block)

    def total_supply(self, token: str, block: int | str) -> int:
        self._hit("total_supply")
        self.block_args.append(block)
        return super().total_supply(token, block)

    def balance_of(self, token: str, address: str, block: int | str) -> int:
        self._hit("balance_of")
        self.block_args.append(block)
        self.token_args.append(token)
        return super().balance_of(token, address, block)

    def block_timestamp(self, number: int) -> int:
        self._hit("block_timestamp")
        return super().block_timestamp(number)

    def transaction_receipt(self, tx_hash: str, token: str) -> TransactionProof | None:
        self._hit("receipt")
        self.token_args.append(token)
        return super().transaction_receipt(tx_hash, token)


class FakeBlockscout(BlockscoutClient):
    def __init__(self, proof: TransactionProof | Exception) -> None:
        self.proof = proof
        self.calls: list[tuple[str, str]] = []
        self.page_calls: list[tuple[str, int, int]] = []

    def pages(
        self, token: str, from_block: int, to_block: int
    ) -> Iterator[tuple[list[Transfer], int]]:
        self.page_calls.append((token, from_block, to_block))
        yield [], to_block

    def transaction_logs(self, tx_hash: str, token: str) -> TransactionProof:
        self.calls.append((tx_hash, token))
        if isinstance(self.proof, Exception):
            raise self.proof
        return self.proof


def synced_evm(store: Store, chain: Chain = CHAIN) -> tuple[EvmProbe, SpyRpc]:
    """A probe over a store synced to the tip, with a mint and a transfer stored."""
    rpc = SpyRpc()
    rpc.add_transfer(101, 100)
    rpc.add_transfer(102, 7, sender=ALICE, to=BOB)
    sync_chain(chain, rpc, store)
    rpc.events.clear()
    return EvmProbe(chain, rpc, store), rpc


def reconciliation_rows(store: Store) -> int:
    row = store.db.execute("SELECT count(*) FROM reconciliations").fetchone()
    assert row is not None
    return int(row[0])


def run(store: Store, *chain_probes: Any) -> RunResult:
    # No Bridge: these runs are partial, and only each chain's own status is of interest.
    return run_reconciliation(chain_probes, store, lambda outcome: None)


def reasons(result: RunResult, chain: str) -> dict[str, str | None]:
    return {
        outcome.check_name: outcome.reason
        for outcome in result.outcomes
        if outcome.subject == chain
    }


# EvmProbe: supply.


def test_supply_check_syncs_and_then_reads_at_the_synced_blocks_hash(store):
    probe, rpc = synced_evm(store)
    rpc.extend(125)

    result = probe.supply_check()

    assert rpc.events.index("logs") < rpc.events.index("total_supply")
    assert rpc.block_args == [rpc.hashes[125]]
    assert isinstance(result, ChainReconciliation)
    assert (result.chain, result.block_number, result.matched) == ("tempo", 125, True)
    assert store.synced_through("tempo") == 125


def test_no_cursor_is_not_synced_and_starts_no_sync(store):
    rpc = SpyRpc()
    probe = EvmProbe(CHAIN, rpc, store)

    with pytest.raises(ChainUnavailable) as raised:
        probe.supply_check()

    assert raised.value.reason == "not_synced"
    assert rpc.events == []
    assert store.synced_through("tempo") is None


# EvmProbe: error mapping.

SOURCE_FAILURES = [
    RuntimeError("anything"),
    HttpError("rpc: HTTP 403"),
    RpcError("execution reverted"),
    ReorgError("no stored block is canonical"),
    ValueError("malformed reply"),
]


@pytest.mark.parametrize("failure", SOURCE_FAILURES, ids=lambda e: type(e).__name__)
def test_a_source_failure_in_the_sync_is_sync_failed(store, failure):
    probe, rpc = synced_evm(store)
    rpc.faults["chain_id"] = failure

    with pytest.raises(ChainUnavailable) as raised:
        probe.supply_check()

    assert raised.value.reason == "sync_failed"
    assert raised.value.__cause__ is failure
    assert "total_supply" not in rpc.events


@pytest.mark.parametrize("failure", SOURCE_FAILURES, ids=lambda e: type(e).__name__)
def test_a_source_failure_on_the_supply_read_is_state_unavailable(store, failure):
    probe, rpc = synced_evm(store)
    rpc.faults["total_supply"] = failure

    with pytest.raises(ChainUnavailable) as raised:
        probe.supply_check()

    assert raised.value.reason == "state_unavailable"
    assert raised.value.__cause__ is failure
    assert reconciliation_rows(store) == 0


@pytest.mark.parametrize("event", ["logs", "total_supply"])
@pytest.mark.parametrize("failure", [StoreConflict("conflict"), KeyError("bug")], ids=["sc", "ke"])
def test_a_store_conflict_or_a_bug_is_not_mapped(store, event, failure):
    probe, rpc = synced_evm(store)
    rpc.faults[event] = failure

    with pytest.raises(type(failure)):
        probe.supply_check()


def test_a_refused_supply_read_in_a_run_is_unchecked_and_not_a_mismatch(store):
    probe, rpc = synced_evm(store)
    rpc.faults["total_supply"] = HttpError("rpc: HTTP 403")

    result = run(store, probe)

    assert result.chains["tempo"] == "unchecked"
    assert reasons(result, "tempo")["chain_supply"] == "state_unavailable"


def test_a_store_conflict_in_a_run_is_a_fail(store):
    probe, rpc = synced_evm(store)
    rpc.faults["logs"] = StoreConflict("a row moved")

    result = run(store, probe)

    assert result.chains["tempo"] == "fail"
    assert result.exit_code == 1
    assert reasons(result, "tempo")["chain_supply"] == "store_conflict"


# EvmProbe: balances and pin times.


def test_a_balance_is_read_at_the_pinned_hash_with_the_configured_token(store):
    probe, rpc = synced_evm(store)

    reads = probe.read_balances([ALICE, BOB], 120)

    assert reads == [BalanceRead(ALICE, 120, 93), BalanceRead(BOB, 120, 7)]
    assert rpc.block_args == [rpc.hashes[120], rpc.hashes[120]]
    assert set(rpc.token_args) == {CHAIN.token}


def test_a_balance_at_a_height_with_no_stored_hash_is_never_read_by_number(store):
    probe, rpc = synced_evm(store)

    with pytest.raises(ChainUnavailable) as raised:
        probe.read_balances([ALICE], 999)

    assert raised.value.reason == "pin_hash_missing"
    assert "balance_of" not in rpc.events


@pytest.mark.parametrize("failure", SOURCE_FAILURES, ids=lambda e: type(e).__name__)
def test_a_refused_balance_read_is_state_unavailable(store, failure):
    probe, rpc = synced_evm(store)
    rpc.faults["balance_of"] = failure

    with pytest.raises(ChainUnavailable) as raised:
        probe.read_balances([ALICE], 120)

    assert raised.value.reason == "state_unavailable"


def test_a_pin_time_comes_from_the_block(store):
    probe, _ = synced_evm(store)

    assert probe.pin_timestamp(120) == 1_120


def test_a_pin_time_that_cant_be_read_is_chain_unavailable(store):
    probe, _ = synced_evm(store)

    with pytest.raises(ChainUnavailable) as raised:
        probe.pin_timestamp(999)

    assert raised.value.reason == "coverage_gap"


# EvmProbe: proofs.

PROOF = TransactionProof("0x" + "d" * 64, 101, None, [ProofTransfer(0, ALICE, BOB, 5)])


def test_a_receipt_is_used_when_present_with_no_blockscout_call(store):
    rpc = SpyRpc()
    transfer = rpc.add_transfer(101, 100)
    history = FakeBlockscout(PROOF)

    proof = EvmProbe(CHAIN, rpc, store, history).read_transaction_proof(transfer.tx_hash)

    assert proof is not None and proof.success is True
    assert proof.tx_hash == transfer.tx_hash
    assert rpc.token_args == [CHAIN.token]
    assert history.calls == []


def test_a_null_receipt_falls_to_blockscout(store):
    history = FakeBlockscout(PROOF)
    probe = EvmProbe(CHAIN, SpyRpc(), store, history)

    assert probe.read_transaction_proof(PROOF.tx_hash) == PROOF
    assert history.calls == [(PROOF.tx_hash, CHAIN.token)]


def test_a_null_receipt_with_no_blockscout_is_none(store):
    assert EvmProbe(CHAIN, SpyRpc(), store).read_transaction_proof(PROOF.tx_hash) is None


@pytest.mark.parametrize("failure", SOURCE_FAILURES, ids=lambda e: type(e).__name__)
def test_a_receipt_outage_raises_and_doesnt_ask_blockscout(store, failure):
    rpc = SpyRpc()
    rpc.faults["receipt"] = failure
    history = FakeBlockscout(PROOF)

    with pytest.raises(ChainUnavailable) as raised:
        EvmProbe(CHAIN, rpc, store, history).read_transaction_proof(PROOF.tx_hash)

    assert raised.value.reason == "group_proof_unavailable"
    assert raised.value.__cause__ is failure
    assert history.calls == []


@pytest.mark.parametrize("failure", SOURCE_FAILURES, ids=lambda e: type(e).__name__)
def test_a_blockscout_outage_raises_rather_than_returning_none(store, failure):
    probe = EvmProbe(CHAIN, SpyRpc(), store, FakeBlockscout(failure))

    with pytest.raises(ChainUnavailable) as raised:
        probe.read_transaction_proof(PROOF.tx_hash)

    assert raised.value.reason == "group_proof_unavailable"


def test_supply_check_syncs_through_the_history_client(store):
    _, rpc = synced_evm(store)
    rpc.extend(125)
    history = FakeBlockscout(PROOF)

    result = EvmProbe(CHAIN, rpc, store, history).supply_check()

    assert history.page_calls == [(CHAIN.token, 116, 123)]
    assert isinstance(result, ChainReconciliation) and result.matched


def test_needs_census_follows_blockscout(store):
    with_history = make_chain(blockscout_url="http://blockscout.invalid/api")

    assert EvmProbe(with_history, SpyRpc(), store).needs_census is True
    assert EvmProbe(CHAIN, SpyRpc(), store).needs_census is False


def test_blanking_the_blockscout_url_doesnt_drop_the_census(store):
    assert EvmProbe(make_chain(blockscout_url=""), SpyRpc(), store).needs_census is True


def test_an_evm_chain_passes_a_whole_run(store):
    probe, rpc = synced_evm(store)
    rpc.extend(125)
    # Two same-looking transfers in one transaction, so the proof path runs too.
    block = 122
    for index in (0, 1):
        rpc.logs.setdefault(block, []).append(
            Transfer(block, rpc.hashes[block], 1_122, "0x" + "e" * 64, index, ALICE, BOB, 1)
        )

    result = run(store, probe)

    assert result.chains["tempo"] == "pass"
    assert "receipt" in rpc.events


class NoReceipts(SpyRpc):
    """A node past its receipt horizon, as Ethereum's is for old blocks."""

    def transaction_receipt(self, tx_hash: str, token: str) -> TransactionProof | None:
        self._hit("receipt")
        return None


GROUP_HASH = "0x" + "e" * 64


def group_on_a_pruned_node(store: Store, history: FakeBlockscout) -> EvmProbe:
    """Two same-looking transfers stored, which the node no longer has a receipt for."""
    rpc = NoReceipts()
    rpc.add_transfer(101, 100)
    for index in (0, 1):
        rpc.logs.setdefault(105, []).append(
            Transfer(105, rpc.hashes[105], 1_105, GROUP_HASH, index, ALICE, BOB, 1)
        )
    sync_chain(CHAIN, rpc, store)
    return EvmProbe(CHAIN, rpc, store, history)


def test_a_group_proven_by_blockscout_passes_a_run_and_is_recorded_as_such(store):
    transfers = [ProofTransfer(index, ALICE, BOB, 1) for index in (0, 1)]
    history = FakeBlockscout(TransactionProof(GROUP_HASH, 105, None, transfers))

    result = run(store, group_on_a_pruned_node(store, history))

    assert result.chains["tempo"] == "pass"
    audit = store.db.execute(
        "SELECT status, proof_source FROM transfer_group_audits WHERE chain = 'tempo'"
    ).fetchall()
    assert audit == [("real", "blockscout")]


def test_a_blockscout_outage_on_a_group_in_a_run_is_unchecked(store):
    history = FakeBlockscout(HttpError("blockscout: gave up after 6 attempts"))

    result = run(store, group_on_a_pruned_node(store, history))

    assert result.chains["tempo"] == "unchecked"
    assert reasons(result, "tempo")["same_looking"] == "group_proof_unavailable"


# SolanaProbe: fixtures.


def moved(name: str, signature: str, slot: int, index: int = 1) -> dict[str, Any]:
    tx = load(name)
    tx["transaction"]["signatures"][0] = signature
    tx["slot"], tx["transactionIndex"] = slot, index
    return tx


def at(fake: FakeSolanaRpc, slot: int, amount: int = 0) -> None:
    fake.head = slot
    fake.supply = SlotReading(slot, amount)
    fake.snapshot = BalanceSnapshot(slot, fake.snapshot.balances or {WALLET: 1})


def walked_node(store: Store) -> FakeSolanaRpc:
    """A node whose real transactions the store has synced, with the tail still to re-read."""
    fake = FakeSolanaRpc(CURSOR)
    fake.add(load("mint_creation"))
    fake.add(movement("moved", START + 10, 1))
    sync_solana(SOLANA, fake, store)
    fake.transaction_requests.clear()
    at(fake, CURSOR)
    return fake


def seeded_node(store: Store, *rows: Transfer, slot: int = CURSOR) -> FakeSolanaRpc:
    """Rows written straight to the store with the cursor at `slot`, and reads there. Nothing is
    walked, as a sync through a slot at or below the cursor stops at once."""
    store.write_range("solana", list(rows), {}, slot)
    fake = FakeSolanaRpc(slot)
    fake.supply = SlotReading(slot, 0)
    return fake


def solana_row(
    slot: int, sender: str, receiver: str, value: int, tx: str = "tx", index: int = 0
) -> Transfer:
    return Transfer(slot, None, 1, tx, index, sender, receiver, value)


# SolanaProbe: results and cursor.


def test_solana_supply_passes_the_result_through(store, monkeypatch):
    result = ChainReconciliation("solana", CURSOR, 5, 1, 4)
    store.write_range("solana", [], {}, CURSOR)
    monkeypatch.setattr(probes, "reconcile_solana", lambda *args: result)

    assert SolanaProbe(SOLANA, FakeSolanaRpc(CURSOR), store).supply_check() is result


def test_solana_supply_reads_at_the_node_and_records_a_match(store):
    fake = seeded_node(store, solana_row(CURSOR, ZERO_ADDRESS, WALLET, 100))
    fake.supply = SlotReading(CURSOR, 100)

    result = SolanaProbe(SOLANA, fake, store).supply_check()

    assert isinstance(result, ChainReconciliation) and result.matched
    assert reconciliation_rows(store) == 1


def test_solana_unchecked_passes_through(store):
    fake = seeded_node(store)
    fake.read_errors["supply"] = HttpError("rpc: HTTP 503")
    probe = SolanaProbe(SOLANA, fake, store)

    result = probe.supply_check()

    assert result == Unchecked("solana", "rpc: HTTP 503")
    assert reconciliation_rows(store) == 0


def test_solana_balance_unchecked_passes_through(store):
    fake = seeded_node(store)
    fake.read_errors["accounts"] = HttpError("rpc: HTTP 503")

    result = SolanaProbe(SOLANA, fake, store).read_balances([WALLET], CURSOR)

    assert result == Unchecked("solana", "rpc: HTTP 503")


@pytest.mark.parametrize(
    "read",
    [
        lambda probe: probe.supply_check(),
        lambda probe: probe.read_balances([WALLET], CURSOR),
    ],
    ids=["supply", "balances"],
)
def test_solana_with_no_cursor_gives_a_code_and_asks_the_node_nothing(store, read):
    fake = FakeSolanaRpc(CURSOR)

    with pytest.raises(ChainUnavailable) as raised:
        read(SolanaProbe(SOLANA, fake, store))

    assert raised.value.reason == "not_synced"
    assert fake.calls == []


def test_solana_needs_no_census(store):
    assert SolanaProbe(SOLANA, FakeSolanaRpc(CURSOR), store).needs_census is False


# SolanaProbe: balances.


def test_read_balances_maps_each_reading(store, monkeypatch):
    store.write_range("solana", [], {}, CURSOR)
    monkeypatch.setattr(
        probes,
        "read_sampled_balances",
        lambda *args: [BalanceReading(WALLET, CURSOR - 2, 7), BalanceReading(OTHER_WALLET, 9, 8)],
    )

    reads = SolanaProbe(SOLANA, FakeSolanaRpc(CURSOR), store).read_balances([WALLET], CURSOR)

    assert reads == [BalanceRead(WALLET, CURSOR - 2, 7), BalanceRead(OTHER_WALLET, 9, 8)]


def test_a_balance_read_reports_its_own_slot_and_not_the_cursor(store):
    lag = CURSOR - 5
    fake = seeded_node(store)
    fake.snapshot = BalanceSnapshot(lag, {WALLET: 7})

    reads = SolanaProbe(SOLANA, fake, store).read_balances([WALLET], CURSOR)

    assert reads == [BalanceRead(WALLET, lag, 7)]


class LaggingNode(FakeSolanaRpc):
    """Answers balance reads in turn, as a node behind the cursor and then caught up would."""

    def __init__(self, head: int, snapshots: list[BalanceSnapshot]) -> None:
        super().__init__(head)
        self.snapshots = snapshots

    def token_accounts(self, mint: str) -> BalanceSnapshot:
        self.calls.append("accounts")
        return self.snapshots.pop(0)


def test_a_run_compares_a_lagging_read_at_its_own_slot_and_passes(store):
    lag = CURSOR - 5
    store.write_range(
        "solana",
        [
            solana_row(lag - 1, ZERO_ADDRESS, WALLET, 100),
            # After the first read and before the cursor. At the cursor, that read would differ.
            solana_row(lag + 2, WALLET, OTHER_WALLET, 40, tx="moved"),
        ],
        {},
        CURSOR,
    )
    fake = LaggingNode(
        CURSOR,
        [
            BalanceSnapshot(lag, {WALLET: 100}),
            BalanceSnapshot(CURSOR, {WALLET: 60, OTHER_WALLET: 40}),
        ],
    )
    fake.supply = SlotReading(CURSOR, 100)

    result = run(store, SolanaProbe(SOLANA, fake, store))

    assert result.chains["solana"] == "pass"
    heights = store.db.execute(
        "SELECT DISTINCT height FROM balance_samples WHERE chain = 'solana' ORDER BY height"
    ).fetchall()
    assert heights == [(lag,), (CURSOR,)]


# SolanaProbe: one tail re-read per run.


def test_one_tail_reread_reaches_both_checks_and_a_new_probe_gets_its_own(store, monkeypatch):
    seen: list[TailReread | None] = []

    def supply(chain, rpc, store, reread=None):
        seen.append(reread)
        return ChainReconciliation("solana", CURSOR, 0, 0, 0)

    def balances(chain, rpc, store, owners, reread=None):
        seen.append(reread)
        return []

    monkeypatch.setattr(probes, "reconcile_solana", supply)
    monkeypatch.setattr(probes, "read_sampled_balances", balances)
    store.write_range("solana", [], {}, CURSOR)
    fake = FakeSolanaRpc(CURSOR)
    probe = SolanaProbe(SOLANA, fake, store)

    probe.supply_check()
    probe.read_balances([WALLET], CURSOR)
    probe.supply_check()
    SolanaProbe(SOLANA, fake, store).supply_check()

    assert isinstance(seen[0], TailReread)
    assert seen[1] is seen[0]
    assert seen[2] is seen[0]
    assert seen[3] is not seen[0]


def test_a_run_rereads_the_tail_once_across_supply_and_balances(store):
    fake = walked_node(store)
    probe = SolanaProbe(SOLANA, fake, store)

    at(fake, CURSOR + 10)
    assert isinstance(probe.supply_check(), ChainReconciliation)
    tail = list(fake.transaction_requests)
    assert tail, "the first sync must re-read the tail"

    fake.transaction_requests.clear()
    at(fake, CURSOR + 20)
    assert isinstance(probe.read_balances([WALLET], CURSOR + 20), list)
    at(fake, CURSOR + 30)
    assert isinstance(probe.supply_check(), ChainReconciliation)
    assert fake.transaction_requests == []

    at(fake, CURSOR + 40)
    assert isinstance(SolanaProbe(SOLANA, fake, store).supply_check(), ChainReconciliation)
    assert fake.transaction_requests == tail


def test_a_balance_read_that_goes_first_spends_the_reread_too(store):
    fake = walked_node(store)
    probe = SolanaProbe(SOLANA, fake, store)

    at(fake, CURSOR + 10)
    assert isinstance(probe.read_balances([WALLET], CURSOR), list)
    assert fake.transaction_requests

    fake.transaction_requests.clear()
    at(fake, CURSOR + 20)
    assert isinstance(probe.supply_check(), ChainReconciliation)
    assert fake.transaction_requests == []


# SolanaProbe: a store conflict is proven disagreement.


def conflicting_node(store: Store) -> FakeSolanaRpc:
    """A stored transaction whose re-read says a different amount, so a sync through the tail
    raises StoreConflict. Reads stay at the cursor, where no sync runs, until `at` moves on."""
    fake = walked_node(store)
    fake.transactions["moved"] = movement("moved", START + 10, 1, 999_999)
    return fake


def test_a_store_conflict_in_solanas_supply_check_isnt_caught(store):
    fake = conflicting_node(store)
    at(fake, CURSOR + 10)

    with pytest.raises(StoreConflict):
        SolanaProbe(SOLANA, fake, store).supply_check()


def test_a_store_conflict_in_solanas_balance_read_isnt_caught(store):
    fake = conflicting_node(store)
    at(fake, CURSOR + 10)

    with pytest.raises(StoreConflict):
        SolanaProbe(SOLANA, fake, store).read_balances([WALLET], CURSOR)


def test_a_store_conflict_on_solanas_supply_is_a_fail_in_a_run(store):
    fake = conflicting_node(store)
    at(fake, CURSOR + 10)

    result = run(store, SolanaProbe(SOLANA, fake, store))

    assert result.chains["solana"] == "fail"
    assert result.status == "fail"
    assert result.exit_code == 1
    assert reasons(result, "solana")["chain_supply"] == "store_conflict"


def test_a_store_conflict_on_solanas_balances_is_a_fail_in_a_run(store):
    fake = conflicting_node(store)
    # Supply stays at the cursor, so the conflict first shows in the sync the balance read runs.
    fake.snapshot = BalanceSnapshot(CURSOR + 10, {WALLET: 1})

    result = run(store, SolanaProbe(SOLANA, fake, store))

    assert result.chains["solana"] == "fail"
    assert result.exit_code == 1
    assert reasons(result, "solana")["sampled_balances"] == "store_conflict"


# SolanaProbe: pin times.


def test_a_solana_pin_time_comes_from_the_node(store):
    fake = FakeSolanaRpc(CURSOR)
    fake.times[CURSOR] = 1_800_000_000

    assert SolanaProbe(SOLANA, fake, store).pin_timestamp(CURSOR) == 1_800_000_000


SOLANA_FAILURES = [
    HttpError("rpc: HTTP 503"),
    SolanaRpcError(-32004, "getBlockTime: not available"),
    SolanaDataError("malformed reply"),
]


class FailingNode(FakeSolanaRpc):
    def __init__(self, failure: Exception) -> None:
        super().__init__(CURSOR)
        self.failure = failure

    def block_time(self, slot: int) -> int:
        raise self.failure

    def transaction(self, signature: str) -> dict[str, Any] | None:
        raise self.failure


@pytest.mark.parametrize("failure", SOLANA_FAILURES, ids=lambda e: type(e).__name__)
def test_a_block_time_error_is_chain_unavailable(store, failure):
    with pytest.raises(ChainUnavailable) as raised:
        SolanaProbe(SOLANA, FailingNode(failure), store).pin_timestamp(CURSOR)

    assert raised.value.reason == "coverage_gap"
    assert raised.value.__cause__ is failure


def test_a_block_time_bug_is_not_mapped(store):
    with pytest.raises(KeyError):
        SolanaProbe(SOLANA, FailingNode(KeyError("bug")), store).pin_timestamp(CURSOR)


# SolanaProbe: proofs.


def proof_node(tx: dict[str, Any] | None, signature: str = "sig") -> FakeSolanaRpc:
    fake = FakeSolanaRpc(CURSOR)
    fake.transactions[signature] = tx
    return fake


def test_a_proof_carries_the_decoded_rows_and_success(store):
    tx = movement("sig", START + 10, 1, 500)
    expected = decode_transaction(tx, OUSD_MINT)
    assert expected

    proof = SolanaProbe(SOLANA, proof_node(tx), store).read_transaction_proof("sig")

    assert proof == TransactionProof(
        "sig",
        START + 10,
        True,
        [ProofTransfer(r.log_index, r.from_address, r.to_address, r.value) for r in expected],
    )


def test_a_proof_from_a_failed_transaction_isnt_a_success(store):
    tx = moved("failed_inner_move", "sig", START + 10)

    proof = SolanaProbe(SOLANA, proof_node(tx), store).read_transaction_proof("sig")

    assert proof == TransactionProof("sig", START + 10, False, [])


def test_a_null_transaction_is_none(store):
    assert SolanaProbe(SOLANA, proof_node(None), store).read_transaction_proof("sig") is None


@pytest.mark.parametrize("failure", SOLANA_FAILURES, ids=lambda e: type(e).__name__)
def test_a_solana_proof_outage_raises_rather_than_returning_none(store, failure):
    with pytest.raises(ChainUnavailable) as raised:
        SolanaProbe(SOLANA, FailingNode(failure), store).read_transaction_proof("sig")

    assert raised.value.reason == "group_proof_unavailable"
    assert raised.value.__cause__ is failure


def test_a_reply_that_cant_be_decoded_is_a_proof_outage(store):
    tx = movement("sig", START + 10, 1)
    del tx["meta"]

    with pytest.raises(ChainUnavailable) as raised:
        SolanaProbe(SOLANA, proof_node(tx), store).read_transaction_proof("sig")

    assert raised.value.reason == "group_proof_unavailable"


def test_a_proof_names_the_transaction_the_node_answered_with(store):
    tx = movement("another", START + 10, 1)

    proof = SolanaProbe(SOLANA, proof_node(tx), store).read_transaction_proof("sig")

    assert proof is not None and proof.tx_hash == "another"


def test_a_proof_keeps_to_the_mint_in_the_chains_config(store):
    tx = movement("sig", START + 10, 1)
    other_mint = dataclasses.replace(SOLANA, mint="SomeOtherMint1111111111111111111111111111111")

    configured = SolanaProbe(SOLANA, proof_node(tx), store).read_transaction_proof("sig")
    other = SolanaProbe(other_mint, proof_node(tx), store).read_transaction_proof("sig")

    assert configured is not None and configured.transfers
    assert other is not None and other.transfers == []


# SolanaProbe: whole runs.


def group_rows(tx_hash: str = "sig") -> list[Transfer]:
    return [solana_row(CURSOR - 5, WALLET, OTHER_WALLET, 1, tx=tx_hash, index=i) for i in (0, 1)]


def group_node(store: Store) -> FakeSolanaRpc:
    """Two same-looking rows in one transaction, with supply and balances agreeing."""
    rows = [solana_row(CURSOR - 9, ZERO_ADDRESS, WALLET, 100, tx="mint"), *group_rows()]
    fake = seeded_node(store, *rows)
    fake.supply = SlotReading(CURSOR, 100)
    fake.snapshot = BalanceSnapshot(CURSOR, {WALLET: 98, OTHER_WALLET: 2})
    return fake


def test_a_solana_chain_passes_a_whole_run(store):
    fake = seeded_node(store, solana_row(CURSOR, ZERO_ADDRESS, WALLET, 100))
    fake.supply = SlotReading(CURSOR, 100)
    fake.snapshot = BalanceSnapshot(CURSOR, {WALLET: 100})

    result = run(store, SolanaProbe(SOLANA, fake, store))

    assert result.chains["solana"] == "pass"
    assert reasons(result, "solana")["chain_supply"] is None


def test_a_real_group_passes_and_is_recorded_as_a_transaction_proof(store, monkeypatch):
    fake = group_node(store)
    fake.transactions["sig"] = moved("top_level_transfer", "sig", CURSOR - 5)
    monkeypatch.setattr(probes, "decode_transaction", lambda tx, mint: group_rows())

    result = run(store, SolanaProbe(SOLANA, fake, store))

    assert result.chains["solana"] == "pass"
    audit = store.db.execute(
        "SELECT status, proof_source FROM transfer_group_audits WHERE chain = 'solana'"
    ).fetchall()
    assert audit == [("real", "transaction")]


def test_a_group_in_a_failed_transaction_is_a_fail(store):
    fake = group_node(store)
    fake.transactions["sig"] = moved("failed_inner_move", "sig", CURSOR - 5)

    result = run(store, SolanaProbe(SOLANA, fake, store))

    assert result.chains["solana"] == "fail"
    assert reasons(result, "solana")["same_looking"] == "group_not_real"


def test_a_group_proof_outage_is_unchecked(store):
    fake = group_node(store)
    down = FailingNode(HttpError("rpc: gave up after 6 attempts"))
    down.supply, down.snapshot = fake.supply, fake.snapshot

    result = run(store, SolanaProbe(SOLANA, down, store))

    assert result.chains["solana"] == "unchecked"
    assert reasons(result, "solana")["same_looking"] == "group_proof_unavailable"
    detail = store.db.execute(
        "SELECT detail FROM reconciliation_checks WHERE check_name = 'same_looking'"
    ).fetchone()
    assert detail is not None
    assert json.loads(detail[0])["error"] == "HttpError"


def test_a_proof_for_another_transaction_is_unavailable_and_not_real_or_passed(store):
    fake = group_node(store)
    fake.transactions["sig"] = moved("top_level_transfer", "another", CURSOR - 5)

    result = run(store, SolanaProbe(SOLANA, fake, store))

    assert result.chains["solana"] == "unchecked"
    assert reasons(result, "solana")["same_looking"] == "group_proof_unavailable"


# build_probes.


def keyed_env() -> dict[str, str]:
    return {
        "BASE_RPC_URL": KEYED_URL,
        "SOLANA_RPC_URL": KEYED_URL,
        "TEMPO_RPC_URL": KEYED_URL,
        "ETHEREUM_RPC_URL": KEYED_URL,
        "ETHEREUM_BLOCKSCOUT_URL": f"http://blockscout.provider.invalid/api/{KEY}",
    }


def all_chains() -> list[Chain | SolanaChain]:
    env = keyed_env()
    return [load_solana(env), *load_chains(env).values()]


def test_build_probes_gives_each_chain_its_family_in_order(store):
    chains = all_chains()

    built = build_probes(chains, store)

    assert [probe.name for probe in built] == [chain.name for chain in chains]
    assert isinstance(built[0], SolanaProbe)
    assert all(isinstance(probe, EvmProbe) for probe in built[1:])
    assert {probe.name: probe.needs_census for probe in built} == {
        "solana": False,
        "tempo": False,
        "ethereum": True,
        "base": False,
    }


def test_every_client_goes_through_polite_client_with_its_throttle(store, monkeypatch):
    built: list[dict[str, Any]] = []
    real = PoliteClient

    def polite(**kwargs: Any) -> PoliteClient:
        built.append(kwargs)
        return real(**kwargs)

    monkeypatch.setattr(probes, "PoliteClient", polite)
    chains = load_chains(keyed_env())

    build_probes(all_chains(), store)

    assert built == [
        {"label": "solana-rpc", "min_interval": RPC_INTERVAL},
        {"label": "tempo-rpc", "min_interval": chains["tempo"].rpc_interval},
        {"label": "ethereum-rpc", "min_interval": chains["ethereum"].rpc_interval},
        {"label": "ethereum-blockscout", "min_interval": BLOCKSCOUT_INTERVAL},
        {"label": "base-rpc", "min_interval": chains["base"].rpc_interval},
    ]


def test_a_chain_with_no_blockscout_url_has_no_history_client():
    assert history_for(load_chains(keyed_env())["ethereum"]) is not None
    assert history_for(make_chain()) is None
    assert history_for(make_chain(blockscout_url="")) is None


def test_a_key_in_a_url_is_in_no_repr(store):
    for probe in build_probes(all_chains(), store):
        assert KEY not in repr(probe)
        assert KEY not in repr(vars(probe))


def test_a_key_in_a_url_is_in_no_label(store, monkeypatch):
    labels: list[str] = []
    real = PoliteClient

    def polite(*, label: str, min_interval: float) -> PoliteClient:
        labels.append(label)
        return real(label=label, min_interval=min_interval)

    monkeypatch.setattr(probes, "PoliteClient", polite)

    build_probes(all_chains(), store)

    assert labels
    assert not [label for label in labels if KEY in label or "provider" in label]


def links(exc: BaseException | None) -> Iterator[BaseException]:
    while exc is not None:
        yield exc
        yield from links(exc.__cause__)
        exc = exc.__context__


def assert_clean(exc: BaseException, caplog: pytest.LogCaptureFixture) -> None:
    for link in links(exc):
        for text in (str(link), repr(link), "".join(traceback.format_exception(link))):
            assert KEY not in text
    assert KEY not in caplog.text


def with_transport(monkeypatch: pytest.MonkeyPatch, handler: Any) -> None:
    """Every client the probes build answers from `handler`, with no retries to wait out."""
    real = PoliteClient

    def polite(**kwargs: Any) -> PoliteClient:
        return real(**kwargs, transport=httpx.MockTransport(handler), sleep=lambda _: None)

    monkeypatch.setattr(probes, "PoliteClient", polite)


def echoes_the_url(request: httpx.Request) -> httpx.Response:
    return httpx.Response(403, text=f"forbidden: {request.url} key {KEY}")


def test_a_failure_echoing_the_key_leaves_it_out_of_every_evm_error(store, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    with_transport(monkeypatch, echoes_the_url)
    chain = make_chain(name="base", rpc_url=KEYED_URL)
    store.write_range("base", [], {100: "0xabc"}, 100)
    probe = build_probes([chain], store)[0]

    for read in (
        probe.supply_check,
        lambda: probe.pin_timestamp(100),
        lambda: probe.read_balances([ALICE], 100),
        lambda: probe.read_transaction_proof("0x" + "d" * 64),
    ):
        with pytest.raises(ChainUnavailable) as raised:
            read()
        assert_clean(raised.value, caplog)


def test_a_failure_echoing_the_key_leaves_it_out_of_every_solana_error(store, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    with_transport(monkeypatch, echoes_the_url)
    store.write_range("solana", [], {}, CURSOR)
    probe = build_probes([load_solana({"SOLANA_RPC_URL": KEYED_URL})], store)[0]

    for read in (probe.pin_timestamp, lambda _: probe.read_transaction_proof("sig")):
        with pytest.raises(ChainUnavailable) as raised:
            read(CURSOR)
        assert_clean(raised.value, caplog)
    for unchecked in (probe.supply_check(), probe.read_balances([WALLET], CURSOR)):
        assert isinstance(unchecked, Unchecked)
        assert KEY not in unchecked.reason


def test_a_failed_run_stores_nothing_from_the_key(store, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    with_transport(monkeypatch, echoes_the_url)
    store.write_range("solana", [], {}, CURSOR)
    store.write_range("base", [], {100: "0xabc"}, 100)
    built = build_probes(
        [load_solana({"SOLANA_RPC_URL": KEYED_URL}), make_chain(name="base", rpc_url=KEYED_URL)],
        store,
    )

    result = run_reconciliation(built, store, lambda outcome: None)

    assert result.chains["solana"] == "unchecked"
    assert result.chains["base"] == "unchecked"
    rows = store.db.execute(
        "SELECT check_name, subject, status, reason, detail FROM reconciliation_checks"
    ).fetchall()
    assert rows
    assert KEY not in repr(rows)
    assert KEY not in caplog.text


# What each read targets, at the HTTP boundary.


def rpc_body(result: Any) -> httpx.Response:
    return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": result})


def test_evm_reads_target_the_configured_token_and_never_origin_dollar(store, monkeypatch):
    chain = dataclasses.replace(load_chains({"BASE_RPC_URL": KEYED_URL})["base"], reorg_lookback=2)
    tip = chain.start_block + 3
    tx_hash = "0x" + "d" * 64
    assert chain.token != ORIGIN_DOLLAR

    def block_hash(number: int) -> str:
        return f"0x{number:064x}"

    def log(address: str, index: int) -> dict[str, Any]:
        topic = "0x" + "0" * 24 + "a" * 40
        return {
            "address": address,
            "topics": [TRANSFER_TOPIC, topic, topic],
            "data": hex(5),
            "logIndex": hex(index),
        }

    calls: list[dict[str, Any]] = []

    def node(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(body)
        method, params = body["method"], body["params"]
        if method == "eth_chainId":
            return rpc_body(hex(chain.chain_id))
        if method == "eth_blockNumber":
            return rpc_body(hex(tip))
        if method == "eth_getBlockByNumber":
            number = tip - 1 if params[0] == "finalized" else int(params[0], 16)
            return rpc_body(
                {
                    "number": hex(number),
                    "hash": block_hash(number),
                    "parentHash": block_hash(number - 1),
                    "timestamp": hex(1_000),
                }
            )
        if method == "eth_getLogs":
            return rpc_body([])
        if method == "eth_call":
            return rpc_body(hex(0))
        assert method == "eth_getTransactionReceipt"
        return rpc_body(
            {
                "transactionHash": tx_hash,
                "status": "0x1",
                "blockNumber": hex(tip),
                "logs": [log(ORIGIN_DOLLAR, 0), log(chain.token, 1)],
            }
        )

    with_transport(monkeypatch, node)
    store.write_range(chain.name, [], {tip: block_hash(tip)}, tip)
    probe = build_probes([chain], store)[0]

    probe.supply_check()
    probe.read_balances([ALICE], tip)
    proof = probe.read_transaction_proof(tx_hash)

    assert proof is not None
    assert [transfer.log_index for transfer in proof.transfers] == [1]
    targets = {call["params"][0]["to"] for call in calls if call["method"] == "eth_call"} | {
        call["params"][0]["address"] for call in calls if call["method"] == "eth_getLogs"
    }
    assert targets == {chain.token}


def test_solana_reads_target_the_configured_mint(store, monkeypatch):
    calls: list[dict[str, Any]] = []

    def node(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(body)
        if body["method"] == "getGenesisHash":
            return rpc_body(solana.GENESIS_HASH)
        if body["method"] == "getSlot":
            return rpc_body(CURSOR)
        if body["method"] == "getTokenSupply":
            return rpc_body({"context": {"slot": CURSOR}, "value": {"amount": "0", "decimals": 6}})
        return rpc_body({"context": {"slot": CURSOR}, "value": load_accounts()})

    def load_accounts() -> list[dict[str, Any]]:
        return load("token_accounts_one_owner")["value"]

    with_transport(monkeypatch, node)
    store.write_range("solana", [], {}, CURSOR)
    probe = build_probes([load_solana({"SOLANA_RPC_URL": KEYED_URL})], store)[0]

    assert isinstance(probe.supply_check(), ChainReconciliation)
    assert isinstance(probe.read_balances([WALLET], CURSOR), list)

    supply = next(call for call in calls if call["method"] == "getTokenSupply")
    accounts = next(call for call in calls if call["method"] == "getProgramAccounts")
    assert supply["params"][0] == OUSD_MINT
    assert accounts["params"][1]["filters"][0]["memcmp"]["bytes"] == OUSD_MINT


# Boundaries.


def imports_of(module: Any) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(Path(module.__file__).read_text())):
        if isinstance(node, ast.Import):
            names |= {alias.name for alias in node.names}
        if isinstance(node, ast.ImportFrom):
            names.add(node.module or "")
    return names


def test_reconcile_imports_neither_solana_nor_the_probes():
    assert not {"ousd.solana", "ousd.probes"} & imports_of(reconcile)


def test_solana_uses_reconciles_unchecked():
    assert solana.Unchecked is reconcile.Unchecked
