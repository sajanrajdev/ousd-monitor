"""Decode ERC-20 Transfer logs from the two shapes our sources return."""

from dataclasses import dataclass
from typing import Any

TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"


@dataclass(frozen=True)
class Transfer:
    block_number: int
    block_hash: str | None  # Blockscout does not return it; those blocks are finalized.
    block_timestamp: int
    tx_hash: str
    log_index: int
    from_address: str
    to_address: str
    value: int  # Base units. Always an integer, never a float.


def _address_from_topic(topic: str) -> str:
    return "0x" + topic[-40:].lower()


def _decode(log: dict[str, Any], block_hash: str | None, timestamp_hex: str) -> Transfer:
    # Blockscout pads the topic list with nulls.
    topics = [topic for topic in log["topics"] if topic is not None]
    if len(topics) != 3 or topics[0].lower() != TRANSFER_TOPIC:
        raise ValueError(f"not an ERC-20 Transfer log: {log}")
    return Transfer(
        block_number=int(log["blockNumber"], 16),
        block_hash=block_hash,
        block_timestamp=int(timestamp_hex, 16),
        tx_hash=log["transactionHash"].lower(),
        log_index=int(log["logIndex"], 16),
        from_address=_address_from_topic(topics[1]),
        to_address=_address_from_topic(topics[2]),
        value=int(log["data"], 16),
    )


def decode_rpc_log(log: dict[str, Any]) -> Transfer:
    return _decode(log, log["blockHash"].lower(), log["blockTimestamp"])


def decode_blockscout_log(log: dict[str, Any]) -> Transfer:
    return _decode(log, None, log["timeStamp"])
