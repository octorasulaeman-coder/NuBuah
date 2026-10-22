"""Refund accounting rules — pure module (no database, no provider calls).

The database layer in ``service.py`` supplies atomicity; this module supplies the
deterministic policy that is easy to unit-test:

- remaining refundable balance is calculated from collected amount minus reserved
  capacity (pending/ambiguous/successful) and never from the original amount alone;
- provider results are classified as authoritative success, definitive failure, or
  ambiguous external outcome (timeout/unknown), never guessed;
- idempotent retries are the same logical request only when attempt, amount, currency,
  reason, and idempotency key all match.
"""

from dataclasses import dataclass
from typing import Optional

REFUND_PENDING = "pending"
REFUND_SUCCEEDED = "succeeded"
REFUND_FAILED = "failed"
REFUND_AMBIGUOUS = "ambiguous"

AMBIGUOUS_REFUND_FAILURE_CODES = {"timeout", "ambiguous", "unknown", "connection_error"}


class RefundValidationError(ValueError):
    """Raised for local, definitely-safe refund validation failures."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class RefundClassification:
    status: str                 # succeeded | failed | ambiguous
    failure_code: Optional[str] = None


def refundable_balance(amount: int, refunded_amount: int = 0, reserved_amount: int = 0) -> int:
    """IDR still available for new refund reservations.

    ``reserved_amount`` is capacity held by pending/ambiguous refunds plus successful
    refunds that consumed capacity. Using ``max(reserved, refunded)`` keeps the helper
    correct for legacy attempts that have ``refunded_amount`` but no reservation field.
    """
    consumed = max(int(reserved_amount or 0), int(refunded_amount or 0))
    return max(0, int(amount) - consumed)


def validate_refund_request(*, amount: int, attempt_amount: int, currency: str,
                            attempt_currency: str = "IDR", refunded_amount: int = 0,
                            reserved_amount: int = 0) -> None:
    """Local validation that must pass before a provider is contacted.

    This is a fast pre-check only; the service still enforces the balance atomically in
    MongoDB so concurrent requests cannot both reserve the same capacity.
    """
    if amount <= 0:
        raise RefundValidationError("invalid_amount", "Jumlah refund harus lebih dari nol")
    if currency != attempt_currency:
        raise RefundValidationError("currency_mismatch", "Mata uang refund tidak cocok dengan pembayaran")
    balance = refundable_balance(attempt_amount, refunded_amount, reserved_amount)
    if amount > balance:
        raise RefundValidationError("amount_exceeded", "Refund melebihi sisa saldo yang bisa dikembalikan")


def classify_refund_result(ok: bool, failure_code: Optional[str] = None) -> RefundClassification:
    """Map an adapter result onto an internal refund state.

    ``ok=True`` means the adapter authoritatively confirms the refund. ``ok=False`` with
    timeout/ambiguous codes means the external outcome is unknown and must be reconciled;
    any other failure is definitive and releases the local reservation.
    """
    if ok:
        return RefundClassification(REFUND_SUCCEEDED)
    code = (failure_code or "refund_failed").lower()
    if code in AMBIGUOUS_REFUND_FAILURE_CODES:
        return RefundClassification(REFUND_AMBIGUOUS, code)
    return RefundClassification(REFUND_FAILED, code)


def same_refund_request(record: dict, *, attempt_id: str, amount: int, currency: str,
                        reason: str, idempotency_key: Optional[str]) -> bool:
    """Whether an existing refund record is the same logical retry.

    The key alone is not enough: reusing a key with a different amount/reason/payload is
    a conflict and must never return the previous refund silently.
    """
    return (
        record.get("attempt_id") == attempt_id
        and record.get("amount") == amount
        and record.get("currency") == currency
        and (record.get("reason") or "") == reason
        and (record.get("idempotency_key") or None) == (idempotency_key or None)
    )


def summarize_refund_status(*, attempt_amount: int, refunded_amount: int,
                            has_open: bool, has_success: bool, last_failed: bool) -> str:
    """Coarse summary stored on PaymentAttempt for compatibility with older readers.

    Authoritative history lives in ``refunds``; this field is only a convenience flag.
    """
    if refunded_amount >= attempt_amount:
        return "refunded"
    if has_open:
        return "requested"
    if has_success:
        return "partial"
    if last_failed:
        return "failed"
    return "none"
