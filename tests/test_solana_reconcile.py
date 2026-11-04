"""The Solana supply and balance checks. These decide what publishes, so every way a check can stop
is tested to be unchecked, and never a pass."""

import ast
import copy
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
from ousd import reconcile, solana
from ousd.decode import ZERO_ADDRESS, Transfer
from ousd.http import HttpError, PoliteClient
from ousd.reconcile import ChainReconciliation
from ousd.solana import (
    GENESIS_HASH,
    MAX_TAIL_SLOTS,
    MINT_CREATION_SIGNATURE,
    OUSD_MINT,
    BalanceCheck,
    BalanceDifference,
    BalanceReading,
    BalanceSnapshot,
    SlotReading,
    SolanaChain,
    SolanaRpc,
    SolanaRpcError,
    Unchecked,
    check_all_balances,
    read_sampled_balances,
    reconcile_solana,
    sync_solana,
)
from ousd.store import Store, StoreConflict
from solana_fakes import FakeSolanaRpc, load, movement

CHAIN = SolanaChain("solana", OUSD_MINT, "http://rpc.invalid/key")
# Above the creation transaction's slot, so a walk that reaches it stays in order.
START = 414_760_000
CURSOR = START + 100
MINTED = 30_315_020_000  # From the `mint_inner_second_mint` fixture.
BURNED = 4_917_380_000  # From the `burn_inner_second_mint` fixture.
MINT_RECEIVER = "Hmc2dLxZZ4xfHqn2wFCTBu11oCpYiuwsj23JBjJmD4ni"
ALICE = "AliceWa11et111111111111111111111111111111111"
BOB = "BobWa11et1111111111111111111111111111111111"
CAROL = "Caro1Wa11et111111111111111111111111111111111"


@pytest.fixture
def store():
    store = Store()
    yield store
    store.close()


def moved(name: str, signature: str, slot: int, index: int = 1) -> dict[str, Any]:
    """A real fixture at another signature, slot and index."""
    tx = load(name)
    tx["transaction"]["signatures"][0] = signature
    tx["slot"], tx["transactionIndex"] = slot, index
    return tx


def synced_node(store: Store) -> FakeSolanaRpc:
    """A node with a real mint and burn, and a store synced to CURSOR. Supply reads at CURSOR."""
    fake = FakeSolanaRpc(CURSOR)
    fake.add(load("mint_creation"))
    fake.add(moved("mint_inner_second_mint", "minted", START + 10))
    fake.add(moved("burn_inner_second_mint", "burned", START + 20))
    sync_solana(CHAIN, fake, store)
    fake.calls.clear()
    fake.signature_requests.clear()
    fake.transaction_requests.clear()
    fake.supply = SlotReading(CURSOR, MINTED - BURNED)
    fake.snapshot = BalanceSnapshot(CURSOR, {MINT_RECEIVER: MINTED})
    return fake


def at(fake: FakeSolanaRpc, slot: int, amount: int = MINTED - BURNED) -> None:
    """Move the node on, with its supply and balance reads reporting the slot."""
    fake.head = slot
    fake.supply = SlotReading(slot, amount)
    fake.snapshot = BalanceSnapshot(slot, fake.snapshot.balances)


def recorded(store: Store) -> list[tuple[Any, ...]]:
    return store.db.execute(
        "SELECT chain, block_number, minted, burned, onchain_supply, matched FROM reconciliations"
    ).fetchall()


def rows_at(slot: int, *moves: tuple[str, str, int]) -> list[Transfer]:
    return [
        Transfer(slot, None, 1, f"tx-{slot}-{i}", i, sender, receiver, value)
        for i, (sender, receiver, value) in enumerate(moves)
    ]


def seeded(store: Store, *moves: tuple[str, str, int], slot: int = CURSOR) -> FakeSolanaRpc:
    """Rows written straight to the store, with the cursor at their slot, and reads at the cursor.
    The node holds only the creation transaction, so a walk ends properly."""
    store.write_range("solana", rows_at(slot, *moves), {}, slot)
    fake = FakeSolanaRpc(slot)
    fake.add(load("mint_creation"))
    fake.supply = SlotReading(slot, 0)
    return fake


CHECKS: dict[str, Callable[[SolanaRpc, Store], Any]] = {
    "supply": lambda rpc, store: reconcile_solana(CHAIN, rpc, store),
    "balances": lambda rpc, store: check_all_balances(CHAIN, rpc, store),
    "sampled": lambda rpc, store: read_sampled_balances(CHAIN, rpc, store, [ALICE]),
    "census": lambda rpc, store: read_sampled_balances(CHAIN, rpc, store, None),
}
every_check = pytest.mark.parametrize("check", CHECKS.values(), ids=CHECKS.keys())


# Supply.


def test_supply_equal_to_stored_events_matches_and_records_one_row(store):
    fake = synced_node(store)
    at(fake, CURSOR + 50)

    result = reconcile_solana(CHAIN, fake, store)

    assert result == ChainReconciliation("solana", CURSOR + 50, MINTED, BURNED, MINTED - BURNED)
    assert result.difference == 0
    assert result.matched
    assert recorded(store) == [("solana", CURSOR + 50, MINTED, BURNED, MINTED - BURNED, True)]


@pytest.mark.parametrize("excess", [0, 2**60])
def test_a_difference_of_one_base_unit_is_a_recorded_mismatch(store, excess):
    store.write_range("solana", rows_at(CURSOR, (ZERO_ADDRESS, ALICE, excess + 5)), {}, CURSOR)
    fake = FakeSolanaRpc(CURSOR)
    fake.supply = SlotReading(CURSOR, excess + 6)

    result = reconcile_solana(CHAIN, fake, store)

    assert isinstance(result, ChainReconciliation)
    assert result.difference == -1
    assert not result.matched
    assert recorded(store) == [("solana", CURSOR, excess + 5, 0, excess + 6, False)]


def test_the_supply_read_comes_first_and_the_sync_goes_through_exactly_its_slot(store):
    fake = synced_node(store)
    # The node's head is past the slot the supply read reports. Only the reported slot counts.
    fake.head = CURSOR + 90
    fake.supply = SlotReading(CURSOR + 50, MINTED - BURNED)

    result = reconcile_solana(CHAIN, fake, store)

    assert fake.calls.index("supply") < fake.calls.index("genesis")
    assert fake.calls.count("supply") == 1
    assert {slot for _, slot in fake.signature_requests} == {CURSOR + 50}
    assert store.synced_through("solana") == CURSOR + 50
    assert isinstance(result, ChainReconciliation) and result.block_number == CURSOR + 50


def test_a_mint_above_the_pin_is_not_counted_or_stored(store):
    fake = synced_node(store)
    fake.add(moved("mint_inner_second_mint", "too-new", CURSOR + 51))
    at(fake, CURSOR + 50)

    result = reconcile_solana(CHAIN, fake, store)

    assert isinstance(result, ChainReconciliation) and result.matched
    assert result.minted == MINTED
    assert "too-new" not in fake.transaction_requests
    assert store.db.execute("SELECT count(*) FROM transfers").fetchone() == (2,)


def test_a_mint_in_the_tail_is_counted_at_the_pin(store):
    fake = synced_node(store)
    fake.add(moved("mint_inner_second_mint", "new", CURSOR + 20))
    at(fake, CURSOR + 50, 2 * MINTED - BURNED)

    result = reconcile_solana(CHAIN, fake, store)

    assert isinstance(result, ChainReconciliation) and result.matched
    assert result.minted == 2 * MINTED


def test_a_pin_at_the_cursor_is_compared_without_walking(store):
    fake = synced_node(store)

    result = reconcile_solana(CHAIN, fake, store)

    assert isinstance(result, ChainReconciliation) and result.matched
    assert result.block_number == store.synced_through("solana")
    assert fake.signature_requests == []


def test_a_pin_behind_the_cursor_is_read_again_and_the_newer_one_used(store):
    fake = synced_node(store)
    fake.supply_queue = [SlotReading(CURSOR - 5, 1), SlotReading(CURSOR - 1, 2)]
    at(fake, CURSOR + 5)

    result = reconcile_solana(CHAIN, fake, store)

    assert isinstance(result, ChainReconciliation) and result.matched
    assert result.block_number == CURSOR + 5
    assert fake.pauses == [solana.RETRY_PAUSE] * 2
    assert [row[1] for row in recorded(store)] == [CURSOR + 5]


def test_a_pin_behind_the_cursor_on_every_read_is_unchecked_and_records_nothing(store):
    fake = synced_node(store)
    fake.supply = SlotReading(CURSOR - 1, MINTED - BURNED)

    result = reconcile_solana(CHAIN, fake, store)

    assert isinstance(result, Unchecked)
    assert result.chain == "solana"
    assert "below the cursor" in result.reason
    assert fake.calls.count("supply") == solana.RETRIES + 1
    assert fake.pauses == [solana.RETRY_PAUSE] * solana.RETRIES
    assert recorded(store) == []
    assert store.synced_through("solana") == CURSOR


@pytest.mark.parametrize("code", [-32603, solana.MIN_CONTEXT_SLOT_NOT_REACHED])
def test_a_node_error_on_the_pin_is_unchecked_and_not_retried(store, code):
    fake = synced_node(store)
    fake.read_errors["supply"] = SolanaRpcError(code, "getTokenSupply: refused")

    result = reconcile_solana(CHAIN, fake, store)

    assert isinstance(result, Unchecked)
    assert "refused" in result.reason
    assert fake.calls.count("supply") == 1
    assert fake.pauses == []
    assert recorded(store) == []


# Every way a check can stop, on every check.


def break_context_slot(fake: FakeSolanaRpc) -> None:
    fake.min_context_failures = 99


def break_invariant(fake: FakeSolanaRpc) -> None:
    tx = movement("broken", CURSOR + 5, 1)
    tx["meta"]["postTokenBalances"][1]["uiTokenAmount"]["amount"] = "1"
    fake.add(tx)


def break_history(fake: FakeSolanaRpc) -> None:
    fake.rows = [row for row in fake.rows if row.signature != MINT_CREATION_SIGNATURE]


def break_genesis(fake: FakeSolanaRpc) -> None:
    fake.genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"


def break_transaction(fake: FakeSolanaRpc) -> None:
    fake.add(movement("missing", CURSOR + 5, 1))
    fake.null_for["missing"] = 99


def break_row(fake: FakeSolanaRpc) -> None:
    tx = fake.add(movement("shifted", CURSOR + 5, 1))
    tx["transactionIndex"] += 1


def break_slot_read(fake: FakeSolanaRpc) -> None:
    fake.read_errors["slot"] = HttpError("solana: gave up after 6 attempts: HTTP 503")


def break_read(fake: FakeSolanaRpc) -> None:
    error = HttpError("solana: gave up after 6 attempts: HTTP 503")
    fake.read_errors["supply"] = fake.read_errors["accounts"] = error


@every_check
@pytest.mark.parametrize(
    ("fault", "expected"),
    [
        (break_context_slot, "Minimum context slot"),
        (break_invariant, "broken"),
        (break_history, "ended"),
        (break_genesis, "mainnet"),
        (break_transaction, "no transaction"),
        (break_row, "differs from its signature row"),
        (break_slot_read, "HTTP 503"),
        (break_read, "HTTP 503"),
    ],
)
def test_each_failure_is_unchecked_with_a_reason_and_records_nothing(store, check, fault, expected):
    fake = synced_node(store)
    at(fake, CURSOR + 50)
    fault(fake)

    result = check(fake, store)

    assert isinstance(result, Unchecked)
    assert result.chain == "solana"
    assert expected in result.reason
    assert recorded(store) == []


@every_check
def test_with_no_cursor_a_check_says_run_sync_first_and_reads_nothing(store, check):
    fake = FakeSolanaRpc(CURSOR)

    result = check(fake, store)

    assert isinstance(result, Unchecked)
    assert "run sync first" in result.reason
    assert fake.calls == []
    assert store.synced_through("solana") is None
    assert recorded(store) == []


@every_check
def test_a_tail_over_the_limit_is_unchecked_before_any_read(store, check):
    fake = synced_node(store)
    at(fake, CURSOR + MAX_TAIL_SLOTS + 1)

    result = check(fake, store)

    assert isinstance(result, Unchecked)
    assert "run sync first" in result.reason
    assert fake.calls == ["slot"]
    assert store.synced_through("solana") == CURSOR
    assert recorded(store) == []


@every_check
def test_a_read_past_the_limit_is_unchecked_before_any_walk(store, check):
    # The head was in reach, and the read then reported a slot that isn't.
    fake = synced_node(store)
    at(fake, CURSOR + MAX_TAIL_SLOTS + 1)
    fake.head = CURSOR

    result = check(fake, store)

    assert isinstance(result, Unchecked)
    assert "genesis" not in fake.calls
    assert fake.signature_requests == []
    assert fake.transaction_requests == []
    assert recorded(store) == []


@every_check
def test_a_tail_of_exactly_the_limit_is_read(store, check):
    fake = synced_node(store)
    at(fake, CURSOR + MAX_TAIL_SLOTS)

    result = check(fake, store)

    assert not isinstance(result, Unchecked)
    assert store.synced_through("solana") == CURSOR + MAX_TAIL_SLOTS


@every_check
def test_a_store_conflict_in_the_tail_propagates_and_records_nothing(store, check):
    fake = synced_node(store)
    fake.add(movement("seen", CURSOR + 5, 1, 1_000))
    at(fake, CURSOR + 10)
    assert check(fake, store) is not None
    before = store.db.execute("SELECT count(*), sum(value) FROM transfers").fetchone()
    store.db.execute("DELETE FROM reconciliations")
    fake.transactions["seen"] = movement("seen", CURSOR + 5, 1, 999)
    at(fake, CURSOR + 20)

    with pytest.raises(StoreConflict):
        check(fake, store)

    assert recorded(store) == []
    assert store.db.execute("SELECT count(*), sum(value) FROM transfers").fetchone() == before
    assert store.synced_through("solana") == CURSOR + 10


@every_check
def test_a_bug_in_the_tail_propagates_rather_than_reading_as_unchecked(store, check):
    fake = synced_node(store)
    fake.add(movement("gone", CURSOR + 5, 1))
    del fake.transactions["gone"]
    at(fake, CURSOR + 10)

    with pytest.raises(KeyError):
        check(fake, store)

    assert recorded(store) == []


@every_check
def test_a_bug_in_a_read_propagates_rather_than_reading_as_unchecked(store, check):
    fake = synced_node(store)
    fake.read_errors["supply"] = fake.read_errors["accounts"] = KeyError("bug")

    with pytest.raises(KeyError):
        check(fake, store)

    assert recorded(store) == []


def test_a_tail_that_stops_part_way_keeps_a_true_cursor_and_is_still_unchecked(store, monkeypatch):
    monkeypatch.setattr(solana, "COMMIT_EVERY", 1)
    fake = synced_node(store)
    fake.add(movement("good", CURSOR + 5, 1))
    fake.add(movement("next", CURSOR + 6, 1))
    fake.add(movement("missing", CURSOR + 7, 1))
    fake.null_for["missing"] = 99
    at(fake, CURSOR + 10)

    result = reconcile_solana(CHAIN, fake, store)

    assert isinstance(result, Unchecked)
    cursor = store.synced_through("solana")
    assert cursor is not None and CURSOR <= cursor < CURSOR + 7
    assert recorded(store) == []


# The real client under the checks: real JSON, and no reason that holds the URL.


def real_client(results: dict[str, Any], url: str = "http://rpc.invalid/key") -> SolanaRpc:
    """A real client over a mock transport. Each method gets a result, or a whole response."""

    def handler(request: httpx.Request) -> httpx.Response:
        answer = results[json.loads(request.content)["method"]]
        if isinstance(answer, httpx.Response):
            return answer
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, **answer})

    http = PoliteClient(
        label="solana", min_interval=0, transport=httpx.MockTransport(handler), sleep=lambda _: None
    )
    return SolanaRpc(http, url, sleep=lambda _: None)


# `token_supply.json`: the slot and amount the node really reported.
SUPPLY_SLOT = 465170684
SUPPLY_AMOUNT = 79686600186640
# `token_accounts_one_owner.json`.
ACCOUNTS_SLOT = 465170674
ACCOUNTS_OWNER = "DpqFuc9Ce2Frn8dMvz8aVZoF1HusRr9gfALrtafG9x4X"


def test_a_real_supply_response_is_compared_exactly_at_the_slot_it_reports(store):
    store.write_range(
        "solana", rows_at(SUPPLY_SLOT, (ZERO_ADDRESS, ALICE, SUPPLY_AMOUNT)), {}, SUPPLY_SLOT
    )
    rpc = real_client(
        {
            "getSlot": {"result": SUPPLY_SLOT},
            "getTokenSupply": {"result": load("token_supply")},
            "getGenesisHash": {"result": GENESIS_HASH},
        }
    )

    result = reconcile_solana(CHAIN, rpc, store)

    assert result == ChainReconciliation("solana", SUPPLY_SLOT, SUPPLY_AMOUNT, 0, SUPPLY_AMOUNT)
    assert recorded(store) == [("solana", SUPPLY_SLOT, SUPPLY_AMOUNT, 0, SUPPLY_AMOUNT, True)]


def test_a_supply_with_other_decimals_is_unchecked(store):
    store.write_range("solana", [], {}, SUPPLY_SLOT)
    supply = load("token_supply")
    supply["value"]["decimals"] = 9
    rpc = real_client({"getSlot": {"result": SUPPLY_SLOT}, "getTokenSupply": {"result": supply}})

    result = reconcile_solana(CHAIN, rpc, store)

    assert isinstance(result, Unchecked)
    assert "decimals" in result.reason
    assert recorded(store) == []


def test_an_owner_with_two_real_token_accounts_is_summed(store):
    accounts = load("token_accounts_one_owner")
    accounts["value"].append(copy.deepcopy(accounts["value"][0]))
    store.write_range(
        "solana", rows_at(ACCOUNTS_SLOT, (ZERO_ADDRESS, ACCOUNTS_OWNER, 980_000)), {}, ACCOUNTS_SLOT
    )
    rpc = real_client(
        {
            "getSlot": {"result": ACCOUNTS_SLOT},
            "getProgramAccounts": {"result": accounts},
            "getGenesisHash": {"result": GENESIS_HASH},
        }
    )

    result = check_all_balances(CHAIN, rpc, store)

    assert result == BalanceCheck("solana", ACCOUNTS_SLOT, 1, ())


KEY = "SECRETKEYMARKER123"
KEYED_URLS = [
    f"http://{KEY}.rpc.invalid/v2",
    f"http://rpc.invalid/{KEY}",
    f"http://rpc.invalid/v2?api-key={KEY}",
]


def echoing(url: str, method: str) -> list[Any]:
    """Every way a node can answer with the URL or key in its text. The last is a value the parse
    error quotes back, so only the scrub keeps it out of the reason."""
    context = {"slot": url}
    malformed: dict[str, Any] = {
        "getSlot": url,
        "getTokenSupply": {"context": context, "value": {"decimals": 6, "amount": url}},
        "getProgramAccounts": {"context": context, "value": []},
    }
    return [
        httpx.Response(401, text=f"bad key at {url}: {KEY}"),
        {"error": {"code": -32000, "message": f"refused {url} for {KEY}"}},
        {"error": {"code": KEY, "message": url}},
        {"result": malformed[method]},
    ]


@pytest.mark.parametrize("url", KEYED_URLS)
@pytest.mark.parametrize("case", range(4))
@pytest.mark.parametrize(
    ("check", "method"),
    [
        (CHECKS["supply"], "getSlot"),
        (CHECKS["supply"], "getTokenSupply"),
        (CHECKS["balances"], "getSlot"),
        (CHECKS["balances"], "getProgramAccounts"),
        (CHECKS["sampled"], "getProgramAccounts"),
        (CHECKS["census"], "getProgramAccounts"),
    ],
)
def test_no_reason_holds_the_url_or_the_key(store, check, method, case, url):
    store.write_range("solana", [], {}, SUPPLY_SLOT)
    answers: dict[str, Any] = {
        "getSlot": {"result": SUPPLY_SLOT},
        "getTokenSupply": {"result": load("token_supply")},
        "getProgramAccounts": {"result": load("token_accounts_one_owner")},
        "getGenesisHash": {"result": GENESIS_HASH},
    }
    answers[method] = echoing(url, method)[case]

    result = check(real_client(answers, url), store)

    assert isinstance(result, Unchecked)
    assert result.reason
    assert KEY not in repr(result)
    assert url not in result.reason
    assert "rpc.invalid" not in result.reason


# Balances.


def test_the_balance_read_comes_first_and_the_sync_goes_through_its_slot(store):
    fake = synced_node(store)
    fake.head = CURSOR + 90
    fake.snapshot = BalanceSnapshot(CURSOR + 50, {MINT_RECEIVER: MINTED})

    check_all_balances(CHAIN, fake, store)

    assert fake.calls.index("accounts") < fake.calls.index("genesis")
    assert fake.calls.count("accounts") == 1
    assert {slot for _, slot in fake.signature_requests} == {CURSOR + 50}
    assert store.synced_through("solana") == CURSOR + 50


def test_rows_from_real_transactions_match_the_read(store):
    fake = FakeSolanaRpc(CURSOR)
    fake.add(load("mint_creation"))
    fake.add(moved("mint_inner_second_mint", "minted", START + 10))
    fake.snapshot = BalanceSnapshot(CURSOR, {MINT_RECEIVER: MINTED})
    sync_solana(CHAIN, fake, store)

    result = check_all_balances(CHAIN, fake, store)

    assert result == BalanceCheck("solana", CURSOR, 1, ())


def test_stored_rows_matching_every_owner_match_and_are_counted(store):
    fake = seeded(store, (ZERO_ADDRESS, ALICE, 100), (ALICE, BOB, 30), (ZERO_ADDRESS, CAROL, 7))
    fake.snapshot = BalanceSnapshot(CURSOR, {ALICE: 70, BOB: 30, CAROL: 7})

    result = check_all_balances(CHAIN, fake, store)

    assert isinstance(result, BalanceCheck)
    assert result.matched
    assert result.wallets_checked == 3
    assert result.slot == CURSOR
    assert result.differences == ()
    assert recorded(store) == []


@pytest.mark.parametrize("base", [0, 2**60])
def test_a_wallet_off_by_one_base_unit_shows_the_owner_and_both_amounts(store, base):
    fake = seeded(store, (ZERO_ADDRESS, ALICE, base + 100), (ZERO_ADDRESS, BOB, 5))
    fake.snapshot = BalanceSnapshot(CURSOR, {ALICE: base + 101, BOB: 5})

    result = check_all_balances(CHAIN, fake, store)

    assert isinstance(result, BalanceCheck)
    assert not result.matched
    assert result.wallets_checked == 2
    assert result.differences == (BalanceDifference(ALICE, base + 101, base + 100),)


def test_a_missed_transfer_supply_cannot_see_makes_both_wallets_differ(store):
    fake = seeded(store, (ZERO_ADDRESS, ALICE, 100))
    fake.snapshot = BalanceSnapshot(CURSOR, {ALICE: 60, BOB: 40})
    fake.supply = SlotReading(CURSOR, 100)

    supply = reconcile_solana(CHAIN, fake, store)
    balances = check_all_balances(CHAIN, fake, store)

    assert isinstance(supply, ChainReconciliation) and supply.matched
    assert isinstance(balances, BalanceCheck)
    assert not balances.matched
    assert balances.differences == (
        BalanceDifference(ALICE, 60, 100),
        BalanceDifference(BOB, 40, 0),
    )


def test_a_token_account_that_changed_owner_is_a_failure_and_not_explained_away(store):
    # Rows keep the owner at the time of the movement, and the read shows the owner now (S14).
    fake = seeded(store, (ZERO_ADDRESS, ALICE, 100))
    fake.snapshot = BalanceSnapshot(CURSOR, {BOB: 100})

    result = check_all_balances(CHAIN, fake, store)

    assert isinstance(result, BalanceCheck)
    assert not result.matched
    assert {difference.owner for difference in result.differences} == {ALICE, BOB}


def test_a_wallet_absent_from_the_read_that_nets_to_zero_is_no_difference(store):
    fake = seeded(store, (ZERO_ADDRESS, ALICE, 100), (ALICE, BOB, 100))
    fake.snapshot = BalanceSnapshot(CURSOR, {BOB: 100})

    result = check_all_balances(CHAIN, fake, store)

    assert isinstance(result, BalanceCheck)
    assert result.matched
    assert result.wallets_checked == 2


def test_a_wallet_absent_from_the_read_that_does_not_net_to_zero_is_a_difference(store):
    fake = seeded(store, (ZERO_ADDRESS, ALICE, 100), (ALICE, BOB, 60))
    fake.snapshot = BalanceSnapshot(CURSOR, {BOB: 60})

    result = check_all_balances(CHAIN, fake, store)

    assert isinstance(result, BalanceCheck)
    assert result.differences == (BalanceDifference(ALICE, 0, 40),)


def test_a_wallet_in_the_read_with_no_rows_is_a_difference_unless_it_holds_nothing(store):
    fake = seeded(store, (ZERO_ADDRESS, ALICE, 100))
    fake.snapshot = BalanceSnapshot(CURSOR, {ALICE: 100, BOB: 0})
    assert check_all_balances(CHAIN, fake, store) == BalanceCheck("solana", CURSOR, 2, ())

    fake.snapshot = BalanceSnapshot(CURSOR, {ALICE: 100, BOB: 1})
    result = check_all_balances(CHAIN, fake, store)

    assert isinstance(result, BalanceCheck)
    assert result.differences == (BalanceDifference(BOB, 1, 0),)


def test_the_zero_address_is_not_a_wallet(store):
    fake = seeded(store, (ZERO_ADDRESS, ALICE, 100), (ALICE, ZERO_ADDRESS, 40))
    fake.snapshot = BalanceSnapshot(CURSOR, {ALICE: 60})

    result = check_all_balances(CHAIN, fake, store)

    assert result == BalanceCheck("solana", CURSOR, 1, ())


def test_a_row_above_the_read_does_not_count(store):
    store.write_range("solana", rows_at(CURSOR - 10, (ZERO_ADDRESS, ALICE, 100)), {}, CURSOR - 10)
    store.write_range("solana", rows_at(CURSOR, (ALICE, BOB, 100)), {}, CURSOR)
    fake = FakeSolanaRpc(CURSOR)
    fake.snapshot = BalanceSnapshot(CURSOR - 5, {ALICE: 100})

    result = check_all_balances(CHAIN, fake, store)

    # The read is below the cursor, so the rows at its slot are all stored and it needs no retry.
    assert result == BalanceCheck("solana", CURSOR - 5, 1, ())
    assert store.synced_through("solana") == CURSOR


def test_a_movement_above_the_read_in_the_node_is_not_stored(store):
    fake = seeded(store, (ZERO_ADDRESS, ALICE, 100))
    fake.add(movement("too-new", CURSOR + 11, 1))
    fake.head = CURSOR + 50
    fake.snapshot = BalanceSnapshot(CURSOR + 10, {ALICE: 100})

    result = check_all_balances(CHAIN, fake, store)

    assert result == BalanceCheck("solana", CURSOR + 10, 1, ())
    assert "too-new" not in fake.transaction_requests


@pytest.mark.parametrize("balances", [{}, {ALICE: 0, BOB: 0}], ids=["empty", "all-zero"])
@pytest.mark.parametrize("check", [CHECKS["balances"], CHECKS["sampled"], CHECKS["census"]])
@pytest.mark.parametrize("moves", [(), ((ZERO_ADDRESS, ALICE, 100), (ALICE, ZERO_ADDRESS, 100))])
def test_a_read_where_nobody_holds_anything_is_unchecked_and_syncs_nothing(
    store, check, moves, balances
):
    # With rows that net to 0, or none at all, this would otherwise compare as a match.
    fake = seeded(store, *moves)
    fake.head = CURSOR + 10
    fake.snapshot = BalanceSnapshot(CURSOR + 10, balances)

    result = check(fake, store)

    assert isinstance(result, Unchecked)
    assert "no token account holds a balance" in result.reason
    assert "genesis" not in fake.calls
    assert store.synced_through("solana") == CURSOR


# Sampled balances.


def test_given_owners_read_only_those_at_the_one_read_slot(store):
    fake = seeded(store, (ZERO_ADDRESS, ALICE, 100))
    fake.head = CURSOR + 3
    fake.snapshot = BalanceSnapshot(CURSOR + 3, {ALICE: 100, BOB: 5, CAROL: 6})

    result = read_sampled_balances(CHAIN, fake, store, [BOB, ALICE])

    assert result == [
        BalanceReading(BOB, CURSOR + 3, 5),
        BalanceReading(ALICE, CURSOR + 3, 100),
    ]
    assert fake.calls.count("accounts") == 1
    assert fake.calls.index("accounts") < fake.calls.index("genesis")
    assert store.synced_through("solana") == CURSOR + 3


def test_none_reads_every_owner(store):
    fake = seeded(store, (ZERO_ADDRESS, ALICE, 100))
    fake.snapshot = BalanceSnapshot(CURSOR, {BOB: 5, ALICE: 100})

    result = read_sampled_balances(CHAIN, fake, store, None)

    assert result == [BalanceReading(ALICE, CURSOR, 100), BalanceReading(BOB, CURSOR, 5)]


def test_an_unknown_owner_reads_zero(store):
    fake = seeded(store, (ZERO_ADDRESS, ALICE, 100))
    fake.snapshot = BalanceSnapshot(CURSOR, {ALICE: 100})

    assert read_sampled_balances(CHAIN, fake, store, [BOB]) == [BalanceReading(BOB, CURSOR, 0)]


def test_an_empty_list_reads_nothing_and_makes_no_requests(store):
    fake = seeded(store, (ZERO_ADDRESS, ALICE, 100))

    assert read_sampled_balances(CHAIN, fake, store, []) == []
    assert fake.calls == []


def test_an_empty_list_with_no_cursor_is_unchecked_and_not_an_empty_success(store):
    fake = FakeSolanaRpc(CURSOR)

    result = read_sampled_balances(CHAIN, fake, store, [])

    assert isinstance(result, Unchecked)
    assert fake.calls == []


# Together, and the boundary between the modules.


def test_balances_then_supply_leaves_the_recorded_row_at_the_cursor(store):
    fake = synced_node(store)
    fake.snapshot = BalanceSnapshot(CURSOR + 10, {MINT_RECEIVER: MINTED})
    assert isinstance(check_all_balances(CHAIN, fake, store), BalanceCheck)
    fake.supply_queue = [SlotReading(CURSOR + 5, MINTED - BURNED)]
    at(fake, CURSOR + 20)

    result = reconcile_solana(CHAIN, fake, store)

    assert isinstance(result, ChainReconciliation)
    assert [row[1] for row in recorded(store)] == [store.synced_through("solana")] == [CURSOR + 20]


def test_supply_then_balances_moves_the_cursor_past_the_recorded_row(store):
    # Why the caller has to read balances first: the older row no longer equals the cursor.
    fake = synced_node(store)
    at(fake, CURSOR + 5)
    reconcile_solana(CHAIN, fake, store)
    at(fake, CURSOR + 10)
    check_all_balances(CHAIN, fake, store)

    assert [row[1] for row in recorded(store)] == [CURSOR + 5]
    assert store.synced_through("solana") == CURSOR + 10


def test_reconcile_imports_nothing_from_solana():
    tree = ast.parse(Path(reconcile.__file__).read_text())
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
            imported.update(alias.name for alias in node.names)

    assert not {name for name in imported if "solana" in name}
