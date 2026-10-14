"""Public, unauthenticated endpoints for the customer side (Option B).

Customers browse the menu and place orders from their phone; payment always happens
face-to-face at the counter, so these endpoints never accept payment or discount data.
Prices are still verified server-side via lib.pricing.verify_line, orders are deduped
via client_order_id, and everything is rate-limited per IP/phone.
"""
import os
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, Request

from lib.audit import audit
from lib.db import db
from lib.dates import today_iso
from lib.pricing import verify_line
from lib.ratelimit import check_rate, client_ip
from models.order import Order, OrderLine, PublicOrderIn, PublicOrderStatus

router = APIRouter()

STORE_TZ = os.environ.get("STORE_TZ", "Asia/Jakarta")


def _status(order: dict, store_name: str) -> PublicOrderStatus:
    return PublicOrderStatus(
        id=order["id"],
        order_no=order["order_no"],
        store_name=store_name,
        payment_status=order.get("payment_status", "paid"),
        total=order["total"],
        lines=[OrderLine(**ln) for ln in order["lines"]],
        created_at=order["created_at"],
    )


@router.get("/public/menu/{code}")
async def public_menu(code: str, request: Request):
    """Everything the customer menu page needs in one request: the store, that store's
    price/sold-out overrides, and all owner-created menu data (custom products, options,
    groups, categories, renames, short codes)."""
    check_rate(f"pubmenu:ip:{client_ip(request)}", limit=60, window_seconds=60)
    store = await db.stores.find_one({"code": code.upper()}, {"_id": 0, "pin_hash": 0, "approval_pin_hash": 0})
    if not store:
        raise HTTPException(status_code=404, detail="Toko tidak ditemukan")
    sid = store["id"]
    codes = {d["product_id"]: d["code"] async for d in db.product_codes.find({}, {"_id": 0, "product_id": 1, "code": 1})}
    return {
        "store": {k: store.get(k) for k in ("id", "name", "code", "address_lines", "phone")},
        "menu_overrides": await db.menu_overrides.find({"store_id": sid}, {"_id": 0}).to_list(2000),
        "option_overrides": await db.option_overrides.find({"store_id": sid}, {"_id": 0}).to_list(2000),
        "custom_products": await db.custom_products.find({}, {"_id": 0}).to_list(2000),
        "custom_options": await db.custom_options.find({}, {"_id": 0}).to_list(2000),
        "custom_categories": await db.custom_categories.find({}, {"_id": 0}).to_list(500),
        "custom_groups": await db.custom_groups.find({}, {"_id": 0}).to_list(500),
        "edits": await db.menu_edits.find({}, {"_id": 0}).to_list(2000),
        "codes": codes,
    }


@router.post("/public/orders", response_model=PublicOrderStatus, status_code=201)
async def public_order(payload: PublicOrderIn, request: Request):
    from routers.orders import next_order_seq  # local import: avoid a router cycle

    ip = client_ip(request)
    check_rate(f"puborder:ip:{ip}", limit=20, window_seconds=60)   # stall Wi-Fi shares one IP
    check_rate(f"puborder:phone:{payload.customer_phone}", limit=5, window_seconds=600)

    store = await db.stores.find_one({"code": payload.store_code.strip().upper()}, {"_id": 0})
    if not store:
        raise HTTPException(status_code=404, detail="Toko tidak ditemukan")
    store_id = store["id"]

    if payload.client_order_id:
        existing = await db.orders.find_one({"store_id": store_id, "client_order_id": payload.client_order_id}, {"_id": 0})
        if existing:
            return _status(existing, store["name"])

    # Same server-side verification as the cashier path: a customer cannot name a price,
    # and menu-hidden items are not orderable from the customer channel.
    verified = [(ln, await verify_line(store_id, ln, reject_hidden=True)) for ln in payload.lines]
    lines = []
    for ln, unit in verified:
        data = ln.model_dump()
        data["unit_price"] = unit
        data["line_total"] = unit * ln.qty
        lines.append(OrderLine(**data))
    total = sum(ln.line_total for ln in lines)

    order = Order(
        client_order_id=payload.client_order_id,
        order_no=f"{store['code']}-{today_iso(STORE_TZ).replace('-', '')[2:]}-000",  # replaced below
        business_date=today_iso(STORE_TZ),
        store_id=store_id,
        store_name=store["name"],
        store_address_lines=store.get("address_lines", []),
        store_phone=store.get("phone", ""),
        cashier_name=None,
        lines=lines,
        item_count=sum(ln.qty for ln in lines),
        subtotal=total,
        total=total,
        payment_method="cash",  # placeholder until paid at the counter
        payment_status="pending",
        channel="customer",
        customer_name=payload.customer_name.strip() if payload.customer_name else None,
        customer_phone=payload.customer_phone,
    )
    seq = await next_order_seq(store_id, order.business_date)
    order.order_no = f"{store['code']}-{order.business_date.replace('-', '')[2:]}-{seq:03d}"
    await db.orders.insert_one(order.model_dump())
    await audit("order.customer_created", None, store_id=store_id, detail={"order_no": order.order_no, "total": total, "items": order.item_count, "ip": ip})
    return _status(order.model_dump(), store["name"])


@router.get("/public/orders/{order_no}", response_model=PublicOrderStatus)
async def public_order_status(order_no: str, phone: str = Query(min_length=9, max_length=16), request: Request = None):
    check_rate(f"pubstatus:ip:{client_ip(request)}", limit=60, window_seconds=60)
    order = await db.orders.find_one({"order_no": order_no.strip().upper()}, {"_id": 0, "cashier_name": 0})
    if not order or (order.get("customer_phone") or "") != phone.strip():
        raise HTTPException(status_code=404, detail="Pesanan tidak ditemukan")
    return _status(order, order.get("store_name", "NuBuah"))
