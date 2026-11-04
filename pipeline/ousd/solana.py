"""Decode a Solana transaction into the rows the `transfers` table holds.

Row contract, so the store and everything after it work on Solana unchanged:

- `block_number` is the slot.
- `log_index` is `(transactionIndex << 12) | position`, where `position` is the instruction's place
  in the transaction's flattened execution order: each outer instruction, then its inner ones. It is
  unique in the slot and in execution order, as on EVM, and fits the INTEGER column.
- `block_hash` is `None`. Only finalized transactions are read, so there is no reorg to detect.
- `from_address` and `to_address` are the owners of the token accounts, not the accounts. A mint has
  `ZERO_ADDRESS` as sender and a burn has it as receiver. That value can't be a base58 address, so
  no real owner can be mistaken for a mint or burn.
- `value` is an integer in base units, from the raw `amount` string and never `uiAmount`.
"""

import logging
import os
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from functools import partial
from typing import Any, NamedTuple

from ousd.chains import DECIMALS
from ousd.decode import ZERO_ADDRESS, Transfer
from ousd.http import HttpError, PoliteClient
from ousd.ingest import SyncResult
from ousd.reconcile import ChainReconciliation
from ousd.sources import _parse
from ousd.store import Store, StoreConflict

log = logging.getLogger(__name__)

TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
OUSD_MINT = "ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB"
# Solana mainnet's genesis hash, so a devnet URL can't pass for a quiet chain.
GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
# The mint's oldest signature, its `initializeMint`. A walk that reaches it has seen all history.
MINT_CREATION_SIGNATURE = (
    "5w8xF6Bzj9UNkMyBWUPDAeUwTZtqECMXg5do4S19gthAC6JR7JSyrmUhN3VyrfBB6rvsJT4kBzejsvtRUTz5AcbW"
)
SIGNATURE_PAGE = 1000
COMMIT_EVERY = 200
# Slots below the cursor read again: a node can list a transaction late. Every plain sync does
# this, and a reconciliation run does it once. See TailReread.
REREAD_SLOTS = 2_000
# Seconds between requests to the RPC.
RPC_INTERVAL = 0.125
# A raised constant is a deliberate change: a newer version errors loudly (-32015).
MAX_TRANSACTION_VERSION = 1
# Retries of a node that is behind the head (-32016), doesn't have a signature yet, or pins
# supply below the cursor.
RETRIES = 5
RETRY_PAUSE = 2.0
MIN_CONTEXT_SLOT_NOT_REACHED = -32016
# Longest tail a check syncs, about 11 hours. More is a backfill, which would hold the DuckDB lock
# for hours without warning, so it is left to `ousd sync`.
MAX_TAIL_SLOTS = 100_000
# Furthest a balance read may sit below the cursor, about a minute. A comparison stops at the read's
# slot, so anything older would leave movements after it unchecked and still report a match.
MAX_READ_LAG_SLOTS = 150
# Longest provider text kept in an error, after scrubbing.
_DETAIL_LIMIT = 200
# Offset of the account type byte in a Token-2022 account. 2 is a mint, 3 a token account.
_ACCOUNT_TYPE_OFFSET = 165

MAX_TRANSACTION_INDEX = 1 << 19
POSITION_BITS = 12
MAX_POSITION = 1 << POSITION_BITS

_MOVEMENTS = {"mintToChecked", "burnChecked", "transferChecked"}
_OWNER_INITIALIZERS = {"initializeAccount", "initializeAccount2", "initializeAccount3"}
# The only confidential instructions that name the mint and move nothing.
_CONFIDENTIAL_ALLOWED = {"initializeConfidentialTransferMint", "updateConfidentialTransferMint"}


class SolanaDataError(RuntimeError):
    """The data can't be trusted, so the sync stops rather than store a wrong number."""


class SolanaRpcError(RuntimeError):
    """The node answered with a JSON-RPC error. `code` is its code."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


def _base_units(amount: Any) -> int:
    """An amount from a raw `amount` field, which the RPC sends as a string of digits.

    `int` alone would cut a JSON 100.9 to 100, and take a sign, spaces or underscores.
    """
    if not isinstance(amount, str) or not amount.isascii() or not amount.isdigit():
        raise ValueError("an amount is not a string of digits")
    return int(amount)


def _flatten(transaction: dict[str, Any]) -> list[dict[str, Any]]:
    """Every instruction in execution order: each outer one, then its inner ones."""
    inner: dict[int, list[dict[str, Any]]] = {}
    for group in transaction["meta"].get("innerInstructions") or []:
        inner.setdefault(int(group["index"]), []).extend(group["instructions"])
    flat: list[dict[str, Any]] = []
    for index, instruction in enumerate(transaction["transaction"]["message"]["instructions"]):
        flat.append(instruction)
        flat.extend(inner.get(index, []))
    return flat


def _balances(
    transaction: dict[str, Any], key: str, mint: str, signature: str
) -> dict[str, tuple[str, int]]:
    """Token account -> (owner, amount) for this mint, from one of the token balance lists."""
    accounts = transaction["transaction"]["message"]["accountKeys"]
    found: dict[str, tuple[str, int]] = {}
    for entry in transaction["meta"].get(key) or []:
        if entry["mint"] != mint:
            continue
        account = str(accounts[int(entry["accountIndex"])]["pubkey"])
        owner = entry.get("owner")
        if not owner:
            raise SolanaDataError(f"{signature}: token account {account} has no owner in {key}")
        if account in found:
            raise SolanaDataError(f"{signature}: token account {account} twice in {key}")
        found[account] = (str(owner), _base_units(entry["uiTokenAmount"]["amount"]))
    return found


def _check_confidential(
    instruction: dict[str, Any], mint: str, signature: str, position: int
) -> None:
    """Stop on an instruction that may move OUSD without changing a public balance."""
    parsed = instruction.get("parsed")
    if parsed is None:
        # A partially decoded Token-2022 instruction that names the mint is one we can't read.
        if instruction.get("programId") == TOKEN_2022 and mint in (
            instruction.get("accounts") or []
        ):
            raise SolanaDataError(
                f"{signature}: unparsed Token-2022 instruction {position} names the mint"
            )
        return
    if instruction.get("program") != "spl-token" or not isinstance(parsed, dict):
        return
    kind = str(parsed.get("type", ""))
    info = parsed.get("info") or {}
    if (
        "confidential" in kind.lower()
        and info.get("mint") == mint
        and kind not in _CONFIDENTIAL_ALLOWED
    ):
        raise SolanaDataError(f"{signature}: confidential instruction {kind} at {position}")


def decode_transaction(transaction: dict[str, Any], mint: str) -> list[Transfer]:
    """The OUSD movements in one `getTransaction` result (`jsonParsed`), in execution order.

    Raises SolanaDataError for anything that would make a stored number untrustworthy: a balance
    that the decoded movements don't explain, an unknown owner, an instruction we can't read, or a
    response that isn't shaped as expected.
    """
    try:
        return _decode(transaction, mint)
    except (KeyError, IndexError, TypeError, ValueError) as error:
        signature = transaction.get("transaction", {}).get("signatures", ["?"])[0]
        raise SolanaDataError(
            f"{signature}: malformed transaction ({type(error).__name__})"
        ) from error


def _decode(transaction: dict[str, Any], mint: str) -> list[Transfer]:
    signature = str(transaction["transaction"]["signatures"][0])
    slot = int(transaction["slot"])
    block_time = transaction.get("blockTime")
    transaction_index = transaction.get("transactionIndex")
    if block_time is None:
        raise SolanaDataError(f"{signature}: no blockTime")
    if transaction_index is None:
        raise SolanaDataError(f"{signature}: no transactionIndex")
    transaction_index = int(transaction_index)
    if not 0 <= transaction_index < MAX_TRANSACTION_INDEX:
        raise SolanaDataError(f"{signature}: transactionIndex {transaction_index} is out of range")

    # A failed transaction changes no balance, even if it records an OUSD instruction.
    if transaction["meta"]["err"] is not None:
        return []

    instructions = _flatten(transaction)
    if len(instructions) > MAX_POSITION:
        raise SolanaDataError(
            f"{signature}: {len(instructions)} instructions, more than the key fits"
        )

    pre = _balances(transaction, "preTokenBalances", mint, signature)
    post = _balances(transaction, "postTokenBalances", mint, signature)
    owners: dict[str, str] = {}
    for account in pre.keys() & post.keys():
        if pre[account][0] != post[account][0]:
            raise SolanaDataError(f"{signature}: token account {account} changed owner")
    for balances in (pre, post):
        for account, (owner, _) in balances.items():
            owners[account] = owner
    # An account created inside the transaction can have no balance entry. Its owner is in its
    # initializer, and a wrong owner would quietly corrupt wallet metrics, so nothing is guessed.
    for instruction in instructions:
        parsed = instruction.get("parsed")
        if (
            instruction.get("program") == "spl-token"
            and isinstance(parsed, dict)
            and parsed.get("type") in _OWNER_INITIALIZERS
            and parsed["info"].get("mint") == mint
        ):
            account = str(parsed["info"]["account"])
            owner = str(parsed["info"]["owner"])
            if owners.setdefault(account, owner) != owner:
                raise SolanaDataError(f"{signature}: token account {account} has two owners")

    def owner_of(account: str, position: int) -> str:
        if account not in owners:
            raise SolanaDataError(
                f"{signature}: no owner for token account {account} at position {position}"
            )
        return owners[account]

    rows: list[Transfer] = []
    net: dict[str, int] = {}
    for position, instruction in enumerate(instructions):
        _check_confidential(instruction, mint, signature, position)
        parsed = instruction.get("parsed")
        if (
            instruction.get("program") != "spl-token"
            or not isinstance(parsed, dict)
            or parsed.get("type") not in _MOVEMENTS
            or parsed["info"].get("mint") != mint
        ):
            continue
        kind = parsed["type"]
        info = parsed["info"]
        value = _base_units(info["tokenAmount"]["amount"])
        if kind == "mintToChecked":
            source, destination = None, str(info["account"])
        elif kind == "burnChecked":
            source, destination = str(info["account"]), None
        else:
            source, destination = str(info["source"]), str(info["destination"])
        sender = ZERO_ADDRESS if source is None else owner_of(source, position)
        receiver = ZERO_ADDRESS if destination is None else owner_of(destination, position)
        if source is not None:
            net[source] = net.get(source, 0) - value
        if destination is not None:
            net[destination] = net.get(destination, 0) + value
        rows.append(
            Transfer(
                block_number=slot,
                block_hash=None,
                block_timestamp=int(block_time),
                tx_hash=signature,
                log_index=(transaction_index << POSITION_BITS) | position,
                from_address=sender,
                to_address=receiver,
                value=value,
            )
        )

    # S4: every token account of this mint must change by exactly what the movements say.
    for account in sorted(pre.keys() | post.keys() | net.keys()):
        change = post.get(account, ("", 0))[1] - pre.get(account, ("", 0))[1]
        if change != net.get(account, 0):
            raise SolanaDataError(
                f"{signature}: token account {account} changed by {change}, "
                f"decoded {net.get(account, 0)}"
            )
    return rows


@dataclass(frozen=True)
class SolanaChain:
    name: str
    mint: str
    # Provider URLs can hold API keys, so they stay out of repr().
    rpc_url: str = field(repr=False)


def load_solana(env: Mapping[str, str] = os.environ) -> SolanaChain:
    """The chain config. An unset, empty or blank key is the same empty URL, and there is no
    public default. Whether to stop on it is the caller's rule, in `missing_rpc_keys`."""
    return SolanaChain(name="solana", mint=OUSD_MINT, rpc_url=env.get("SOLANA_RPC_URL", "").strip())


class SignatureRow(NamedTuple):
    signature: str
    slot: int
    transaction_index: int
    failed: bool


class SlotReading(NamedTuple):
    slot: int
    amount: int  # Base units.


class BalanceSnapshot(NamedTuple):
    slot: int
    balances: dict[str, int]  # Owner -> base units, summed over the owner's token accounts.


class SolanaRpc:
    def __init__(
        self, http: PoliteClient, url: str, sleep: Callable[[float], None] = time.sleep
    ) -> None:
        self._http = http
        self._url = url
        self.sleep = sleep

    def _call(self, method: str, params: list[Any]) -> Any:
        payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        body = self._http.request_json("POST", self._url, json=payload)
        if self._parse(f"{method} response", lambda: "error" in body):
            error = self._parse(f"{method} response", lambda: body["error"])
            code = self._parse(f"{method} error code", lambda: int(error["code"]))
            raise SolanaRpcError(code, self.scrub(f"{method}: {code} {error}"))
        return self._parse(f"{method} response", lambda: body["result"])

    def scrub(self, text: str) -> str:
        """Text that may hold provider data, without the URL or its key, and cut to length."""
        # Control characters go first, so none can split a key the scrub would then miss.
        printable = "".join(c for c in text if c.isprintable())
        return self._http.scrub(printable, self._url)[:_DETAIL_LIMIT]

    def _parse[T](self, what: str, read: Callable[[], T]) -> T:
        try:
            return _parse(self._http, self._url, what, read)
        except ValueError as exc:
            # Already scrubbed. Re-raised so a bad reply is a data stop, with no cause attached.
            raise SolanaDataError(str(exc)) from None

    def genesis_hash(self) -> str:
        result = self._call("getGenesisHash", [])
        return self._parse("getGenesisHash result", lambda: str(result))

    def finalized_slot(self) -> int:
        result = self._call("getSlot", [{"commitment": "finalized"}])
        return self._parse("getSlot result", lambda: int(result))

    def signatures(
        self, mint: str, before: str | None, min_context_slot: int
    ) -> list[SignatureRow]:
        """One page of signatures for the mint, newest first, at `finalized`."""
        options: dict[str, Any] = {
            "commitment": "finalized",
            "limit": SIGNATURE_PAGE,
            "minContextSlot": min_context_slot,
        }
        if before is not None:
            options["before"] = before
        page = self._call("getSignaturesForAddress", [mint, options])
        return self._parse(
            "getSignaturesForAddress result",
            lambda: [
                SignatureRow(
                    str(row["signature"]),
                    int(row["slot"]),
                    int(row["transactionIndex"]),
                    row.get("err") is not None,
                )
                for row in page
            ],
        )

    def transaction(self, signature: str) -> dict[str, Any] | None:
        """One transaction as `jsonParsed`, or None if the node doesn't have it (yet)."""
        options = {
            "encoding": "jsonParsed",
            "commitment": "finalized",
            "maxSupportedTransactionVersion": MAX_TRANSACTION_VERSION,
        }
        result = self._call("getTransaction", [signature, options])

        def read() -> dict[str, Any] | None:
            if result is None:
                return None
            if not isinstance(result, dict):
                raise TypeError("not an object")
            return result

        return self._parse("getTransaction result", read)

    def block_time(self, slot: int) -> int:
        """Unix seconds of a slot."""
        result = self._call("getBlockTime", [slot])
        return self._parse(f"getBlockTime result for slot {slot}", lambda: int(result))

    def token_supply(self, mint: str) -> SlotReading:
        result = self._call("getTokenSupply", [mint, {"commitment": "finalized"}])

        def read() -> SlotReading:
            if int(result["value"]["decimals"]) != DECIMALS:
                raise ValueError("unexpected decimals")
            return SlotReading(
                int(result["context"]["slot"]), _base_units(result["value"]["amount"])
            )

        return self._parse("getTokenSupply result", read)

    def token_accounts(self, mint: str) -> BalanceSnapshot:
        """Every token account of the mint at one slot, summed by owner."""
        options = {
            "encoding": "jsonParsed",
            "commitment": "finalized",
            "withContext": True,
            "filters": [
                {"memcmp": {"offset": 0, "bytes": mint}},
                {"memcmp": {"offset": _ACCOUNT_TYPE_OFFSET, "bytes": "3"}},
            ],
        }
        result = self._call("getProgramAccounts", [TOKEN_2022, options])

        def read() -> BalanceSnapshot:
            balances: dict[str, int] = {}
            for entry in result["value"]:
                parsed = entry["account"]["data"]["parsed"]
                info = parsed["info"]
                if parsed["type"] != "account" or info["mint"] != mint:
                    raise ValueError("a row is not a token account of this mint")
                owner = str(info["owner"])
                balances[owner] = balances.get(owner, 0) + _base_units(
                    info["tokenAmount"]["amount"]
                )
            return BalanceSnapshot(int(result["context"]["slot"]), balances)

        return self._parse("getProgramAccounts result", read)


@dataclass
class TailReread:
    """One reconciliation run's healing re-read of the tail, shared by that run's syncs.

    A run's final pin needs a window with no new rows between two reads, and refetching the tail
    makes every window as long as that refetch. So only the first sync that walks re-reads it.
    Spent only once that sync has finished, so a failed sync doesn't use it up.
    """

    spent: bool = False


def sync_solana(
    chain: SolanaChain,
    rpc: SolanaRpc,
    store: Store,
    through_slot: int | None = None,
    reread: TailReread | None = None,
) -> SyncResult:
    """Store the mint's transactions through a slot (default: the finalized head), oldest first.

    Everything at or below `synced_through` is stored, so a crash or a stop leaves a cursor that is
    still true. Only `finalized` data is read, so there is no reorg to repair. With no `reread`, the
    tail is always read again.
    """
    if rpc.genesis_hash() != GENESIS_HASH:
        raise SolanaDataError(f"{chain.name}: the RPC does not serve Solana mainnet")
    head = rpc.finalized_slot() if through_slot is None else through_slot
    cursor = store.synced_through(chain.name)
    if cursor is not None and cursor >= head:
        return SyncResult(chain.name, head, head, None, store.transfer_count(chain.name))

    # Read below the cursor again, wherever the head is: a node can list a transaction late.
    heal = reread is None or not reread.spent
    lower = None if cursor is None else cursor - REREAD_SLOTS if heal else cursor
    rows = _walk(chain, rpc, head, lower)
    fetch = [row for row in reversed(rows) if not row.failed]

    batch: list[Transfer] = []
    slots: dict[str, int] = {}
    last_slot: int | None = None
    for row in fetch:
        # Commit only between slots, so the cursor never lands on a slot with a row missing.
        if last_slot is not None and row.slot != last_slot and len(slots) >= COMMIT_EVERY:
            _commit(chain, store, batch, slots, last_slot)
            batch, slots = [], {}
        batch.extend(_fetch_decoded(rpc, row))
        slots[row.signature] = row.slot
        last_slot = row.slot
    _commit(chain, store, batch, slots, head)
    if reread is not None:
        reread.spent = True
    return SyncResult(chain.name, head, head, None, store.transfer_count(chain.name))


def _retry[T](rpc: SolanaRpc, attempt: Callable[[], T | None], retry_on_code: bool) -> T | None:
    """Call until it returns something, pausing between tries. None after the last one."""
    for tries in range(RETRIES + 1):
        if tries:
            rpc.sleep(RETRY_PAUSE)
        try:
            result = attempt()
        except SolanaRpcError as error:
            if not retry_on_code or error.code != MIN_CONTEXT_SLOT_NOT_REACHED:
                raise
            if tries == RETRIES:
                raise
            continue
        if result is not None:
            return result
    return None


def _walk(chain: SolanaChain, rpc: SolanaRpc, head: int, lower: int | None) -> list[SignatureRow]:
    """Signatures above `lower` and at or below `head`, newest first.

    Stops at a row at or below `lower`, or at the creation signature. A short page proves nothing,
    so an empty page before either of those is truncated history and raises.
    """
    rows: list[SignatureRow] = []
    before: str | None = None
    previous: tuple[int, int] | None = None
    while True:
        page = _retry(rpc, partial(rpc.signatures, chain.mint, before, head), True)
        assert page is not None  # A page is a list, even when empty.
        if not page:
            raise SolanaDataError(
                f"{chain.name}: signature history ended before its start (slot {lower}) "
                "or the mint's creation"
            )
        for row in page:
            position = (row.slot, row.transaction_index)
            if previous is not None and position >= previous:
                raise SolanaDataError(
                    f"{chain.name}: signature rows are out of order at {row.signature}"
                )
            previous = position
            if lower is not None and row.slot <= lower:
                return rows
            if row.slot <= head:
                rows.append(row)
            if row.signature == MINT_CREATION_SIGNATURE:
                return rows
        before = page[-1].signature


def _fetch_decoded(rpc: SolanaRpc, row: SignatureRow) -> list[Transfer]:
    transaction = _retry(rpc, lambda: rpc.transaction(row.signature), False)
    if transaction is None:
        raise SolanaDataError(f"{row.signature}: the node returned no transaction")
    # A node serving another fork of the history would show here, not as a wrong number.
    if (
        transaction.get("slot") != row.slot
        or transaction.get("transactionIndex") != row.transaction_index
    ):
        raise SolanaDataError(f"{row.signature}: the transaction differs from its signature row")
    return decode_transaction(transaction, OUSD_MINT)


def _commit(
    chain: SolanaChain, store: Store, batch: list[Transfer], slots: dict[str, int], through: int
) -> None:
    _refuse_rekey(chain, store, batch, slots)
    store.write_range(chain.name, batch, {}, through)
    log.info("%s: stored through slot %d", chain.name, through)


def _refuse_rekey(
    chain: SolanaChain, store: Store, batch: list[Transfer], slots: dict[str, int]
) -> None:
    """The key holds `transactionIndex`. If a stored transaction now decodes to other positions,
    the index moved, and writing would store the movement twice."""
    if not slots:
        return
    new: dict[str, set[int]] = {signature: set() for signature in slots}
    for transfer in batch:
        new[transfer.tx_hash].add(transfer.log_index)
    stored: dict[str, set[int]] = {}
    for tx_hash, log_index in store.db.execute(
        "SELECT tx_hash, log_index FROM transfers WHERE chain = ? AND block_number BETWEEN ? AND ?",
        [chain.name, min(slots.values()), max(slots.values())],
    ).fetchall():
        if tx_hash in new:
            stored.setdefault(tx_hash, set()).add(log_index)
    for tx_hash, positions in stored.items():
        if positions != new[tx_hash]:
            raise StoreConflict(
                f"{chain.name}: {tx_hash} is stored at {sorted(positions)} but now decodes to "
                f"{sorted(new[tx_hash])}. The transaction index moved"
            )


@dataclass(frozen=True)
class Unchecked:
    """Solana couldn't be checked. Nothing is proven wrong, and nothing is proven right.

    Never a pass, and never written to `reconciliations`. Unit 1.4 moves it to `reconcile.py`.
    """

    chain: str
    reason: str


class BalanceReading(NamedTuple):
    owner: str
    slot: int
    amount: int  # Base units.


class BalanceDifference(NamedTuple):
    owner: str
    onchain: int  # Base units, from the read.
    stored: int  # Base units, received minus sent in `transfers`.


@dataclass(frozen=True)
class BalanceCheck:
    chain: str
    slot: int
    wallets_checked: int
    differences: tuple[BalanceDifference, ...]

    @property
    def matched(self) -> bool:
        return not self.differences


class _NotReady(Exception):
    """The store isn't in a state a check should sync from. Its text is the Unchecked reason."""


# Only what says "couldn't check". A StoreConflict is proven disagreement and a bug is a bug, so
# both propagate rather than read as unchecked.
_CANT_CHECK = (HttpError, SolanaRpcError, SolanaDataError, _NotReady)


def _unchecked(chain: SolanaChain, rpc: SolanaRpc, error: Exception) -> Unchecked:
    # Errors built here can quote provider fields, such as a signature, that no scrub has seen.
    return Unchecked(chain.name, rpc.scrub(str(error)))


def _require_cursor(chain: SolanaChain, store: Store) -> int:
    cursor = store.synced_through(chain.name)
    if cursor is None:
        raise _NotReady(f"{chain.name}: nothing synced yet, run sync first")
    return cursor


def _require_short_tail(chain: SolanaChain, cursor: int, slot: int) -> None:
    if slot - cursor > MAX_TAIL_SLOTS:
        raise _NotReady(
            f"{chain.name}: slot {slot} is {slot - cursor} past the cursor, more than a check "
            f"syncs ({MAX_TAIL_SLOTS}), run sync first"
        )


def _require_recent_read(chain: SolanaChain, cursor: int, slot: int) -> None:
    if cursor - slot > MAX_READ_LAG_SLOTS:
        raise _NotReady(
            f"{chain.name}: the balance read at slot {slot} is {cursor - slot} below the cursor, "
            f"more than a check compares ({MAX_READ_LAG_SLOTS}), read again"
        )


def _pin_supply_and_sync(
    chain: SolanaChain, rpc: SolanaRpc, store: Store, reread: TailReread | None
) -> SlotReading:
    """Read supply, then sync through the slot that reading reports, which is what makes the
    comparison exact: `getTokenSupply` can't be read at a past slot."""
    cursor = _require_cursor(chain, store)
    # Measured before the read, so a long tail costs one request. The pin is held to it as well.
    _require_short_tail(chain, cursor, rpc.finalized_slot())

    def read() -> SlotReading | None:
        reading = rpc.token_supply(chain.mint)
        return reading if reading.slot >= cursor else None

    pin = _retry(rpc, read, False)
    if pin is None:
        # Recording it would fail the gate, which needs the row's block to equal the cursor.
        raise _NotReady(f"{chain.name}: the supply pin stayed below the cursor, slot {cursor}")
    _require_short_tail(chain, cursor, pin.slot)
    sync_solana(chain, rpc, store, through_slot=pin.slot, reread=reread)
    return pin


def _read_balances_and_sync(
    chain: SolanaChain, rpc: SolanaRpc, store: Store, reread: TailReread | None
) -> BalanceSnapshot:
    """Read every wallet, then sync through the slot the read reports.

    A read just below the cursor needs no retry, unlike supply: its rows are stored, and a
    comparison only looks at or below the read's slot. It can't see movements after that slot, so a
    miss among them waits for the next run. A read further below than `MAX_READ_LAG_SLOTS` is not
    compared at all.
    """
    cursor = _require_cursor(chain, store)
    _require_short_tail(chain, cursor, rpc.finalized_slot())
    snapshot = rpc.token_accounts(chain.mint)
    _require_recent_read(chain, cursor, snapshot.slot)
    # Nobody holding anything can't be told from a refused or truncated answer, and would compare
    # nothing, so it can't be a match.
    if not any(snapshot.balances.values()):
        raise SolanaDataError(f"{chain.name}: no token account holds a balance at {snapshot.slot}")
    _require_short_tail(chain, cursor, snapshot.slot)
    sync_solana(chain, rpc, store, through_slot=snapshot.slot, reread=reread)
    return snapshot


def reconcile_solana(
    chain: SolanaChain, rpc: SolanaRpc, store: Store, reread: TailReread | None = None
) -> ChainReconciliation | Unchecked:
    """Compare events with the supply at a pinned slot, to the base unit, and record it.

    A difference after a complete sync is a real mismatch. Anything that stops the steps before it
    is Unchecked, which records nothing. A supply match says nothing about transfers, which is what
    `check_all_balances` is for.
    """
    try:
        pin = _pin_supply_and_sync(chain, rpc, store, reread)
    except _CANT_CHECK as error:
        return _unchecked(chain, rpc, error)
    minted, burned = store.minted_and_burned(chain.name, pin.slot)
    result = ChainReconciliation(chain.name, pin.slot, minted, burned, pin.amount)
    store.record_reconciliation(chain.name, pin.slot, minted, burned, pin.amount, result.matched)
    return result


def read_sampled_balances(
    chain: SolanaChain,
    rpc: SolanaRpc,
    store: Store,
    owners: Sequence[str] | None,
    reread: TailReread | None = None,
) -> list[BalanceReading] | Unchecked:
    """On-chain balances of the given owners, or of every owner in the read for None, all at one
    slot, with the store synced through it. An owner with no token account reads 0.

    None can't show a wallet whose accounts are closed, or one a short answer left out. Only
    `check_all_balances` also looks at the wallets in the rows.
    """
    try:
        # Before the shortcut, so an unsynced chain is never an empty success.
        _require_cursor(chain, store)
        if owners is not None and not owners:
            return []
        snapshot = _read_balances_and_sync(chain, rpc, store, reread)
    except _CANT_CHECK as error:
        return _unchecked(chain, rpc, error)
    wanted = sorted(snapshot.balances) if owners is None else owners
    return [
        BalanceReading(owner, snapshot.slot, snapshot.balances.get(owner, 0)) for owner in wanted
    ]


def check_all_balances(
    chain: SolanaChain, rpc: SolanaRpc, store: Store, reread: TailReread | None = None
) -> BalanceCheck | Unchecked:
    """Compare every wallet's balance with received minus sent at the read's slot.

    This catches a missed transfer between two wallets, which supply can't see, unless a later
    movement exactly reverses it. Rows keep a token account's owner at the time of the movement,
    so an owner change also fails here, and stays a fail until someone looks (S14). A wallet in
    the rows but not in the read must net to 0, since a closed account has no entry. Nothing is
    recorded, because unit 1.4 adds the table.
    """
    try:
        snapshot = _read_balances_and_sync(chain, rpc, store, reread)
    except _CANT_CHECK as error:
        return _unchecked(chain, rpc, error)
    wallets = sorted(snapshot.balances.keys() | set(store.wallets(chain.name, snapshot.slot)))
    stored = store.balances_at(chain.name, wallets, snapshot.slot)
    differences = tuple(
        BalanceDifference(wallet, snapshot.balances.get(wallet, 0), stored[wallet])
        for wallet in wallets
        if snapshot.balances.get(wallet, 0) != stored[wallet]
    )
    return BalanceCheck(chain.name, snapshot.slot, len(wallets), differences)
