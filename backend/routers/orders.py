import os
import re
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pymongo import ReturnDocument

from lib.auth import Principal, get_principal, resolve_store, verify_secret
from lib.audit import audit
from lib.dates import today_iso
from lib.db import db
from lib.pricing import verify_line
from models.order import CancelIn, Order, OrderCreate, OrderLine, OrderList, OrderPayIn, OrdersSummary, TodayInfo, VoidIn

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
    # already-created order instead of charging the customer twice.
    if payload.client_order_id:
        existing = await db.orders.find_one({"store_id": store_id, "client_order_id": payload.client_order_id}, {"_id": 0})
        if existing:
            return _to_order(existing)

    store = await db.stores.find_one({"id": store_id}, {"_id": 0})
    # Recompute every line price server-side; a tampered client cannot name its own price.
    verified = [(ln, await verify_line(store_id, ln)) for ln in payload.lines]
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
    cash_tendered: Optional[int] = None
    change: Optional[int] = None
    if payload.payment_method == "cash":
        cash_tendered = payload.cash_tendered if payload.cash_tendered is not None else total
        if cash_tendered < total:
            raise HTTPException(status_code=400, detail="Uang tunai kurang dari total")
        change = cash_tendered - total

    business_date = today_iso(STORE_TZ)
    seq = await next_order_seq(store_id, business_date)
    order = Order(
        client_order_id=payload.client_order_id,
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
        total=total,
        payment_method=payload.payment_method,
        cash_tendered=cash_tendered,
        change=change,
        customer_name=(payload.customer_name or "").strip() or None,
        customer_phone=(payload.customer_phone or "").strip() or None,
    )
    await db.orders.insert_one(order.model_dump())
    return order


@router.get("/orders/pending", response_model=list[Order])
async def list_pending_customer_orders(store_id: Optional[str] = Query(None), p: Principal = Depends(get_principal)):
    """Customer-channel orders waiting for payment at the counter (today, this store)."""
    sid = await resolve_store(p, store_id)
    d = today_iso(STORE_TZ)
    docs = await db.orders.find(
        {"store_id": sid, "business_date": d, "channel": "customer", "payment_status": "pending", "voided": {"$ne": True}},
        {"_id": 0},
    ).sort("created_at", 1).to_list(200)
    return [_to_order(d) for d in docs]


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
    return _to_order({**doc, **changes})


@router.post("/orders/{id}/cancel", response_model=Order)
async def cancel_pending_order(id: str, payload: CancelIn, p: Principal = Depends(get_principal)):
    """Cashier/owner cancels a pending customer order (no-show, duplicate, customer request).
    The order stays in history as VOID with the reason; it never counted as revenue."""
    doc = await db.orders.find_one({"id": id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Order not found")
    await resolve_store(p, doc.get("store_id"))
    if doc.get("channel") != "customer" or doc.get("payment_status") != "pending":
        raise HTTPException(status_code=409, detail="Hanya pesanan online yang belum bayar yang bisa dibatalkan")
    reason = payload.reason.strip()
    changes = {"voided": True, "void_reason": reason, "voided_at": datetime.now(timezone.utc), "voided_by": p.name}
    # atomic guard: pay and cancel race — exactly one can win
    res = await db.orders.update_one({"id": id, "payment_status": "pending"}, {"$set": changes})
    if not res.matched_count:
        raise HTTPException(status_code=409, detail="Pesanan ini sudah dibayar")
    await audit("order.cancel", p, store_id=doc.get("store_id"), detail={"order_id": id, "order_no": doc.get("order_no"), "reason": reason})
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
    await audit("order.void", p, store_id=doc.get("store_id"), detail={"order_id": id, "order_no": doc.get("order_no"), "total": doc.get("total"), "reason": payload.reason.strip()})
    return _to_order({**doc, **changes})
