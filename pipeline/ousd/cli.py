"""Command line entry point: `ousd sync`, `reconcile`, `check` and `publish`."""

import argparse
import logging
import os
import sys
import time
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

import duckdb

from ousd.chains import (
    DECIMALS,
    DEFAULT_BRIDGE_URL,
    DEFAULT_DB_PATH,
    Chain,
    load_chains,
    missing_rpc_keys,
)
from ousd.checks import DEFAULT_MARTS_PATH, run_checks, unacceptable
from ousd.http import HttpError, PoliteClient
from ousd.ingest import sync_chain
from ousd.probes import build_probes, history_for, rpc_for, solana_rpc_for
from ousd.publish import DEFAULT_PUBLISHED_DIR, PublishRefused, PublishUnavailable, publish
from ousd.reconcile import (
    FULL_SCOPE,
    PARTIAL_SCOPE,
    BalanceFinding,
    BalanceRead,
    BridgeFigures,
    BridgeWait,
    ChainProbe,
    ChainReconciliation,
    CheckOutcome,
    GroupFinding,
    RunResult,
    Unchecked,
    check_at_block,
    compare_with_bridge,
    exit_code,
    run_reconciliation,
)
from ousd.solana import SolanaChain, load_solana, sync_solana
from ousd.sources import BridgeSnapshot, TransactionProof, bridge_snapshot
from ousd.store import Store, StoreConflict

# Wallets read per progress line, and proofs per progress line. A read this long is otherwise
# silent for minutes, and a silent gap should mean a real hang.
BALANCE_CHUNK = 100
PROOF_PROGRESS = 250

CHECK_LABELS = {
    "sampled_balances": "balances",
    "balance_census": "census",
    "same_looking": "same-looking groups",
    "bridge": "Bridge check",
}


def format_units(base_units: int) -> str:
    """Render base units as a decimal OUSD amount, using integer arithmetic only."""
    sign = "-" if base_units < 0 else ""
    whole, fraction = divmod(abs(base_units), 10**DECIMALS)
    return f"{sign}{whole:,}.{fraction:0{DECIMALS}d}"


def _say(text: str) -> None:
    print(text, flush=True)


def _sync(chains: Sequence[Chain | SolanaChain], store: Store) -> int:
    for chain in chains:
        if isinstance(chain, SolanaChain):
            solana = sync_solana(chain, solana_rpc_for(chain), store)
            print(
                f"{solana.chain}: synced to slot {solana.tip}, "
                f"{solana.transfers_stored} transfers stored"
            )
            continue
        result = sync_chain(chain, rpc_for(chain), store, history_for(chain))
        reorg = f", reorg repaired at {result.reorg_fork_block}" if result.reorg_fork_block else ""
        print(
            f"{result.chain}: synced to {result.tip} (finalized {result.finalized}), "
            f"{result.transfers_stored} transfers stored{reorg}"
        )
    return 0


class _Narrated:
    """A probe that says what it is doing, so a long read is never silent.

    Reads of wallets on an EVM chain are split into chunks, which changes nothing: every wallet is
    read at the same pinned hash. Solana's read and sync are one call, so it is announced only.
    """

    def __init__(self, probe: ChainProbe, chunked: bool) -> None:
        self.name = probe.name
        self.needs_census = probe.needs_census
        self._probe = probe
        self._chunked = chunked
        self._proofs = 0

    def supply_check(self) -> ChainReconciliation | Unchecked:
        _say(f"{self.name}: syncing, then reading supply")
        return self._probe.supply_check()

    def pin_timestamp(self, height: int) -> int:
        return self._probe.pin_timestamp(height)

    def read_balances(self, addresses: Sequence[str], height: int) -> list[BalanceRead] | Unchecked:
        total = len(addresses)
        if total <= BALANCE_CHUNK:
            return self._probe.read_balances(addresses, height)
        if not self._chunked:
            _say(f"{self.name}: reading {total} wallets")
            return self._probe.read_balances(addresses, height)
        reads: list[BalanceRead] = []
        for start in range(0, total, BALANCE_CHUNK):
            chunk = self._probe.read_balances(addresses[start : start + BALANCE_CHUNK], height)
            if isinstance(chunk, Unchecked):
                return chunk
            reads.extend(chunk)
            _say(f"{self.name}: read {len(reads)}/{total} wallets")
        return reads

    def read_transaction_proof(self, tx_hash: str) -> TransactionProof | None:
        proof = self._probe.read_transaction_proof(tx_hash)
        self._proofs += 1
        if self._proofs % PROOF_PROGRESS == 0:
            _say(f"{self.name}: {self._proofs} transactions proven")
        return proof


def _verdict(status: str, reason: str | None) -> str:
    return status.upper() if reason is None else f"{status.upper()} ({reason})"


def _print_reconciliation(outcome: CheckOutcome, result: ChainReconciliation) -> None:
    if not result.matched:
        verdict = "MISMATCH"
    elif outcome.reason == "diagnostic_only":
        verdict = "MATCH (diagnostic only, nothing recorded)"
    elif outcome.status == "pass":
        verdict = "MATCH"
    else:
        # Equal figures that were not accepted: never shown as a plain match.
        verdict = _verdict(outcome.status, outcome.reason)
    attempt = f" (attempt {outcome.attempt})" if outcome.attempt and outcome.attempt > 1 else ""
    print(f"{result.chain} at block {result.block_number}: {verdict}{attempt}")
    print(f"  minted         {format_units(result.minted)}")
    print(f"  burned         {format_units(result.burned)}")
    print(f"  mints - burns  {format_units(result.event_supply)}")
    print(f"  totalSupply()  {format_units(result.onchain_supply)}")
    print(f"  difference     {format_units(result.difference)} ({result.difference} base units)")


def _print_outcome(outcome: CheckOutcome) -> None:
    if outcome.check_name == "chain_supply":
        if outcome.reconciliation:
            _print_reconciliation(outcome, outcome.reconciliation)
        else:
            reason = outcome.reason or "no reason recorded"
            print(f"{outcome.subject}: {outcome.status.upper()}: {reason}")
        return
    label = CHECK_LABELS.get(outcome.check_name, outcome.check_name)
    subject = "" if outcome.check_name == "bridge" else f"{outcome.subject} "
    attempt = f" (attempt {outcome.attempt})" if outcome.attempt and outcome.attempt > 1 else ""
    print(f"{subject}{label}: {_verdict(outcome.status, outcome.reason)}{attempt}")


def _utc(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _print_bridge(figures: BridgeFigures, title: str) -> None:
    comparison = figures.comparison
    age = max(0, int(figures.fetched_at) - figures.snapshot.last_updated)
    print(f"{title}")
    print(f"  Bridge updated   {_utc(figures.snapshot.last_updated)} (age {age} s when fetched)")
    print(f"  chains included  {', '.join(comparison.chains_included)}")
    print(f"  chains missing   {', '.join(comparison.chains_missing) or 'none'}")
    print(f"  chains total     {format_units(comparison.chains_total)}")
    print(f"  Bridge total     {format_units(comparison.bridge_total)}")
    print(f"  difference       {format_units(comparison.difference)}")


def _report(
    event: CheckOutcome | BridgeWait | BridgeFigures | BalanceFinding | GroupFinding,
) -> None:
    """Print each event as it happens, so one chain's failure doesn't hide what the others found
    and a crash later in the run leaves everything before it on screen."""
    if isinstance(event, CheckOutcome):
        _print_outcome(event)
    elif isinstance(event, BridgeFigures):
        _print_bridge(event, f"Bridge comparison, attempt {event.attempt}:")
    elif isinstance(event, BridgeWait):
        _say(
            f"Bridge: waiting {event.seconds} s before attempt {event.attempt + 1}, "
            f"until {_utc(event.resume_at)}"
        )
    elif isinstance(event, BalanceFinding):
        print(
            f"  {event.chain} wallet {event.address} at {event.height}: "
            f"model {format_units(event.model_balance)}, "
            f"on-chain {format_units(event.observed_balance)}"
        )
    elif isinstance(event, GroupFinding):
        mixed = ", mixes rows with and without a block hash" if event.mixed_hash else ""
        print(
            f"  {event.chain} transaction {event.tx_hash}: {event.verdict.replace('_', ' ')}, "
            f"stored positions {list(event.stored_positions)}, "
            f"proven positions {list(event.proven_positions)}{mixed}"
        )


def _print_result(status: str, code: int, scope: str, outcomes: Sequence[CheckOutcome]) -> int:
    """The last word on a run. Only a status of pass, at full scope, may be a pass."""
    if code == 0 and (status != "pass" or scope != FULL_SCOPE):
        code = exit_code("unchecked")
    print(f"RESULT: {'FULL PASS' if code == 0 else 'FAIL' if code == 1 else 'UNCHECKED'}")
    if scope == PARTIAL_SCOPE:
        print("  scope: partial run, so it cannot be a full pass")
    # Every attempt, so a mismatch that a later attempt didn't repeat is still listed.
    for outcome in outcomes:
        if outcome.status != "pass":
            attempt = f" (attempt {outcome.attempt})" if outcome.attempt else ""
            print(
                f"  {outcome.check_name} {outcome.subject}{attempt}: "
                f"{_verdict(outcome.status, outcome.reason)}"
            )
    return code


def _fetch_bridge() -> BridgeSnapshot:
    url = os.environ.get("BRIDGE_API_URL", DEFAULT_BRIDGE_URL)
    return bridge_snapshot(PoliteClient(label="bridge"), url)


def _print_information(outcomes: Sequence[CheckOutcome]) -> None:
    """A partial run asks Bridge nothing, so its figures are shown here, as information only."""
    latest: dict[str, ChainReconciliation] = {}
    for outcome in outcomes:
        if outcome.check_name == "chain_supply" and outcome.reconciliation:
            latest[outcome.subject] = outcome.reconciliation
    if not latest:
        return
    title = "Bridge comparison (information only, not a check):"
    try:
        snapshot = _fetch_bridge()
    except (HttpError, ValueError):
        # No message: a provider's text can hold a URL.
        print(f"{title} Bridge could not be read")
        return
    comparison = compare_with_bridge(list(latest.values()), snapshot.total)
    _print_bridge(BridgeFigures(0, snapshot, time.time(), comparison), title)


def _check_at_block(chain: Chain, store: Store, block: int) -> int:
    """A diagnostic: nothing is recorded, no sync runs and Bridge isn't read."""
    outcome = check_at_block(chain, rpc_for(chain), store, block)
    _print_outcome(outcome)
    return _print_result(outcome.status, exit_code(outcome.status), PARTIAL_SCOPE, [outcome])


def _reconcile(
    chains: Sequence[Chain | SolanaChain],
    store: Store,
    at_block: int | None = None,
    census: Sequence[str] = (),
) -> int:
    if at_block is not None:
        chain = chains[0]
        if isinstance(chain, SolanaChain):
            raise ValueError("--at-block is not available for solana")
        return _check_at_block(chain, store, at_block)

    probes = [
        _Narrated(probe, chunked=not isinstance(chain, SolanaChain))
        for chain, probe in zip(chains, build_probes(chains, store), strict=True)
    ]
    result: RunResult = run_reconciliation(
        probes, store, _report, bridge=_fetch_bridge, census=census
    )
    if result.scope == PARTIAL_SCOPE:
        _print_information(result.outcomes)
    return _print_result(result.status, result.exit_code, result.scope, result.outcomes)


def _check(run_id: str, allow_partial: bool) -> int:
    """Run the seven checks over stored data and record them. It needs no key and no network."""
    raw_path = Path(os.environ.get("OUSD_DB_PATH", DEFAULT_DB_PATH))
    marts_path = Path(os.environ.get("OUSD_MARTS_DB_PATH", DEFAULT_MARTS_PATH))
    # Store would create a missing file, and the checks need one that holds the runs.
    if not raw_path.is_file():
        print("error: the raw database does not exist; check OUSD_DB_PATH", file=sys.stderr)
        return 1
    if not marts_path.is_file():
        print("error: the marts database does not exist; run dbt first", file=sys.stderr)
        return 1
    try:
        store = Store(raw_path)
    except duckdb.IOException:
        print("error: database in use: another process holds it", file=sys.stderr)
        return 2
    try:
        marts = duckdb.connect(str(marts_path), read_only=True)
    except duckdb.IOException:
        store.close()
        print("error: marts in use: another process holds them", file=sys.stderr)
        return 2
    try:
        results = run_checks(store, marts, run_id, allow_partial)
    finally:
        marts.close()
        store.close()
    for result in results:
        print(f"{result.name}: {result.status.upper()}: {result.detail}")
    problems = unacceptable({r.name: r.status for r in results}, allow_partial)
    skipped = any(result.status == "skipped" for result in results)
    outcome = (
        "FAILED" if problems else "LOCAL PREVIEW ONLY, NOT RECONCILED" if skipped else "PASSED"
    )
    print(f"RESULT: {outcome}")
    return 1 if problems else 0


def _publish(run_id: str, allow_partial: bool) -> int:
    try:
        folder = publish(
            run_id,
            Path(os.environ.get("OUSD_MARTS_DB_PATH", DEFAULT_MARTS_PATH)),
            Path(os.environ.get("OUSD_DB_PATH", DEFAULT_DB_PATH)),
            Path(os.environ.get("OUSD_PUBLISHED_DIR", DEFAULT_PUBLISHED_DIR)),
            allow_partial,
        )
    except PublishUnavailable as busy:
        # Not a verdict, so not exit 1, as with `reconcile`.
        print(f"error: {busy}", file=sys.stderr)
        return 2
    except PublishRefused as refusal:
        print(f"PUBLISH REFUSED: {refusal}")
        return 1
    print(f"{'LOCAL PREVIEW, NOT A RELEASE' if allow_partial else 'PUBLISHED'}: {folder}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ousd", description=__doc__)
    parser.add_argument("--chain", action="append", help="limit to this chain (repeatable)")
    parser.add_argument("-v", "--verbose", action="store_true", help="log progress")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("sync", help="ingest transfers up to the tip and repair reorgs")
    reconcile = commands.add_parser("reconcile", help="compare events with totalSupply()")
    reconcile.add_argument("--at-block", type=int, help="check a past block (needs archive state)")
    reconcile.add_argument(
        "--census",
        action="append",
        default=[],
        metavar="CHAIN",
        help="read every wallet of this chain (repeatable)",
    )
    for name, summary in (
        ("check", "run the seven blocking checks over stored data and record them"),
        ("publish", "write the dataset, only if this run's recorded checks all passed"),
    ):
        command = commands.add_parser(
            name,
            help=summary,
            description=summary,
            epilog="Exit 0 on success, 1 on a failure or refusal, 2 when a database is in use. "
            "Paths: OUSD_DB_PATH, OUSD_MARTS_DB_PATH, OUSD_PUBLISHED_DIR.",
        )
        command.add_argument("--run-id", required=True, help="the run these checks belong to")
        command.add_argument(
            "--allow-partial",
            action="store_true",
            help="local preview only, never a release: tolerate missing chains",
        )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    if args.command in ("check", "publish"):
        if args.chain:
            parser.error(f"--chain does not apply to {args.command}: it covers every chain")
        run = _check if args.command == "check" else _publish
        return run(args.run_id, args.allow_partial)

    # Solana first: its sync is the slowest, and Ethereum's state must still be recent when
    # reconcile reads it.
    available: dict[str, Chain | SolanaChain] = {"solana": load_solana(), **load_chains()}
    unknown = set(args.chain or []) - set(available)
    if unknown:
        parser.error(f"unknown chain: {', '.join(sorted(unknown))}")
    chains = [available[name] for name in args.chain or available]
    # Block numbers mean nothing across chains.
    if args.command == "reconcile" and args.at_block is not None and len(chains) != 1:
        parser.error("--at-block needs exactly one --chain")
    if (
        args.command == "reconcile"
        and args.at_block is not None
        and isinstance(chains[0], SolanaChain)
    ):
        parser.error("--at-block is not available for solana: getTokenSupply has no past-slot read")
    census = getattr(args, "census", [])
    if unknown := set(census) - set(available):
        parser.error(f"unknown chain in --census: {', '.join(sorted(unknown))}")
    if not_selected := set(census) - {chain.name for chain in chains}:
        parser.error(f"--census needs the chain in this run: {', '.join(sorted(not_selected))}")
    if census and args.at_block is not None:
        parser.error("--census does not apply to --at-block")
    missing = missing_rpc_keys([chain.name for chain in chains], os.environ)
    if missing:
        parser.error(f"set {', '.join(missing)} in .env, or limit the run with --chain")

    try:
        store = Store(os.environ.get("OUSD_DB_PATH", DEFAULT_DB_PATH))
    except duckdb.IOException as exc:
        # A running sync holds the file. Not a verdict, so not exit 1. The error text carries the
        # path, so it is never echoed.
        held = "lock" in str(exc).lower()
        print(
            "error: database in use: another process holds it; try again when it finishes"
            if held
            else "error: cannot open the database; check OUSD_DB_PATH",
            file=sys.stderr,
        )
        return 2
    try:
        if args.command == "sync":
            return _sync(chains, store)
        return _reconcile(chains, store, args.at_block, census)
    except StoreConflict as conflict:
        # Proven disagreement with stored rows: stop, never pass.
        print(f"error: {conflict}", file=sys.stderr)
        if args.command == "reconcile":
            print("RESULT: FAIL")
        return 1
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
