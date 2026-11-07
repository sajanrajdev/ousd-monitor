"""Same-looking transfer groups, part of blocking check 3: is each one a real set of transfers,
as its transaction shows?
"""

from collections import Counter
from collections.abc import Sequence
from typing import Literal

from ousd.decode import Transfer
from ousd.reconcile.recorder import _ChainRun
from ousd.reconcile.status import ChainUnavailable, GroupFinding, GroupVerdict
from ousd.sources import ProofTransfer, TransactionProof
from ousd.store import SameLookingGroup, Status

# These chains' group proofs are decoded transactions. Every other chain's are receipts, or
# Blockscout's listing, the only source that reports no status.
CHAINS_PROVEN_BY_TRANSACTION = frozenset({"solana"})


def _proof_source(chain: str, proof: TransactionProof) -> str:
    if proof.success is None:
        return "blockscout"
    return "transaction" if chain in CHAINS_PROVEN_BY_TRANSACTION else "receipt"


def _is_real(rows: Sequence[Transfer], proof: TransactionProof) -> bool:
    """The transaction succeeded, and its logs are the stored rows: a row too many or too few, or
    one at another position, is not real. A source that reports no status is judged on the rows."""
    stored = [
        ProofTransfer(row.log_index, row.from_address, row.to_address, row.value) for row in rows
    ]
    return (
        proof.success is not False
        and sorted(stored) == sorted(proof.transfers)
        and all(row.block_number == proof.block_number for row in rows)
    )


def _check_groups(run: _ChainRun, through: int) -> Status:
    """Is every same-looking group a real set of transfers? Only the transaction can say: a loop
    between two wallets nets to zero, so losing rows from it leaves every balance unchanged.

    Each verdict commits as it's reached, so a stopped run resumes. Rows that aren't real stay
    where they are, as nothing here changes `transfers`, and the maintainer decides what happens.
    """
    name = run.probe.name
    transactions: dict[str, list[SameLookingGroup]] = {}
    for group in run.store.same_looking_groups(name, through):
        transactions.setdefault(group.tx_hash, []).append(group)

    verdicts: Counter[str] = Counter()
    sources: Counter[str] = Counter()
    mixed_groups = 0

    def note(tx_hash: str, verdict: GroupVerdict, stored: list[int], proven: list[int]) -> None:
        nonlocal mixed_groups
        mixed = sum(
            0 < group.null_hash_count < len(group.positions) for group in transactions[tx_hash]
        )
        mixed_groups += mixed
        verdicts[verdict] += 1
        if verdict != "real" or mixed:
            run.report(
                GroupFinding(name, tx_hash, verdict, tuple(stored), tuple(proven), mixed > 0)
            )

    cause: BaseException | None = None
    for tx_hash, groups in transactions.items():
        block = groups[0].block_number
        rows = run.store.transaction_rows(name, tx_hash)
        # Every position in the transaction, as the skip list compares all of them. Only the group's
        # would bring a transaction with other rows back on every run.
        stored = [row.log_index for row in rows]
        try:
            proof = run.probe.read_transaction_proof(tx_hash)
        except ChainUnavailable as exc:
            # The source is down, and every transaction left would wait out its retries too.
            cause = exc.__cause__
            note(tx_hash, "unavailable", stored, [])
            break
        # Any stored block will do. Rows that span two blocks can't all match, which is not_real.
        stored_blocks = {row.block_number for row in rows}
        if proof is None or proof.tx_hash != tx_hash or proof.block_number not in stored_blocks:
            note(tx_hash, "unavailable", stored, [])
            continue
        source = _proof_source(name, proof)
        proven = sorted(transfer.log_index for transfer in proof.transfers)
        verdict: Literal["real", "not_real"] = "real" if _is_real(rows, proof) else "not_real"
        run.store.record_group_audit(
            name, tx_hash, block, verdict, source, stored, proven, run.run_id
        )
        sources[source] += 1
        note(tx_hash, verdict, stored, proven)

    status: Status = "pass"
    reason = None
    if verdicts["not_real"]:
        status, reason = "fail", "group_not_real"
    elif verdicts["unavailable"]:
        status, reason = "unchecked", "group_proof_unavailable"
    return run.recorder.record(
        "same_looking",
        name,
        status,
        reason,
        cause=cause,
        pin=through,
        # Counts only. The transactions themselves are in transfer_group_audits and the report.
        detail={
            "transactions": len(transactions),
            "real": verdicts["real"],
            "not_real": verdicts["not_real"],
            "unavailable": verdicts["unavailable"],
            # Left when a source went down, so a stop on the first can be told from one on the last.
            "not_attempted": len(transactions) - sum(verdicts.values()),
            "proof_sources": dict(sources),
            "mixed_hash_groups": mixed_groups,
        },
    ).status
