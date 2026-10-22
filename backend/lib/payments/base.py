"""Provider adapter interface (P3 + refund accounting).

The payment service talks ONLY to this interface; provider response formats never leak
beyond an adapter. A real provider integration = one subclass implementing these
operations with the provider's CURRENT official documentation, plus registration in
lib/payments/registry.py.

Interface contract
------------------
create_payment(request) -> CreateResult
    Create one payment obligation with the provider. Must be safe to NOT retry blindly
    after a timeout: callers pass idempotency_key so the adapter can dedupe upstream.
get_payment_status(provider_ref) -> ProviderStatus
    Authoritative status poll for reconciliation after timeouts/ambiguity.
verify_webhook(headers, body) -> VerifiedNotification
    Authenticate a provider callback with the provider's real procedure (signature,
    token, IP allow-list — whatever the docs say). Returning valid=False MUST make the
    caller reject the notification; an unverified notification is never payment proof.
normalize_status(raw_status, failure_code=None) -> AttemptTransition
    Map provider vocabulary onto our state machine (lib/payments/transitions.py).
request_refund(provider_ref, amount, reason, idempotency_key=None) -> RefundResult
    Where supported. ``ok=True`` must mean authoritative refund success. ``ok=False``
    with failure_code in {"timeout", "ambiguous", ...} means the external outcome is
    unknown and must be reconciled, not blindly retried. Adapters whose provider lacks
    refunds raise NotImplementedError.
get_refund_status(provider_ref, refund_ref) -> RefundStatus
    Reconciliation for ambiguous refund outcomes. Raise NotImplementedError when the
    provider does not expose refund status; the service then preserves the ambiguous
    local record for manual reconciliation.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


@dataclass(frozen=True)
class CreateRequest:
    provider_ref: str          # OUR generated reference (primary key upstream)
    amount: int                # IDR integer
    currency: str
    method: str                # "qris" (extensible)
    expires_at: datetime
    idempotency_key: Optional[str] = None
    metadata: dict = field(default_factory=dict)


@dataclass(frozen=True)
class CreateResult:
    ok: bool
    provider_ref: str          # what get_payment_status / webhooks refer to
    qr_payload: Optional[str] = None
    qr_image_url: Optional[str] = None
    expires_at: Optional[datetime] = None   # provider may shorten our ask
    failure_code: Optional[str] = None      # safe code when ok=False ("timeout", "rejected", ...)
    raw: dict = field(default_factory=dict) # diagnostics for SERVER logs only — never persisted verbatim


@dataclass(frozen=True)
class ProviderStatus:
    raw_status: str
    transaction_ref: Optional[str] = None
    failure_code: Optional[str] = None


@dataclass(frozen=True)
class VerifiedNotification:
    valid: bool
    event_id: Optional[str] = None         # unique per notification — powers dedupe
    provider_ref: Optional[str] = None
    raw_status: Optional[str] = None
    amount: Optional[int] = None
    currency: Optional[str] = None
    transaction_ref: Optional[str] = None
    reason: Optional[str] = None           # why verification failed (server logs only)


@dataclass(frozen=True)
class RefundResult:
    ok: bool
    refund_ref: Optional[str] = None
    failure_code: Optional[str] = None     # "timeout"/"ambiguous" mean outcome unknown


@dataclass(frozen=True)
class RefundStatus:
    """Authoritative refund status for reconciliation after ambiguity."""
    status: str                            # "succeeded" | "failed" | "pending"
    refund_ref: Optional[str] = None
    failure_code: Optional[str] = None


class PaymentProviderAdapter:
    """Base class: subclass + implement; raise NotImplementedError where unsupported."""

    name: str = "base"

    async def create_payment(self, req: CreateRequest) -> CreateResult:  # pragma: no cover
        raise NotImplementedError

    async def get_payment_status(self, provider_ref: str) -> ProviderStatus:  # pragma: no cover
        raise NotImplementedError

    def verify_webhook(self, headers: dict, body: bytes) -> VerifiedNotification:  # pragma: no cover
        raise NotImplementedError

    def normalize_status(self, raw_status: str, failure_code: Optional[str] = None):  # pragma: no cover
        raise NotImplementedError

    async def request_refund(self, provider_ref: str, amount: int, reason: str,
                             idempotency_key: Optional[str] = None) -> RefundResult:  # pragma: no cover
        raise NotImplementedError

    async def get_refund_status(self, provider_ref: str, refund_ref: Optional[str] = None) -> RefundStatus:  # pragma: no cover
        raise NotImplementedError
