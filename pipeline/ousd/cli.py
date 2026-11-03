"""Command line entry point: `ousd sync` and `ousd reconcile`."""

import argparse
import logging
import os
import sys

from ousd.chains import DECIMALS, DEFAULT_BRIDGE_URL, DEFAULT_DB_PATH, Chain, load_chains
from ousd.http import PoliteClient
from ousd.ingest import sync_chain
from ousd.reconcile import ChainReconciliation, compare_with_bridge, reconcile_chain
from ousd.sources import BlockscoutClient, RpcClient, bridge_total_base_units
from ousd.store import Store

BLOCKSCOUT_INTERVAL = 0.25


def format_units(base_units: int) -> str:
    """Render base units as a decimal OUSD amount, using integer arithmetic only."""
    sign = "-" if base_units < 0 else ""
    whole, fraction = divmod(abs(base_units), 10**DECIMALS)
    return f"{sign}{whole:,}.{fraction:0{DECIMALS}d}"


def _rpc_for(chain: Chain) -> RpcClient:
    return RpcClient(PoliteClient(min_interval=chain.rpc_interval), chain.rpc_url)


def _sync(chains: list[Chain], store: Store) -> int:
    for chain in chains:
        history = None
        if chain.blockscout_url:
            http = PoliteClient(min_interval=BLOCKSCOUT_INTERVAL)
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


def _reconcile(chains: list[Chain], store: Store, at_block: int | None) -> int:
    results = [reconcile_chain(chain, _rpc_for(chain), store, at_block) for chain in chains]
    for result in results:
        _print_reconciliation(result)

    if at_block is None:
        url = os.environ.get("BRIDGE_API_URL", DEFAULT_BRIDGE_URL)
        comparison = compare_with_bridge(results, bridge_total_base_units(PoliteClient(), url))
        status = "PARTIAL" if comparison.is_partial else "FULL"
        print(f"Bridge comparison: {status}")
        print(f"  chains included  {', '.join(comparison.chains_included)}")
        print(f"  chains missing   {', '.join(comparison.chains_missing) or 'none'}")
        print(f"  chains total     {format_units(comparison.chains_total)}")
        print(f"  Bridge total     {format_units(comparison.bridge_total)}")
        print(f"  difference       {format_units(comparison.difference)}")

    return 0 if all(result.matched for result in results) else 1


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
    # httpx logs every request at INFO, which would bury our progress lines.
    logging.getLogger("httpx").setLevel(logging.WARNING)

    available = load_chains()
    unknown = set(args.chain or []) - set(available)
    if unknown:
        parser.error(f"unknown chain: {', '.join(sorted(unknown))}")
    chains = [available[name] for name in args.chain or available]

    store = Store(os.environ.get("OUSD_DB_PATH", DEFAULT_DB_PATH))
    try:
        if args.command == "sync":
            return _sync(chains, store)
        return _reconcile(chains, store, args.at_block)
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
