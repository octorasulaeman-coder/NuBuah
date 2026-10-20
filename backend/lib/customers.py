"""Customer/loyalty/coupon database operations (P5). Every mutation is idempotent or
atomically guarded — retries, double-clicks, and double hooks must never award points,
redeem points, or burn coupon quotas twice. Rules live in lib/loyalty.py (pure).
"""

import logging
from datetime import datetime, timezone
from typing import Optional

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from lib.audit import audit
from lib.db import db
from lib.loyalty import CONFIG as LOYALTY, coupon_discount, effective_config, points_for_order, redeem_value
from models.customer import Customer, LedgerEntry

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def loyalty_for(store_id: str):
    """The EFFECTIVE loyalty config for a store (its saved settings over env defaults)."""
    store = await db.stores.find_one({"id": store_id}, {"_id": 0, "loyalty": 1})
    return effective_config((store or {}).get("loyalty"))


async def generate_member_no(store_id: str) -> str:
    """Unique, human-typable member code per store: NB + 6 digits."""
    import secrets

    for _ in range(20):
        candidate = f"NB{secrets.randbelow(900000) + 100000}"
        clash = await db.customers.find_one({"store_id": store_id, "member_no": candidate}, {"_id": 1})
        if not clash:
            return candidate
    raise RuntimeError("could not allocate a unique member number")


# ------------------------------------------------------------------ profiles
async def upsert_from_order(order: dict) -> Optional[Customer]:
    """Create/update the store-scoped profile when an order carries a phone."""
    phone = (order.get("customer_phone") or "").strip()
    if not phone:
        return None
    doc = await db.customers.find_one_and_update(
        {"store_id": order["store_id"], "phone": phone},
        {"$set": {"name": order.get("customer_name") or "", "updated_at": _now()},
         "$setOnInsert": {"id": Customer(store_id=order["store_id"], name="", phone=phone).id,
                          "points": 0, "lifetime_spend": 0, "order_count": 0,
                          "marketing_opt_in": False, "created_at": _now()}},
        upsert=True, return_document=ReturnDocument.AFTER,
    )
    return Customer(**doc)


async def award_points(order: dict, actor: Optional[dict] = None) -> None:
    """Award points for a PAID order. Idempotent: the ledger's unique (order_id, reason)
    index makes a second call a no-op even under a race."""
    earned = points_for_order(order["total"], await loyalty_for(order["store_id"]))
    if earned <= 0:
        return
    customer = await upsert_from_order(order)
    if not customer:
        return
    if not customer.is_member:
        return  # points are a MEMBER benefit — non-members are tracked but earn nothing
    try:
        await db.points_ledger.insert_one(LedgerEntry(
            customer_id=customer.id, store_id=order["store_id"], order_id=order["id"],
            delta=earned, reason="order_paid",
        ).model_dump())
    except DuplicateKeyError:
        return  # already awarded (retry / double hook)
    await db.customers.update_one(
        {"id": customer.id},
        {"$inc": {"points": earned, "lifetime_spend": order["total"], "order_count": 1},
         "$set": {"last_order_at": _now()}},
    )
    await audit("loyalty.award", actor, store_id=order["store_id"],
                detail={"order_id": order["id"], "order_no": order.get("order_no"), "points": earned})


async def reverse_points(order: dict, reason: str, actor: Optional[dict] = None) -> None:
    """Reverse points on void/cancel/refund. Reverses only what was actually awarded —
    if the order never earned (below min spend), there is nothing to reverse."""
    if order.get("payment_status") != "paid" and reason == "reversal_refund":
        return
    earned = points_for_order(order["total"], await loyalty_for(order["store_id"]))
    if earned <= 0 or not order.get("customer_phone"):
        return
    customer = await db.customers.find_one(
        {"store_id": order["store_id"], "phone": order["customer_phone"]}, {"_id": 0}
    )
    if not customer:
        return
    try:
        await db.points_ledger.insert_one(LedgerEntry(
            customer_id=customer["id"], store_id=order["store_id"], order_id=order["id"],
            delta=-earned, reason=reason,
        ).model_dump())
    except DuplicateKeyError:
        return
    # never drive the balance below zero
    await db.customers.update_one(
        {"id": customer["id"], "points": {"$gte": earned}},
        {"$inc": {"points": -earned}, "$set": {"updated_at": _now()}},
    )
    await audit("loyalty.reverse", actor, store_id=order["store_id"],
                detail={"order_id": order["id"], "order_no": order.get("order_no"), "points": -earned, "reason": reason})


async def refund_redeem(customer_phone: str, store_id: str, points: int, order_id: str) -> None:
    """Undo a redemption when the order never materializes (insert race / coupon quota).
    Deletes the ledger row and credits the points back — safe to call when nothing was
    debited (both ops are no-ops then)."""
    customer = await db.customers.find_one({"store_id": store_id, "phone": customer_phone}, {"_id": 0})
    if not customer:
        return
    res = await db.points_ledger.delete_one({"order_id": order_id, "reason": "redeem", "customer_id": customer["id"]})
    if res.deleted_count:
        await db.customers.update_one({"id": customer["id"]}, {"$inc": {"points": points}, "$set": {"updated_at": _now()}})


async def redeem_points(customer_phone: str, store_id: str, points: int, order_id: str) -> int:
    """Atomically debit points for a redemption; returns the rupiah value.
    Raises ValueError on insufficient balance (the atomic guard is the lock)."""
    customer = await db.customers.find_one_and_update(
        {"store_id": store_id, "phone": customer_phone, "points": {"$gte": points}},
        {"$inc": {"points": -points}, "$set": {"updated_at": _now()}},
        return_document=ReturnDocument.BEFORE,
    )
    if not customer:
        raise ValueError("Nomor/HP tidak terdaftar atau saldo poin tidak cukup")
    if not customer.get("is_member"):
        raise ValueError("Pelanggan bukan member — poin hanya untuk member")
    cfg = await loyalty_for(store_id)
    try:
        await db.points_ledger.insert_one(LedgerEntry(
            customer_id=customer["id"], store_id=store_id, order_id=order_id,
            delta=-points, reason="redeem",
        ).model_dump())
    except DuplicateKeyError:
        # a ledger row exists for this order — refund the debit and treat as done
        await db.customers.update_one({"id": customer["id"]}, {"$inc": {"points": points}})
    return redeem_value(points, cfg)


# ------------------------------------------------------------------ coupons
async def validate_and_price_coupon(store_id: str, code: str, subtotal: int,
                                    lines: list[dict], customer_phone: Optional[str]) -> tuple[dict, int]:
    """Find + validate a coupon; returns (coupon_doc, discount_idr). Raises CouponError."""
    from lib.loyalty import CouponError

    coupon = await db.coupons.find_one({"store_id": store_id, "code": code.strip().upper()}, {"_id": 0})
    if not coupon:
        raise CouponError("not_found", "Kupon tidak ditemukan")
    used_by_customer = 0
    if customer_phone:
        used_by_customer = await db.coupon_redemptions.count_documents(
            {"coupon_id": coupon["id"], "customer_phone": customer_phone}
        )
    amount = coupon_discount(coupon, subtotal, lines, _now(), customer_phone, used_by_customer)
    return coupon, amount


async def reserve_coupon(coupon_id: str, order_id: str, customer_phone: Optional[str]) -> None:
    """Consume one redemption atomically (cap-checked); the per-order unique index
    makes retries free. Raises CouponError("sold_out") when the quota just ran out."""
    from lib.loyalty import CouponError

    doc = await db.coupons.find_one_and_update(
        {"id": coupon_id},
        {"$inc": {"used_count": 1}}, return_document=ReturnDocument.AFTER,
    )
    if not doc:
        raise CouponError("not_found", "Kupon tidak ditemukan")
    cap = int(doc.get("max_redemptions") or 0)
    if cap and doc["used_count"] > cap:
        await db.coupons.update_one({"id": coupon_id, "used_count": {"$gt": 0}}, {"$inc": {"used_count": -1}})
        raise CouponError("sold_out", "Kuota kupon habis")
    try:
        await db.coupon_redemptions.insert_one({
            "coupon_id": coupon_id, "order_id": order_id,
            "customer_phone": customer_phone or "", "created_at": _now(),
        })
    except DuplicateKeyError:
        pass  # same order retrying — quota already counted once


async def release_coupon(coupon_id: Optional[str], order_id: str) -> None:
    """Give the quota back when an order is voided/cancelled (the redemption record is
    deleted so per-customer limits also free up)."""
    if not coupon_id:
        return
    res = await db.coupon_redemptions.delete_one({"order_id": order_id})
    if res.deleted_count:
        await db.coupons.update_one(
            {"id": coupon_id, "used_count": {"$gt": 0}}, {"$inc": {"used_count": -1}}
        )
