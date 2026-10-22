import os
import re
from datetime import date, datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from lib.auth import Principal, get_principal, resolve_store, verify_secret
from lib.audit import audit
from lib.dates import today_iso
from lib.db import db
from lib.idempotency import payload_fingerprint
from lib.orderflow import ALL_STATUSES, CANCELLED, COMPLETED, PREPARING, assert_transition
from lib.pricing import verify_line
from lib.scheduling import ScheduleError, normalize_schedule, validate_requested_slot
from lib.slot_reservation import release_slot, reserve_slot
from models.order import (
    CancelIn, Order, OrderCreate, OrderLine, OrderList, OrderPayIn, OrdersSummary,
    RescheduleIn, StatusIn, TodayInfo, VoidIn,
)

router = APIRouter()

STORE_TZ = os.environ.get("STORE_TZ", "Asia/Jakarta")
MAX_RANGE_DAYS = 92  # hard cap on report/history ranges so an open range cannot scan the whole collection


def discount_cap_pct() -> int:
    """Cashier discounts above this percent of subtotal need the store's owner approval PIN."""
    try:
        return max(0, min(100, int(os.environ.get("DISCOUNT_CAP_PCT", "10"))))
    except ValueError:
        return 10


def _parse_date(value: str, field: str) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{field} must be YYYY-MM-DD")


def date_range(start: Optional[str], end: Optional[str]) -> tuple[str, str]:
    today = today_iso(STORE_TZ)
    start_d = _parse_date(start, "start") if start else today
    end_d = _parse_date(end, "end") if end else start_d
    if start_d > end_d:
        raise HTTPException(status_code=400, detail="start must be on or before end")
    if (date.fromisoformat(end_d) - date.fromisoformat(start_d)).days >= MAX_RANGE_DAYS:
        raise HTTPException(status_code=400, detail=f"Rentang tanggal maksimal {MAX_RANGE_DAYS} hari")
    return start_d, end_d


async def next_order_seq(store_id: str, business_date: str) -> int:
    """Atomic per-store-per-day counter (find_one_and_update + upsert): concurrent checkouts
    can never produce duplicate order numbers the way count_documents+1 could."""
    key = f"order_seq:{store_id}:{business_date}"
    doc = await db.counters.find_one_and_update(
        {"key": key},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    seq = doc["seq"]
    # Backups used to skip the counters collection: after a restore the counter resets to 1
    # and would collide with an existing order number. Re-seed from the highest order_no.
    last = await db.orders.find_one(
        {"store_id": store_id, "business_date": business_date, "order_no": {"$regex": r"-\d+$"}},
        {"order_no": 1},
        sort=[("order_no", -1)],
    )
    if last and (m := re.search(r"-(\d+)$", last["order_no"])) and int(m.group(1)) >= seq:
        seq = int(m.group(1)) + 1
        await db.counters.update_one({"key": key}, {"$set": {"seq": seq}})
    return seq


def _to_order(doc: dict) -> Order:
    doc.pop("_id", None)
    doc.pop("seeded", None)
    created = doc.get("created_at")
    if isinstance(created, datetime) and created.tzinfo is None:
        doc["created_at"] = created.replace(tzinfo=timezone.utc)
    return Order(**doc)


@router.get("/today", response_model=TodayInfo)
async def get_today():
    return TodayInfo(date=today_iso(STORE_TZ), timezone=STORE_TZ)


@router.post("/orders", response_model=Order, status_code=201)
async def create_order(payload: OrderCreate, p: Principal = Depends(get_principal)):
    store_id = await resolve_store(p, payload.store_id)

    # Idempotent checkout: a retried submission (network hiccup, double tap) returns the
    # already-created order instead of charging the customer twice. The fingerprint pins
    # the key to its content: the same key carrying *different* order content is a
    # client bug or an abuse attempt and must not silently return the old order.
    fingerprint = payload_fingerprint(payload.model_dump())
    if payload.client_order_id:
        existing = await db.orders.find_one({"store_id": store_id, "client_order_id": payload.client_order_id}, {"_id": 0})
        if existing:
            if existing.get("idempotency_hash") and existing["idempotency_hash"] != fingerprint:
                raise HTTPException(status_code=409, detail="Idempotency key sudah dipakai untuk pesanan yang berbeda")
            return _to_order(existing)

    store = await db.stores.find_one({"id": store_id}, {"_id": 0})

    # Scheduling (P2): validate the requested slot against the store's config. A slot
    # reservation is taken only after validation, and released again if the insert loses
    # an idempotency race — capacity never leaks.
    schedule_cfg = normalize_schedule((store or {}).get("schedule"))
    scheduled_for = None
    if payload.scheduled_for:
        try:
            scheduled_for = validate_requested_slot(schedule_cfg, payload.scheduled_for, ZoneInfo(STORE_TZ), datetime.now(timezone.utc))
        except ScheduleError as e:
            raise HTTPException(status_code=409, detail=e.detail) from e
        if not await reserve_slot(store_id, scheduled_for, int(schedule_cfg.get("capacity_per_slot") or 0)):
            raise HTTPException(status_code=409, detail="Slot penuh, pilih waktu lain")

    # Recompute every line price server-side; a tampered client cannot name its own price.
    verified = [(ln, await verify_line(store_id, ln)) for ln in payload.lines]

    # attach each line's category from the LIVE menu (server-derived, never client-sent)
    # so category-scoped coupons and category reports work on real data
    prod_ids = list({ln.product_id for ln in payload.lines if ln.product_id})
    if prod_ids:
        prods = await db.menu_products.find({"$or": [{"store_id": None}, {"store_id": store_id}], "id": {"$in": prod_ids}}, {"_id": 0, "id": 1, "category_id": 1, "category": 1}).to_list(None)
        # legacy menu rows store the category id in `category`; newer ones in `category_id`
        cat_of = {pr["id"]: pr.get("category_id") or pr.get("category") for pr in prods}
        verified = [(ln.model_copy(update={"category_id": cat_of.get(ln.product_id)}), price) for ln, price in verified]
    lines = []
    for ln, unit in verified:
        data = ln.model_dump()
        data["unit_price"] = unit
        data["line_total"] = unit * ln.qty
        lines.append(OrderLine(**data))
    subtotal = sum(ln.line_total for ln in lines)
    discount = 0
    if payload.discount_type and payload.discount_value:
        if payload.discount_type == "percent":
            if payload.discount_value > 100:
                raise HTTPException(status_code=400, detail="Diskon persen maksimal 100%")
            discount = (subtotal * payload.discount_value + 50) // 100  # rounded to the nearest Rupiah
        else:
            if payload.discount_value > subtotal:
                raise HTTPException(status_code=400, detail="Diskon lebih besar dari total belanja")
            discount = payload.discount_value
    total = subtotal - discount

    # P5 customer programs — priced on the VERIFIED lines; amounts are snapshotted onto
    # the order so later coupon edits can never rewrite history.
    from lib.customers import loyalty_for, reserve_coupon, validate_and_price_coupon, refund_redeem
    from lib.loyalty import CouponError, redeem_value, redeemable_points
    phone = (payload.customer_phone or "").strip() or None
    # member ID in its own field — resolves to the profile (canonical phone + name)
    resolved_member = None
    if payload.member_no:
        resolved_member = await db.customers.find_one(
            {"store_id": store_id, "member_no": payload.member_no.strip().upper()}, {"_id": 0}
        )
        if not resolved_member:
            raise HTTPException(status_code=409, detail="ID member tidak ditemukan")
        phone = resolved_member["phone"]
    loyalty_cfg = await loyalty_for(store_id)
    coupon_id = None
    coupon_code = None
    coupon_amount = 0
    if payload.coupon_code:
        try:
            coupon, coupon_amount = await validate_and_price_coupon(
                store_id, payload.coupon_code, subtotal, [ln.model_dump() for ln in lines], phone)
            coupon_id, coupon_code = coupon["id"], coupon["code"]
        except CouponError as e:
            raise HTTPException(status_code=409, detail=e.detail)

    points_redeemed = 0
    redeem_value_amount = 0
    if payload.redeem_points:
        if not phone:
            raise HTTPException(status_code=400, detail="Redeem poin butuh No. HP atau ID member")
        # the cashier field accepts EITHER a phone or a member number
        cust = await db.customers.find_one(
            {"store_id": store_id, "$or": [{"phone": phone}, {"member_no": phone}]}, {"_id": 0}
        )
        if not cust:
            raise HTTPException(status_code=409, detail="Pelanggan/member tidak ditemukan")
        if not cust.get("is_member"):
            raise HTTPException(status_code=409, detail="Pelanggan bukan member — poin hanya untuk member")
        allowed = redeemable_points(cust.get("points", 0), max(0, total - coupon_amount), loyalty_cfg)
        if payload.redeem_points > allowed:
            raise HTTPException(status_code=409, detail=f"Maksimal {allowed} poin untuk pesanan ini")
        points_redeemed = payload.redeem_points
        redeem_value_amount = redeem_value(points_redeemed, loyalty_cfg)
        phone = cust["phone"]  # canonical phone for the snapshot/award path

    # the single amount the customer actually pays — used by the cash check, the Order,
    # and nothing else, so tendered/change can never drift from the charged total
    grand_total = max(0, total - coupon_amount - redeem_value_amount)

    if discount > 0:
        cap = discount_cap_pct()
        above_cap = subtotal == 0 or discount * 100 > cap * subtotal
        if above_cap and not p.is_owner:
            approved = bool(payload.approval_pin and store and store.get("approval_pin_hash") and verify_secret(payload.approval_pin, store["approval_pin_hash"]))
            if not approved:
                raise HTTPException(status_code=403, detail=f"Diskon di atas {cap}% butuh PIN owner")
        await audit("order.discount", p, store_id=store_id, detail={
            "subtotal": subtotal, "discount": discount, "type": payload.discount_type, "value": payload.discount_value,
            "note": payload.discount_note, "above_cap": above_cap,
        })
    # pay_at_pickup only makes sense for a scheduled order; the cash/card/qris fields are
    # recorded by the cashier at pickup (pay_pending_order) instead of at creation.
    pay_now = not payload.pay_at_pickup
    if payload.pay_at_pickup and scheduled_for is None:
        raise HTTPException(status_code=400, detail="pay_at_pickup hanya untuk pesanan terjadwal")
    cash_tendered: Optional[int] = None
    change: Optional[int] = None
    if payload.payment_method == "cash" and pay_now:
        cash_tendered = payload.cash_tendered if payload.cash_tendered is not None else grand_total
        if cash_tendered < grand_total:
            raise HTTPException(status_code=400, detail="Uang tunai kurang dari total")
        change = cash_tendered - grand_total

    business_date = today_iso(STORE_TZ)
    seq = await next_order_seq(store_id, business_date)
    order = Order(
        client_order_id=payload.client_order_id,
        idempotency_hash=fingerprint,
        fulfillment="scheduled" if scheduled_for else "immediate",
        scheduled_for=scheduled_for,
        payment_status="pending" if not pay_now else "paid",
        order_no=f"{store['code']}-{business_date.replace('-', '')[2:]}-{seq:03d}",
        business_date=business_date,
        store_id=store_id,
        store_name=store["name"],
        store_address_lines=store.get("address_lines", []),
        store_phone=store.get("phone", ""),
        cashier_name=p.name,
        lines=lines,
        item_count=sum(ln.qty for ln in lines),
        subtotal=subtotal,
        discount_type=payload.discount_type if discount else None,
        discount_value=payload.discount_value if discount else 0,
        discount_amount=discount,
        discount_note=(payload.discount_note or "").strip() or None if discount else None,
        coupon_id=coupon_id,
        coupon_code=coupon_code,
        coupon_amount=coupon_amount,
        points_redeemed=points_redeemed,
        redeem_value_amount=redeem_value_amount,
        total=grand_total,
        payment_method=payload.payment_method,
        cash_tendered=cash_tendered,
        change=change,
        customer_name=(payload.customer_name or "").strip() or (resolved_member or {}).get("name"),
        customer_phone=phone,
    )

    # Redeem points + consume coupon quota BEFORE the insert, keyed by the order id, so a
    # failed insert never leaves a dangling debit. The value was fixed above; this is the
    # atomic debit (guarded by the balance check in do_redeem). Rolled back on failure.
    if points_redeemed:
        from lib.customers import redeem_points as do_redeem
        try:
            await do_redeem(phone, store_id, points_redeemed, order.id)
        except ValueError as e:
            raise HTTPException(status_code=409, detail=str(e))
    if coupon_id:
        try:
            await reserve_coupon(coupon_id, order.id, phone)
        except CouponError as e:
            if points_redeemed:
                await refund_redeem(phone, store_id, points_redeemed, order.id)
            raise HTTPException(status_code=409, detail=e.detail)

    try:
        await db.orders.insert_one(order.model_dump())
    except DuplicateKeyError:
        # Concurrent retries can both pass the find_one above; the unique index decides.
        # The loser returns the winner's order — never a 500, never a second charge.
        # Its slot/coupon/points reservations are rolled back (the winner keeps its own).
        existing = await db.orders.find_one(
            {"store_id": store_id, "client_order_id": payload.client_order_id}, {"_id": 0}
        ) if payload.client_order_id else None
        await release_slot(store_id, scheduled_for)
        await release_coupon(coupon_id, order.id)
        if points_redeemed:
            await refund_redeem(phone, store_id, points_redeemed, order.id)
        if existing:
            return _to_order(existing)
        raise  # a different unique collision (order_no): surface it as a real error
    if order.payment_status == "paid":
        await award_points(order.model_dump(), actor=p)
    return order


@router.get("/orders/pending", response_model=list[Order])
async def list_pending_customer_orders(store_id: Optional[str] = Query(None), p: Principal = Depends(get_principal)):
    """Customer-channel orders waiting for payment at the counter (today, this store).

    Kept for compatibility; the POS now uses /orders/cashier-queue for the unified
    customer/scheduled action view.
    """
    sid = await resolve_store(p, store_id)
    d = today_iso(STORE_TZ)
    docs = await db.orders.find(
        {"store_id": sid, "business_date": d, "channel": "customer", "payment_status": "pending", "voided": {"$ne": True}},
        {"_id": 0},
    ).sort("created_at", 1).to_list(200)
    return [_to_order(d) for d in docs]


@router.get("/orders/cashier-queue")
async def cashier_queue(store_id: Optional[str] = Query(None), include_completed: bool = Query(True),
                        p: Principal = Depends(get_principal)):
    """Action-first queue for customer self-checkout and scheduled pickup orders.

    - unpaid: every active unpaid customer/scheduled order, regardless pickup date;
    - processing: paid orders still in the staff workflow;
    - ready: paid orders waiting for customer handoff;
    - completed: recent completed/cancelled orders for history.
    """
    sid = await resolve_store(p, store_id or p.store_id)
    customer_scope = {"$or": [{"channel": "customer"}, {"fulfillment": "scheduled"}]}
    active = {"voided": {"$ne": True}, "status": {"$nin": [CANCELLED, COMPLETED]}}

    unpaid_docs = await db.orders.find(
        {**customer_scope, **active, "payment_status": "pending"}, {"_id": 0}
    ).to_list(500)
    processing_docs = await db.orders.find(
        {**customer_scope, **active, "payment_status": "paid",
         "status": {"$in": ["received", "confirmed", "preparing"]}}, {"_id": 0}
    ).to_list(500)
    ready_docs = await db.orders.find(
        {**customer_scope, **active, "payment_status": "paid", "status": "ready"}, {"_id": 0}
    ).to_list(500)

    if include_completed:
        completed_docs = await db.orders.find(
            {**customer_scope, "$or": [{"voided": True}, {"status": {"$in": [CANCELLED, COMPLETED]}}]},
            {"_id": 0}, sort=[("updated_at", -1)],
        ).to_list(200)
    else:
        completed_docs = []

    epoch = datetime.min.replace(tzinfo=timezone.utc)
    far_future = datetime.max.replace(tzinfo=timezone.utc)

    def as_utc(value):
        if isinstance(value, datetime):
            return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        if isinstance(value, str):
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
            except ValueError:
                return None
        return None

    def urgency(doc: dict):
        immediate = doc.get("fulfillment") != "scheduled"
        created = as_utc(doc.get("created_at")) or epoch
        scheduled = as_utc(doc.get("scheduled_for"))
        return (0 if immediate else 1, scheduled or created, created)

    def ready_urgency(doc: dict):
        created = as_utc(doc.get("created_at")) or epoch
        scheduled = as_utc(doc.get("scheduled_for"))
        late = bool(scheduled and scheduled < datetime.now(timezone.utc))
        return (0 if late else 1, scheduled or far_future, created)

    return {
        "unpaid": [_to_order(d) for d in sorted(unpaid_docs, key=urgency)],
        "processing": [_to_order(d) for d in sorted(processing_docs, key=urgency)],
        "ready": [_to_order(d) for d in sorted(ready_docs, key=ready_urgency)],
        "completed": [_to_order(d) for d in completed_docs],
    }


@router.post("/orders/{id}/pay", response_model=Order)
async def pay_pending_order(id: str, payload: OrderPayIn, p: Principal = Depends(get_principal)):
    """Cashier collects payment for a pending customer order at pickup."""
    doc = await db.orders.find_one({"id": id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Order not found")
    await resolve_store(p, doc.get("store_id"))  # cashier must belong to the order's store
    if doc.get("channel") != "customer" or doc.get("payment_status") != "pending":
        raise HTTPException(status_code=409, detail="Pesanan ini sudah dibayar")
    subtotal = doc["total"]  # customer orders are created undiscounted, so total == subtotal
    discount = 0
    if payload.discount_type and payload.discount_value:
        if payload.discount_type == "percent":
            if payload.discount_value > 100:
                raise HTTPException(status_code=400, detail="Diskon persen maksimal 100%")
            discount = (subtotal * payload.discount_value + 50) // 100
        else:
            if payload.discount_value > subtotal:
                raise HTTPException(status_code=400, detail="Diskon lebih besar dari total belanja")
            discount = payload.discount_value
    total = subtotal - discount
    if discount > 0:
        cap = discount_cap_pct()
        above_cap = subtotal == 0 or discount * 100 > cap * subtotal
        if above_cap and not p.is_owner:
            store = await db.stores.find_one({"id": doc.get("store_id")}, {"_id": 0, "approval_pin_hash": 1})
            approved = bool(payload.approval_pin and store and store.get("approval_pin_hash") and verify_secret(payload.approval_pin, store["approval_pin_hash"]))
            if not approved:
                raise HTTPException(status_code=403, detail=f"Diskon di atas {cap}% butuh PIN owner")
        await audit("order.discount", p, store_id=doc.get("store_id"), detail={
            "order_id": id, "order_no": doc.get("order_no"), "subtotal": subtotal, "discount": discount,
            "type": payload.discount_type, "value": payload.discount_value, "note": payload.discount_note, "above_cap": above_cap,
        })
    cash_tendered: Optional[int] = None
    change: Optional[int] = None
    if payload.payment_method == "cash":
        cash_tendered = payload.cash_tendered if payload.cash_tendered is not None else total
        if cash_tendered < total:
            raise HTTPException(status_code=400, detail="Uang tunai kurang dari total")
        change = cash_tendered - total
    changes = {
        "subtotal": subtotal,
        "discount_type": payload.discount_type if discount > 0 else None,
        "discount_value": payload.discount_value if discount > 0 else 0,
        "discount_note": payload.discount_note.strip() if discount > 0 and payload.discount_note else None,
        "discount_amount": discount,
        "total": total,
        "payment_method": payload.payment_method,
        "payment_status": "paid",
        "cash_tendered": cash_tendered,
        "change": change,
        "cashier_name": p.name,
    }
    # atomic guard: a concurrent double-pay can never both succeed
    res = await db.orders.update_one({"id": id, "payment_status": "pending"}, {"$set": changes})
    if not res.matched_count:
        raise HTTPException(status_code=409, detail="Pesanan ini sudah dibayar")
    await audit("order.pay", p, store_id=doc.get("store_id"), detail={"order_id": id, "order_no": doc.get("order_no"), "total": total, "method": payload.payment_method})
    # P5: award loyalty points exactly once (ledger uniqueness makes this idempotent)
    from lib.customers import award_points
    await award_points({**doc, **changes}, actor=p)
    return _to_order({**doc, **changes})


@router.post("/orders/{id}/cancel", response_model=Order)
async def cancel_pending_order(id: str, payload: CancelIn, p: Principal = Depends(get_principal)):
    """Cashier/owner cancels a pending customer order (no-show, duplicate, customer request).
    The order stays in history as VOID with the reason; it never counted as revenue."""
    doc = await db.orders.find_one({"id": id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Order not found")
    await resolve_store(p, doc.get("store_id"))
    cancellable = doc.get("payment_status") == "pending" and not doc.get("voided") and (
        doc.get("channel") == "customer" or doc.get("fulfillment") == "scheduled"
    )
    if not cancellable:
        raise HTTPException(status_code=409, detail="Hanya pesanan yang belum dibayar (online atau terjadwal) yang bisa dibatalkan")
    reason = payload.reason.strip()
    changes = {
        "voided": True, "void_reason": reason, "voided_at": datetime.now(timezone.utc),
        "voided_by": p.name, "status": CANCELLED,
    }
    # atomic guard: pay and cancel race — exactly one can win
    res = await db.orders.update_one({"id": id, "payment_status": "pending"}, {"$set": changes})
    if not res.matched_count:
        raise HTTPException(status_code=409, detail="Pesanan ini sudah dibayar")
    await release_slot(doc.get("store_id"), doc.get("scheduled_for"))
    # P5: free the coupon quota (if any); no points reversal — unpaid orders earn nothing
    from lib.customers import release_coupon
    await release_coupon(doc.get("coupon_id"), id)
    await audit("order.cancel", p, store_id=doc.get("store_id"), detail={"order_id": id, "order_no": doc.get("order_no"), "reason": reason})
    return _to_order({**doc, **changes})


@router.get("/orders/scheduled", response_model=list[Order])
async def list_scheduled_orders(store_id: Optional[str] = Query(None), include_completed: bool = Query(False), p: Principal = Depends(get_principal)):
    """Scheduled orders for the staff panel. Default: active ones (not completed/
    cancelled/voided), pickup within the last 4h .. next 36h. include_completed=true
    returns completed ones instead, so the 'Sudah diambil' tab works off one fetch."""
    sid = await resolve_store(p, store_id)
    now = datetime.now(timezone.utc)
    # include_completed=true means "the staff panel's single fetch": return BOTH active
    # and completed orders so its client-side tabs (Baru … Sudah diambil) all work.
    # Otherwise return only the active ones.
    status_q = {"status": {"$nin": [COMPLETED, CANCELLED]}} if not include_completed else {}
    docs = await db.orders.find(
        {
            "store_id": sid, "fulfillment": "scheduled", "voided": {"$ne": True},
            **status_q,
            "scheduled_for": {"$gte": now - timedelta(hours=4), "$lte": now + timedelta(days=7)},
        },
        {"_id": 0},
    ).sort("scheduled_for", 1).to_list(500)
    return [_to_order(d) for d in docs]


def _aware_utc(value: datetime) -> datetime:
    """MongoDB stores datetimes without tz info and motor returns them naive-UTC.
    Every Python-side comparison MUST route through this or naive-vs-aware raises
    TypeError (surfaced to the client as a 500)."""
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


@router.post("/orders/{id}/status", response_model=Order)
async def set_order_status(id: str, payload: StatusIn, p: Principal = Depends(get_principal)):
    """Advance the preparation flow. Transitions are validated (lib/orderflow.py); a
    scheduled order cannot be completed before its pickup time."""
    doc = await db.orders.find_one({"id": id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Order not found")
    await resolve_store(p, doc.get("store_id"))
    if doc.get("voided") or doc.get("status") == CANCELLED:
        raise HTTPException(status_code=409, detail="Pesanan sudah dibatalkan")
    current = doc.get("status") or "received"
    try:
        assert_transition(current, payload.status)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    # business rule: "dibuat" (preparing) requires payment — never start production on an
    # unpaid order. Completion has no time restriction; payment is the only gate.
    if payload.status == PREPARING and doc.get("payment_status") != "paid":
        raise HTTPException(status_code=409, detail="Pesanan belum lunas — tidak bisa ditandai 'dibuat'")
    res = await db.orders.update_one({"id": id, "status": current}, {"$set": {"status": payload.status}})
    if not res.matched_count:
        raise HTTPException(status_code=409, detail="Status sudah berubah, muat ulang")
    await audit("order.status", p, store_id=doc.get("store_id"), detail={
        "order_id": id, "order_no": doc.get("order_no"), "from": current, "to": payload.status,
    })
    return _to_order({**doc, "status": payload.status})


@router.post("/orders/{id}/reschedule", response_model=Order)
async def reschedule_order(id: str, payload: RescheduleIn, p: Principal = Depends(get_principal)):
    """Move an order to a different slot (null = convert to immediate). Staff only.
    The new slot is validated and capacity-reserved BEFORE the old one is released, so a
    full target slot can never strand the order without a reservation."""
    doc = await db.orders.find_one({"id": id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Order not found")
    store_id = await resolve_store(p, doc.get("store_id"))
    if doc.get("voided") or doc.get("status") in (COMPLETED, CANCELLED):
        raise HTTPException(status_code=409, detail="Pesanan sudah selesai/dibatalkan")
    store = await db.stores.find_one({"id": store_id}, {"_id": 0, "schedule": 1})
    cfg = normalize_schedule((store or {}).get("schedule"))
    now = datetime.now(timezone.utc)
    new_slot = None
    if payload.scheduled_for is not None:
        try:
            new_slot = validate_requested_slot(cfg, payload.scheduled_for, ZoneInfo(STORE_TZ), now)
        except ScheduleError as e:
            raise HTTPException(status_code=409, detail=e.detail) from e
    old_slot = doc.get("scheduled_for")
    # naive-aware safe equality: without _aware_utc a naive old_slot never equals the
    # aware new_slot, and we'd "move" to the identical time (releasing its reservation)
    if (new_slot == (_aware_utc(old_slot) if old_slot else None)) and ((new_slot is None) == (old_slot is None)):
        return _to_order(doc)
    if new_slot is not None and not await reserve_slot(store_id, new_slot, int(cfg.get("capacity_per_slot") or 0)):
        raise HTTPException(status_code=409, detail="Slot penuh, pilih waktu lain")
    changes = {"scheduled_for": new_slot, "fulfillment": "scheduled" if new_slot else "immediate"}
    res = await db.orders.update_one(
        {"id": id, "status": {"$nin": [COMPLETED, CANCELLED]}, "voided": {"$ne": True}},
        {"$set": changes},
    )
    if not res.matched_count:
        await release_slot(store_id, new_slot)
        raise HTTPException(status_code=409, detail="Pesanan sudah selesai/dibatalkan")
    await release_slot(store_id, old_slot)
    await audit("order.reschedule", p, store_id=store_id, detail={
        "order_id": id, "order_no": doc.get("order_no"),
        "from": old_slot.isoformat() if old_slot else None,
        "to": new_slot.isoformat() if new_slot else None,
    })
    return _to_order({**doc, **changes})


async def find_orders(store_id: Optional[str], start_d: str, end_d: str, sort: int = -1) -> list[dict]:
    q: dict = {"business_date": {"$gte": start_d, "$lte": end_d}}
    if store_id:
        q["store_id"] = store_id
    return await db.orders.find(q, {"_id": 0}).sort("created_at", sort).to_list(10000)


@router.get("/orders", response_model=OrderList)
async def list_orders(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    store_id: Optional[str] = Query(None),
    p: Principal = Depends(get_principal),
):
    start_d, end_d = date_range(start, end)
    sid = await resolve_store(p, store_id, allow_all=True)
    orders = [_to_order(d) for d in await find_orders(sid, start_d, end_d)]
    # pending (unpaid customer) orders are listed — the cashier must see them — but never counted as revenue
    valid = [o for o in orders if not o.voided and o.payment_status != "pending"]
    voided = [o for o in orders if o.voided]
    by_method = {"cash": 0, "card": 0, "qris": 0}
    for o in valid:
        by_method[o.payment_method] += o.total
    summary = OrdersSummary(
        count=len(valid),
        revenue=sum(o.total for o in valid),
        items=sum(o.item_count for o in valid),
        by_method=by_method,
        voided_count=len(voided),
        voided_total=sum(o.total for o in voided),
        discount_total=sum(o.discount_amount for o in valid),
    )
    return OrderList(start=start_d, end=end_d, store_id=sid, orders=orders, summary=summary)


@router.get("/orders/{id}", response_model=Order)
async def get_order(id: str, p: Principal = Depends(get_principal)):
    q = {"id": id} if p.is_owner else {"id": id, "store_id": p.store_id}
    doc = await db.orders.find_one(q, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Order not found")
    return _to_order(doc)


@router.post("/orders/{id}/void", response_model=Order)
async def void_order(id: str, payload: VoidIn, p: Principal = Depends(get_principal)):
    """Owner only. Marks the order as void with a reason; it is kept for the record but excluded from totals."""
    if not p.is_owner:
        raise HTTPException(status_code=403, detail="Owner only")
    doc = await db.orders.find_one({"id": id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Order not found")
    if doc.get("voided"):
        raise HTTPException(status_code=409, detail="Order already voided")
    changes = {"voided": True, "void_reason": payload.reason.strip(), "voided_at": datetime.now(timezone.utc), "voided_by": p.name}
    await db.orders.update_one({"id": id}, {"$set": changes})
    # P5: reverse loyalty points earned on this order (idempotent) and free any coupon
    # quota — the sale never happened.
    from lib.customers import release_coupon, reverse_points
    await reverse_points(doc, "reversal_void", actor=p)
    await release_coupon(doc.get("coupon_id"), id)
    await audit("order.void", p, store_id=doc.get("store_id"), detail={"order_id": id, "order_no": doc.get("order_no"), "total": doc.get("total"), "reason": payload.reason.strip()})
    return _to_order({**doc, **changes})
