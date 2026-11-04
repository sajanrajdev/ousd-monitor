"""Per-chain configuration. Base and Solana are added here once their keys exist."""

import os
from collections.abc import Mapping
from dataclasses import dataclass, field

DECIMALS = 6
DEFAULT_DB_PATH = "data/ousd.duckdb"
DEFAULT_BRIDGE_URL = "https://transparency.bridge.xyz/v0/stablecoins/ousd"

# Every chain that makes up Bridge's total, whether or not it is ingested yet.
REQUIRED_CHAINS = ("tempo", "ethereum", "base", "solana")


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
            rpc_tail_blocks=2_000,
        ),
    )
    return {chain.name: chain for chain in chains}
