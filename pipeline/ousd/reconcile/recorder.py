"""One run's check rows, filed through one place, and what the checks on one chain share."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from ousd.reconcile.status import REASONS, ChainProbe, ChainReconciliation, CheckOutcome, Report
from ousd.store import BalanceSample, Status, Store


class _RunRecorder:
    """One run's checks. Every row goes through record, so `attempt` is one rising counter per
    check and subject across every kind of retry, and `reason` can only be a fixed code."""

    def __init__(
        self,
        store: Store,
        run_id: str,
        report: Report,
    ) -> None:
        self._store = store
        self._run_id = run_id
        self._report = report
        self._attempts: dict[tuple[str, str], int] = {}
        self.outcomes: list[CheckOutcome] = []

    def record(
        self,
        check_name: str,
        subject: str,
        status: Status,
        reason: str | None = None,
        *,
        cause: BaseException | None = None,
        reading: ChainReconciliation | None = None,
        pin: int | None = None,
        reference: int | None = None,
        observed: int | None = None,
        detail: Mapping[str, object] | None = None,
        samples: Sequence[BalanceSample] = (),
    ) -> CheckOutcome:
        attempt = self._attempts.get((check_name, subject), 0) + 1
        self._attempts[check_name, subject] = attempt
        fixed = reason if reason is None or reason in REASONS else "source_error"
        # The class name only: an exception's message can hold a URL with a key in it.
        error = {"error": type(cause).__name__} if cause else {}
        height = reading.block_number if reading else pin
        self._store.record_check(
            self._run_id,
            check_name,
            subject,
            attempt,
            status,
            fixed,
            pin_height=height,
            pin_hash=None if height is None else self._store.block_hashes(subject).get(height),
            transfer_count=None if height is None else self._store.transfer_count(subject),
            reference_value=reading.onchain_supply if reading else reference,
            observed_value=reading.event_supply if reading else observed,
            detail={**(detail or {}), **error},
            samples=samples,
        )
        outcome = CheckOutcome(check_name, subject, status, fixed, attempt, reading)
        self.outcomes.append(outcome)
        self._report(outcome)
        return outcome


@dataclass(frozen=True)
class _ChainRun:
    """What the checks on one chain share."""

    probe: ChainProbe
    store: Store
    recorder: _RunRecorder
    report: Report
    run_id: str
