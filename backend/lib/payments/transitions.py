"""Payment-attempt state machine — pure module (no database, no provider calls).

Rules encoded here (mirrors the P3 requirements):
- paid is TERMINAL: a later failure/expiration notification can never downgrade it.
- failed/expired are retryable-by-new-attempt: a retry never mutates a dead attempt.
- a payment that arrives after expiry still records PAID but raises late_payment —
  late money is flagged for reconciliation, never silently discarded.
- anything unmapped stays PENDING and raises needs_review — ambiguity is surfaced,
  never guessed.
"""

from dataclasses import dataclass

PENDING, PAID, FAILED, EXPIRED = "pending", "paid", "failed", "expired"


@dataclass(frozen=True)
class AttemptTransition:
    target: str            # attempt status to apply
    late_payment: bool = False
    needs_review: bool = False


def apply_notification(current: str, normalized_target: "str | None", *, expired: bool) -> AttemptTransition:
    """Given the stored status and the normalized provider outcome, decide what changes.

    normalized_target: PAID/FAILED/PENDING, or None when the ADAPTER cannot map the
    provider vocabulary (EXPIRED is derived from time, not provider vocabulary).
    None means ambiguity: stay put, flag needs_review — never guess.
    """
    if current == PAID:
        # duplicate or out-of-order delivery after settlement: acknowledge, change nothing
        return AttemptTransition(PAID)
    if normalized_target is None:
        return AttemptTransition(current, needs_review=True)
    if normalized_target == PAID:
        return AttemptTransition(PAID, late_payment=expired)
    if normalized_target == FAILED:
        return AttemptTransition(FAILED)
    if normalized_target == EXPIRED:
        return AttemptTransition(EXPIRED)
    return AttemptTransition(PENDING)  # a genuine "still pending" confirmation: no-op


def apply_expiry(current: str) -> AttemptTransition:
    """Scheduled sweep: pending attempts past their expiry time."""
    if current == PAID:
        return AttemptTransition(PAID)
    if current == PENDING:
        return AttemptTransition(EXPIRED)
    return AttemptTransition(current)  # failed stays failed — history is preserved
