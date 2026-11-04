import duckdb
import pytest
from conftest import ALICE, make_chain, rows
from ousd.cli import format_units
from ousd.decode import Transfer
from ousd.store import Store


def transfer(block: int, index: int = 0, value: int = 1) -> Transfer:
    return Transfer(block, "0x1", 1, "0x2", index, ALICE, ALICE, value)


def test_data_survives_reopening_the_database(tmp_path):
    path = tmp_path / "nested" / "test.duckdb"
    first = Store(path)
    first.write_range("testnet", [transfer(5)], {5: "0xabc"}, 5)
    first.close()

    second = Store(path)

    assert second.synced_through("testnet") == 5
    assert second.block_hashes("testnet") == {5: "0xabc"}
    assert len(rows(second)) == 1
    second.close()


def test_failed_write_leaves_nothing_behind(store):
    bad = transfer(5, value=2**200)  # Too big for HUGEINT, so the insert fails.

    with pytest.raises(duckdb.Error):
        store.write_range("testnet", [transfer(4), bad], {4: "0xabc"}, 5)

    assert rows(store) == []
    assert store.block_hashes("testnet") == {}
    assert store.synced_through("testnet") is None


def test_chains_are_kept_apart(store):
    store.write_range("one", [transfer(1)], {1: "0xa"}, 1)
    store.write_range("two", [transfer(1)], {1: "0xb"}, 1)

    store.rollback_to("one", 0)

    assert rows(store, "one") == []
    assert len(rows(store, "two")) == 1
    assert store.synced_through("two") == 1


def test_format_units_uses_exact_integer_arithmetic():
    assert format_units(872_221_164_606_640) == "872,221,164.606640"
    assert format_units(-1) == "-0.000001"
    assert format_units(0) == "0.000000"


def test_chain_repr_hides_provider_urls():
    chain = make_chain(rpc_url="https://rpc.invalid/KEY", blockscout_url="https://bs.invalid/KEY")

    assert "KEY" not in repr(chain)
