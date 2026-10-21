"""Public, unauthenticated endpoints for the customer side (Option B).

Customers browse the menu and place orders from their phone; payment always happens
face-to-face at the counter, so these endpoints never accept payment or discount data.
Prices are still verified server-side via lib.pricing.verify_line, orders are deduped
via client_order_id, and everything is rate-limited per IP/phone.
"""
import os
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from pymongo.errors import DuplicateKeyError

from lib.audit import audit
from lib.db import db
from lib.dates import today_iso
from lib.idempotency import payload_fingerprint
from lib.pricing import verify_line
from lib.ratelimit import check_rate, client_ip
from lib.scheduling import (
    ScheduleError, build_day_slots, local_day_range, normalize_schedule,
    upcoming_days, validate_requested_slot,
)
from lib.slot_reservation import release_slot, reserve_slot, slot_counts
from lib.loyalty import effective_config, points_for_order
from models.order import Order, OrderLine, PublicOrderIn, PublicOrderStatus

router = APIRouter()

STORE_TZ = os.environ.get("STORE_TZ", "Asia/Jakarta")


def _status(order: dict, store_name: str, cfg=None) -> PublicOrderStatus:
    from lib.loyalty import effective_config
    cfg = cfg or effective_config(None)  # env defaults when the caller has no store doc
    return PublicOrderStatus(
        id=order["id"],
        order_no=order["order_no"],
        store_name=store_name,
        payment_status=order.get("payment_status", "paid"),
        total=order["total"],
        lines=[OrderLine(**ln) for ln in order["lines"]],
        created_at=order["created_at"],
        fulfillment=order.get("fulfillment", "immediate"),
        scheduled_for=order.get("scheduled_for"),
        status=order.get("status", "received"),
        points_earned=points_for_order(order.get("total", 0), cfg) if order.get("payment_status") == "paid" else 0,
    )


async def menu_bundle(store: dict, include_legacy: bool = True) -> dict:
    """Everything a menu consumer needs in one payload (used by /public/menu/{code}
    and the authenticated /menu/bundle — POS and customer page see identical data)."""
    sid = store["id"]
    bundle = {
        "store": {k: store.get(k) for k in ("id", "name", "code", "address_lines", "phone")},
        "menu_overrides": await db.menu_overrides.find({"store_id": sid}, {"_id": 0}).to_list(2000),
        "option_overrides": await db.option_overrides.find({"store_id": sid}, {"_id": 0}).to_list(2000),
        "menu_products": await db.menu_products.find({}, {"_id": 0}).to_list(2000),
        "menu_groups": await db.menu_groups.find({}, {"_id": 0}).to_list(500),
        "menu_options": await db.menu_options.find({}, {"_id": 0}).to_list(3000),
        "menu_categories": await db.menu_categories.find({}, {"_id": 0}).to_list(200),
        "edits": await db.menu_edits.find({}, {"_id": 0}).to_list(2000),
        "codes": {d["product_id"]: d["code"] async for d in db.product_codes.find({}, {"_id": 0, "product_id": 1, "code": 1})},
    }
    if include_legacy:  # old frontends read these until everyone is on the new build
        bundle["custom_products"] = await db.custom_products.find({}, {"_id": 0}).to_list(2000)
        bundle["custom_options"] = await db.custom_options.find({}, {"_id": 0}).to_list(2000)
        bundle["custom_categories"] = await db.custom_categories.find({}, {"_id": 0}).to_list(500)
        bundle["custom_groups"] = await db.custom_groups.find({}, {"_id": 0}).to_list(500)
    return bundle


@router.get("/public/menu/{code}")
async def public_menu(code: str, request: Request):
    """Everything the customer menu page needs in one request."""
    check_rate(f"pubmenu:ip:{client_ip(request)}", limit=60, window_seconds=60)
    store = await db.stores.find_one({"code": code.upper()}, {"_id": 0, "pin_hash": 0, "approval_pin_hash": 0})
    if not store:
        raise HTTPException(status_code=404, detail="Toko tidak ditemukan")
    return await menu_bundle(store, include_legacy=True)


@router.get("/public/bundle")
async def public_bundle(store_id: str, request: Request):
    """Same payload keyed by store id — public, so unauthenticated pages (the landing
    page's menu preview) and any future kiosks can read the live menu."""
    check_rate(f"pubbundle:ip:{client_ip(request)}", limit=60, window_seconds=60)
    store = await db.stores.find_one({"id": store_id}, {"_id": 0, "pin_hash": 0, "approval_pin_hash": 0})
    if not store:
        raise HTTPException(status_code=404, detail="Toko tidak ditemukan")
    return await menu_bundle(store, include_legacy=True)


@router.get("/public/stores/{code}/schedule")
async def public_store_schedule(code: str, request: Request):
    """Scheduling config + the bookable calendar days (public: nothing sensitive)."""
    check_rate(f"pubsched:ip:{client_ip(request)}", limit=60, window_seconds=60)
    store = await db.stores.find_one({"code": code.upper()}, {"_id": 0, "pin_hash": 0, "approval_pin_hash": 0})
    if not store:
        raise HTTPException(status_code=404, detail="Toko tidak ditemukan")
    cfg = normalize_schedule(store.get("schedule"))
    tz = ZoneInfo(STORE_TZ)
    return {
        "store_code": store["code"],
        "timezone": STORE_TZ,
        "enabled": cfg.get("enabled", True),
        "slot_minutes": cfg.get("slot_minutes"),
        "lead_time_minutes": cfg.get("lead_time_minutes"),
        "max_days_ahead": cfg.get("max_days_ahead"),
        "days": upcoming_days(cfg, tz, datetime.now(timezone.utc)),
    }


@router.get("/public/stores/{code}/slots")
async def public_store_slots(code: str, request: Request, date_: str = Query(alias="date", min_length=10, max_length=10)):
    """All slots for one local day with availability and reasons (closed/past/lead_time/full)."""
    check_rate(f"pubslots:ip:{client_ip(request)}", limit=60, window_seconds=60)
    try:
        day = date.fromisoformat(date_)
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    store = await db.stores.find_one({"code": code.upper()}, {"_id": 0, "pin_hash": 0, "approval_pin_hash": 0})
    if not store:
        raise HTTPException(status_code=404, detail="Toko tidak ditemukan")
    cfg = normalize_schedule(store.get("schedule"))
    tz = ZoneInfo(STORE_TZ)
    start_utc, end_utc = local_day_range(day, tz)
    taken = await slot_counts(store["id"], start_utc, end_utc)
    return build_day_slots(cfg, day, tz, datetime.now(timezone.utc), taken)


@router.get("/public/stores/{code}/loyalty")
async def public_loyalty_config(code: str, request: Request):
    """Earn/redeem rules for the public menu, for THAT store (nothing sensitive)."""
    check_rate(f"publoyal:ip:{client_ip(request)}", limit=60, window_seconds=60)
    store = await db.stores.find_one({"code": code.upper()}, {"_id": 0, "loyalty": 1})
    if not store:
        raise HTTPException(status_code=404, detail="Toko tidak ditemukan")
    from lib.customers import loyalty_for
    cfg = await loyalty_for(store["id"])
    return {
        "points_per": cfg.points_per,
        "min_spend_to_earn": cfg.min_spend_to_earn,
        "redeem_value_per_point": cfg.redeem_value_per_point,
        "redeem_min_points": cfg.redeem_min_points,
        "redeem_max_fraction": cfg.redeem_max_fraction,
    }


class PublicPointsLookupIn(BaseModel):
    """`key` may be a phone number OR a member number — the lookup tries both."""
    key: str = Field(min_length=4, max_length=20)


@router.post("/public/points/lookup")
async def public_points_lookup(payload: PublicPointsLookupIn, request: Request):
    """Customer points balance by phone OR member number — same weak-secret model as
    the order-status lookup, with matching rate limits."""
    check_rate(f"pubpoints:ip:{client_ip(request)}", limit=30, window_seconds=60)
    check_rate(f"pubpoints:ph:{payload.key}", limit=10, window_seconds=60)
    store = await db.stores.find_one({}, {"_id": 0, "id": 1})
    if not store:
        raise HTTPException(status_code=404, detail="Toko tidak ditemukan")
    key = payload.key.strip()
    customer = await db.customers.find_one(
        {"store_id": store["id"], "$or": [{"phone": key}, {"member_no": key.upper()}]},
        {"_id": 0, "name": 1, "points": 1, "order_count": 1, "last_order_at": 1, "is_member": 1, "member_no": 1},
    )
    if not customer:
        return {"found": False}
    from lib.customers import loyalty_for
    from lib.loyalty import redeem_value
    return {
        "found": True,
        "name": customer.get("name") or "",
        "is_member": customer.get("is_member", False),
        "member_no": customer.get("member_no"),
        "points": customer.get("points", 0),
        "points_value": redeem_value(customer.get("points", 0), await loyalty_for(store["id"])),
        "order_count": customer.get("order_count", 0),
        "last_order_at": customer.get("last_order_at"),
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

    fingerprint = payload_fingerprint(payload.model_dump())
    if payload.client_order_id:
        existing = await db.orders.find_one({"store_id": store_id, "client_order_id": payload.client_order_id}, {"_id": 0})
        if existing:
            if existing.get("idempotency_hash") and existing["idempotency_hash"] != fingerprint:
                raise HTTPException(status_code=409, detail="Idempotency key sudah dipakai untuk pesanan yang berbeda")
            return _status(existing, store["name"], effective_config(store.get("loyalty")))

    # Scheduled pickup (P2): same validation + capacity rules as the cashier path.
    schedule_cfg = normalize_schedule(store.get("schedule"))
    scheduled_for = None
    if payload.scheduled_for:
        try:
            scheduled_for = validate_requested_slot(schedule_cfg, payload.scheduled_for, ZoneInfo(STORE_TZ), datetime.now(timezone.utc))
        except ScheduleError as e:
            raise HTTPException(status_code=409, detail=e.detail) from e
        if not await reserve_slot(store_id, scheduled_for, int(schedule_cfg.get("capacity_per_slot") or 0)):
            raise HTTPException(status_code=409, detail="Slot penuh, pilih waktu lain")

    # Same server-side verification as the cashier path: a customer cannot name a price,
    # and menu-hidden items are not orderable from the customer channel.
    verified = [(ln, await verify_line(store_id, ln, reject_hidden=True)) for ln in payload.lines]

    # server-derived category per line (see the cashier path for why)
    prod_ids = list({ln.product_id for ln in payload.lines if ln.product_id})
    if prod_ids:
        prods = await db.menu_products.find({"$or": [{"store_id": None}, {"store_id": store_id}], "id": {"$in": prod_ids}}, {"_id": 0, "id": 1, "category_id": 1, "category": 1}).to_list(None)
        cat_of = {pr["id"]: pr.get("category_id") or pr.get("category") for pr in prods}
        verified = [(ln.model_copy(update={"category_id": cat_of.get(ln.product_id)}), price) for ln, price in verified]
    lines = []
    for ln, unit in verified:
        data = ln.model_dump()
        data["unit_price"] = unit
        data["line_total"] = unit * ln.qty
        lines.append(OrderLine(**data))
    total = sum(ln.line_total for ln in lines)

    # P5: public customers may apply a coupon AND (members) redeem points by member ID.
    # Same snapshot discipline as the cashier path.
    from lib.customers import release_coupon, reserve_coupon, validate_and_price_coupon
    from lib.loyalty import CouponError
    coupon_id = None
    coupon_amount = 0
    if payload.coupon_code:
        try:
            coupon, coupon_amount = await validate_and_price_coupon(
                store_id, payload.coupon_code, total, [ln.model_dump() for ln in lines], payload.customer_phone)
            coupon_id = coupon["id"]
        except CouponError as e:
            await release_slot(store_id, scheduled_for)
            raise HTTPException(status_code=409, detail=e.detail)

    member_phone = payload.customer_phone
    member = None
    points_redeemed = 0
    redeem_value_amount = 0
    if payload.member_no:
        member = await db.customers.find_one(
            {"store_id": store_id, "member_no": payload.member_no.strip().upper()}, {"_id": 0}
        )
        if not member:
            await release_slot(store_id, scheduled_for)
            raise HTTPException(status_code=409, detail="ID member tidak ditemukan")
        member_phone = member["phone"]
        if payload.redeem_points:
            if not member.get("is_member"):
                await release_slot(store_id, scheduled_for)
                raise HTTPException(status_code=409, detail="Akun ini bukan member")
            from lib.customers import loyalty_for as _loyalty_for
            from lib.loyalty import redeemable_points as _redeemable
            cfg = await _loyalty_for(store_id)
            allowed = _redeemable(member.get("points", 0), max(0, total - coupon_amount), cfg)
            if payload.redeem_points > allowed:
                await release_slot(store_id, scheduled_for)
                raise HTTPException(status_code=409, detail=f"Maksimal {allowed} poin untuk pesanan ini")
            points_redeemed = payload.redeem_points
            redeem_value_amount = points_redeemed * cfg.redeem_value_per_point

    order = Order(
        client_order_id=payload.client_order_id,
        idempotency_hash=fingerprint,
        fulfillment="scheduled" if scheduled_for else "immediate",
        scheduled_for=scheduled_for,
        coupon_id=coupon_id,
        coupon_code=payload.coupon_code.strip().upper() if payload.coupon_code else None,
        coupon_amount=coupon_amount,
        points_redeemed=points_redeemed,
        redeem_value_amount=redeem_value_amount,
        total=max(0, total - coupon_amount - redeem_value_amount),
        customer_phone=member_phone,
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
        payment_method="cash",  # placeholder until paid at the counter
        payment_status="pending",
        channel="customer",
        customer_name=payload.customer_name.strip() if payload.customer_name else None,
    )
    # member identity fills blanks — the profile IS the identity proof
    if not order.customer_name and member:
        order.customer_name = member.get("name")
    seq = await next_order_seq(store_id, order.business_date)
    order.order_no = f"{store['code']}-{order.business_date.replace('-', '')[2:]}-{seq:03d}"
    if points_redeemed:
        from lib.customers import redeem_points as do_redeem
        try:
            await do_redeem(member_phone, store_id, points_redeemed, order.id)
        except ValueError as e:
            await release_slot(store_id, scheduled_for)
            raise HTTPException(status_code=409, detail=str(e))
    if coupon_id:
        try:
            await reserve_coupon(coupon_id, order.id, member_phone)
        except CouponError as e:
            await release_slot(store_id, scheduled_for)
            raise HTTPException(status_code=409, detail=e.detail)
    try:
        await db.orders.insert_one(order.model_dump())
    except DuplicateKeyError:
        # concurrent retries: the unique index lets exactly one insert win; the other
        # returns the winner's order instead of failing the customer with a 500 (and
        # gives back its duplicate slot + coupon reservations)
        existing = await db.orders.find_one(
            {"store_id": store_id, "client_order_id": payload.client_order_id}, {"_id": 0}
        ) if payload.client_order_id else None
        await release_slot(store_id, scheduled_for)
        await release_coupon(coupon_id, order.id)
        if existing:
            return _status(existing, store["name"], effective_config(store.get("loyalty")))
        raise
    await audit("order.customer_created", None, store_id=store_id, detail={"order_no": order.order_no, "total": total, "items": order.item_count, "ip": ip})
    return _status(order.model_dump(), store["name"], effective_config(store.get("loyalty")))


@router.get("/public/orders/{order_no}", response_model=PublicOrderStatus)
async def public_order_status(order_no: str, request: Request, phone: str | None = Query(default=None, min_length=9, max_length=16)):
    check_rate(f"pubstatus:ip:{client_ip(request)}", limit=60, window_seconds=60)
    order = await db.orders.find_one({"order_no": order_no.strip().upper()}, {"_id": 0, "cashier_name": 0})
    # phone is OPTIONAL: if given it must match (still blocks guessing with a known
    # number); if omitted, the receipt number alone is the key — the owner's choice
    # of convenience over the weak-secret model.
    if not order or (phone is not None and (order.get("customer_phone") or "") != phone.strip()):
        raise HTTPException(status_code=404, detail="Pesanan tidak ditemukan")
    store = await db.stores.find_one({"id": order.get("store_id")}, {"_id": 0, "loyalty": 1}) or {}
    return _status(order, order.get("store_name", "NuBuah"), effective_config(store.get("loyalty")))
