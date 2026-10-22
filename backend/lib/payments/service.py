"""Payment orchestration service (P3 + refund accounting).

Layering rule: routes talk to THIS module only, this module talks to providers through
the adapter interface. No FastAPI imports, no request/response objects, no raw provider
payloads crossing layers.

What "safe" means here (see docs/PAYMENTS.md for the full contract):

* One order can have multiple payment attempts over its lifetime; each attempt is one
  payment obligation with one provider. Orders are never mutated optimistically.
* Intent creation is atomic per (store, provider, idempotency_key) via unique indexes —
  never check-then-insert. The same logical retry returns the existing attempt; a key
  reuse with different scope/payload is a hard conflict.
* Webhook processing is idempotent per event_id and order-scoped; an event for order A
  can never flip order B. Late payment after expiry is reconciled, not dropped.
* Refunds are a durable ledger. Capacity is reserved atomically before any provider
  call, so concurrent partial refunds cannot over-refund; provider timeouts remain
  ambiguous and are reconciled instead of blind retries.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from pymongo.errors import DuplicateKeyError

from lib.audit import audit
from lib.db import db
from lib.payments.base import PaymentProviderAdapter, RefundStatus
from lib.payments.config import CONFIG
from lib.payments import transitions as T
from lib.payments.refund_rules import (
    REFUND_AMBIGUOUS, REFUND_FAILED, REFUND_PENDING, REFUND_SUCCEEDED,
    RefundValidationError, classify_refund_result, refundable_balance,
    same_refund_request, summarize_refund_status, validate_refund_request,
)
from lib.idempotency import payload_fingerprint
from lib.orderflow import CANCELLED, COMPLETED
from models.order import Order
from models.payment import (
    EXPIRED, FAILED, PAID, PENDING,
    PAYMENT_EVENT_FAILED, PAYMENT_EVENT_PROCESSED, PAYMENT_EVENT_PROCESSING,
    PAYMENT_EVENT_RECEIVED,
    PaymentAttempt, PaymentAttemptPublic, PaymentEventRecord, RefundRecord,
)

log = logging.getLogger("nubuah.payments")

MAX_EVENT_ATTEMPTS = 3
EVENT_LOCK_MINUTES = 2


def _event_retry_delay(attempts: int) -> timedelta:
    # Bounded backoff for recoverable webhook failures: 1m, 2m, 4m, capped at 15m.
    minutes = min(2 ** max(0, attempts - 1), 15)
    return timedelta(minutes=minutes)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class PaymentProviderError(RuntimeError):
    """Raised to callers for payment failures; ``code`` is a safe UI string."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


# ---------------------------------------------------------------------------
# Public views
# ---------------------------------------------------------------------------

def public_attempt(att: PaymentAttempt) -> PaymentAttemptPublic:
    return PaymentAttemptPublic(
        id=att.id, order_id=att.order_id, order_no=att.order_no,
        amount=att.amount, currency=att.currency, method=att.method, status=att.status,
        qr_payload=att.qr_payload, qr_image_url=att.qr_image_url,
        expires_at=att.expires_at, paid_at=att.paid_at, failure_code=att.failure_code,
    )


async def payment_attempts_for_order(order_id: str, store_id: str) -> list[PaymentAttemptPublic]:
    rows = await db.payment_attempts.find({"order_id": order_id, "store_id": store_id}).to_list(100)
    rows.sort(key=lambda r: r.get("created_at") or _utcnow(), reverse=True)
    return [public_attempt(PaymentAttempt(**r)) for r in rows]


async def latest_attempt_for_order(order_id: str, store_id: str) -> Optional[PaymentAttempt]:
    row = await db.payment_attempts.find_one(
        {"order_id": order_id, "store_id": store_id},
        sort=[("created_at", -1)],
    )
    return PaymentAttempt(**row) if row else None


# ---------------------------------------------------------------------------
# Intent creation — atomic reservation before any provider call
# ---------------------------------------------------------------------------

ORDER_CURRENCY = "IDR"


def _order_currency(order: Order) -> str:
    # Orders predate a currency field; the POS is IDR-only today. Keep this helper so a
    # future multi-currency order model has one place to change.
    return str(getattr(order, "currency", None) or ORDER_CURRENCY)


def _order_must_be_payable(order: Order) -> None:
    if order.status == CANCELLED:
        raise PaymentProviderError("order_cancelled", "Pesanan sudah dibatalkan")
    if order.payment_status == PAID:
        raise PaymentProviderError("order_already_paid", "Pesanan sudah lunas")
    if order.status == COMPLETED:
        raise PaymentProviderError("order_completed", "Pesanan sudah selesai")


def _intent_fingerprint(order: Order, store_id: str, method: str = "qris") -> str:
    """Canonical hash of the order-defining payment payload.

    The key itself and auth-only material are excluded by payload_fingerprint. Amount,
    currency, method, order identity, and store identity are included, so a key reuse
    with any incompatible payload is detectable even if an old row lacks the field.
    """
    return payload_fingerprint({
        "order_id": order.id,
        "order_no": order.order_no,
        "store_id": store_id,
        "amount": order.total,
        "currency": _order_currency(order),
        "method": method,
    })


def _same_intent_attempt(att: PaymentAttempt, order: Order, store_id: str,
                         adapter: PaymentProviderAdapter, fingerprint: str) -> bool:
    if att.store_id != store_id or att.provider != adapter.name:
        return False
    if att.order_id != order.id or att.amount != order.total:
        return False
    if att.currency != _order_currency(order) or att.method != "qris":
        return False
    # Rows written before request_fingerprint existed are validated by the explicit
    # fields above. Rows with a fingerprint must match it exactly.
    return att.request_fingerprint is None or att.request_fingerprint == fingerprint


def _idempotency_conflict() -> PaymentProviderError:
    return PaymentProviderError(
        "idempotency_conflict",
        "Kunci idempotensi dipakai untuk permintaan pembayaran yang berbeda",
    )


async def create_intent(order_id: str, store_id: str, adapter: PaymentProviderAdapter,
                        idempotency_key: Optional[str] = None) -> PaymentAttempt:
    """Create one local payment attempt, atomically, before any provider call.

    Concurrency/idempotency contract:
    - ``idempotency_key`` is unique per store. The provider is part of the validated
      logical payload, so reusing a key for a different provider/order/amount/currency/
      payload is a conflict, not a second payment obligation.
    - The local row is inserted first. Concurrent identical requests converge on the
      single row that wins the database unique constraint; duplicate-key recovery
      fetches by the same full store+key scope and validates the payload again.
    - Only the local winner calls the provider, with a stable provider-side key.
    - Timeout/connection/unknown outcomes are marked ``needs_review`` and returned as
      ambiguous. They must be reconciled (poll/webhook) and must not be auto-retried.
    """
    order_doc = await db.orders.find_one({"id": order_id, "store_id": store_id})
    if not order_doc:
        raise PaymentProviderError("order_not_found", "Pesanan tidak ditemukan")
    order = Order(**order_doc)
    _order_must_be_payable(order)
    currency = _order_currency(order)
    fingerprint = _intent_fingerprint(order, store_id)

    # -- keyed retry: exact logical match returns the same attempt ----------------
    if idempotency_key:
        existing = await db.payment_attempts.find_one({
            "store_id": store_id, "idempotency_key": idempotency_key,
        })
        if existing:
            ex = PaymentAttempt(**existing)
            if not _same_intent_attempt(ex, order, store_id, adapter, fingerprint):
                raise _idempotency_conflict()
            return ex

    # -- unkeyed duplicate prevention: one open attempt per order/provider/payload --
    if not idempotency_key:
        open_row = await db.payment_attempts.find_one({
            "order_id": order.id,
            "store_id": store_id,
            "provider": adapter.name,
            "status": {"$in": [PENDING, FAILED]},
        })
        if open_row:
            open_att = PaymentAttempt(**open_row)
            same = _same_intent_attempt(open_att, order, store_id, adapter, fingerprint)
            if same and (open_att.status == PENDING or open_att.needs_review):
                # Pending: return the same QRIS obligation. Failed+needs_review: the
                # provider outcome is unknown and must be reconciled, not duplicated.
                return open_att

    provider_ref = f"NBP-{uuid.uuid4().hex[:16].upper()}"
    expires_at = _utcnow() + timedelta(minutes=CONFIG.expiry_minutes)
    att = PaymentAttempt(
        order_id=order.id, order_no=order.order_no, store_id=store_id,
        provider=adapter.name, provider_ref=provider_ref,
        amount=order.total, currency=currency, method="qris",
        status=PENDING, idempotency_key=idempotency_key,
        request_fingerprint=fingerprint, provider_idempotency_key=provider_ref,
        provider_attempted=False, expires_at=expires_at,
    )

    try:
        # Unique index pay_store_idem makes this insert the concurrency gate.
        await db.payment_attempts.insert_one(att.model_dump())
    except DuplicateKeyError:
        if not idempotency_key:
            raise
        # Race recovery: another request inserted after our pre-check. Fetch by the same
        # full store+key scope and validate the winning row against this logical payload.
        row = await db.payment_attempts.find_one({
            "store_id": store_id, "idempotency_key": idempotency_key,
        })
        if row:
            winner = PaymentAttempt(**row)
            if _same_intent_attempt(winner, order, store_id, adapter, fingerprint):
                return winner
        raise _idempotency_conflict()

    # Local reservation succeeded; mark that an external call is now in flight.
    await db.payment_attempts.update_one({"id": att.id}, {"$set": {
        "provider_attempted": True, "updated_at": _utcnow(),
    }})
    att.provider_attempted = True

    from lib.payments.base import CreateRequest
    try:
        result = await adapter.create_payment(CreateRequest(
            provider_ref=att.provider_ref, amount=att.amount, currency=att.currency,
            method=att.method, expires_at=att.expires_at,
            idempotency_key=att.provider_idempotency_key,
        ))
    except Exception as exc:  # connection failure after the provider may have created it
        await db.payment_attempts.update_one({"id": att.id}, {"$set": {
            "status": FAILED, "failure_code": "provider_exception",
            "failure_message": str(exc)[:200], "needs_review": True,
            "updated_at": _utcnow(),
        }})
        raise PaymentProviderError("payment_ambiguous", "Status pembayaran tidak pasti — perlu rekonsiliasi") from exc

    if not result.ok:
        failure_code = result.failure_code or "provider_rejected"
        ambiguous = failure_code.lower() in ("timeout", "ambiguous", "unknown", "connection_error")
        await db.payment_attempts.update_one({"id": att.id}, {"$set": {
            "status": FAILED,
            "failure_code": failure_code,
            "failure_message": "Provider tidak dapat memproses permintaan",
            "needs_review": ambiguous,
            "updated_at": _utcnow(),
        }})
        att_doc = await db.payment_attempts.find_one({"id": att.id})
        att = PaymentAttempt(**att_doc)
        if ambiguous:
            raise PaymentProviderError("payment_ambiguous", "Status pembayaran tidak pasti — perlu rekonsiliasi")
        # Definitive pre-creation failures are safe to retry only with a NEW key (or, for
        # unkeyed creation, by calling create_intent again); the failed local row remains.
        raise PaymentProviderError(failure_code, "Pembayaran ditolak provider")

    if result.expires_at and result.expires_at < att.expires_at:
        att.expires_at = result.expires_at
    att.qr_payload = result.qr_payload
    att.qr_image_url = result.qr_image_url
    await db.payment_attempts.update_one({"id": att.id}, {"$set": {
        "qr_payload": att.qr_payload, "qr_image_url": att.qr_image_url,
        "expires_at": att.expires_at, "updated_at": _utcnow(),
    }})
    await audit("payment.intent_created", "system", store_id=store_id,
                detail={"order_id": order.id, "provider": adapter.name, "amount": att.amount,
                        "attempt_id": att.id, "provider_idempotency_key": att.provider_idempotency_key})
    return att


# ---------------------------------------------------------------------------
# Refunds — durable ledger + atomic capacity reservation
# ---------------------------------------------------------------------------

async def _load_refundable_attempt(attempt_id: str, store_id: str) -> PaymentAttempt:
    row = await db.payment_attempts.find_one({"id": attempt_id, "store_id": store_id})
    if not row:
        raise PaymentProviderError("attempt_not_found", "Percobaan pembayaran tidak ditemukan")
    att = PaymentAttempt(**row)
    if att.status != PAID:
        raise PaymentProviderError("payment_not_paid", "Refund hanya untuk pembayaran yang sudah lunas")
    return att


async def _reserve_refund_capacity(attempt_id: str, amount: int) -> None:
    """Atomically hold refund capacity before contacting the provider.

    MongoDB's conditional update is the concurrency gate. ``$expr`` treats a missing
    ``refund_reserved_amount`` as 0, so pre-migration attempts still behave correctly.
    A failed match means current reserved + requested exceeds the collected amount.
    """
    res = await db.payment_attempts.update_one(
        {
            "id": attempt_id,
            "$expr": {"$lte": [
                {"$add": [{"$ifNull": ["$refund_reserved_amount", 0]}, amount]},
                "$amount",
            ]},
        },
        {"$inc": {"refund_reserved_amount": amount}, "$set": {"updated_at": _utcnow()}},
    )
    if not getattr(res, "matched_count", 0):
        raise PaymentProviderError("amount_exceeded", "Refund melebihi sisa saldo yang bisa dikembalikan")


async def _release_refund_capacity(attempt_id: str, amount: int) -> None:
    await db.payment_attempts.update_one(
        {"id": attempt_id, "refund_reserved_amount": {"$gte": amount}},
        {"$inc": {"refund_reserved_amount": -amount}, "$set": {"updated_at": _utcnow()}},
    )


async def _insert_refund_record(att: PaymentAttempt, amount: int, reason: str,
                                actor: Optional[str], idempotency_key: Optional[str]) -> tuple[RefundRecord, bool]:
    """Insert a refund ledger row, distinguishing creator from duplicate-key loser.

    Returns ``(record, created)``. Only ``created=True`` permits capacity reservation
    and a provider refund call. A duplicate-key recovery returns the pre-existing row
    after validating the same logical request, so concurrent identical retries cannot
    create a second provider obligation.
    """
    record = RefundRecord(
        attempt_id=att.id, order_id=att.order_id, store_id=att.store_id,
        provider=att.provider, provider_ref=att.provider_ref, amount=amount,
        currency=att.currency, reason=reason, status=REFUND_PENDING,
        idempotency_key=idempotency_key,
        provider_key=idempotency_key or f"auto-{uuid.uuid4().hex}",
        requested_by=actor,
    )
    try:
        await db.refunds.insert_one(record.model_dump())
    except DuplicateKeyError:
        existing = await db.refunds.find_one({"attempt_id": att.id, "idempotency_key": idempotency_key})
        if existing and same_refund_request(
            existing, attempt_id=att.id, amount=amount, currency=att.currency,
            reason=reason, idempotency_key=idempotency_key,
        ):
            return RefundRecord(**existing), False
        raise PaymentProviderError(
            "refund_conflict",
            "Kunci idempotensi refund dipakai untuk permintaan refund yang berbeda",
        )
    return record, True


async def _refresh_attempt_refund_summary(attempt_id: str) -> None:
    """Recompute summary fields from the authoritative refund ledger.

    The ledger decides: successful amounts, open ambiguity/pending work, and reserved
    capacity (pending + ambiguous + succeeded). This runs after final refund states and
    on reconciliation, never as a substitute for the atomic reservation gate.
    """
    att_doc = await db.payment_attempts.find_one({"id": attempt_id})
    if not att_doc:
        return
    rows = await db.refunds.find({"attempt_id": attempt_id}).to_list(1000)
    refunded = sum(int(r.get("amount") or 0) for r in rows if r.get("status") == REFUND_SUCCEEDED)
    reserved = sum(int(r.get("amount") or 0) for r in rows if r.get("status") in (REFUND_PENDING, REFUND_AMBIGUOUS, REFUND_SUCCEEDED))
    has_open = any(r.get("status") in (REFUND_PENDING, REFUND_AMBIGUOUS) for r in rows)
    last = max(rows, key=lambda r: r.get("updated_at") or datetime.min.replace(tzinfo=timezone.utc), default=None)
    status = summarize_refund_status(
        attempt_amount=int(att_doc.get("amount") or 0), refunded_amount=refunded,
        has_open=has_open, has_success=refunded > 0,
        last_failed=bool(last and last.get("status") == REFUND_FAILED),
    )
    await db.payment_attempts.update_one({"id": attempt_id}, {"$set": {
        "refunded_amount": refunded,
        "refund_reserved_amount": min(reserved, int(att_doc.get("amount") or 0)),
        "refund_status": status,
        "updated_at": _utcnow(),
    }})


async def _mark_refund_succeeded(record: RefundRecord, refund_ref: Optional[str]) -> RefundRecord:
    now = _utcnow()
    await db.refunds.update_one({"id": record.id}, {"$set": {
        "status": REFUND_SUCCEEDED, "refund_ref": refund_ref or record.refund_ref,
        "failure_code": None, "updated_at": now, "succeeded_at": now,
    }})
    await db.payment_attempts.update_one({"id": record.attempt_id}, {"$set": {
        "refund_ref": refund_ref or record.refund_ref, "updated_at": now,
    }})
    await _refresh_attempt_refund_summary(record.attempt_id)
    fresh = await db.refunds.find_one({"id": record.id})
    return RefundRecord(**fresh)


async def _mark_refund_failed(record: RefundRecord, failure_code: str, *, release: bool = True) -> RefundRecord:
    await db.refunds.update_one({"id": record.id}, {"$set": {
        "status": REFUND_FAILED, "failure_code": failure_code, "updated_at": _utcnow(),
    }})
    if release:
        await _release_refund_capacity(record.attempt_id, record.amount)
    await _refresh_attempt_refund_summary(record.attempt_id)
    fresh = await db.refunds.find_one({"id": record.id})
    return RefundRecord(**fresh)


async def _mark_refund_ambiguous(record: RefundRecord, failure_code: str) -> RefundRecord:
    # Capacity stays reserved: the provider may have moved money and the outcome must
    # be confirmed before any other refund can consume the same capacity.
    await db.refunds.update_one({"id": record.id}, {"$set": {
        "status": REFUND_AMBIGUOUS, "failure_code": failure_code, "updated_at": _utcnow(),
    }})
    await _refresh_attempt_refund_summary(record.attempt_id)
    fresh = await db.refunds.find_one({"id": record.id})
    return RefundRecord(**fresh)


async def refresh_refund(refund_id: str, adapter: PaymentProviderAdapter) -> RefundRecord:
    """Reconcile a pending/ambiguous refund WITHOUT issuing a new provider refund."""
    row = await db.refunds.find_one({"id": refund_id})
    if not row:
        raise PaymentProviderError("refund_not_found", "Refund tidak ditemukan")
    record = RefundRecord(**row)
    if record.status in (REFUND_SUCCEEDED, REFUND_FAILED):
        return record
    try:
        status: RefundStatus = await adapter.get_refund_status(record.provider_ref, record.refund_ref)
    except NotImplementedError:
        return record
    except Exception:
        # Reconciliation probe failed; keep the record open and return current state.
        return record

    outcome = (status.status or "").lower()
    if outcome == "succeeded":
        return await _mark_refund_succeeded(record, status.refund_ref or record.refund_ref)
    if outcome == "failed":
        return await _mark_refund_failed(record, status.failure_code or record.failure_code or "refund_failed")
    # Provider still reports pending/unknown — keep it open for a later probe.
    return record


async def request_refund(store_id: str, attempt_id: str, amount: int, reason: str, adapter: PaymentProviderAdapter,
                         actor: Optional[str] = None, idempotency_key: Optional[str] = None) -> PaymentAttempt:
    """Request a refund with idempotency and over-refund protection.

    Ordering guarantees:
    1. Load and locally validate the PAID attempt (store-scoped).
    2. Insert the refund ledger row first. A duplicate idempotency key returns the same
       logical refund after optional reconciliation; a conflicting reuse is rejected.
    3. Reserve capacity atomically in MongoDB. Concurrent partial refunds cannot both
       pass validation; the loser gets a failed ledger row and ``amount_exceeded``.
    4. Only then call the provider with a deterministic refund idempotency key.
    5. ok=True -> succeeded. Definitive failure -> failed + capacity released. Timeout/
       ambiguous -> ambiguous, capacity held, safe for refresh_refund/manual reconciliation.
    """
    row = await db.payment_attempts.find_one({"id": attempt_id, "store_id": store_id})
    if not row:
        raise PaymentProviderError("attempt_not_found", "Percobaan pembayaran tidak ditemukan")
    att = PaymentAttempt(**row)
    if att.status != PAID:
        raise PaymentProviderError("payment_not_paid", "Refund hanya untuk pembayaran yang sudah lunas")

    # Retry fast-path: an existing key must be resolved before any remaining-balance
    # check, otherwise an ambiguous refund would block its own idempotent reconciliation.
    if idempotency_key:
        existing = await db.refunds.find_one({"attempt_id": attempt_id, "idempotency_key": idempotency_key})
        if existing:
            if not same_refund_request(
                existing, attempt_id=attempt_id, amount=amount, currency=att.currency,
                reason=reason, idempotency_key=idempotency_key,
            ):
                raise PaymentProviderError(
                    "refund_conflict",
                    "Kunci idempotensi refund dipakai untuk permintaan refund yang berbeda",
                )
            # Only an ambiguous refund may be reconciled by probing provider status. A
            # pending row may exist before the first provider call; querying status now
            # could falsely infer success/failure. Preserve it and its reservation for
            # the owner request or explicit recovery instead.
            if existing.get("status") == REFUND_AMBIGUOUS:
                await refresh_refund(existing["id"], adapter)
            att_doc = await db.payment_attempts.find_one({"id": attempt_id})
            return PaymentAttempt(**att_doc)

    try:
        validate_refund_request(
            amount=amount, attempt_amount=att.amount, currency=att.currency,
            attempt_currency=att.currency, refunded_amount=att.refunded_amount,
            reserved_amount=att.refund_reserved_amount,
        )
    except RefundValidationError as exc:
        raise PaymentProviderError(exc.code, exc.detail) from exc

    record, created = await _insert_refund_record(att, amount, reason, actor, idempotency_key)

    # Duplicate-key race/retry: this request did not create the ledger row, so it must
    # not reserve capacity or initiate a provider refund. Ambiguous rows may be probed
    # for reconciliation; pending rows are simply returned as in-progress work owned by
    # the request that created them.
    if not created:
        if record.status == REFUND_AMBIGUOUS:
            await refresh_refund(record.id, adapter)
        att_doc = await db.payment_attempts.find_one({"id": attempt_id})
        return PaymentAttempt(**att_doc)

    try:
        await _reserve_refund_capacity(attempt_id, amount)
    except PaymentProviderError as exc:
        await _mark_refund_failed(record, "amount_exceeded", release=False)
        raise

    try:
        result = await adapter.request_refund(att.provider_ref, amount, reason,
                                              idempotency_key=record.provider_key)
    except PaymentProviderError:
        raise
    except Exception as exc:
        await _mark_refund_ambiguous(record, "provider_exception")
        raise PaymentProviderError("refund_ambiguous", f"Hasil refund tidak pasti: {exc.__class__.__name__}") from exc

    classification = classify_refund_result(result.ok, result.failure_code)
    if classification.status == REFUND_SUCCEEDED:
        finished = await _mark_refund_succeeded(record, result.refund_ref)
        await audit("payment.refunded", actor or "system", store_id=att.store_id,
                    detail={"order_id": att.order_id, "refund_id": record.id, "amount": amount,
                            "reason": reason, "provider": adapter.name, "attempt_id": attempt_id})
        # Best-effort points reversal. reverse_points is itself idempotent per order,
        # so retries/reconciliation cannot reverse the same order twice.
        try:
            from lib.customers import reverse_points
            order_doc = await db.orders.find_one({"id": att.order_id})
            if order_doc:
                # reverse_points is ledger-idempotent per order+reason, so repeated
                # confirmations/reconciliation cannot reverse the same order twice.
                await reverse_points({**order_doc, "payment_status": "paid"}, "reversal_refund")
        except Exception:
            log.exception("points reversal failed for refunded order %s", att.order_id)
    elif classification.status == REFUND_FAILED:
        finished = await _mark_refund_failed(record, classification.failure_code or "refund_failed")
        await audit("payment.refund_failed", actor or "system", store_id=att.store_id,
                    detail={"refund_id": record.id, "amount": amount,
                            "failure_code": finished.failure_code, "attempt_id": attempt_id})
        raise PaymentProviderError(finished.failure_code or "refund_failed", "Refund ditolak provider")
    else:
        finished = await _mark_refund_ambiguous(record, classification.failure_code or "timeout")
        await audit("payment.refund_ambiguous", actor or "system", store_id=att.store_id,
                    detail={"refund_id": record.id, "amount": amount,
                            "failure_code": finished.failure_code, "attempt_id": attempt_id})
        raise PaymentProviderError("refund_ambiguous", "Hasil refund tidak pasti — perlu rekonsiliasi")

    att_doc = await db.payment_attempts.find_one({"id": attempt_id})
    return PaymentAttempt(**att_doc)


# ---------------------------------------------------------------------------
# Expiration / polling
# ---------------------------------------------------------------------------

async def get_attempt(attempt_id: str) -> Optional[PaymentAttempt]:
    row = await db.payment_attempts.find_one({"id": attempt_id})
    return PaymentAttempt(**row) if row else None


async def expire_stale_attempts() -> int:
    """Close expired PENDING attempts. Never treats expiry as proof of non-payment:
    a late provider success reconciles it to PAID (late_payment=True) later."""
    now = _utcnow()
    res = await db.payment_attempts.update_many(
        {"status": PENDING, "expires_at": {"$lt": now}},
        {"$set": {"status": EXPIRED, "updated_at": now}},
    )
    return int(getattr(res, "modified_count", 0) or 0)


async def sweep_expirations() -> int:
    """Server-loop entry point. Kept separate so tests can target the pure pieces."""
    return await expire_stale_attempts()


async def _ensure_order_paid_for_attempt(attempt: PaymentAttempt) -> bool:
    """Best-effort idempotent order settlement for an already-authoritative payment.

    Multi-document transactions may be unavailable, so paid-state propagation is made
    convergent: every paid-attempt observation re-checks the order side. This covers a
    crash after the attempt update but before the order update.
    """
    now = _utcnow()
    res = await db.orders.update_one(
        {"id": attempt.order_id, "payment_status": {"$ne": "paid"}},
        {"$set": {"payment_status": "paid", "payment_method": "qris", "updated_at": now}},
    )
    if not getattr(res, "matched_count", 0):
        return False
    order_doc = await db.orders.find_one({"id": attempt.order_id})
    if not order_doc:
        return False
    try:
        from lib.customers import award_points
        await award_points(order_doc, actor={"name": "QRIS online"})
    except Exception:
        log.exception("points award failed for paid order %s", attempt.order_id)
    return True


async def _apply_paid_transition(attempt: PaymentAttempt, transaction_ref: Optional[str], *, late: bool) -> dict:
    """Authoritatively settle one attempt and converge its order to paid.

    If the order is no longer payable (cancelled/completed), the money is still recorded
    on the attempt, but the payment is flagged for review instead of silently changing a
    terminal order or awarding fulfillment side effects.
    """
    now = _utcnow()
    await db.payment_attempts.update_one({"id": attempt.id, "status": {"$ne": PAID}}, {"$set": {
        "status": PAID, "transaction_ref": transaction_ref, "paid_at": now,
        "late_payment": late, "needs_review": False, "failure_code": None,
        "failure_message": None, "updated_at": now,
    }})
    order_doc = await db.orders.find_one({"id": attempt.order_id})
    if not order_doc:
        await db.payment_attempts.update_one({"id": attempt.id}, {"$set": {
            "needs_review": True, "failure_code": "order_not_found", "updated_at": now,
        }})
        await audit("payment.paid_needs_review", "system", store_id=attempt.store_id,
                    detail={"order_id": attempt.order_id, "reason": "order_not_found", "attempt_id": attempt.id})
        return await db.payment_attempts.find_one({"id": attempt.id})
    if order_doc.get("status") in (CANCELLED, COMPLETED):
        reason = "order_cancelled" if order_doc.get("status") == CANCELLED else "order_completed"
        await db.payment_attempts.update_one({"id": attempt.id}, {"$set": {
            "needs_review": True, "failure_code": reason, "updated_at": now,
        }})
        await audit("payment.paid_needs_review", "system", store_id=attempt.store_id,
                    detail={"order_id": attempt.order_id, "reason": reason,
                            "late_payment": late, "attempt_id": attempt.id})
        return await db.payment_attempts.find_one({"id": attempt.id})

    await _ensure_order_paid_for_attempt(attempt)
    await audit("payment.paid", "system", store_id=attempt.store_id,
                detail={"order_id": attempt.order_id, "provider": attempt.provider,
                        "amount": attempt.amount, "late_payment": late, "attempt_id": attempt.id})
    return await db.payment_attempts.find_one({"id": attempt.id})


async def refresh_status(attempt_id: str, store_id: str, adapter: PaymentProviderAdapter) -> PaymentAttemptPublic:
    """Poll the provider for an attempt whose UI says pending/failed/ambiguous."""
    row = await db.payment_attempts.find_one({"id": attempt_id, "store_id": store_id})
    if not row:
        raise PaymentProviderError("attempt_not_found", "Percobaan pembayaran tidak ditemukan")
    att = PaymentAttempt(**row)
    if att.status == PAID:
        # If the attempt was settled but an earlier order update failed/crashed, polling
        # the paid attempt must converge the order side too.
        await _ensure_order_paid_for_attempt(att)
        return public_attempt(PaymentAttempt(**await db.payment_attempts.find_one({"id": att.id})))
    if att.status not in (PENDING, FAILED) or (att.status == FAILED and not att.needs_review and att.failure_code not in ("timeout", "ambiguous", "unknown")):
        return public_attempt(att)

    status = await adapter.get_payment_status(att.provider_ref)
    new_status = adapter.normalize_status(status.raw_status, status.failure_code)
    if new_status is None:
        await db.payment_attempts.update_one({"id": att.id}, {"$set": {
            "needs_review": True, "updated_at": _utcnow(),
        }})
        return public_attempt(PaymentAttempt(**await db.payment_attempts.find_one({"id": att.id})))

    transition = T.apply_notification(att.status, new_status, expired=att.expires_at < _utcnow())
    if transition.needs_review:
        await db.payment_attempts.update_one({"id": att.id}, {"$set": {
            "needs_review": True, "updated_at": _utcnow(),
        }})
    elif transition.target == PAID and att.status != PAID:
        await _apply_paid_transition(att, status.transaction_ref, late=transition.late_payment)
    elif transition.target != att.status:
        await db.payment_attempts.update_one({"id": att.id}, {"$set": {
            "status": transition.target,
            "failure_code": status.failure_code or ("provider_failed" if transition.target == FAILED else None),
            "updated_at": _utcnow(),
        }})
    fresh = await db.payment_attempts.find_one({"id": att.id})
    return public_attempt(PaymentAttempt(**fresh))


# ---------------------------------------------------------------------------
# Webhooks — idempotent, order-scoped, replay-safe
# ---------------------------------------------------------------------------

def _mandatory_notification_error(notif) -> Optional[str]:
    missing = [
        name for name, value in (
            ("event_id", notif.event_id),
            ("provider_ref", notif.provider_ref),
            ("raw_status", notif.raw_status),
            ("amount", notif.amount),
            ("currency", notif.currency),
        )
        if value in (None, "")
    ]
    return ",".join(missing) if missing else None


async def _record_unknown_event(notif, adapter: PaymentProviderAdapter, failure_code: str) -> None:
    """Preserve investigation data for events that cannot be applied to one attempt."""
    if not getattr(notif, "event_id", None):
        return
    doc = PaymentEventRecord(
        event_id=notif.event_id, provider=adapter.name, provider_ref=notif.provider_ref,
        raw_status=notif.raw_status, amount=notif.amount, currency=notif.currency,
        transaction_ref=notif.transaction_ref, status=PAYMENT_EVENT_FAILED,
        processing_attempts=1, failure_code=failure_code, retryable=False,
        manual_reconciliation_required=True,
    )
    try:
        await db.payment_events.insert_one(doc.model_dump())
    except DuplicateKeyError:
        pass


async def _claim_event(notif, attempt: PaymentAttempt, adapter: PaymentProviderAdapter,
                       store_id: str) -> tuple[Optional[dict], str]:
    """Atomically acquire the event lifecycle row for processing.

    Returns (event_row, outcome). outcome is one of:
    claimed, duplicate, processing, retry_later, manual.
    """
    now = _utcnow()
    event = PaymentEventRecord(
        event_id=notif.event_id, provider=adapter.name, provider_ref=attempt.provider_ref,
        attempt_id=attempt.id, order_id=attempt.order_id, store_id=store_id,
        raw_status=notif.raw_status, amount=int(notif.amount), currency=notif.currency,
        transaction_ref=notif.transaction_ref, status=PAYMENT_EVENT_PROCESSING,
        processing_attempts=1, started_at=now, locked_until=now + timedelta(minutes=EVENT_LOCK_MINUTES),
    )
    try:
        await db.payment_events.insert_one(event.model_dump())
        return await db.payment_events.find_one({"event_id": event.event_id}), "claimed"
    except DuplicateKeyError:
        existing = await db.payment_events.find_one({"event_id": notif.event_id})

    if not existing:
        return None, "processing"
    if existing.get("status") == PAYMENT_EVENT_PROCESSED:
        return existing, "duplicate"
    if existing.get("manual_reconciliation_required"):
        return existing, "manual"

    attempts = int(existing.get("processing_attempts") or 0) + 1
    if attempts > MAX_EVENT_ATTEMPTS:
        await db.payment_events.update_one({"event_id": notif.event_id}, {"$set": {
            "status": PAYMENT_EVENT_FAILED, "retryable": False,
            "manual_reconciliation_required": True, "locked_until": None,
            "next_retry_at": None, "updated_at": now,
        }})
        return existing, "manual"

    if existing.get("status") == PAYMENT_EVENT_PROCESSING:
        locked_until = existing.get("locked_until")
        if locked_until and locked_until > now:
            return existing, "processing"
        claim_filter = {"event_id": notif.event_id, "status": PAYMENT_EVENT_PROCESSING,
                        "locked_until": {"$lt": now}}
    else:
        next_retry_at = existing.get("next_retry_at")
        if next_retry_at and next_retry_at > now:
            return existing, "retry_later"
        claim_filter = {"event_id": notif.event_id,
                        "status": {"$in": [PAYMENT_EVENT_RECEIVED, PAYMENT_EVENT_FAILED]}}

    res = await db.payment_events.update_one(claim_filter, {
        "$set": {"status": PAYMENT_EVENT_PROCESSING, "started_at": now,
                 "locked_until": now + timedelta(minutes=EVENT_LOCK_MINUTES),
                 "failure_code": None, "updated_at": now},
        "$inc": {"processing_attempts": 1},
    })
    if not getattr(res, "matched_count", 0):
        return existing, "processing"
    return await db.payment_events.find_one({"event_id": notif.event_id}), "claimed"


async def _complete_event(event_id: str) -> None:
    await db.payment_events.update_one({"event_id": event_id}, {"$set": {
        "status": PAYMENT_EVENT_PROCESSED, "processed_at": _utcnow(),
        "locked_until": None, "next_retry_at": None, "retryable": False,
        "manual_reconciliation_required": False, "failure_code": None, "updated_at": _utcnow(),
    }})


async def _mark_event_failed(event_id: str, failure_code: str, *, retryable: bool,
                             response_status: str = "failed") -> dict:
    row = await db.payment_events.find_one({"event_id": event_id})
    attempts = int(row.get("processing_attempts") or 1) if row else 1
    can_retry = bool(retryable and attempts < MAX_EVENT_ATTEMPTS)
    await db.payment_events.update_one({"event_id": event_id}, {"$set": {
        "status": PAYMENT_EVENT_FAILED, "failure_code": failure_code,
        "retryable": can_retry,
        "manual_reconciliation_required": not can_retry,
        "locked_until": None,
        "next_retry_at": (_utcnow() + _event_retry_delay(attempts)) if can_retry else None,
        "updated_at": _utcnow(),
    }})
    return {"status": response_status, "reason": failure_code,
            "manual_reconciliation_required": not can_retry}


PAYMENT_EVENT_REVIEW_FIELDS = {
    "id", "event_id", "provider", "provider_ref", "attempt_id", "order_id",
    "store_id", "raw_status", "amount", "currency", "transaction_ref", "status",
    "processing_attempts", "failure_code", "retryable",
    "manual_reconciliation_required", "received_at", "started_at", "locked_until",
    "next_retry_at", "processed_at", "updated_at",
}


async def list_events_needing_attention(store_id: Optional[str] = None, limit: int = 100) -> list[dict]:
    """Operational visibility for events needing retry or manual reconciliation.

    Returns only a safe projection for API serialization: no Mongo ``_id``/BSON values,
    no raw provider payloads, and no unrelated internal diagnostics.
    """
    now = _utcnow()
    query = {"$or": [
        {"manual_reconciliation_required": True},
        {"status": PAYMENT_EVENT_PROCESSING, "locked_until": {"$lt": now}},
        {"status": PAYMENT_EVENT_FAILED, "retryable": True,
         "next_retry_at": {"$lte": now}},
    ]}
    if store_id:
        query["store_id"] = store_id
    projection = {"_id": 0}
    for field in PAYMENT_EVENT_REVIEW_FIELDS:
        projection[field] = 1
    return await db.payment_events.find(query, projection).sort("updated_at", -1).to_list(limit)


async def apply_notification(notif, store_id: str, adapter: PaymentProviderAdapter) -> dict:
    """Apply one verified notification through a recoverable event lifecycle."""
    missing = _mandatory_notification_error(notif)
    if missing:
        await _record_unknown_event(notif, adapter, "missing_fields")
        return {"status": "rejected", "reason": f"missing_fields:{missing}"}

    matches = await db.payment_attempts.find({"provider_ref": notif.provider_ref}).to_list(10)
    if len(matches) != 1:
        await _record_unknown_event(notif, adapter,
                                    "duplicate_provider_ref" if len(matches) > 1 else "unknown_provider_ref")
        return {"status": "rejected" if len(matches) > 1 else "ignored",
                "reason": "duplicate_provider_ref" if len(matches) > 1 else "unknown_provider_ref"}

    row = matches[0]
    if row.get("store_id") != store_id:
        await _record_unknown_event(notif, adapter, "wrong_store")
        return {"status": "ignored", "reason": "wrong_store"}
    attempt = PaymentAttempt(**row)

    event, outcome = await _claim_event(notif, attempt, adapter, store_id)
    if outcome == "duplicate":
        return {"status": "duplicate"}
    if outcome == "processing":
        return {"status": "processing", "reason": "event_already_processing"}
    if outcome == "retry_later":
        return {"status": "retry_later", "reason": "event_retry_backoff"}
    if outcome == "manual":
        return {"status": "manual", "reason": "manual_reconciliation_required"}
    if not event:
        return {"status": "failed", "reason": "event_claim_failed"}

    try:
        if int(notif.amount) != attempt.amount:
            return await _mark_event_failed(notif.event_id, "amount_mismatch", retryable=False,
                                            response_status="rejected")
        if notif.currency != attempt.currency:
            return await _mark_event_failed(notif.event_id, "currency_mismatch", retryable=False,
                                            response_status="rejected")

        # A paid attempt is authoritative even if a prior order-side update was lost.
        if attempt.status == PAID:
            await _ensure_order_paid_for_attempt(attempt)

        new_status = adapter.normalize_status(notif.raw_status or "", None)
        if new_status is None:
            await db.payment_attempts.update_one({"id": attempt.id}, {"$set": {
                "needs_review": True, "updated_at": _utcnow(),
            }})
            return await _mark_event_failed(notif.event_id, "unknown_status", retryable=True,
                                            response_status="ambiguous")

        transition = T.apply_notification(attempt.status, new_status, expired=attempt.expires_at < _utcnow())
        already_applied = transition.target == attempt.status and not transition.needs_review and not transition.late_payment
        if transition.needs_review:
            await db.payment_attempts.update_one({"id": attempt.id}, {"$set": {
                "needs_review": True, "updated_at": _utcnow(),
            }})
            return await _mark_event_failed(notif.event_id, "transition_needs_review", retryable=True,
                                            response_status="ambiguous")
        if transition.target == PAID and attempt.status != PAID:
            await _apply_paid_transition(attempt, notif.transaction_ref, late=transition.late_payment)
        elif transition.target != attempt.status:
            update = {"$set": {"status": transition.target, "updated_at": _utcnow()}}
            if transition.target == FAILED:
                update["$set"]["failure_code"] = "provider_failed"
            await db.payment_attempts.update_one({"id": attempt.id}, update)

        await _complete_event(notif.event_id)
        return {"status": "duplicate" if already_applied else "applied"}
    except Exception as exc:
        log.exception("webhook event processing failed: %s", notif.event_id)
        return await _mark_event_failed(notif.event_id, f"processing_error:{exc.__class__.__name__}", retryable=True)


async def handle_webhook(provider: str, headers: dict, body: bytes, adapter: PaymentProviderAdapter) -> tuple[str, str]:
    """Raw webhook entry point: verify, validate, then apply through recoverable events."""
    if provider != adapter.name:
        return "rejected", "unknown provider"
    notif = adapter.verify_webhook(headers, body)
    if not notif.valid:
        return "rejected", notif.reason or "verification failed"
    missing = _mandatory_notification_error(notif)
    if missing:
        await _record_unknown_event(notif, adapter, "missing_fields")
        return "rejected", f"missing_fields:{missing}"

    matches = await db.payment_attempts.find({"provider_ref": notif.provider_ref}).to_list(10)
    if len(matches) != 1:
        reason = "duplicate_provider_ref" if len(matches) > 1 else "unknown_provider_ref"
        await _record_unknown_event(notif, adapter, reason)
        return ("rejected" if len(matches) > 1 else "ignored"), reason
    result = await apply_notification(notif, matches[0]["store_id"], adapter)
    return result["status"], result.get("reason", "ok")
