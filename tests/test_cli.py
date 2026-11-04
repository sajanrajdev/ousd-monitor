import pytest
from conftest import make_chain
from ousd import cli
from ousd.reconcile import ChainReconciliation


def outcome(name: str, onchain: int = 5) -> ChainReconciliation:
    return ChainReconciliation(name, 10, 5, 0, onchain)


@pytest.mark.parametrize("chains", [[], ["--chain", "tempo", "--chain", "ethereum"]])
def test_at_block_needs_exactly_one_chain(chains, capsys):
    with pytest.raises(SystemExit) as stopped:
        cli.main([*chains, "reconcile", "--at-block", "5"])

    assert stopped.value.code == 2
    assert "exactly one --chain" in capsys.readouterr().err


def test_a_mismatch_exits_non_zero(store, monkeypatch):
    results = iter([outcome("one"), outcome("two", onchain=6)])
    monkeypatch.setattr(cli, "reconcile_chain", lambda *args: next(results))
    chains = [make_chain(name="one"), make_chain(name="two")]

    assert cli._reconcile(chains, store, at_block=10) == 1


def test_a_failing_chain_does_not_hide_the_one_before_it(store, monkeypatch, capsys):
    def reconcile(chain, *args):
        if chain.name == "two":
            raise ConnectionError("provider went away")
        return outcome(chain.name)

    monkeypatch.setattr(cli, "reconcile_chain", reconcile)
    chains = [make_chain(name="one"), make_chain(name="two")]

    with pytest.raises(ConnectionError):
        cli._reconcile(chains, store, at_block=10)

    assert "one at block 10: MATCH" in capsys.readouterr().out
