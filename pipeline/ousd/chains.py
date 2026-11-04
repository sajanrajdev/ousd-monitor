"""Per-chain configuration for the EVM chains. Solana will keep its own chain type in solana.py."""

import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

DECIMALS = 6
DEFAULT_DB_PATH = "data/ousd.duckdb"
DEFAULT_BRIDGE_URL = "https://transparency.bridge.xyz/v0/stablecoins/ousd"

# Every chain that makes up Bridge's total, whether or not it is ingested yet.
REQUIRED_CHAINS = ("tempo", "ethereum", "base", "solana")


# Chains with no public endpoint: the run stops unless the variable holds a provider URL.
KEYED_RPC_ENV = {"base": "BASE_RPC_URL", "solana": "SOLANA_RPC_URL"}


def missing_rpc_keys(names: Iterable[str], env: Mapping[str, str]) -> list[str]:
    """Variables the named chains need that are unset, empty or blank."""
    return [
        variable
        for name in names
        if (variable := KEYED_RPC_ENV.get(name)) and not env.get(variable, "").strip()
    ]


@dataclass(frozen=True)
class Chain:
    name: str
    chain_id: int
    token: str
    # Provider URLs can hold API keys, so they stay out of repr().
    rpc_url: str = field(repr=False)
    # First block worth scanning. Verified against the chain, see docs/build-log.md.
    start_block: int
    # Largest block span the RPC accepts in one eth_getLogs call.
    max_log_range: int
    # Minimum blocks of hashes to keep and re-check at the tip.
    reorg_lookback: int
    # Seconds between requests to the RPC.
    rpc_interval: float = 0.1
    # Blockscout API for old ranges the RPC refuses. None means the RPC serves all history.
    blockscout_url: str | None = field(default=None, repr=False)
    # Blocks at the tip read from the RPC even when Blockscout is configured. This keeps
    # unfinalized data, and anything Blockscout has not indexed yet, away from Blockscout.
    rpc_tail_blocks: int = 0


def load_chains(env: Mapping[str, str] = os.environ) -> dict[str, Chain]:
    chains = (
        Chain(
            name="tempo",
            chain_id=4217,
            token="0x20c0000000000000000000006a37da5c996874be",
            rpc_url=env.get("TEMPO_RPC_URL", "https://rpc.tempo.xyz"),
            start_block=15_844_819,
            # The RPC allows 100,000, but Cloudflare often returns 502 once a response nears
            # 5 MB. At 20,000 blocks responses stay near 3 MB. See docs/build-log.md.
            max_log_range=20_000,
            # Tempo's finalized block equals its tip, so this is only a safety margin.
            reorg_lookback=16,
        ),
        Chain(
            name="ethereum",
            chain_id=1,
            token="0x9f6f3991d525015a6f8caf062c83b62fd3ac4436",
            rpc_url=env.get("ETHEREUM_RPC_URL", "https://ethereum-rpc.publicnode.com"),
            start_block=25_137_271,
            max_log_range=2_000,
            # Finality lags about 76 blocks. Sync widens this if finality stalls.
            reorg_lookback=128,
            blockscout_url=env.get("ETHEREUM_BLOCKSCOUT_URL", "https://eth.blockscout.com/api"),
            # A daily top-up is about 7,200 blocks. Keep it on RPC, which serves up to about
            # 10,000 blocks of logs, rather than on Blockscout, which lags the tip.
            rpc_tail_blocks=9_000,
        ),
        Chain(
            name="base",
            chain_id=8453,
            token="0xb2000000000000000000002feb517dfec7415344",
            # No public endpoint serves the history we need, so the URL comes from a provider.
            # Unset gives "", and the CLI stops with a message naming BASE_RPC_URL.
            rpc_url=env.get("BASE_RPC_URL", "").strip(),
            # The first block with code, found by bisecting eth_getCode: block 48,631,940 has none.
            # The first mint is block 50,497,983. See docs/plans/2026-11-03-003-base-source-plan.md.
            start_block=48_631_941,
            # The provider accepts spans of up to 10,000 blocks, and refuses 50,000. A span over
            # the 20,000 result cap is split by the client. See the same plan.
            max_log_range=10_000,
            # Finality lags about 725 blocks at the tip, as measured in the plan. This covers
            # that lag with room to spare, and sync widens it if finality stalls.
            reorg_lookback=1_200,
        ),
    )
    return {chain.name: chain for chain in chains}
