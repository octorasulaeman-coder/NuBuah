"""Payment-attempt model (P3). One order may have several attempts over its lifetime;
the ORDER stays authoritative for what was bought, each ATTEMPT tracks one payment
obligation with one provider. No secrets are ever stored here."""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

PENDING = "pending"
PAID = "paid"
FAILED = "failed"
EXPIRED = "expired"

ATTEMPT_STATUSES = [PENDING, PAID, FAILED, EXPIRED]


class PaymentAttempt(BaseModel):
    id: str = Field(default_factory=lambda: __import__("uuid").uuid4().hex)
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
    idempotency_key: Optional[str] = None  # client retry key: one logical attempt per key
    expires_at: datetime
    created_at: datetime = Field(default_factory=lambda: datetime.now(__import__("datetime").timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(__import__("datetime").timezone.utc))
    paid_at: Optional[datetime] = None
    failure_code: Optional[str] = None     # safe, coarse-grained code for the UI
    failure_message: Optional[str] = None  # never contains credentials or full provider payloads
    refund_status: Optional[str] = None    # "requested" | "refunded" | "failed" | None
    refund_ref: Optional[str] = None
    refunded_amount: Optional[int] = None  # partial refunds allowed; defaults to amount
    late_payment: bool = False             # money arrived after expiry — flagged for review
    needs_review: bool = False             # ambiguous outcome — a human must reconcile


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
