"""Payment service (P3): the ONLY path by which provider outcomes reach the order book.

Invariants enforced here:
- an order becomes PAID only through this service, via a guarded atomic update, with an
  audit record. No frontend action, no redirect, no QR display can mark an order paid.
- duplicate / out-of-order notifications are acknowledged but change nothing (paid is
  terminal; events are deduped by (provider, event_id)).
- amount or currency mismatches never mark anything paid — they flag needs_review.
- late money (after expiry) is recorded, flagged late_payment, and surfaced — never
  silently dropped, never auto-refunded (no refund workflow exists until a real
  provider with refund support is integrated).
- sweeps and reconciliation are rerun-safe.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from pymongo.errors import DuplicateKeyError

from lib.audit import audit
from lib.db import db
from lib.payments.base import CreateRequest, PaymentProviderAdapter
from lib.payments.config import CONFIG, PaymentConfig, PaymentConfigError
from lib.payments.transitions import EXPIRED, FAILED, PAID, PENDING, apply_expiry, apply_notification
from models.payment import PaymentAttempt

logger = logging.getLogger(__name__)


class PaymentProviderError(Exception):
    """provider call failed without creating a provable obligation (e.g. timeout)"""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail or code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware_utc(value: datetime) -> datetime:
    """motor returns MongoDB datetimes tz-naive (UTC); make them aware before ANY
    Python-side comparison or naive-vs-aware raises TypeError (a 500 at the API)."""
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


async def create_intent(
    order: dict,
    adapter: PaymentProviderAdapter,
    cfg: PaymentConfig = CONFIG,
    method: str = "qris",
    idempotency_key: Optional[str] = None,
    actor: Optional[dict] = None,
) -> PaymentAttempt:
    """Create one payment attempt for a PENDING order.

    Retry-safe: an existing attempt with the same idempotency_key (or the order's still
    pending attempt when no key is given) is returned instead of creating a second
    obligation. Callers must pass the adapter from get_adapter() — config errors raise
    PaymentConfigError and never half-create anything.
    """
    if order.get("payment_status") != "pending":
        raise PaymentProviderError("order_not_payable", "pesanan sudah dibayar/dibatalkan")
    if order.get("voided"):
        raise PaymentProviderError("order_not_payable", "pesanan dibatalkan")

    query = {"order_id": order["id"]}
    if idempotency_key:
        query = {"$or": [{"idempotency_key": idempotency_key}, {"order_id": order["id"], "status": PENDING}]}
    existing = await db.payment_attempts.find_one(query, {"_id": 0})
    if existing:
        att = PaymentAttempt(**existing)
        if att.status == PENDING or att.status == PAID:
            return att  # safe retry: same logical attempt, never a second obligation
        # dead attempt (failed/expired): fall through and create a fresh one

    import uuid

    provider_ref = f"NB-{order['order_no']}-{uuid.uuid4().hex[:8]}"
    expires_at = _now() + timedelta(minutes=cfg.expiry_minutes)
    res = await adapter.create_payment(CreateRequest(
        provider_ref=provider_ref, amount=order["total"], currency="IDR",
        method=method, expires_at=expires_at, idempotency_key=idempotency_key,
    ))
    if not res.ok:
        # a timeout does NOT prove failure — the caller may reconcile via the provider
        # reference later; we surface a safe code and create no local attempt
        raise PaymentProviderError(res.failure_code or "provider_error")
    attempt = PaymentAttempt(
        order_id=order["id"], order_no=order["order_no"], store_id=order["store_id"],
        provider=adapter.name, provider_ref=res.provider_ref,
        amount=order["total"], method=method, qr_payload=res.qr_payload,
        qr_image_url=res.qr_image_url, idempotency_key=idempotency_key,
        expires_at=res.expires_at or expires_at,
    )
    try:
        await db.payment_attempts.insert_one(attempt.model_dump())
    except DuplicateKeyError:
        stored = await db.payment_attempts.find_one(
            {"provider": adapter.name, "provider_ref": res.provider_ref}, {"_id": 0}
        )
        if stored:
            return PaymentAttempt(**stored)
        raise
    await audit("payment.intent_created", actor, store_id=order["store_id"], detail={
        "attempt_id": attempt.id, "order_no": order["order_no"], "amount": attempt.amount, "provider": adapter.name,
    })
    return attempt


async def get_attempt(attempt_id: str) -> Optional[PaymentAttempt]:
    doc = await db.payment_attempts.find_one({"id": attempt_id}, {"_id": 0})
    return PaymentAttempt(**doc) if doc else None


async def _apply_outcome(attempt: PaymentAttempt, normalized: str, adapter: PaymentProviderAdapter,
                         *, transaction_ref: Optional[str], source: str, expired: bool = False) -> str:
    """Guarded state application shared by webhooks, status polls, and the expiry sweep.
    Returns the resulting status (or the unchanged status)."""
    decision = apply_notification(attempt.status, normalized, expired=expired)
    if decision.target == PAID and attempt.status != PAID:
        res = await db.payment_attempts.update_one(
            {"id": attempt.id, "status": {"$ne": PAID}},
            {"$set": {
                "status": PAID, "paid_at": _now(), "transaction_ref": transaction_ref,
                "late_payment": decision.late_payment, "updated_at": _now(),
            }},
        )
        if res.matched_count:
            order_res = await db.orders.update_one(
                {"id": attempt.order_id, "payment_status": "pending"},
                {"$set": {"payment_status": "paid", "payment_method": "qris", "paid_at": _now()}},
            )
            detail = {"attempt_id": attempt.id, "order_no": attempt.order_no, "amount": attempt.amount,
                      "source": source, "late_payment": decision.late_payment}
            if not order_res.matched_count:
                # money arrived for an order that is already paid/cancelled — a human
                # must reconcile (refund via provider or manual review); we never guess
                await db.payment_attempts.update_one({"id": attempt.id}, {"$set": {"needs_review": True}})
                detail["needs_review"] = True
            else:
                # P5: loyalty for provider-paid orders (idempotent — safe on redelivery)
                from lib.customers import award_points
                order_doc = await db.orders.find_one({"id": attempt.order_id}, {"_id": 0}) or {}
                order_doc.update({"payment_status": "paid"})
                await award_points(order_doc)
            await audit("payment.paid", None, store_id=attempt.store_id, detail=detail)
            return PAID
        return PAID  # lost a race with another paid transition — already settled
    if decision.target == FAILED and attempt.status == PENDING:
        await db.payment_attempts.update_one(
            {"id": attempt.id, "status": PENDING},
            {"$set": {"status": FAILED, "failure_code": "provider_declined", "updated_at": _now()}},
        )
        await audit("payment.failed", None, store_id=attempt.store_id,
                    detail={"attempt_id": attempt.id, "order_no": attempt.order_no, "source": source})
        return FAILED
    if decision.target == EXPIRED and attempt.status == PENDING:
        await db.payment_attempts.update_one(
            {"id": attempt.id, "status": PENDING},
            {"$set": {"status": EXPIRED, "updated_at": _now()}},
        )
        await audit("payment.expired", None, store_id=attempt.store_id,
                    detail={"attempt_id": attempt.id, "order_no": attempt.order_no})
        return EXPIRED
    if decision.needs_review and not attempt.needs_review:
        await db.payment_attempts.update_one({"id": attempt.id}, {"$set": {"needs_review": True, "updated_at": _now()}})
        await audit("payment.needs_review", None, store_id=attempt.store_id,
                    detail={"attempt_id": attempt.id, "order_no": attempt.order_no, "source": source})
    return attempt.status


async def handle_webhook(provider_name: str, headers: dict, body: bytes,
                         adapter: PaymentProviderAdapter) -> tuple[int, str]:
    """Generic webhook pipeline with the provider-specific verification boundary.
    Returns (http_status, message). Never raises on provider weirdness."""
    vn = adapter.verify_webhook(headers, body)
    if not vn.valid:
        await audit("webhook.rejected", None, detail={"provider": provider_name, "reason": vn.reason})
        return 401, "invalid notification"
    if not vn.event_id:
        await audit("webhook.rejected", None, detail={"provider": provider_name, "reason": "no event id"})
        return 400, "no event id"

    # dedupe BEFORE any business effect: the (provider, event_id) unique index is the lock
    try:
        await db.payment_events.insert_one({
            "provider": provider_name, "event_id": vn.event_id, "received_at": _now(), "processed": False,
        })
    except DuplicateKeyError:
        return 200, "duplicate ignored"  # provider redelivery: acknowledge, change nothing

    event_update = {"processed": True}
    attempt = await db.payment_attempts.find_one(
        {"provider": provider_name, "provider_ref": vn.provider_ref}, {"_id": 0}
    )
    if not attempt:
        await db.payment_events.update_one(
            {"provider": provider_name, "event_id": vn.event_id}, {"$set": {"orphan": True}}
        )
        await audit("webhook.orphan", None, detail={"provider": provider_name, "ref": vn.provider_ref})
        return 404, "unknown payment reference"

    att = PaymentAttempt(**attempt)
    if vn.amount is not None and (vn.amount != att.amount or (vn.currency or "IDR") != att.currency):
        await db.payment_attempts.update_one({"id": att.id}, {"$set": {"needs_review": True, "updated_at": _now()}})
        event_update["amount_mismatch"] = True
        await audit("webhook.amount_mismatch", None, store_id=att.store_id, detail={
            "attempt_id": att.id, "expected": att.amount, "got": vn.amount, "currency": vn.currency,
        })
    else:
        normalized = adapter.normalize_status(vn.raw_status or "")
        expired_by_time = att.status == PENDING and _now() > _aware_utc(att.expires_at)
        await _apply_outcome(att, normalized, adapter, transaction_ref=vn.transaction_ref,
                             source="webhook", expired=expired_by_time)

    await db.payment_events.update_one(
        {"provider": provider_name, "event_id": vn.event_id}, {"$set": event_update}
    )
    return 200, "ok"


async def refresh_status(attempt_id: str, adapter: PaymentProviderAdapter) -> Optional[PaymentAttempt]:
    """Reconciliation poll for timeouts and ambiguous outcomes. Reuses the exact same
    guarded application as webhooks — a poll can never do anything a webhook couldn't."""
    att = await get_attempt(attempt_id)
    if not att or att.status != PENDING:
        return att
    ps = await adapter.get_payment_status(att.provider_ref)
    expired_by_time = _now() > _aware_utc(att.expires_at)
    await _apply_outcome(att, adapter.normalize_status(ps.raw_status, ps.failure_code), adapter,
                         transaction_ref=ps.transaction_ref, source="reconcile", expired=expired_by_time)
    return await get_attempt(attempt_id)


async def sweep_expirations(now: Optional[datetime] = None) -> int:
    """Rerun-safe: pending attempts whose time ran out become expired. Paid attempts are
    untouched (apply_expiry guarantees that even if the query races a settlement)."""
    now = now or _now()
    docs = await db.payment_attempts.find(
        {"status": PENDING, "expires_at": {"$lt": now}}, {"_id": 0}
    ).to_list(500)
    for doc in docs:
        att = PaymentAttempt(**doc)
        decision = apply_expiry(att.status)
        if decision.target == EXPIRED:
            await db.payment_attempts.update_one(
                {"id": att.id, "status": PENDING}, {"$set": {"status": EXPIRED, "updated_at": _now()}}
            )
            await audit("payment.expired", None, store_id=att.store_id,
                        detail={"attempt_id": att.id, "order_no": att.order_no, "source": "sweep"})
    return len(docs)


async def request_refund(attempt_id: str, amount: int, reason: str,
                         adapter: PaymentProviderAdapter, actor: Optional[dict] = None) -> PaymentAttempt:
    """Where the provider supports refunds. The ORDER's payment record is not rewritten —
    refunds are tracked on the attempt and reported in P4 analytics."""
    att = await get_attempt(attempt_id)
    if not att:
        raise PaymentProviderError("not_found", "percobaan pembayaran tidak ditemukan")
    if att.status != PAID:
        raise PaymentProviderError("not_paid", "hanya pembayaran berhasil yang bisa refund")
    if amount > att.amount:
        raise PaymentProviderError("amount_exceeded", "refund melebihi jumlah bayar")
    res = await adapter.request_refund(att.provider_ref, amount, reason)
    if not res.ok:
        await db.payment_attempts.update_one(
            {"id": att.id}, {"$set": {"refund_status": "failed", "updated_at": _now()}}
        )
        raise PaymentProviderError(res.failure_code or "refund_failed")
    await db.payment_attempts.update_one(
        {"id": att.id},
        {"$set": {"refund_status": "refunded", "refund_ref": res.refund_ref,
                  "refunded_amount": amount, "updated_at": _now()}},
    )
    await audit("payment.refund", actor, store_id=att.store_id, detail={
        "attempt_id": att.id, "order_no": att.order_no, "amount": amount, "reason": reason,
    })
    # P5: a refunded order earned points it keeps no right to — reverse exactly what the
    # order earned (idempotent). Coupon redemption stays consumed (goods may be gone);
    # owners can compensate manually via the ledger adjustment endpoint.
    from lib.customers import reverse_points
    order_doc = await db.orders.find_one({"id": att.order_id}, {"_id": 0})
    if order_doc:
        await reverse_points(order_doc, "reversal_refund", actor=actor)
    return (await get_attempt(attempt_id)) or att
