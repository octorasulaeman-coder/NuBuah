"""Payment-attempt and refund models (P3 + refund accounting).

One order may have several payment attempts over its lifetime; the ORDER stays
authoritative for what was bought, each ATTEMPT tracks one payment obligation with one
provider, and each REFUND record tracks one refund request against one attempt. No
secrets are ever stored here.
"""

from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, Field, field_validator

PENDING = "pending"
PAID = "paid"
FAILED = "failed"
EXPIRED = "expired"

ATTEMPT_STATUSES = [PENDING, PAID, FAILED, EXPIRED]

REFUND_PENDING = "pending"
REFUND_SUCCEEDED = "succeeded"
REFUND_FAILED = "failed"
REFUND_AMBIGUOUS = "ambiguous"
REFUND_STATUSES = [REFUND_PENDING, REFUND_SUCCEEDED, REFUND_FAILED, REFUND_AMBIGUOUS]

PAYMENT_EVENT_RECEIVED = "received"
PAYMENT_EVENT_PROCESSING = "processing"
PAYMENT_EVENT_PROCESSED = "processed"
PAYMENT_EVENT_FAILED = "failed"
PAYMENT_EVENT_STATUSES = [
    PAYMENT_EVENT_RECEIVED,
    PAYMENT_EVENT_PROCESSING,
    PAYMENT_EVENT_PROCESSED,
    PAYMENT_EVENT_FAILED,
]


def _uuid() -> str:
    return __import__("uuid").uuid4().hex


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class RefundRecord(BaseModel):
    """Durable ledger row for one refund request.

    ``status`` distinguishes local pending work from authoritative provider outcomes:
    pending -> succeeded/failed, or ambiguous when the provider outcome is unknown.
    ``provider_key`` is the deterministic key passed to providers that support refund
    idempotency; it is not a secret.
    """

    id: str = Field(default_factory=_uuid)
    attempt_id: str
    order_id: str
    store_id: str
    provider: str
    provider_ref: str                 # the original payment reference at the provider
    amount: int                       # IDR integer
    currency: str = "IDR"
    reason: str
    status: str = REFUND_PENDING
    idempotency_key: Optional[str] = None   # client retry key scoped to this attempt
    provider_key: str = Field(default_factory=_uuid)  # deterministic provider refund idempotency key
    refund_ref: Optional[str] = None  # provider's refund reference once known
    failure_code: Optional[str] = None
    requested_by: Optional[str] = None
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)
    succeeded_at: Optional[datetime] = None

    @field_validator("amount")
    @classmethod
    def _amount_positive(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("refund amount must be positive")
        return v


class PaymentEventRecord(BaseModel):
    """Durable webhook-event lifecycle row.

    The event is acknowledged only when ``status == processed``. A row can stay in
    ``received``/``failed``/stale ``processing`` and be recovered by a later delivery or
    operational retry without repeating financial side effects.
    """

    id: str = Field(default_factory=_uuid)
    event_id: str
    provider: str
    provider_ref: Optional[str] = None
    attempt_id: Optional[str] = None
    order_id: Optional[str] = None
    store_id: Optional[str] = None
    raw_status: Optional[str] = None
    amount: Optional[int] = None
    currency: Optional[str] = None
    transaction_ref: Optional[str] = None
    status: str = PAYMENT_EVENT_RECEIVED
    processing_attempts: int = 0
    failure_code: Optional[str] = None
    retryable: bool = True
    manual_reconciliation_required: bool = False
    received_at: datetime = Field(default_factory=_utcnow)
    started_at: Optional[datetime] = None
    locked_until: Optional[datetime] = None
    next_retry_at: Optional[datetime] = None
    processed_at: Optional[datetime] = None


class PaymentAttempt(BaseModel):
    id: str = Field(default_factory=_uuid)
    order_id: str
    order_no: str
    store_id: str
    provider: str                      # adapter name, e.g. "mock" — never a secret
    provider_ref: str                  # provider's own payment/order reference
    transaction_ref: Optional[str] = None  # provider's settled transaction id, once paid
    amount: int                        # IDR, integer rupiah — must match the order total
    currency: str = "IDR"
    method: str = "qris"
    status: str = PENDING
    qr_payload: Optional[str] = None   # QRIS payload string, if the provider supplies one
    qr_image_url: Optional[str] = None # provider-hosted QR image URL, if supplied
    idempotency_key: Optional[str] = None  # client retry key: one logical intent per store
    request_fingerprint: Optional[str] = None  # canonical order/payment payload hash
    provider_idempotency_key: str = ""  # stable key passed to providers that support dedupe
    provider_attempted: bool = False    # provider call was initiated; outcome may still be unknown
    expires_at: datetime
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)
    paid_at: Optional[datetime] = None
    failure_code: Optional[str] = None     # safe, coarse-grained code for the UI
    failure_message: Optional[str] = None  # never contains credentials or full provider payloads
    # Summary fields only; authoritative refund history is in the refunds collection.
    refund_status: Optional[str] = None    # none|requested|partial|refunded|failed (coarse)
    refund_ref: Optional[str] = None       # most recent provider refund reference
    refunded_amount: int = 0               # cumulative authoritative successful refunds
    refund_reserved_amount: int = 0        # capacity held by pending/ambiguous/succeeded refunds
    late_payment: bool = False             # money arrived after expiry — flagged for review
    needs_review: bool = False             # ambiguous outcome — a human must reconcile

    @field_validator("refunded_amount", "refund_reserved_amount", mode="before")
    @classmethod
    def _none_int_to_zero(cls, v):
        return 0 if v is None else v


class PaymentAttemptPublic(BaseModel):
    """What the browser may see. No internal diagnostics beyond a safe failure code."""
    id: str
    order_id: str
    order_no: str
    amount: int
    currency: str
    method: str
    status: str
    qr_payload: Optional[str] = None
    qr_image_url: Optional[str] = None
    expires_at: datetime
    paid_at: Optional[datetime] = None
    failure_code: Optional[str] = None


class PaymentIntentIn(BaseModel):
    """Create (or safely retry) a payment attempt for a pending order."""
    order_id: str
    method: str = "qris"
    idempotency_key: Optional[str] = Field(default=None, max_length=64)


class PublicPaymentIntentIn(BaseModel):
    """Customer-side intent creation: order identity proven by order_no + phone,
    the same weak-secret pair as the public order-status lookup (rate-limited there)."""
    order_no: str = Field(min_length=4, max_length=20)
    customer_phone: str = Field(min_length=9, max_length=16, pattern=r"^\+?\d+$")
    idempotency_key: Optional[str] = Field(default=None, max_length=64)
