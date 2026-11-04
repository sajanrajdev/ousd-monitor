import httpx
import pytest
from conftest import make_chain
from ousd import cli
from ousd.http import HttpError
from ousd.ingest import SyncResult
from ousd.reconcile import ChainReconciliation
from ousd.solana import RPC_INTERVAL, BalanceCheck, BalanceDifference, Unchecked, load_solana
from ousd.store import StoreConflict


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


# Solana

SOLANA_URL = "http://solana-rpc.invalid/v2/solana-marker-key"


@pytest.fixture
def solana_env(monkeypatch, tmp_path):
    monkeypatch.setenv("OUSD_DB_PATH", str(tmp_path / "ousd.duckdb"))
    monkeypatch.setenv("SOLANA_RPC_URL", SOLANA_URL)
    monkeypatch.setenv("BASE_RPC_URL", "http://base-rpc.invalid")
    monkeypatch.setattr(cli, "bridge_total_base_units", lambda *args: 0)
    return tmp_path / "ousd.duckdb"


def balances(matched: bool = True) -> BalanceCheck:
    differences = () if matched else (BalanceDifference("WalletOne", 5, 4),)
    return BalanceCheck("solana", 77, 3, differences)


def supply(onchain: int = 5) -> ChainReconciliation:
    return ChainReconciliation("solana", 78, 5, 0, onchain)


def patch_solana(monkeypatch, balance, supply_result) -> None:
    monkeypatch.setattr(cli, "check_all_balances", lambda *args: balance)
    monkeypatch.setattr(cli, "reconcile_solana", lambda *args: supply_result)


def test_solana_sync_runs_once_and_prints_the_head_slot(solana_env, monkeypatch, capsys):
    calls = []

    def sync(chain, rpc, store):
        calls.append(chain.name)
        return SyncResult("solana", 900, 900, None, 12)

    monkeypatch.setattr(cli, "sync_solana", sync)

    assert cli.main(["--chain", "solana", "sync"]) == 0

    assert calls == ["solana"]
    assert "solana: synced to slot 900, 12 transfers stored" in capsys.readouterr().out


def test_solana_client_is_throttled_and_labelled(monkeypatch):
    built = {}
    real = cli.PoliteClient

    def polite(**kwargs):
        built.update(kwargs)
        return real(**kwargs)

    monkeypatch.setattr(cli, "PoliteClient", polite)

    cli._solana_rpc(load_solana({"SOLANA_RPC_URL": SOLANA_URL}))

    assert built == {"label": "solana-rpc", "min_interval": RPC_INTERVAL}


def test_solana_reconcile_prints_both_checks_and_exits_zero(solana_env, monkeypatch, capsys):
    calls: list[str] = []

    def check(*args):
        calls.append("balances")
        return balances()

    def reconcile(*args):
        calls.append("supply")
        return supply()

    monkeypatch.setattr(cli, "check_all_balances", check)
    monkeypatch.setattr(cli, "reconcile_solana", reconcile)

    assert cli.main(["--chain", "solana", "reconcile"]) == 0

    assert calls == ["balances", "supply"]
    out = capsys.readouterr().out
    assert "solana balances at slot 77: MATCH (3 wallets)" in out
    assert "solana at block 78: MATCH" in out


def test_a_supply_mismatch_exits_non_zero(solana_env, monkeypatch):
    patch_solana(monkeypatch, balances(), supply(onchain=6))

    assert cli.main(["--chain", "solana", "reconcile"]) == 1


def test_a_balance_mismatch_exits_non_zero_and_shows_the_wallet(solana_env, monkeypatch, capsys):
    patch_solana(monkeypatch, balances(matched=False), supply())

    assert cli.main(["--chain", "solana", "reconcile"]) == 1

    out = capsys.readouterr().out
    assert "balances at slot 77: MISMATCH" in out
    assert "WalletOne" in out
    assert "solana at block 78: MATCH" in out


def test_unchecked_balances_never_print_a_match(solana_env, monkeypatch, capsys):
    patch_solana(monkeypatch, Unchecked("solana", "balance read failed"), supply())

    assert cli.main(["--chain", "solana", "reconcile"]) == 1

    out = capsys.readouterr().out
    assert "solana: UNCHECKED: balance read failed" in out
    assert "balances at slot" not in out
    assert "solana at block 78: MATCH" in out


def test_unchecked_supply_exits_non_zero_and_leaves_solana_missing(solana_env, monkeypatch, capsys):
    patch_solana(monkeypatch, balances(), Unchecked("solana", "pin stayed behind"))

    assert cli.main(["--chain", "solana", "reconcile"]) == 1

    out = capsys.readouterr().out
    assert "solana: UNCHECKED: pin stayed behind" in out
    assert "solana at block" not in out
    assert "chains missing   tempo, ethereum, base, solana" in out


def test_many_differences_are_capped_at_ten(solana_env, monkeypatch, capsys):
    differences = tuple(BalanceDifference(f"Wallet{n:02d}", 1, 0) for n in range(12))
    check = BalanceCheck("solana", 77, 20, differences)
    patch_solana(monkeypatch, check, supply())

    assert cli.main(["--chain", "solana", "reconcile"]) == 1

    out = capsys.readouterr().out
    assert "Wallet09" in out
    assert "Wallet10" not in out
    assert "12 wallets differ in all" in out


@pytest.mark.parametrize("value", [None, "", "   "])
@pytest.mark.parametrize("command", [["sync"], ["reconcile"]])
def test_solana_needs_its_key_before_the_store_opens(monkeypatch, tmp_path, capsys, value, command):
    database = tmp_path / "ousd.duckdb"
    monkeypatch.setenv("OUSD_DB_PATH", str(database))
    if value is None:
        monkeypatch.delenv("SOLANA_RPC_URL", raising=False)
    else:
        monkeypatch.setenv("SOLANA_RPC_URL", value)

    with pytest.raises(SystemExit) as stopped:
        cli.main(["--chain", "solana", *command])

    assert stopped.value.code == 2
    assert "SOLANA_RPC_URL" in capsys.readouterr().err
    assert not database.exists()


def test_no_chain_selected_counts_solana_as_selected(monkeypatch, tmp_path, capsys):
    database = tmp_path / "ousd.duckdb"
    monkeypatch.setenv("OUSD_DB_PATH", str(database))
    monkeypatch.setenv("BASE_RPC_URL", "http://base-rpc.invalid")
    monkeypatch.setenv("SOLANA_RPC_URL", "")

    with pytest.raises(SystemExit) as stopped:
        cli.main(["sync"])

    assert stopped.value.code == 2
    err = capsys.readouterr().err
    assert "SOLANA_RPC_URL" in err
    assert "BASE_RPC_URL" not in err
    assert not database.exists()


def test_tempo_runs_without_a_solana_key_and_builds_no_solana_client(monkeypatch, tmp_path):
    monkeypatch.setenv("OUSD_DB_PATH", str(tmp_path / "ousd.duckdb"))
    monkeypatch.delenv("SOLANA_RPC_URL", raising=False)
    synced: list[str] = []
    monkeypatch.setattr(cli, "_sync", lambda chains, store: synced.extend(c.name for c in chains))
    monkeypatch.setattr(cli, "_solana_rpc", lambda chain: pytest.fail("built a Solana client"))

    cli.main(["--chain", "tempo", "sync"])

    assert synced == ["tempo"]


def test_with_every_key_set_solana_syncs_first(solana_env, monkeypatch):
    order: list[str] = []
    monkeypatch.setattr(cli, "_sync", lambda chains, store: order.extend(c.name for c in chains))

    cli.main(["sync"])

    assert order[0] == "solana"
    assert set(order) == {"solana", "tempo", "ethereum", "base"}


def test_at_block_is_refused_for_solana(solana_env, capsys):
    with pytest.raises(SystemExit) as stopped:
        cli.main(["--chain", "solana", "reconcile", "--at-block", "5"])

    assert stopped.value.code == 2
    assert "solana" in capsys.readouterr().err
    assert not solana_env.exists()


@pytest.mark.parametrize(
    ("command", "raiser"),
    [
        (["sync"], "sync_solana"),
        (["reconcile"], "check_all_balances"),
        (["reconcile"], "reconcile_solana"),
    ],
)
def test_a_store_conflict_stops_the_run_non_zero(solana_env, monkeypatch, capsys, command, raiser):
    def conflict(*args):
        raise StoreConflict("solana: abc stored differently")

    patch_solana(monkeypatch, balances(), supply())
    monkeypatch.setattr(cli, raiser, conflict)

    assert cli.main(["--chain", "solana", *command]) == 1

    captured = capsys.readouterr()
    assert "stored differently" in captured.err
    assert "Bridge comparison" not in captured.out


def test_a_failing_verbose_solana_sync_leaks_no_url(solana_env, monkeypatch, capsys, caplog):
    transport = httpx.MockTransport(lambda request: httpx.Response(500, text=f"down {SOLANA_URL}"))
    real = cli.PoliteClient
    monkeypatch.setattr(
        cli, "PoliteClient", lambda **kw: real(transport=transport, sleep=lambda _: None, **kw)
    )

    with pytest.raises(HttpError) as raised:
        cli.main(["-v", "--chain", "solana", "sync"])

    captured = capsys.readouterr()
    everything = captured.out + captured.err + caplog.text + str(raised.value)
    assert "solana-marker-key" not in everything
