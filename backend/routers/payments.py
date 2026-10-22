"""Payment endpoints (P3 + refund accounting).

- POST /payments/intents (staff): start a QRIS attempt for a pending order in their store.
- GET  /payments/{id} (staff): attempt status; stale pending attempts are refreshed
  through the provider first (timeout/ambiguity reconciliation).
- POST /public/payments/intents (customer): same, for THEIR order, proven by
  order_no + phone with the same rate limits as the public status lookup.
- GET  /public/payments/{id} (customer): poll status; the attempt id is an unguessable
  uuid and only the public view is returned.
- POST /payments/{attempt_id}/refund (staff): refund a PAID attempt. Optional
  ``idempotency_key`` makes refund retries safe; partial refunds are ledger-tracked.
- POST /webhooks/payments/{provider}: raw-bytes entry into the verification pipeline.
- POST /dev/payments/{id}/settle: mock-provider control, ONLY when the mock adapter is
  active in a non-production process — impossible in production by config.
"""

import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from lib.auth import Principal, get_principal, require_owner, resolve_store
from lib.db import db
from lib.payments import CONFIG, create_intent, get_attempt, refresh_status, request_refund
from lib.payments.config import PaymentConfigError
from lib.payments.registry import get_adapter
from lib.payments.service import (
    PaymentProviderError, handle_webhook, list_events_needing_attention, public_attempt,
)
from lib.ratelimit import check_rate, client_ip
from models.payment import PaymentAttemptPublic, PaymentIntentIn, PublicPaymentIntentIn

router = APIRouter()

DEV_CONTROLS = os.environ.get("DEV_PAYMENT_CONTROLS", "1") == "1"  # off in any real deployment


def _public_view(att: PaymentAttemptPublic) -> PaymentAttemptPublic:
    return att


def _disabled() -> HTTPException:
    return HTTPException(status_code=503, detail="Pembayaran online belum dikonfigurasi di server")


def _error_status(code: str) -> int:
    if code == "attempt_not_found":
        return 404
    if code in {"order_not_found", "order_cancelled", "order_already_paid", "already_at_pickup",
                "idempotency_conflict", "payment_not_paid", "amount_exceeded", "refund_conflict",
                "invalid_amount", "currency_mismatch"}:
        return 409
    return 502


@router.get("/payments/config")
async def payments_config():
    """What the UI may know: enabled flag + provider name. No credentials, no internals."""
    return {
        "enabled": CONFIG.enabled,
        "provider": CONFIG.provider if CONFIG.enabled else None,
        "mode": CONFIG.mode if CONFIG.enabled else None,
        "methods": ["qris"] if CONFIG.enabled else [],
        "expiry_minutes": CONFIG.expiry_minutes if CONFIG.enabled else None,
    }


@router.post("/payments/intents", response_model=PaymentAttemptPublic, status_code=201)
async def create_payment_intent(payload: PaymentIntentIn, p: Principal = Depends(get_principal)):
    if payload.method != "qris":
        raise HTTPException(status_code=422, detail="Unsupported payment method")
    try:
        adapter = get_adapter()
    except PaymentConfigError:
        raise _disabled()
    order = await db.orders.find_one({"id": payload.order_id}, {"_id": 0})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    store_id = await resolve_store(p, order.get("store_id"))
    try:
        att = await create_intent(order["id"], store_id, adapter, idempotency_key=payload.idempotency_key)
    except PaymentProviderError as e:
        raise HTTPException(status_code=_error_status(e.code), detail=e.detail)
    return _public_view(public_attempt(att))


@router.get("/payments/{attempt_id}", response_model=PaymentAttemptPublic)
async def get_payment_attempt(attempt_id: str, p: Principal = Depends(get_principal)):
    att = await get_attempt(attempt_id)
    if not att:
        raise HTTPException(status_code=404, detail="Payment attempt not found")
    await resolve_store(p, att.store_id)
    if att.status == "pending" and att.updated_at < datetime.now(timezone.utc) - timedelta(seconds=30):
        try:
            adapter = get_adapter()
            return _public_view(await refresh_status(attempt_id, att.store_id, adapter))
        except PaymentConfigError:
            pass  # report the stored state rather than erroring the poll
    return _public_view(public_attempt(att))


@router.post("/public/payments/intents", response_model=PaymentAttemptPublic, status_code=201)
async def create_public_payment_intent(payload: PublicPaymentIntentIn, request: Request):
    check_rate(f"payintent:ip:{client_ip(request)}", limit=30, window_seconds=60)
    check_rate(f"payintent:ph:{payload.customer_phone}", limit=10, window_seconds=60)
    try:
        adapter = get_adapter()
    except PaymentConfigError:
        raise _disabled()
    order = await db.orders.find_one(
        {"order_no": payload.order_no, "customer_phone": payload.customer_phone}, {"_id": 0}
    )
    if not order:
        # identical response to a wrong phone — no order existence oracle
        raise HTTPException(status_code=404, detail="Order not found")
    try:
        att = await create_intent(order["id"], order["store_id"], adapter,
                                  idempotency_key=payload.idempotency_key)
    except PaymentProviderError as e:
        raise HTTPException(status_code=_error_status(e.code), detail=e.detail)
    return _public_view(public_attempt(att))


@router.get("/public/payments/{attempt_id}", response_model=PaymentAttemptPublic)
async def get_public_payment_attempt(attempt_id: str, request: Request):
    """Customer status poll. The attempt id is an unguessable uuid; only the public
    projection leaves the server."""
    check_rate(f"paypoll:ip:{client_ip(request)}", limit=60, window_seconds=60)
    att = await get_attempt(attempt_id)
    if not att:
        raise HTTPException(status_code=404, detail="Payment attempt not found")
    if att.status == "pending" and att.updated_at < datetime.now(timezone.utc) - timedelta(seconds=30):
        try:
            adapter = get_adapter()
            return _public_view(await refresh_status(attempt_id, att.store_id, adapter))
        except PaymentConfigError:
            pass
    return _public_view(public_attempt(att))


@router.post("/webhooks/payments/{provider}")
async def payment_webhook(provider: str, request: Request):
    body = await request.body()
    headers = {k.lower(): v for k, v in request.headers.items()}
    try:
        adapter = get_adapter()  # provider must be the configured one — never arbitrary code
    except PaymentConfigError:
        raise _disabled()
    status, message = await handle_webhook(provider, headers, body, adapter)
    return {"status": status, "message": message}


@router.post("/payments/{attempt_id}/refund", response_model=PaymentAttemptPublic)
async def refund_payment(attempt_id: str, amount: int = Query(gt=0), reason: str = Query(min_length=3, max_length=200),
                         idempotency_key: Optional[str] = Query(default=None, max_length=64),
                         p: Principal = Depends(get_principal)):
    att = await get_attempt(attempt_id)
    if not att:
        raise HTTPException(status_code=404, detail="Payment attempt not found")
    await resolve_store(p, att.store_id)
    try:
        adapter = get_adapter()
        att = await request_refund(att.store_id, attempt_id, amount, reason, adapter,
                                   actor=p.name, idempotency_key=idempotency_key)
    except PaymentConfigError:
        raise _disabled()
    except PaymentProviderError as e:
        raise HTTPException(status_code=_error_status(e.code), detail=e.detail)
    return _public_view(public_attempt(att))


@router.get("/payments/events/review")
async def review_payment_events(store_id: str = Query(min_length=1), limit: int = Query(default=100, ge=1, le=200),
                                p: Principal = Depends(require_owner)):
    """Read-only owner-only operational view of payment events needing retry/manual review."""
    sid = await resolve_store(p, store_id)
    return {"events": await list_events_needing_attention(sid, limit=limit)}


# --- development-only mock controls (unreachable in production by config) ------------
@router.post("/dev/payments/{attempt_id}/settle")
async def dev_settle_mock_payment(attempt_id: str, request: Request, outcome: str = Query(default="success")):
    if not (DEV_CONTROLS and CONFIG.provider == "mock" and CONFIG.mock_allowed):
        raise HTTPException(status_code=404, detail="Not found")
    att = await get_attempt(attempt_id)
    if not att:
        raise HTTPException(status_code=404, detail="Payment attempt not found")
    from lib.payments.mock import RAW_FAILED, RAW_PAID, MockProvider
    adapter = get_adapter()
    assert isinstance(adapter, MockProvider)
    raw = RAW_PAID if outcome == "success" else RAW_FAILED
    import uuid as _uuid
    hdrs, body = adapter.build_notification(
        att.provider_ref, att.amount, outcome=raw, event_id=_uuid.uuid4().hex,
        transaction_ref=f"MOCKTX-{att.provider_ref[-8:]}",
    )
    status, message = await handle_webhook("mock", hdrs, body, adapter)
    return {"status": status, "message": message, "outcome": outcome}
