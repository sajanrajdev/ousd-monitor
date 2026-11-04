"""Command line entry point: `ousd sync` and `ousd reconcile`."""

import argparse
import logging
import os
import sys
from collections.abc import Sequence

from ousd.chains import (
    DECIMALS,
    DEFAULT_BRIDGE_URL,
    DEFAULT_DB_PATH,
    Chain,
    load_chains,
    missing_rpc_keys,
)
from ousd.http import PoliteClient
from ousd.ingest import sync_chain
from ousd.reconcile import ChainReconciliation, compare_with_bridge, reconcile_chain
from ousd.solana import (
    RPC_INTERVAL,
    BalanceCheck,
    SolanaChain,
    SolanaRpc,
    Unchecked,
    check_all_balances,
    load_solana,
    reconcile_solana,
    sync_solana,
)
from ousd.sources import BlockscoutClient, RpcClient, bridge_total_base_units
from ousd.store import Store, StoreConflict

BLOCKSCOUT_INTERVAL = 0.25
MAX_SHOWN_DIFFERENCES = 10


def format_units(base_units: int) -> str:
    """Render base units as a decimal OUSD amount, using integer arithmetic only."""
    sign = "-" if base_units < 0 else ""
    whole, fraction = divmod(abs(base_units), 10**DECIMALS)
    return f"{sign}{whole:,}.{fraction:0{DECIMALS}d}"


def _rpc_for(chain: Chain) -> RpcClient:
    http = PoliteClient(label=f"{chain.name}-rpc", min_interval=chain.rpc_interval)
    return RpcClient(http, chain.rpc_url)


def _solana_rpc(chain: SolanaChain) -> SolanaRpc:
    http = PoliteClient(label=f"{chain.name}-rpc", min_interval=RPC_INTERVAL)
    return SolanaRpc(http, chain.rpc_url)


def _sync(chains: Sequence[Chain | SolanaChain], store: Store) -> int:
    for chain in chains:
        if isinstance(chain, SolanaChain):
            solana = sync_solana(chain, _solana_rpc(chain), store)
            print(
                f"{solana.chain}: synced to slot {solana.tip}, "
                f"{solana.transfers_stored} transfers stored"
            )
            continue
        history = None
        if chain.blockscout_url:
            http = PoliteClient(label=f"{chain.name}-blockscout", min_interval=BLOCKSCOUT_INTERVAL)
            history = BlockscoutClient(http, chain.blockscout_url)
        result = sync_chain(chain, _rpc_for(chain), store, history)
        reorg = f", reorg repaired at {result.reorg_fork_block}" if result.reorg_fork_block else ""
        print(
            f"{result.chain}: synced to {result.tip} (finalized {result.finalized}), "
            f"{result.transfers_stored} transfers stored{reorg}"
        )
    return 0


def _print_reconciliation(result: ChainReconciliation) -> None:
    verdict = "MATCH" if result.matched else "MISMATCH"
    print(f"{result.chain} at block {result.block_number}: {verdict}")
    print(f"  minted         {format_units(result.minted)}")
    print(f"  burned         {format_units(result.burned)}")
    print(f"  mints - burns  {format_units(result.event_supply)}")
    print(f"  totalSupply()  {format_units(result.onchain_supply)}")
    print(f"  difference     {format_units(result.difference)} ({result.difference} base units)")


def _print_unchecked(result: Unchecked) -> None:
    print(f"{result.chain}: UNCHECKED: {result.reason}")


def _print_solana_balances(check: BalanceCheck | Unchecked) -> bool:
    if isinstance(check, Unchecked):
        _print_unchecked(check)
        return False
    verdict = "MATCH" if check.matched else "MISMATCH"
    print(
        f"{check.chain} balances at slot {check.slot}: {verdict} ({check.wallets_checked} wallets)"
    )
    for difference in check.differences[:MAX_SHOWN_DIFFERENCES]:
        print(
            f"  {difference.owner}  on-chain {format_units(difference.onchain)}"
            f"  stored {format_units(difference.stored)}"
        )
    if len(check.differences) > MAX_SHOWN_DIFFERENCES:
        print(f"  ... {len(check.differences)} wallets differ in all")
    return check.matched


def _reconcile_solana(chain: SolanaChain, store: Store) -> tuple[ChainReconciliation | None, bool]:
    rpc = _solana_rpc(chain)
    # Balances first, so the supply row is the one left at the cursor.
    balances_ok = _print_solana_balances(check_all_balances(chain, rpc, store))
    supply = reconcile_solana(chain, rpc, store)
    if isinstance(supply, Unchecked):
        _print_unchecked(supply)
        return None, False
    _print_reconciliation(supply)
    return supply, balances_ok and supply.matched


def _reconcile(chains: Sequence[Chain | SolanaChain], store: Store, at_block: int | None) -> int:
    results = []
    all_ok = True
    for chain in chains:
        # Print as we go, so one chain's failure doesn't hide what the others found.
        if isinstance(chain, SolanaChain):
            solana, ok = _reconcile_solana(chain, store)
            all_ok &= ok
            if solana is not None:
                results.append(solana)
            continue
        results.append(reconcile_chain(chain, _rpc_for(chain), store, at_block))
        _print_reconciliation(results[-1])
        all_ok &= results[-1].matched

    if at_block is None:
        url = os.environ.get("BRIDGE_API_URL", DEFAULT_BRIDGE_URL)
        comparison = compare_with_bridge(
            results, bridge_total_base_units(PoliteClient(label="bridge"), url)
        )
        status = "PARTIAL" if comparison.is_partial else "FULL"
        print(f"Bridge comparison: {status}")
        print(f"  chains included  {', '.join(comparison.chains_included)}")
        print(f"  chains missing   {', '.join(comparison.chains_missing) or 'none'}")
        print(f"  chains total     {format_units(comparison.chains_total)}")
        print(f"  Bridge total     {format_units(comparison.bridge_total)}")
        print(f"  difference       {format_units(comparison.difference)}")

    return 0 if all_ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ousd", description=__doc__)
    parser.add_argument("--chain", action="append", help="limit to this chain (repeatable)")
    parser.add_argument("-v", "--verbose", action="store_true", help="log progress")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("sync", help="ingest transfers up to the tip and repair reorgs")
    reconcile = commands.add_parser("reconcile", help="compare events with totalSupply()")
    reconcile.add_argument("--at-block", type=int, help="check a past block (needs archive state)")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(message)s",
    )

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
    missing = missing_rpc_keys([chain.name for chain in chains], os.environ)
    if missing:
        parser.error(f"set {', '.join(missing)} in .env, or limit the run with --chain")

    store = Store(os.environ.get("OUSD_DB_PATH", DEFAULT_DB_PATH))
    try:
        if args.command == "sync":
            return _sync(chains, store)
        return _reconcile(chains, store, args.at_block)
    except StoreConflict as conflict:
        # Proven disagreement with stored rows: stop, never pass.
        print(f"error: {conflict}", file=sys.stderr)
        return 1
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
