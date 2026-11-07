import subprocess
import sys

import httpx
import pytest
from ousd import cli, probes, reconcile, steps
from ousd.chains import REQUIRED_CHAINS
from ousd.http import HttpError, PoliteClient
from ousd.ingest import SyncResult
from ousd.reconcile import (
    BalanceFinding,
    BalanceRead,
    BridgeFigures,
    BridgeWait,
    ChainReconciliation,
    ChainUnavailable,
    CheckOutcome,
    GroupFinding,
    RunResult,
    Unchecked,
    compare_with_bridge,
)
from ousd.sources import BridgeSnapshot, bridge_snapshot
from ousd.store import Store, StoreConflict
from test_reconcile import (
    GOOD,
    NOW,
    Drift,
    DriftingRpc,
    FakeProbe,
    bridge_passes,
    no_sleep,
)

SOLANA_URL = "http://solana-rpc.invalid/v2/solana-marker-key"
BASE_URL = "http://base-rpc.invalid/v2/base-marker-key"
TEMPO_URL = "http://tempo-rpc.invalid/v2/tempo-marker-key"
ETHEREUM_URL = "http://ethereum-rpc.invalid/v2/ethereum-marker-key"
MARKERS = ("solana-marker-key", "base-marker-key", "tempo-marker-key", "ethereum-marker-key")


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("OUSD_DB_PATH", str(tmp_path / "ousd.duckdb"))
    monkeypatch.setenv("SOLANA_RPC_URL", SOLANA_URL)
    monkeypatch.setenv("BASE_RPC_URL", BASE_URL)
    monkeypatch.setenv("TEMPO_RPC_URL", TEMPO_URL)
    monkeypatch.setenv("ETHEREUM_RPC_URL", ETHEREUM_URL)
    # Never the network, whatever a test forgets to patch.
    monkeypatch.setattr(steps, "bridge_snapshot", lambda *args: GOOD)
    return tmp_path / "ousd.duckdb"


def with_fake_probes(monkeypatch, steps=None, balance_steps=None):
    """A run over fake chains with the real run_reconciliation, a Bridge that matches, and no
    waiting. `steps` maps a chain to its probe's supply steps, `balance_steps` to its balance
    reads."""

    def build(chains, store):
        built = []
        for chain in chains:
            probe = FakeProbe(store, chain.name, (steps or {}).get(chain.name, ()))
            probe.balance_steps = list((balance_steps or {}).get(chain.name, ()))
            built.append(probe)
        return built

    real = reconcile.run_reconciliation

    def run(probes_, store, report, **kwargs):
        kwargs.update(bridge=bridge_passes, sleep=no_sleep, clock=lambda: NOW)
        return real(probes_, store, report, **kwargs)

    monkeypatch.setattr(cli, "build_probes", build)
    monkeypatch.setattr(cli, "run_reconciliation", run)


def result_of(status, code, scope="full") -> RunResult:
    return RunResult("run", scope, status, code, {}, "pass", [])


# Usage


@pytest.mark.parametrize("chains", [[], ["--chain", "tempo", "--chain", "ethereum"]])
def test_at_block_needs_exactly_one_chain(chains, capsys):
    with pytest.raises(SystemExit) as stopped:
        cli.main([*chains, "reconcile", "--at-block", "5"])

    assert stopped.value.code == 2
    assert "exactly one --chain" in capsys.readouterr().err


def test_at_block_is_refused_for_solana(env, capsys):
    with pytest.raises(SystemExit) as stopped:
        cli.main(["--chain", "solana", "reconcile", "--at-block", "5"])

    assert stopped.value.code == 2
    assert "solana" in capsys.readouterr().err
    assert not env.exists()


@pytest.mark.parametrize(
    "argv",
    [
        ["reconcile", "--census", "nosuchchain"],
        ["--chain", "tempo", "reconcile", "--census", "ethereum"],
        ["--chain", "tempo", "reconcile", "--census", "tempo", "--at-block", "5"],
    ],
)
def test_a_census_the_run_cannot_honour_exits_two_before_the_store_opens(env, capsys, argv):
    with pytest.raises(SystemExit) as stopped:
        cli.main(argv)

    assert stopped.value.code == 2
    assert "--census" in capsys.readouterr().err
    assert not env.exists()


def test_census_reaches_the_run(env, monkeypatch):
    seen: dict[str, object] = {}

    def run(probes_, store, report, **kwargs):
        seen.update(kwargs, names=[probe.name for probe in probes_])
        return result_of("unchecked", 3, "partial")

    monkeypatch.setattr(cli, "run_reconciliation", run)

    code = cli.main(
        ["--chain", "tempo", "--chain", "ethereum", "reconcile", "--census", "ethereum"]
    )

    assert code == 3
    assert seen["census"] == ["ethereum"]
    assert seen["names"] == ["tempo", "ethereum"]


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


def test_a_missing_key_exits_two_for_a_full_reconcile_and_records_nothing(
    monkeypatch, tmp_path, capsys
):
    database = tmp_path / "ousd.duckdb"
    monkeypatch.setenv("OUSD_DB_PATH", str(database))
    monkeypatch.setenv("BASE_RPC_URL", BASE_URL)
    monkeypatch.delenv("SOLANA_RPC_URL", raising=False)

    with pytest.raises(SystemExit) as stopped:
        cli.main(["reconcile", "--census", "ethereum"])

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


# Exit codes and the last line


@pytest.mark.parametrize(
    ("status", "code", "line"),
    [
        ("pass", 0, "RESULT: FULL PASS"),
        ("fail", 1, "RESULT: FAIL"),
        ("unchecked", 3, "RESULT: UNCHECKED"),
    ],
)
def test_the_runs_exit_code_passes_through_with_one_result_line(
    env, monkeypatch, capsys, status, code, line
):
    monkeypatch.setattr(cli, "run_reconciliation", lambda *args, **kwargs: result_of(status, code))

    assert cli.main(["reconcile"]) == code

    results = [row for row in capsys.readouterr().out.splitlines() if row.startswith("RESULT:")]
    assert results == [line]


@pytest.mark.parametrize(
    ("argv", "status", "scope"),
    [
        (["--chain", "tempo", "reconcile"], "pass", "partial"),
        (["reconcile"], "unchecked", "full"),
        (["reconcile"], "fail", "full"),
    ],
)
def test_an_exit_zero_that_is_not_a_full_scope_pass_is_never_a_pass(
    env, monkeypatch, capsys, argv, status, scope
):
    # Even if the run claimed exit 0, only a pass at full scope may be one.
    monkeypatch.setattr(
        cli, "run_reconciliation", lambda *args, **kwargs: result_of(status, 0, scope)
    )

    assert cli.main(argv) == 3

    assert "FULL PASS" not in capsys.readouterr().out


def test_a_real_subset_run_matches_but_exits_three(env, monkeypatch, capsys):
    with_fake_probes(monkeypatch)

    assert cli.main(["--chain", "tempo", "reconcile"]) == 3

    out = capsys.readouterr().out
    assert "tempo at block 120: MATCH" in out
    assert "RESULT: UNCHECKED" in out
    assert "FULL PASS" not in out
    assert "scope: partial run" in out


def test_a_partial_run_shows_bridge_figures_as_information_only(env, monkeypatch, capsys):
    with_fake_probes(monkeypatch)

    cli.main(["--chain", "tempo", "reconcile"])

    out = capsys.readouterr().out
    assert "Bridge comparison (information only, not a check):" in out
    assert "chains missing   ethereum, base, solana" in out
    # The info block comes before the verdict, so the verdict is the last word.
    assert out.index("information only") < out.index("RESULT: UNCHECKED")


def test_a_partial_run_survives_bridge_being_down_and_leaks_nothing(env, monkeypatch, capsys):
    with_fake_probes(monkeypatch)

    def down(*args):
        raise HttpError(f"down {SOLANA_URL}")

    monkeypatch.setattr(steps, "bridge_snapshot", down)

    assert cli.main(["--chain", "tempo", "reconcile"]) == 3

    out = capsys.readouterr().out
    assert "Bridge could not be read" in out
    assert "marker-key" not in out


def test_four_passing_chains_and_bridge_exit_zero(env, monkeypatch, capsys):
    with_fake_probes(monkeypatch)

    assert cli.main(["reconcile"]) == 0

    out = capsys.readouterr().out
    for name in REQUIRED_CHAINS:
        assert f"{name} at block 120: MATCH" in out
    assert "MISMATCH" not in out
    assert "Bridge comparison, attempt 1:" in out
    # T is 1,110 s past the epoch, and the fetch was at 1,200 s.
    assert "Bridge updated   1970-01-01T00:18:30Z (age 90 s when fetched)" in out
    assert out.splitlines()[-1] == "RESULT: FULL PASS"


@pytest.mark.parametrize("missing", REQUIRED_CHAINS)
def test_removing_any_one_chain_exits_three(env, monkeypatch, capsys, missing):
    with_fake_probes(monkeypatch)
    argv = [arg for name in REQUIRED_CHAINS if name != missing for arg in ("--chain", name)]

    assert cli.main([*argv, "reconcile"]) == 3

    out = capsys.readouterr().out
    assert "RESULT: UNCHECKED" in out
    assert "FULL PASS" not in out
    assert f"chain_supply {missing}" in out


def test_an_unsynced_chain_is_unchecked_with_its_reason_and_never_a_match(env, capsys):
    assert cli.main(["--chain", "tempo", "reconcile"]) == 3

    out = capsys.readouterr().out
    assert "tempo: UNCHECKED: not_synced" in out
    assert "MATCH" not in out
    assert "RESULT: UNCHECKED" in out
    assert "  chain_supply tempo (attempt 1): UNCHECKED (not_synced)" in out


def test_a_failing_chain_does_not_hide_the_one_before_it(env, monkeypatch, capsys):
    with_fake_probes(monkeypatch, {"ethereum": [ChainUnavailable("sync_failed")]})

    assert cli.main(["--chain", "tempo", "--chain", "ethereum", "reconcile"]) == 3

    out = capsys.readouterr().out
    assert "tempo at block 120: MATCH" in out
    assert "ethereum: UNCHECKED: sync_failed" in out


def test_an_unexpected_error_in_the_second_chain_leaves_the_first_chains_lines(
    env, monkeypatch, capsys
):
    with_fake_probes(monkeypatch, {"ethereum": [ConnectionError("provider went away")]})

    with pytest.raises(ConnectionError):
        cli.main(["--chain", "tempo", "--chain", "ethereum", "reconcile"])

    assert "tempo at block 120: MATCH" in capsys.readouterr().out


def test_a_mismatch_exits_one_and_shows_both_attempts(env, monkeypatch, capsys):
    with_fake_probes(monkeypatch, {"tempo": [Drift(1), Drift(1)]})

    assert cli.main(["--chain", "tempo", "reconcile"]) == 1

    out = capsys.readouterr().out
    assert "tempo at block 120: MISMATCH" in out
    assert "tempo at block 120: MISMATCH (attempt 2)" in out
    assert "RESULT: FAIL" in out
    assert "chain_supply tempo (attempt 1): FAIL (supply_mismatch)" in out


def test_the_first_mismatch_is_listed_even_when_the_last_attempt_is_unchecked(
    env, monkeypatch, capsys
):
    steps = {"tempo": [Drift(1), ChainUnavailable("sync_failed")]}
    with_fake_probes(monkeypatch, steps)

    assert cli.main(["--chain", "tempo", "reconcile"]) == 3

    out = capsys.readouterr().out
    verdict, reasons = out.split("RESULT: UNCHECKED")
    assert "tempo at block 120: MISMATCH" in verdict
    assert "chain_supply tempo (attempt 1): FAIL (supply_mismatch)" in reasons
    assert "chain_supply tempo (attempt 2): UNCHECKED (sync_failed)" in reasons


def test_a_wallet_that_differs_is_shown_with_both_balances(env, monkeypatch, capsys):
    def off_by_one(reads):
        return [reads[0]._replace(amount=reads[0].amount + 1_000_000), *reads[1:]]

    # Wrong again on the recheck, so the chain fails.
    with_fake_probes(monkeypatch, balance_steps={"tempo": [off_by_one, off_by_one]})

    assert cli.main(["--chain", "tempo", "reconcile"]) == 1

    out = capsys.readouterr().out
    assert "tempo balances: FAIL (balance_mismatch)" in out
    assert "tempo wallet 0x" in out
    assert "on-chain" in out


def test_a_store_conflict_in_a_chain_is_a_failure(env, monkeypatch, capsys):
    with_fake_probes(monkeypatch, {"tempo": [StoreConflict("tempo: abc stored differently")]})

    assert cli.main(["--chain", "tempo", "reconcile"]) == 1

    out = capsys.readouterr().out
    assert "tempo: FAIL: store_conflict" in out
    assert "RESULT: FAIL" in out


@pytest.mark.parametrize("command", [["sync"], ["reconcile"]])
def test_a_store_conflict_that_escapes_stops_the_run_with_one(env, monkeypatch, capsys, command):
    def conflict(*args, **kwargs):
        raise StoreConflict("solana: abc stored differently")

    monkeypatch.setattr(steps, "sync_solana", conflict)
    monkeypatch.setattr(cli, "run_reconciliation", conflict)

    assert cli.main(["--chain", "solana", *command]) == 1

    captured = capsys.readouterr()
    assert "stored differently" in captured.err
    assert ("RESULT: FAIL" in captured.out) == (command == ["reconcile"])


# --at-block


def seeded_database(path) -> DriftingRpc:
    store = Store(path)
    probe = FakeProbe(store, "tempo")
    probe.supply_check()
    store.close()
    return probe.rpc


def table_rows(path, table) -> int:
    store = Store(path)
    try:
        row = store.db.execute(f"SELECT count(*) FROM {table}").fetchone()
        assert row is not None
        return row[0]
    finally:
        store.close()


def test_at_block_match_exits_three_and_writes_nothing(env, monkeypatch, capsys):
    rpc = seeded_database(env)
    before = {table: table_rows(env, table) for table in ("reconciliations", "reconciliation_runs")}
    monkeypatch.setattr(cli, "rpc_for", lambda chain: rpc)
    synced = []
    monkeypatch.setattr(steps, "sync_chain", lambda *args: synced.append(args))

    assert cli.main(["--chain", "tempo", "reconcile", "--at-block", "102"]) == 3

    out = capsys.readouterr().out
    assert "tempo at block 102: MATCH (diagnostic only, nothing recorded)" in out
    assert "RESULT: UNCHECKED" in out
    assert "FULL PASS" not in out
    assert "Bridge" not in out
    assert synced == []
    assert before == {t: table_rows(env, t) for t in before}


def test_at_block_mismatch_exits_one(env, monkeypatch, capsys):
    rpc = seeded_database(env)
    rpc.offset = 1
    monkeypatch.setattr(cli, "rpc_for", lambda chain: rpc)

    assert cli.main(["--chain", "tempo", "reconcile", "--at-block", "102"]) == 1

    out = capsys.readouterr().out
    assert "tempo at block 102: MISMATCH" in out
    assert "RESULT: FAIL" in out


def test_at_block_above_the_cursor_is_unchecked(env, monkeypatch, capsys):
    rpc = seeded_database(env)
    monkeypatch.setattr(cli, "rpc_for", lambda chain: rpc)

    assert cli.main(["--chain", "tempo", "reconcile", "--at-block", "9999"]) == 3

    assert "tempo: UNCHECKED: above_cursor" in capsys.readouterr().out


# Progress


class WalletProbe:
    name = "ethereum"
    needs_census = True

    def __init__(self, unchecked_at=None):
        self.calls = []
        self.unchecked_at = unchecked_at

    def supply_check(self):
        return Unchecked("ethereum", "never")

    def pin_timestamp(self, height):
        return height

    def read_balances(self, addresses, height):
        self.calls.append(list(addresses))
        if self.unchecked_at is not None and len(self.calls) == self.unchecked_at:
            return Unchecked("ethereum", "refused")
        return [BalanceRead(address, height, int(address)) for address in addresses]

    def read_transaction_proof(self, tx_hash):
        return None


def test_a_long_census_prints_progress_and_reads_the_same_wallets(capsys):
    wallets = [str(n) for n in range(250)]
    inner = WalletProbe()

    reads = cli._Narrated(inner, chunked=True).read_balances(wallets, 7)

    assert not isinstance(reads, Unchecked)
    assert [read.address for read in reads] == wallets
    assert {read.height for read in reads} == {7}
    assert [len(call) for call in inner.calls] == [100, 100, 50]
    out = capsys.readouterr().out
    assert "ethereum: read 100/250 wallets" in out
    assert "ethereum: read 250/250 wallets" in out


def test_a_short_read_prints_nothing_and_is_one_call(capsys):
    inner = WalletProbe()

    cli._Narrated(inner, chunked=True).read_balances(["1", "2"], 7)

    assert len(inner.calls) == 1
    assert capsys.readouterr().out == ""


def test_a_refused_chunk_ends_the_read_with_its_unchecked():
    inner = WalletProbe(unchecked_at=2)

    result = cli._Narrated(inner, chunked=True).read_balances([str(n) for n in range(250)], 7)

    assert result == Unchecked("ethereum", "refused")
    assert len(inner.calls) == 2


def test_a_read_that_cannot_be_split_is_announced_and_made_in_one_call(capsys):
    inner = WalletProbe()

    cli._Narrated(inner, chunked=False).read_balances([str(n) for n in range(250)], 7)

    assert len(inner.calls) == 1
    assert "ethereum: reading 250 wallets" in capsys.readouterr().out


def test_the_supply_check_and_proofs_say_they_are_working(capsys):
    narrated = cli._Narrated(WalletProbe(), chunked=True)

    narrated.supply_check()
    for n in range(500):
        narrated.read_transaction_proof(str(n))

    out = capsys.readouterr().out
    assert "ethereum: syncing, then reading supply" in out
    assert "ethereum: 250 transactions proven" in out
    assert "ethereum: 500 transactions proven" in out
    assert "ethereum: 251 transactions proven" not in out


# What each event prints


def test_a_group_finding_shows_its_positions_and_the_hash_signature(capsys):
    cli._report(GroupFinding("tempo", "0xabc", "not_real", (0, 1), (0,), True))

    out = capsys.readouterr().out
    assert "tempo transaction 0xabc: not real" in out
    assert "stored positions [0, 1]" in out
    assert "proven positions [0]" in out
    assert "block hash" in out


def test_a_balance_finding_shows_the_wallet_and_both_amounts(capsys):
    cli._report(BalanceFinding("tempo", 1, "0xwallet", 44, 5_000_000, 4_000_000))

    out = capsys.readouterr().out
    assert "tempo wallet 0xwallet at 44: model 5.000000, on-chain 4.000000" in out


def test_a_bridge_wait_says_how_long_and_until_when(capsys):
    cli._report(BridgeWait(1, 600, 1_800.0))

    assert "Bridge: waiting 600 s before attempt 2, until 1970-01-01T00:30:00Z" in (
        capsys.readouterr().out
    )


def test_bridge_figures_show_t_age_total_and_difference(capsys):
    comparison = compare_with_bridge([ChainReconciliation("tempo", 1, 5_000_000, 0, 5_000_000)], 7)
    cli._report(BridgeFigures(2, BridgeSnapshot(7, 1_000), 1_090.4, comparison))

    out = capsys.readouterr().out
    assert "Bridge comparison, attempt 2:" in out
    assert "Bridge updated   1970-01-01T00:16:40Z (age 90 s when fetched)" in out
    assert "chains total     5.000000" in out
    assert "Bridge total     0.000007" in out
    assert "difference       4.999993" in out


def test_equal_figures_that_were_not_accepted_are_never_a_plain_match(capsys):
    reading = ChainReconciliation("base", 9, 5, 0, 5)

    cli._report(CheckOutcome("chain_supply", "base", "unchecked", "pin_behind_cursor", 1, reading))

    out = capsys.readouterr().out
    assert "UNCHECKED (pin_behind_cursor)" in out
    assert "MATCH" not in out


# Sync


def test_solana_sync_runs_once_and_prints_the_head_slot(env, monkeypatch, capsys):
    calls = []

    def sync(chain, rpc, store):
        calls.append(chain.name)
        return SyncResult("solana", 900, 900, None, 12)

    monkeypatch.setattr(steps, "sync_solana", sync)

    assert cli.main(["--chain", "solana", "sync"]) == 0

    assert calls == ["solana"]
    assert "solana: synced to slot 900, 12 transfers stored" in capsys.readouterr().out


def test_tempo_runs_without_a_solana_key_and_builds_no_solana_client(monkeypatch, tmp_path):
    monkeypatch.setenv("OUSD_DB_PATH", str(tmp_path / "ousd.duckdb"))
    monkeypatch.delenv("SOLANA_RPC_URL", raising=False)
    synced: list[str] = []
    monkeypatch.setattr(cli, "_sync", lambda chains, store: synced.extend(c.name for c in chains))
    monkeypatch.setattr(steps, "solana_rpc_for", lambda chain: pytest.fail("built a Solana client"))
    monkeypatch.setattr(
        probes, "solana_rpc_for", lambda chain: pytest.fail("built a Solana client")
    )

    cli.main(["--chain", "tempo", "sync"])
    assert cli.main(["--chain", "tempo", "reconcile"]) == 3

    assert synced == ["tempo"]


def test_with_every_key_set_solana_syncs_first(env, monkeypatch):
    order: list[str] = []
    monkeypatch.setattr(cli, "_sync", lambda chains, store: order.extend(c.name for c in chains))

    cli.main(["sync"])

    assert order[0] == "solana"
    assert set(order) == {"solana", "tempo", "ethereum", "base"}


# Secrets


@pytest.mark.parametrize(
    "argv",
    [
        ["sync"],
        ["reconcile"],
        ["reconcile", "--census", "ethereum", "--census", "tempo"],
        ["--chain", "tempo", "reconcile", "--at-block", "10"],
        ["-v", "reconcile"],
    ],
)
def test_no_key_or_url_reaches_any_output_of_any_command(env, monkeypatch, capsys, caplog, argv):
    # A provider that fails every request and echoes the URL it was asked, which is what leaks.
    def echo(request):
        return httpx.Response(500, text=f"down {request.url} {SOLANA_URL} {TEMPO_URL}")

    real = PoliteClient

    def polite(**kwargs):
        return real(transport=httpx.MockTransport(echo), sleep=lambda _: None, **kwargs)

    monkeypatch.setattr(steps, "PoliteClient", polite)
    monkeypatch.setattr(probes, "PoliteClient", polite)
    # The real Bridge read, over the failing transport.
    monkeypatch.setattr(steps, "bridge_snapshot", bridge_snapshot)
    if "--at-block" in argv:
        store = Store(env)
        store.write_range("tempo", [], {}, 50)
        store.close()

    raised = None
    try:
        code = cli.main(argv)
    except HttpError as exc:
        raised, code = exc, None

    captured = capsys.readouterr()
    everything = captured.out + captured.err + caplog.text + (str(raised) if raised else "")
    for marker in MARKERS:
        assert marker not in everything
    assert "invalid" not in everything
    if argv[-1] == "sync":
        assert raised is not None
    else:
        assert code == 3


def test_a_held_database_exits_two_without_a_traceback_or_the_path(env, capsys):
    # DuckDB only refuses a second process, so the holder is one.
    holder = subprocess.Popen(
        [
            sys.executable,
            "-I",
            "-c",
            "import duckdb, sys; db = duckdb.connect(sys.argv[1]);"
            " print('held', flush=True); input()",
            str(env),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().strip() == "held"
        assert cli.main(["--chain", "tempo", "sync"]) == 2
    finally:
        holder.communicate("\n", timeout=30)

    captured = capsys.readouterr()
    assert "database in use: another process holds it; try again when it finishes" in captured.err
    assert str(env) not in captured.err + captured.out
    assert "RESULT" not in captured.out


def test_a_database_that_cannot_be_opened_is_not_called_held(env, capsys):
    env.mkdir()  # A directory where the file should be.

    assert cli.main(["--chain", "tempo", "sync"]) == 2

    err = capsys.readouterr().err
    assert "cannot open the database" in err
    assert "in use" not in err
    assert str(env) not in err
