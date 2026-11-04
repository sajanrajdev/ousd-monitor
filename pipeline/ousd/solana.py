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

from typing import Any

from ousd.decode import ZERO_ADDRESS, Transfer

TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

MAX_TRANSACTION_INDEX = 1 << 19
POSITION_BITS = 12
MAX_POSITION = 1 << POSITION_BITS

_MOVEMENTS = {"mintToChecked", "burnChecked", "transferChecked"}
_OWNER_INITIALIZERS = {"initializeAccount", "initializeAccount2", "initializeAccount3"}
# The only confidential instructions that name the mint and move nothing.
_CONFIDENTIAL_ALLOWED = {"initializeConfidentialTransferMint", "updateConfidentialTransferMint"}


class SolanaDataError(RuntimeError):
    """The data can't be trusted, so the sync stops rather than store a wrong number."""


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
        found[account] = (str(owner), int(entry["uiTokenAmount"]["amount"]))
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
        value = int(info["tokenAmount"]["amount"])
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
