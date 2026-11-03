import json
from pathlib import Path

import pytest
from ousd.decode import ZERO_ADDRESS, decode_blockscout_log, decode_rpc_log

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def test_decodes_rpc_log():
    transfer = decode_rpc_log(load("rpc_log.json"))

    assert transfer.block_number == 26_334_851
    assert transfer.log_index == 587
    assert transfer.block_hash.startswith("0x245ebf46")
    assert transfer.block_timestamp == 0x6AE9EE7F
    assert transfer.from_address == ZERO_ADDRESS
    assert transfer.to_address == "0x4c2c0f0bb2631b02ac9299c59690914ee7a200b8"
    assert transfer.value == 6_301_250_000


def test_decodes_blockscout_log_with_null_padded_topics_and_no_block_hash():
    transfer = decode_blockscout_log(load("blockscout_log.json"))

    assert transfer.block_number == 25_180_434
    assert transfer.block_hash is None
    assert transfer.from_address == "0x4508a7021dfb7a1afe5ff60169c1778c303389fb"
    assert transfer.value == 1_000_000


def test_value_above_float_precision_stays_exact():
    log = load("rpc_log.json") | {"data": hex(2**53 + 1)}

    assert decode_rpc_log(log).value == 9_007_199_254_740_993


@pytest.mark.parametrize(
    "change",
    [
        {"topics": ["0x" + "1" * 64, "0x" + "0" * 64, "0x" + "0" * 64]},
        {"topics": ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]},
    ],
)
def test_rejects_logs_that_are_not_transfers(change):
    with pytest.raises(ValueError, match="not an ERC-20 Transfer"):
        decode_rpc_log(load("rpc_log.json") | change)
