"""The steps the CLI and the Dagster run share: one chain's sync, and the read of Bridge's total.

Each caller keeps its own error handling, output and exit codes. These only do the work.
"""

import os

from ousd.chains import DEFAULT_BRIDGE_URL, Chain
from ousd.http import PoliteClient
from ousd.ingest import SyncResult, sync_chain
from ousd.probes import history_for, rpc_for, solana_rpc_for
from ousd.solana import SolanaChain, sync_solana
from ousd.sources import BridgeSnapshot, bridge_snapshot
from ousd.store import Store


def sync_one(chain: Chain | SolanaChain, store: Store) -> SyncResult:
    """Ingest one chain to its tip, repairing any reorg on an EVM chain."""
    if isinstance(chain, SolanaChain):
        return sync_solana(chain, solana_rpc_for(chain), store)
    return sync_chain(chain, rpc_for(chain), store, history_for(chain))


def fetch_bridge() -> BridgeSnapshot:
    """Bridge's reported total. Raises HttpError or ValueError when it can't be read."""
    url = os.environ.get("BRIDGE_API_URL", DEFAULT_BRIDGE_URL)
    return bridge_snapshot(PoliteClient(label="bridge"), url)
