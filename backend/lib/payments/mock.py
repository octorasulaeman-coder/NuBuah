"""Mock payment provider — development and automated tests ONLY.

Simulates the full provider surface: creation, pending status, success/failure,
expiration, duplicate and delayed notifications, timeouts, and ambiguous outcomes
(selected via MOCK_PAYMENT_BEHAVIOR). Webhook "verification" uses an HMAC token so the
whole webhook pipeline (including REJECTION of bad signatures) is exercised for real.

GUARANTEE: this adapter can never confirm a production payment — it never contacts any
network and lib/payments/config.py refuses provider=mock when mode=production.
"""

import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from typing import Optional

from lib.payments.base import (
    CreateRequest, CreateResult, PaymentProviderAdapter, ProviderStatus,
    VerifiedNotification,
)

BEHAVIOR = os.environ.get("MOCK_PAYMENT_BEHAVIOR", "success")  # success|failure|expire|timeout|ambiguous

# provider vocabulary (deliberately unlike our internal names — exercises normalize_status)
RAW_PENDING = "MOCK_CREATED"
RAW_PAID = "MOCK_SETTLED"
RAW_FAILED = "MOCK_DECLINED"
RAW_UNKNOWN = "MOCK_WHAT"


class MockProvider(PaymentProviderAdapter):
    name = "mock"

    def __init__(self, webhook_secret: str = "mock-dev-secret"):
        self.webhook_secret = webhook_secret

    # -- creation ---------------------------------------------------------
    async def create_payment(self, req: CreateRequest) -> CreateResult:
        if BEHAVIOR == "timeout":
            # simulate an upstream timeout: no obligation is provably created; the
            # service must reconcile (get_payment_status) instead of blindly retrying
            return CreateResult(ok=False, provider_ref=req.provider_ref, failure_code="timeout",
                                  raw={"behavior": "timeout"})
        qr = f"QRIS|MOCK|{req.provider_ref}|{req.amount}.{self._cents(req.amount)}|{req.expires_at:%Y%m%d%H%M}"
        return CreateResult(ok=True, provider_ref=req.provider_ref, qr_payload=qr, expires_at=req.expires_at,
                            raw={"behavior": BEHAVIOR})

    @staticmethod
    def _cents(amount: int) -> str:
        return f"{amount % 1000:03d}"

    # -- status -----------------------------------------------------------
    async def get_payment_status(self, provider_ref: str) -> ProviderStatus:
        return ProviderStatus(raw_status=self._outcome_raw(), transaction_ref=f"MOCKTX-{provider_ref[-8:]}" if BEHAVIOR == "success" else None)

    def _outcome_raw(self) -> str:
        return {
            "success": RAW_PAID,
            "failure": RAW_FAILED,
            "expire": RAW_PENDING,          # never settled; the expiry sweep closes it
            "timeout": RAW_UNKNOWN,         # even the status poll is ambiguous
            "ambiguous": RAW_UNKNOWN,
        }.get(BEHAVIOR, RAW_PAID)

    # -- webhook ----------------------------------------------------------
    def sign(self, body: bytes) -> str:
        """Test/dev helper: compute the header a genuine mock notification would carry."""
        return hmac.new(self.webhook_secret.encode(), body, hashlib.sha256).hexdigest()

    def build_notification(self, provider_ref: str, amount: int, *, outcome: str, event_id: str,
                           transaction_ref: Optional[str] = None) -> tuple[dict, bytes]:
        """Construct a signed mock notification (used by dev controls and tests)."""
        body = json.dumps({
            "event_id": event_id, "ref": provider_ref, "amount": amount,
            "currency": "IDR", "status": outcome, "transaction_ref": transaction_ref or f"MOCKTX-{provider_ref[-8:]}",
        }).encode()
        return {"x-mock-signature": self.sign(body)}, body

    def verify_webhook(self, headers: dict, body: bytes) -> VerifiedNotification:
        signature = headers.get("x-mock-signature") or headers.get("X-Mock-Signature") or ""
        expected = self.sign(body)
        # constant-time comparison — the real pipeline must not shortcut this
        if not hmac.compare_digest(signature, expected):
            return VerifiedNotification(valid=False, reason="bad signature")
        try:
            payload = json.loads(body.decode())
        except (ValueError, UnicodeDecodeError):
            return VerifiedNotification(valid=False, reason="unparseable body")
        return VerifiedNotification(
            valid=True, event_id=str(payload.get("event_id")), provider_ref=payload.get("ref"),
            raw_status=payload.get("status"), amount=payload.get("amount"),
            currency=payload.get("currency"), transaction_ref=payload.get("transaction_ref"),
        )

    # -- normalization ----------------------------------------------------
    def normalize_status(self, raw_status: str, failure_code: Optional[str] = None) -> Optional[str]:
        """Map provider vocabulary to internal status; None = unrecognized (ambiguous)."""
        from lib.payments.transitions import FAILED, PAID, PENDING
        return {
            RAW_PAID: PAID,
            RAW_FAILED: FAILED,
            RAW_PENDING: PENDING,
        }.get(raw_status)  # unknown vocabulary -> None -> service flags needs_review

    async def request_refund(self, provider_ref: str, amount: int, reason: str):  # noqa: ARG002
        from lib.payments.base import RefundResult
        return RefundResult(ok=True, refund_ref=f"MOCKRF-{provider_ref[-8:]}")


def outcome_for_behavior() -> str:
    return BEHAVIOR
