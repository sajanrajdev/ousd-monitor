"""Solana sync and client. The fake node serves real fixtures, with their ids moved in memory."""

import copy
from typing import Any

import httpx
import pytest
from ousd import solana
from ousd.http import PoliteClient
from ousd.solana import (
    GENESIS_HASH,
    MINT_CREATION_SIGNATURE,
    OUSD_MINT,
    SignatureRow,
    SolanaChain,
    SolanaDataError,
    SolanaRpc,
    SolanaRpcError,
    load_solana,
    sync_solana,
)
from ousd.store import Store, StoreConflict
from solana_fakes import FakeSolanaRpc, load, movement

CHAIN = SolanaChain("solana", OUSD_MINT, "http://rpc.invalid/key")
FIRST_SLOT = 414_760_000
STEP = 10


def slot_of(i: int) -> int:
    return FIRST_SLOT + STEP * i


def history(count: int, head: int | None = None) -> FakeSolanaRpc:
    """The creation transaction, then `count` one-transfer transactions, one per slot."""
    fake = FakeSolanaRpc(head if head is not None else slot_of(count + 5))
    fake.add(load("mint_creation"))
    for i in range(count):
        fake.add(movement(f"sig{i}", slot_of(i), 1, 1000 + i))
    return fake


@pytest.fixture
def store():
    store = Store()
    yield store
    store.close()


def stored(store: Store) -> list[tuple[Any, ...]]:
    return store.db.execute(
        "SELECT block_number, log_index, tx_hash, value FROM transfers ORDER BY 1, 2"
    ).fetchall()


def test_a_cold_run_stores_everything_oldest_first_and_moves_the_cursor_to_the_head(store):
    fake = history(5)

    result = sync_solana(CHAIN, fake, store)

    assert [r[2] for r in stored(store)] == [f"sig{i}" for i in range(5)]
    assert store.synced_through("solana") == fake.head
    assert (result.tip, result.finalized, result.transfers_stored) == (fake.head, fake.head, 5)
    assert fake.transaction_requests == [MINT_CREATION_SIGNATURE, *(f"sig{i}" for i in range(5))]


def test_a_failed_signature_is_never_fetched(store):
    fake = history(3)
    fake.rows.append(SignatureRow("failed", slot_of(1), 9, True))

    sync_solana(CHAIN, fake, store)

    assert "failed" not in fake.transaction_requests
    assert len(stored(store)) == 3


def test_history_that_ends_without_the_creation_signature_writes_nothing(store):
    fake = history(3)
    fake.rows = [r for r in fake.rows if r.signature != MINT_CREATION_SIGNATURE]

    with pytest.raises(SolanaDataError, match="ended"):
        sync_solana(CHAIN, fake, store)

    assert store.synced_through("solana") is None
    assert stored(store) == []
    assert fake.transaction_requests == []


def test_a_short_page_does_not_end_the_walk(store):
    fake = history(8)
    fake.page_size = 3

    sync_solana(CHAIN, fake, store)

    assert len(stored(store)) == 8
    assert len(fake.signature_requests) == 3


class UnorderedRpc(FakeSolanaRpc):
    def signatures(self, mint, before, min_context_slot):
        page = super().signatures(mint, before, min_context_slot)
        return [page[1], page[0], *page[2:]]


def test_rows_that_do_not_descend_are_refused(store):
    fake = UnorderedRpc(slot_of(10))
    fake.add(load("mint_creation"))
    for i in range(3):
        fake.add(movement(f"sig{i}", slot_of(i), 1))

    with pytest.raises(SolanaDataError, match="out of order"):
        sync_solana(CHAIN, fake, store)

    assert stored(store) == []


def test_a_crash_keeps_a_true_cursor_and_a_second_run_finishes_the_job(store, monkeypatch):
    monkeypatch.setattr(solana, "COMMIT_EVERY", 2)
    monkeypatch.setattr(solana, "REREAD_SLOTS", 15)
    fake = history(8)
    fake.raise_on_transaction_call = 6
    with pytest.raises(RuntimeError, match="dropped"):
        sync_solana(CHAIN, fake, store)
    cursor = store.synced_through("solana")
    assert cursor is not None and cursor < fake.head
    # Everything at or below the cursor is stored, and nothing above it.
    assert {r[0] for r in stored(store)} == {s for s in map(slot_of, range(8)) if s <= cursor}

    fake.raise_on_transaction_call = None
    fake.page_size = 2
    fake.signature_requests.clear()
    sync_solana(CHAIN, fake, store)

    reference = Store()
    sync_solana(CHAIN, history(8), reference)
    assert stored(store) == stored(reference)
    reference.close()
    by_signature = {r.signature: r for r in fake.rows}
    befores = [before for before, _ in fake.signature_requests if before is not None]
    assert befores
    for before in befores:
        assert by_signature[before].slot > cursor - 15


def test_the_cursor_never_lands_on_a_slot_with_a_transaction_missing(store, monkeypatch):
    monkeypatch.setattr(solana, "COMMIT_EVERY", 2)
    fake = FakeSolanaRpc(slot_of(10))
    fake.add(load("mint_creation"))
    fake.add(movement("a", slot_of(0), 1))
    for index in (1, 2, 3):
        fake.add(movement(f"b{index}", slot_of(1), index))
    fake.add(movement("c", slot_of(2), 1))
    expected = {slot_of(0): 1, slot_of(1): 3, slot_of(2): 1}
    cursors: list[int] = []
    write = store.write_range

    def checked(chain, transfers, hashes, through):
        write(chain, transfers, hashes, through)
        cursors.append(through)
        if through in expected:
            (count,) = store.db.execute(
                "SELECT count(DISTINCT tx_hash) FROM transfers WHERE block_number = ?", [through]
            ).fetchone()
            assert count == expected[through]

    monkeypatch.setattr(store, "write_range", checked)

    sync_solana(CHAIN, fake, store)

    assert slot_of(1) in cursors
    assert len(stored(store)) == 5


def test_a_second_sync_with_nothing_new_changes_nothing(store):
    fake = history(4)
    sync_solana(CHAIN, fake, store)
    before = stored(store)
    fake.calls.clear()

    sync_solana(CHAIN, fake, store)

    assert stored(store) == before
    assert store.synced_through("solana") == fake.head
    assert "transaction" not in fake.calls

    fake.head += 1
    sync_solana(CHAIN, fake, store)
    assert stored(store) == before
    assert store.synced_through("solana") == fake.head


def test_a_signature_an_earlier_page_omitted_is_stored_by_the_next_sync(store, monkeypatch):
    monkeypatch.setattr(solana, "REREAD_SLOTS", 25)
    fake = history(6, head=slot_of(6))
    omitted = {r.signature: r for r in fake.rows if r.signature in {"sig1", "sig4"}}
    fake.rows = [r for r in fake.rows if r.signature not in omitted]
    sync_solana(CHAIN, fake, store)
    assert {"sig1", "sig4"}.isdisjoint(r[2] for r in stored(store))

    fake.rows.extend(omitted.values())
    fake.head += 1
    sync_solana(CHAIN, fake, store)

    # sig4 is inside the re-read window below the cursor. sig1 is below it, so it isn't healed.
    names = [r[2] for r in stored(store)]
    assert "sig4" in names
    assert "sig1" not in names


def test_a_reread_with_a_different_amount_is_a_conflict_and_stores_nothing(store):
    fake = history(4)
    sync_solana(CHAIN, fake, store)
    before = stored(store)
    fake.transactions["sig3"] = movement("sig3", slot_of(3), 1, 999_999)
    # A new transaction below the conflicting one lands in the same batch.
    fake.add(movement("fresh", slot_of(3) + 1, 1))
    fake.head += 1

    with pytest.raises(StoreConflict):
        sync_solana(CHAIN, fake, store)

    assert stored(store) == before
    assert store.synced_through("solana") == fake.head - 1


def test_a_reread_at_a_shifted_transaction_index_is_a_conflict_and_adds_no_row(store):
    fake = history(4)
    sync_solana(CHAIN, fake, store)
    before = stored(store)
    fake.rows = [r if r.signature != "sig3" else r._replace(transaction_index=2) for r in fake.rows]
    fake.transactions["sig3"] = movement("sig3", slot_of(3), 2, 1003)
    fake.add(movement("fresh", slot_of(3) + 1, 1))
    fake.head += 1

    with pytest.raises(StoreConflict, match="index moved"):
        sync_solana(CHAIN, fake, store)

    assert stored(store) == before


def test_through_slot_stops_there(store):
    fake = history(6)

    result = sync_solana(CHAIN, fake, store, through_slot=slot_of(2))

    assert store.synced_through("solana") == slot_of(2)
    assert [r[2] for r in stored(store)] == ["sig0", "sig1", "sig2"]
    assert result.tip == slot_of(2)
    assert "slot" not in fake.calls


def test_through_slot_at_or_below_the_cursor_asks_nothing_more_than_the_chain_check(store):
    fake = history(4)
    sync_solana(CHAIN, fake, store)
    fake.calls.clear()

    sync_solana(CHAIN, fake, store, through_slot=slot_of(1))

    assert fake.calls == ["genesis"]
    assert store.synced_through("solana") == fake.head


def test_every_signature_page_asks_for_the_head_as_its_minimum_context_slot(store):
    fake = history(6)
    fake.page_size = 2

    sync_solana(CHAIN, fake, store)

    assert {slot for _, slot in fake.signature_requests} == {fake.head}
    assert len(fake.signature_requests) > 1


def test_a_node_behind_the_head_is_retried_and_then_works(store):
    fake = history(3)
    fake.min_context_failures = 2

    sync_solana(CHAIN, fake, store)

    assert len(stored(store)) == 3
    assert fake.pauses == [solana.RETRY_PAUSE] * 2


def test_a_node_that_stays_behind_the_head_fails_after_five_retries(store):
    fake = history(3)
    fake.min_context_failures = 99

    with pytest.raises(SolanaRpcError) as raised:
        sync_solana(CHAIN, fake, store)

    assert raised.value.code == -32016
    assert "Minimum context slot has not been reached" in str(raised.value)
    assert len(fake.signature_requests) == solana.RETRIES + 1
    assert fake.pauses == [solana.RETRY_PAUSE] * solana.RETRIES
    assert store.synced_through("solana") is None


def test_another_chain_stops_before_any_other_request_and_writes_nothing(store):
    fake = history(3)
    fake.genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"

    with pytest.raises(SolanaDataError, match="mainnet"):
        sync_solana(CHAIN, fake, store)

    assert fake.calls == ["genesis"]
    assert store.synced_through("solana") is None


def test_the_genesis_constant_is_mainnets():
    assert GENESIS_HASH == "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"


def test_a_transaction_the_node_lacks_at_first_is_retried(store):
    fake = history(3)
    fake.null_for["sig1"] = 2

    sync_solana(CHAIN, fake, store)

    assert len(stored(store)) == 3
    assert fake.pauses == [solana.RETRY_PAUSE] * 2


def test_a_transaction_the_node_never_has_stops_the_sync_before_it(store, monkeypatch):
    monkeypatch.setattr(solana, "COMMIT_EVERY", 1)
    fake = history(3)
    fake.null_for["sig1"] = 99

    with pytest.raises(SolanaDataError, match="no transaction"):
        sync_solana(CHAIN, fake, store)

    assert store.synced_through("solana") == slot_of(0)
    assert "sig1" not in [r[2] for r in stored(store)]


@pytest.mark.parametrize("field", ["slot", "transactionIndex"])
def test_a_fetched_transaction_that_differs_from_its_signature_row_is_refused(field, store):
    fake = history(3)
    tx = fake.transactions["sig1"]
    assert tx is not None
    tx[field] += 1

    with pytest.raises(SolanaDataError, match="differs from its signature row"):
        sync_solana(CHAIN, fake, store)


# The client, through a mock transport.


def client(responses: list[Any], seen: list[dict[str, Any]] | None = None) -> SolanaRpc:
    queue = list(responses)
    requests = seen if seen is not None else []

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, **queue.pop(0)})

    http = PoliteClient(
        label="solana", min_interval=0, transport=httpx.MockTransport(handler), sleep=lambda _: None
    )
    return SolanaRpc(http, "http://rpc.invalid/key", sleep=lambda _: None)


def test_a_transaction_request_asks_for_parsed_finalized_data_at_version_one():
    seen: list[dict[str, Any]] = []
    rpc = client([{"result": None}], seen)

    assert rpc.transaction("abc") is None

    assert seen[0]["method"] == "getTransaction"
    assert seen[0]["params"] == [
        "abc",
        {"encoding": "jsonParsed", "commitment": "finalized", "maxSupportedTransactionVersion": 1},
    ]


def test_signatures_ask_at_finalized_with_the_context_floor_and_the_cursor():
    seen: list[dict[str, Any]] = []
    page = load("signature_page")
    rpc = client([{"result": page}], seen)

    rows = rpc.signatures(OUSD_MINT, "before-me", 123)

    options = seen[0]["params"][1]
    assert options["commitment"] == "finalized"
    assert options["minContextSlot"] == 123
    assert options["before"] == "before-me"
    assert options["limit"] == solana.SIGNATURE_PAGE
    assert [r.failed for r in rows] == [True, False, False]
    assert rows[0].slot == 464931822 and rows[0].transaction_index == 207


def test_an_unsupported_version_is_an_rpc_error_with_its_code():
    rpc = client([load("error_unsupported_version")])

    with pytest.raises(SolanaRpcError) as raised:
        rpc.transaction("abc")

    assert raised.value.code == -32015
    assert "Transaction version (1) is not supported" in str(raised.value)


def test_a_context_floor_error_keeps_its_code():
    rpc = client([load("error_min_context_slot")])

    with pytest.raises(SolanaRpcError) as raised:
        rpc.signatures(OUSD_MINT, None, 1)

    assert raised.value.code == -32016


def test_supply_block_time_and_one_owners_balance_parse_to_the_real_values():
    rpc = client(
        [
            {"result": load("token_supply")},
            {"result": load("block_time")},
            {"result": load("token_accounts_one_owner")},
        ]
    )

    supply = rpc.token_supply(OUSD_MINT)
    assert (supply.slot, supply.amount) == (465170684, 79686600186640)
    assert rpc.block_time(463296214) == 1793365664
    snapshot = rpc.token_accounts(OUSD_MINT)
    assert snapshot.slot == 465170674
    assert snapshot.balances == {"DpqFuc9Ce2Frn8dMvz8aVZoF1HusRr9gfALrtafG9x4X": 490000}


def test_token_accounts_ask_for_this_mint_and_account_type_on_token_2022():
    seen: list[dict[str, Any]] = []
    rpc = client([{"result": load("token_accounts_one_owner")}], seen)

    rpc.token_accounts(OUSD_MINT)

    program, options = seen[0]["params"]
    assert program == solana.TOKEN_2022
    assert options["withContext"] is True
    assert options["filters"] == [
        {"memcmp": {"offset": 0, "bytes": OUSD_MINT}},
        {"memcmp": {"offset": 165, "bytes": "3"}},
    ]


def test_several_token_accounts_of_one_owner_are_summed():
    result = copy.deepcopy(load("token_accounts_one_owner"))
    result["value"].append(copy.deepcopy(result["value"][0]))
    rpc = client([{"result": result}])

    assert rpc.token_accounts(OUSD_MINT).balances == {
        "DpqFuc9Ce2Frn8dMvz8aVZoF1HusRr9gfALrtafG9x4X": 980000
    }


def test_a_token_account_of_another_mint_is_refused():
    result = copy.deepcopy(load("token_accounts_one_owner"))
    result["value"][0]["account"]["data"]["parsed"]["info"]["mint"] = "other-mint"
    rpc = client([{"result": result}])

    with pytest.raises(SolanaDataError):
        rpc.token_accounts(OUSD_MINT)


def test_a_supply_with_other_decimals_is_refused():
    result = copy.deepcopy(load("token_supply"))
    result["value"]["decimals"] = 9
    rpc = client([{"result": result}])

    with pytest.raises(SolanaDataError):
        rpc.token_supply(OUSD_MINT)


@pytest.mark.parametrize("value", [None, "", "   "])
def test_an_unset_empty_or_blank_key_loads_as_the_same_empty_url(value):
    env = {} if value is None else {"SOLANA_RPC_URL": value}

    chain = load_solana(env)

    assert chain == SolanaChain("solana", OUSD_MINT, "")


def test_a_key_is_stripped():
    assert load_solana({"SOLANA_RPC_URL": " http://rpc.invalid/k \n"}).rpc_url == (
        "http://rpc.invalid/k"
    )
