"""The key check: do stored events explain the supply each chain reports?

`run_reconciliation` runs a whole reconciliation and records it. Each check has its own module:
supply (blocking check 1), bridge (2), balances (3, sampled balances and the census) and groups
(same-looking transfer groups). status holds what a check can find and what a run reports, and
recorder files each check's row. The names below are re-exported, so callers import from
`ousd.reconcile` alone.
"""

from ousd.reconcile.balances import (
    CHAINS_READ_WHOLE,
    RANDOM_WALLETS,
    TOP_WALLETS,
    choose_sample,
    sample_seed,
)
from ousd.reconcile.bridge import (
    BRIDGE_ATTEMPTS,
    BRIDGE_MAX_AGE,
    BRIDGE_MAX_AHEAD,
    BRIDGE_MAX_SUMS,
    BRIDGE_RETRY_DELAY,
    BRIDGE_SAME_SNAPSHOT_TRIES,
    BRIDGE_SAME_SNAPSHOT_WAIT,
    BRIDGE_SUBJECT,
    BRIDGE_WINDOW_AFTER,
    BRIDGE_WINDOW_BEFORE,
    BridgeCheck,
    bridge_window,
    check_bridge,
    compare_with_bridge,
)
from ousd.reconcile.groups import CHAINS_PROVEN_BY_TRANSACTION
from ousd.reconcile.runner import run_reconciliation
from ousd.reconcile.status import (
    EXIT_CODES,
    FULL_SCOPE,
    PARTIAL_SCOPE,
    REASONS,
    BalanceFinding,
    BalanceRead,
    BridgeComparison,
    BridgeFigures,
    BridgeWait,
    ChainProbe,
    ChainReconciliation,
    ChainUnavailable,
    CheckOutcome,
    GroupFinding,
    GroupVerdict,
    Report,
    RunResult,
    Unchecked,
    exit_code,
    overall_status,
)
from ousd.reconcile.supply import (
    CHAINS_WITHOUT_BLOCK_HASHES,
    PIN_ROUNDS,
    check_at_block,
    reconcile_chain,
)

__all__ = [
    "BRIDGE_ATTEMPTS",
    "BRIDGE_MAX_AGE",
    "BRIDGE_MAX_AHEAD",
    "BRIDGE_MAX_SUMS",
    "BRIDGE_RETRY_DELAY",
    "BRIDGE_SAME_SNAPSHOT_TRIES",
    "BRIDGE_SAME_SNAPSHOT_WAIT",
    "BRIDGE_SUBJECT",
    "BRIDGE_WINDOW_AFTER",
    "BRIDGE_WINDOW_BEFORE",
    "CHAINS_PROVEN_BY_TRANSACTION",
    "CHAINS_READ_WHOLE",
    "CHAINS_WITHOUT_BLOCK_HASHES",
    "EXIT_CODES",
    "FULL_SCOPE",
    "PARTIAL_SCOPE",
    "PIN_ROUNDS",
    "RANDOM_WALLETS",
    "REASONS",
    "TOP_WALLETS",
    "BalanceFinding",
    "BalanceRead",
    "BridgeCheck",
    "BridgeComparison",
    "BridgeFigures",
    "BridgeWait",
    "ChainProbe",
    "ChainReconciliation",
    "ChainUnavailable",
    "CheckOutcome",
    "GroupFinding",
    "GroupVerdict",
    "Report",
    "RunResult",
    "Unchecked",
    "bridge_window",
    "check_at_block",
    "check_bridge",
    "choose_sample",
    "compare_with_bridge",
    "exit_code",
    "overall_status",
    "reconcile_chain",
    "run_reconciliation",
    "sample_seed",
]
