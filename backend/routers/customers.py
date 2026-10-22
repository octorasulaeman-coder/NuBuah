"""Customer, loyalty, and coupon endpoints (P5). Staff read; owner write/adjust.
Everything store-scoped — a cashier sees only their own store's customers."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from lib.audit import audit
from lib.auth import Principal, get_principal, resolve_store
from lib.customers import generate_member_no, loyalty_for, reserve_coupon, validate_and_price_coupon
from lib.db import db
from lib.loyalty import CouponError, redeemable_points
from models.customer import (
    Coupon, CouponIn, CouponUpdateIn, Customer, CustomerDetail, CustomerUpdateIn,
    LoyaltyConfigIn, PointsAdjustIn,
)

router = APIRouter()


def _require_owner(p: Principal) -> None:
    if not p.is_owner:
        raise HTTPException(status_code=403, detail="Owner only")


@router.get("/customers", response_model=list[Customer])
async def list_customers(
    search: str = Query(default="", max_length=60),
    store_id: str = Query(None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    p: Principal = Depends(get_principal),
):
    sid = await resolve_store(p, store_id)
    query: dict = {"store_id": sid}
    if search.strip():
        needle = search.strip()
        query["$or"] = [
            {"phone": {"$regex": needle, "$options": "i"}},
            {"name": {"$regex": needle, "$options": "i"}},
            {"member_no": {"$regex": needle, "$options": "i"}},
        ]
    docs = await db.customers.find(query, {"_id": 0}).sort("last_order_at", -1).skip(offset).limit(limit).to_list(limit)
    return [Customer(**d) for d in docs]


@router.get("/customers/{cid}", response_model=CustomerDetail)
async def customer_detail(cid: str, p: Principal = Depends(get_principal)):
    doc = await db.customers.find_one({"id": cid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Customer not found")
    await resolve_store(p, doc["store_id"])
    ledger = await db.points_ledger.find({"customer_id": cid}, {"_id": 0}).sort("created_at", -1).limit(100).to_list(100)
    orders = await db.orders.find(
        {"store_id": doc["store_id"], "customer_phone": doc["phone"]},
        {"_id": 0, "id": 1, "order_no": 1, "total": 1, "payment_status": 1, "created_at": 1},
    ).sort("created_at", -1).limit(20).to_list(20)
    return CustomerDetail(customer=Customer(**doc), ledger=ledger, recent_orders=orders)


@router.put("/customers/{cid}", response_model=Customer)
async def update_customer(cid: str, payload: CustomerUpdateIn, p: Principal = Depends(get_principal)):
    """Owner-only profile edit: name, phone (unique per store), marketing consent."""
    _require_owner(p)
    from datetime import datetime, timezone

    doc = await db.customers.find_one({"id": cid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Customer not found")
    await resolve_store(p, doc["store_id"])
    changes = {k: v for k, v in payload.model_dump(exclude_none=True).items()}
    if not changes:
        return Customer(**doc)
    if "phone" in changes:
        clash = await db.customers.find_one(
            {"store_id": doc["store_id"], "phone": changes["phone"], "id": {"$ne": cid}}, {"_id": 1}
        )
        if clash:
            raise HTTPException(status_code=409, detail="Nomor HP sudah dipakai pelanggan lain")
    if changes.get("is_member") and not changes.get("member_no") and not doc.get("member_no"):
        changes["member_no"] = await generate_member_no(doc["store_id"])  # auto-assign on upgrade
    if "member_no" in changes and changes["member_no"]:
        clash = await db.customers.find_one(
            {"store_id": doc["store_id"], "member_no": changes["member_no"], "id": {"$ne": cid}}, {"_id": 1}
        )
        if clash:
            raise HTTPException(status_code=409, detail="ID member sudah dipakai pelanggan lain")
    changes["updated_at"] = datetime.now(timezone.utc)
    await db.customers.update_one({"id": cid}, {"$set": changes})
    await audit("customer.updated", p, store_id=doc["store_id"], detail={"customer_id": cid, "changes": {k: v for k, v in changes.items() if k != "updated_at"}})
    updated = await db.customers.find_one({"id": cid}, {"_id": 0})
    return Customer(**updated)


@router.delete("/customers/{cid}")
async def delete_customer(
    cid: str,
    mode: str = Query(default="anonymize", pattern="^(anonymize|purge)$"),
    confirm_phone: Optional[str] = Query(default=None, max_length=32),
    p: Principal = Depends(get_principal),
):
    """Owner-only customer removal.

    `anonymize` preserves financial/audit rows but removes customer PII and points.
    `purge` permanently removes the customer and related operational rows; it requires
    typing the customer's current phone number and always creates a safety backup first.
    """
    _require_owner(p)
    from datetime import datetime, timezone

    doc = await db.customers.find_one({"id": cid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Customer not found")
    sid = await resolve_store(p, doc["store_id"])
    phone = doc.get("phone") or ""
    now = datetime.now(timezone.utc)

    orders = await db.orders.find(
        {"store_id": sid, "customer_phone": phone},
        {"_id": 0, "id": 1, "order_no": 1},
    ).to_list(5000)
    order_ids = [o["id"] for o in orders]

    if mode == "anonymize":
        token = f"deleted-{cid}"
        await db.customers.update_one({"id": cid}, {"$set": {
            "name": "Pelanggan terhapus",
            "phone": token,
            "member_no": None,
            "is_member": False,
            "points": 0,
            "marketing_opt_in": False,
            "updated_at": now,
        }})
        if order_ids:
            await db.orders.update_many(
                {"store_id": sid, "customer_phone": phone},
                {"$set": {"customer_name": "Pelanggan terhapus", "customer_phone": token, "member_no": None, "updated_at": now}},
            )
        if phone:
            await db.coupon_redemptions.update_many(
                {"store_id": sid, "customer_phone": phone},
                {"$set": {"customer_phone": token, "updated_at": now}},
            )
            await db.points_ledger.update_many(
                {"store_id": sid, "customer_phone": phone},
                {"$set": {"customer_phone": token, "updated_at": now}},
            )
        await audit("customer.anonymized", p, store_id=sid, detail={
            "customer_id": cid,
            "orders_anonymized": len(order_ids),
        })
        return {
            "deleted": False,
            "anonymized": True,
            "safety_backup": None,
            "counts": {"orders_anonymized": len(order_ids)},
        }

    if not confirm_phone or confirm_phone.strip() != phone:
        raise HTTPException(status_code=400, detail="Konfirmasi nomor HP tidak cocok")

    from lib.backup import create_backup
    safety = await create_backup()

    counts: dict[str, int] = {"orders": len(order_ids)}
    attempts = await db.payment_attempts.find(
        {"store_id": sid, "order_id": {"$in": order_ids}},
        {"_id": 0, "id": 1, "provider_ref": 1},
    ).to_list(5000) if order_ids else []
    attempt_ids = [a["id"] for a in attempts]
    provider_refs = [a["provider_ref"] for a in attempts if a.get("provider_ref")]

    if attempt_ids:
        r = await db.refunds.delete_many({"$or": [{"attempt_id": {"$in": attempt_ids}}, {"order_id": {"$in": order_ids}}]})
        counts["refunds"] = int(r.deleted_count)
    if order_ids or provider_refs:
        event_filter: dict = {"$or": []}
        if order_ids:
            event_filter["$or"].append({"order_id": {"$in": order_ids}})
        if provider_refs:
            event_filter["$or"].append({"provider_ref": {"$in": provider_refs}})
        r = await db.payment_events.delete_many(event_filter)
        counts["payment_events"] = int(r.deleted_count)
    if attempt_ids:
        r = await db.payment_attempts.delete_many({"id": {"$in": attempt_ids}})
        counts["payment_attempts"] = int(r.deleted_count)
    if order_ids:
        r = await db.orders.delete_many({"id": {"$in": order_ids}})
        counts["orders"] = int(r.deleted_count)
    if phone:
        r = await db.coupon_redemptions.delete_many({"store_id": sid, "customer_phone": phone})
        counts["coupon_redemptions"] = int(r.deleted_count)
    r = await db.points_ledger.delete_many({"$or": [{"customer_id": cid}, {"customer_phone": phone}]})
    counts["points_ledger"] = int(r.deleted_count)
    r = await db.customers.delete_one({"id": cid})
    counts["customers"] = int(r.deleted_count)

    await audit("customer.purged", p, store_id=sid, detail={
        "customer_id": cid,
        "safety_backup": safety["name"],
        "counts": counts,
    })
    return {
        "deleted": True,
        "anonymized": False,
        "safety_backup": safety["name"],
        "counts": counts,
    }


@router.post("/customers/{cid}/adjust", response_model=Customer)
async def adjust_points(cid: str, payload: PointsAdjustIn, p: Principal = Depends(get_principal)):
    """Owner-only manual ledger adjustment (corrections, goodwill) — always audited."""
    _require_owner(p)
    from datetime import datetime, timezone

    from models.customer import LedgerEntry

    doc = await db.customers.find_one({"id": cid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Customer not found")
    await resolve_store(p, doc["store_id"])
    if payload.delta == 0:
        raise HTTPException(status_code=400, detail="delta must not be 0")
    await db.points_ledger.insert_one(LedgerEntry(
        customer_id=cid, store_id=doc["store_id"], delta=payload.delta,
        reason="adjust", actor=p.name, note=payload.reason,
    ).model_dump())
    await db.customers.update_one(
        {"id": cid, "points": {"$gte": -payload.delta if payload.delta < 0 else 0}},
        {"$inc": {"points": payload.delta}, "$set": {"updated_at": datetime.now(timezone.utc)}},
    )
    await audit("loyalty.adjust", p, store_id=doc["store_id"],
                detail={"customer_id": cid, "delta": payload.delta, "reason": payload.reason})
    updated = await db.customers.find_one({"id": cid}, {"_id": 0})
    return Customer(**updated)


class CouponValidateIn(BaseModel):
    code: str = Field(min_length=3, max_length=32)
    subtotal: int = Field(ge=0)
    lines: list[dict] = Field(default_factory=list)  # verified lines (product_id, qty, unit_price, category_id)
    customer_phone: Optional[str] = None


@router.post("/coupons/validate")
async def validate_coupon_preview(payload: CouponValidateIn, store_id: str = Query(None), p: Principal = Depends(get_principal)):
    """Checkout preview: price a coupon against the CURRENT verified lines without
    consuming anything. The authoritative pricing still happens at order creation."""
    sid = await resolve_store(p, store_id)
    from lib.loyalty import CouponError

    try:
        coupon, amount = await validate_and_price_coupon(sid, payload.code, payload.subtotal, payload.lines, payload.customer_phone)
    except CouponError as e:
        raise HTTPException(status_code=409, detail=e.detail)
    return {"code": coupon["code"], "amount": amount, "description": coupon.get("description", "")}


@router.get("/loyalty/config")
async def loyalty_config(store_id: str = Query(None), p: Principal = Depends(get_principal)):
    """Redemption rules for the checkout UI (earn rules are applied server-side).
    Returns the store's EFFECTIVE config (its saved settings over env defaults)."""
    sid = await resolve_store(p, store_id)
    cfg = await loyalty_for(sid)
    return {
        "points_per": cfg.points_per,
        "min_spend_to_earn": cfg.min_spend_to_earn,
        "redeem_value_per_point": cfg.redeem_value_per_point,
        "redeem_min_points": cfg.redeem_min_points,
        "redeem_max_fraction": cfg.redeem_max_fraction,
    }


@router.put("/store/loyalty")
async def update_loyalty_config(payload: LoyaltyConfigIn, store_id: str = Query(None), p: Principal = Depends(get_principal)):
    """Owner-only: edit earn/redeem rules for a store (applies to new calculations)."""
    _require_owner(p)
    sid = await resolve_store(p, store_id)
    doc = await db.stores.find_one({"id": sid}, {"_id": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Store not found")
    await db.stores.update_one({"id": sid}, {"$set": {"loyalty": payload.model_dump()}})
    await audit("store.loyalty", p, store_id=sid, detail=payload.model_dump())
    return payload.model_dump()


@router.get("/coupons", response_model=list[Coupon])
async def list_coupons(store_id: str = Query(None), p: Principal = Depends(get_principal)):
    sid = await resolve_store(p, store_id)
    docs = await db.coupons.find({"store_id": sid}, {"_id": 0}).sort("created_at", -1).to_list(200)
    return [Coupon(**d) for d in docs]


@router.post("/coupons", response_model=Coupon, status_code=201)
async def create_coupon(payload: CouponIn, store_id: str = Query(None), p: Principal = Depends(get_principal)):
    _require_owner(p)
    sid = await resolve_store(p, store_id)
    from pymongo.errors import DuplicateKeyError

    coupon = Coupon(store_id=sid, code=payload.code.upper(), **payload.model_dump(exclude={"code"}))
    if coupon.type == "percent" and coupon.value > 100:
        raise HTTPException(status_code=400, detail="Percent coupon value must be 1-100")
    try:
        await db.coupons.insert_one(coupon.model_dump())
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="Kode kupon sudah dipakai")
    await audit("coupon.created", p, store_id=sid, detail={"code": coupon.code, "type": coupon.type, "value": coupon.value})
    return coupon


@router.put("/coupons/{coupon_id}", response_model=Coupon)
async def update_coupon(coupon_id: str, payload: CouponUpdateIn, p: Principal = Depends(get_principal)):
    _require_owner(p)
    doc = await db.coupons.find_one({"id": coupon_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Coupon not found")
    await resolve_store(p, doc["store_id"])
    changes = {k: v for k, v in payload.model_dump(exclude_none=True).items()}
    if not changes:
        return Coupon(**doc)
    if changes.get("type") == "percent" and int(changes.get("value") or doc.get("value") or 0) > 100:
        raise HTTPException(status_code=400, detail="Percent coupon value must be 1-100")
    await db.coupons.update_one({"id": coupon_id}, {"$set": changes})
    await audit("coupon.updated", p, store_id=doc["store_id"], detail={"coupon_id": coupon_id, "changes": changes})
    updated = await db.coupons.find_one({"id": coupon_id}, {"_id": 0})
    return Coupon(**updated)


@router.delete("/coupons/{coupon_id}", status_code=204)
async def delete_coupon(coupon_id: str, p: Principal = Depends(get_principal)):
    """Owner-only, ALWAYS allowed — even after use. Orders snapshot the coupon code and
    amount at creation, so receipts/reports/order history are unaffected. Redemption
    rows are removed with the coupon (quota and per-customer bookkeeping is moot once
    the coupon no longer exists)."""
    _require_owner(p)
    doc = await db.coupons.find_one({"id": coupon_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Coupon not found")
    await resolve_store(p, doc["store_id"])
    used = int(doc.get("used_count") or 0)
    await db.coupon_redemptions.delete_many({"coupon_id": coupon_id})
    await db.coupons.delete_one({"id": coupon_id})
    await audit("coupon.deleted", p, store_id=doc["store_id"],
                detail={"coupon_id": coupon_id, "code": doc.get("code"), "had_been_used": used})


# --- checkout helpers (used by the order routers; not public API) --------------------
async def price_coupon_for_order(store_id: str, code: str, subtotal: int, lines: list[dict], phone: str | None):
    return await validate_and_price_coupon(store_id, code, subtotal, lines, phone)


__all__ = ["router", "reserve_coupon", "redeemable_points"]
