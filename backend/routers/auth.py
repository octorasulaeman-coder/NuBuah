import os
import os
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from lib.auth import (
    Principal, clear_session, get_principal, hash_secret, require_owner, set_session, verify_secret,
)
from lib.audit import audit
from lib.db import db
from lib.ratelimit import check_locked, check_rate, client_ip, record_fail, record_success
from models.auth import LoginIn, Me, PasswordChange, PinLoginIn, ProfileUpdate, PublicStore, Staff, StaffIn, StaffUpdate, Store, StoreIn, StoreUpdate

router = APIRouter()


def _me(p: Principal) -> Me:
    return Me(id=p.id, kind=p.kind, name=p.name, email=p.email, role=p.role, store_id=p.store_id, must_change_password=p.must_change_password)


def discount_cap_pct() -> int:
    """Cashier discounts above this percent of subtotal need the owner approval PIN."""
    try:
        return max(0, min(100, int(os.environ.get("DISCOUNT_CAP_PCT", "10"))))
    except ValueError:
        return 10


def _store(d: dict) -> Store:
    # Tolerant of legacy store docs missing fields (e.g. created_at on data restored from an
    # old backup): one bad doc must not 500 the whole store list or a create response.
    data = {k: d.get(k) for k in ("id", "name", "code", "address_lines", "phone", "created_at")}
    data["created_at"] = data["created_at"] or datetime.now(timezone.utc)
    data["address_lines"] = data["address_lines"] or []
    data["phone"] = data["phone"] or ""
    return Store(**data, has_pin=bool(d.get("pin_hash")), has_approval_pin=bool(d.get("approval_pin_hash")), discount_cap=discount_cap_pct())


# ---------- auth ----------
@router.post("/auth/login", response_model=Me)
async def login(payload: LoginIn, request: Request, response: Response):
    email = payload.email.strip().lower()
    ip_key, acct_key = f"login:ip:{client_ip(request)}", f"login:acct:{email}"
    check_rate(ip_key)
    check_locked(acct_key)  # brute-force lockout per account, not just per IP
    user = await db.users.find_one({"email": email}, {"_id": 0})
    if not user or not user.get("active", True) or not verify_secret(payload.password, user["password_hash"]):
        record_fail(acct_key)
        raise HTTPException(status_code=401, detail="Email atau password salah")
    record_success(acct_key)
    set_session(request, response, {"kind": "user", "sub": user["id"], "tv": user.get("token_version", 0)})
    return Me(id=user["id"], kind="user", name=user["name"], email=user["email"], role=user["role"], store_id=user.get("store_id"), must_change_password=user.get("must_change_password", False))


@router.post("/auth/pin", response_model=Me)
async def pin_login(payload: PinLoginIn, request: Request, response: Response):
    ip_key, acct_key = f"pin:ip:{client_ip(request)}", f"pin:store:{payload.store_id}"
    check_rate(ip_key)
    check_locked(acct_key)
    store = await db.stores.find_one({"id": payload.store_id}, {"_id": 0})
    if not store or not store.get("pin_hash") or not verify_secret(payload.pin, store["pin_hash"]):
        record_fail(acct_key)
        raise HTTPException(status_code=401, detail="PIN salah")
    record_success(acct_key)
    set_session(request, response, {"kind": "pin", "store_id": store["id"], "pv": store.get("pin_version", 0)})
    return Me(id=f"pin:{store['id']}", kind="pin", name=f"Kasir {store['name']}", role="cashier", store_id=store["id"])


@router.post("/auth/logout", status_code=204)
async def logout(response: Response):
    clear_session(response)


@router.get("/auth/me", response_model=Me)
async def me(p: Principal = Depends(get_principal)):
    return _me(p)


def _own_account(p: Principal) -> None:
    if p.kind != "user" or not p.is_owner:
        raise HTTPException(status_code=403, detail="Owner only")


@router.put("/auth/me", response_model=Me)
async def update_me(payload: ProfileUpdate, request: Request, response: Response, p: Principal = Depends(get_principal)):
    """The owner edits their own name and email."""
    _own_account(p)
    upd = {}
    if payload.name is not None:
        upd["name"] = payload.name.strip()
    if payload.email is not None:
        email = payload.email.strip().lower()
        if await db.users.find_one({"email": email, "id": {"$ne": p.id}}):
            raise HTTPException(status_code=409, detail="Email sudah dipakai akun lain")
        upd["email"] = email
    if upd:
        await db.users.update_one({"id": p.id}, {"$set": upd})
    user = await db.users.find_one({"id": p.id}, {"_id": 0})
    return Me(id=user["id"], kind="user", name=user["name"], email=user["email"], role=user["role"], store_id=user.get("store_id"))


@router.post("/auth/me/password", status_code=204)
async def change_my_password(payload: PasswordChange, request: Request, response: Response, p: Principal = Depends(get_principal)):
    """The owner changes their own password (must know the current one). Other devices are signed out; this one stays in."""
    _own_account(p)
    user = await db.users.find_one({"id": p.id}, {"_id": 0})
    if not user or not verify_secret(payload.current_password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="Password saat ini salah")
    tv = user.get("token_version", 0) + 1
    await db.users.update_one({"id": p.id}, {"$set": {"password_hash": hash_secret(payload.new_password), "token_version": tv, "must_change_password": False}})
    await audit("user.password_change", p)
    set_session(request, response, {"kind": "user", "sub": p.id, "tv": tv})


# ---------- stores ----------
@router.get("/public/stores", response_model=list[PublicStore])
async def public_stores():
    docs = await db.stores.find({}, {"_id": 0, "pin_hash": 0}).sort("created_at", 1).to_list(200)
    return [PublicStore(**{k: d[k] for k in ("id", "name", "code", "address_lines", "phone")}) for d in docs]


@router.get("/stores", response_model=list[Store])
async def list_stores(p: Principal = Depends(get_principal)):
    q = {} if p.is_owner else {"id": p.store_id}
    docs = await db.stores.find(q, {"_id": 0}).sort("created_at", 1).to_list(200)
    # self-heal legacy docs missing created_at (they would otherwise sort unpredictably)
    for d in docs:
        if d.get("created_at") is None:
            await db.stores.update_one({"id": d["id"]}, {"$set": {"created_at": datetime.now(timezone.utc)}})
    return [_store(d) for d in docs]


@router.post("/stores", response_model=Store, status_code=201)
async def create_store(payload: StoreIn, p: Principal = Depends(require_owner)):
    if await db.stores.find_one({"code": payload.code}):
        raise HTTPException(status_code=409, detail="Kode toko sudah dipakai")
    doc = {
        "id": str(uuid.uuid4()),
        "name": payload.name.strip(),
        "code": payload.code,
        "address_lines": [a.strip() for a in payload.address_lines if a.strip()],
        "phone": payload.phone.strip(),
        "pin_hash": hash_secret(payload.pin) if payload.pin else None,
        "approval_pin_hash": hash_secret(payload.approval_pin) if payload.approval_pin else None,
        "pin_version": 1,
        "created_at": datetime.now(timezone.utc),
    }
    await db.stores.insert_one(dict(doc))
    await audit("store.create", p, store_id=doc["id"], detail={"name": doc["name"], "code": doc["code"], "has_approval_pin": bool(payload.approval_pin)})
    return _store(doc)


@router.put("/stores/{id}", response_model=Store)
async def update_store(id: str, payload: StoreUpdate, p: Principal = Depends(require_owner)):
    store = await db.stores.find_one({"id": id}, {"_id": 0})
    if not store:
        raise HTTPException(status_code=404, detail="Store not found")
    upd = payload.model_dump(exclude_none=True)
    if "code" in upd and await db.stores.find_one({"code": upd["code"], "id": {"$ne": id}}):
        raise HTTPException(status_code=409, detail="Kode toko sudah dipakai")
    if "address_lines" in upd:
        upd["address_lines"] = [a.strip() for a in upd["address_lines"] if a.strip()]
    inc = {}
    if "pin" in upd:
        upd["pin_hash"] = hash_secret(upd.pop("pin"))
        inc = {"pin_version": 1}  # changing the PIN signs out existing PIN sessions
    if "approval_pin" in upd:
        upd["approval_pin_hash"] = hash_secret(upd.pop("approval_pin"))
    await db.stores.update_one({"id": id}, {"$set": upd, **({"$inc": inc} if inc else {})})
    await _sync_order_snapshots(store, upd)
    await audit("store.update", p, store_id=id, detail={"fields": sorted(upd.keys()), "pin_changed": bool(inc), "approval_pin_changed": "approval_pin_hash" in upd})
    return _store(await db.stores.find_one({"id": id}, {"_id": 0}))


async def _sync_order_snapshots(old: dict, upd: dict) -> None:
    """Receipts snapshot store details; keep past orders in step when the owner edits the store (name, code, address, phone)."""
    mapping = {"name": "store_name", "address_lines": "store_address_lines", "phone": "store_phone"}
    fields = {f: upd[k] for k, f in mapping.items() if k in upd}
    if fields:
        await db.orders.update_many({"store_id": old["id"]}, {"$set": fields})
    new_code, old_code = upd.get("code"), old.get("code")
    if new_code and old_code and new_code != old_code:
        prefix = f"{old_code}-"
        async for o in db.orders.find({"store_id": old["id"], "order_no": {"$regex": f"^{old_code}-"}}, {"_id": 0, "id": 1, "order_no": 1}):
            await db.orders.update_one({"id": o["id"]}, {"$set": {"order_no": f"{new_code}-{o['order_no'][len(prefix):]}"}})


@router.delete("/stores/{id}", status_code=204)
async def delete_store(id: str, p: Principal = Depends(require_owner)):
    """Remove a store and its cashier logins + menu overrides. Past sales stay in history and reports."""
    if not await db.stores.find_one({"id": id}, {"_id": 1}):
        raise HTTPException(status_code=404, detail="Store not found")
    if await db.stores.count_documents({}) <= 1:
        raise HTTPException(status_code=400, detail="Toko terakhir tidak bisa dihapus")
    await db.users.delete_many({"store_id": id, "role": {"$ne": "owner"}})
    await db.menu_overrides.delete_many({"store_id": id})
    await db.option_overrides.delete_many({"store_id": id})
    await db.stores.delete_one({"id": id})  # PIN sessions for this store become invalid automatically
    await audit("store.delete", p, store_id=id)


# ---------- staff ----------
@router.get("/staff", response_model=list[Staff])
async def list_staff(_: Principal = Depends(require_owner)):
    docs = await db.users.find({"active": {"$ne": False}}, {"_id": 0, "password_hash": 0}).sort("created_at", 1).to_list(500)
    return [Staff(**d) for d in docs]


@router.post("/staff", response_model=Staff, status_code=201)
async def create_staff(payload: StaffIn, _: Principal = Depends(require_owner)):
    email = payload.email.strip().lower()
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=409, detail="Email sudah terdaftar")
    if not await db.stores.find_one({"id": payload.store_id}):
        raise HTTPException(status_code=404, detail="Store not found")
    staff = Staff(name=payload.name.strip(), email=email, role="cashier", store_id=payload.store_id)
    await db.users.insert_one({**staff.model_dump(), "password_hash": hash_secret(payload.password), "active": True})
    await audit("staff.create", _, detail={"staff_id": staff.id, "email": email, "store_id": payload.store_id})
    return staff


@router.put("/staff/{id}", response_model=Staff)
async def update_staff(id: str, payload: StaffUpdate, _: Principal = Depends(require_owner)):
    user = await db.users.find_one({"id": id, "role": "cashier"}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="Staff not found")
    upd: dict = {}
    if payload.name is not None:
        upd["name"] = payload.name.strip()
    signout = False
    if payload.email is not None:
        email = payload.email.strip().lower()
        if email != user["email"]:
            if await db.users.find_one({"email": email, "id": {"$ne": id}}):
                raise HTTPException(status_code=409, detail="Email sudah terdaftar")
            upd["email"] = email
            signout = True
    if payload.store_id is not None and payload.store_id != user.get("store_id"):
        if not await db.stores.find_one({"id": payload.store_id}, {"_id": 1}):
            raise HTTPException(status_code=404, detail="Store not found")
        upd["store_id"] = payload.store_id
        signout = True
    if payload.password:
        upd["password_hash"] = hash_secret(payload.password)
        signout = True
    cmd: dict = {"$set": upd} if upd else {}
    if signout:
        cmd["$inc"] = {"token_version": 1}  # the cashier has to sign in again with the new details
    if cmd:
        await db.users.update_one({"id": id}, cmd)
        await audit("staff.update", _, detail={"staff_id": id, "fields": sorted(upd.keys()), "signed_out": signout})
    fresh = await db.users.find_one({"id": id}, {"_id": 0, "password_hash": 0})
    return Staff(**fresh)


@router.delete("/staff/{id}", status_code=204)
async def delete_staff(id: str, p: Principal = Depends(require_owner)):
    if id == p.id:
        raise HTTPException(status_code=400, detail="Tidak bisa menghapus akun sendiri")
    res = await db.users.delete_one({"id": id, "role": "cashier"})
    if not res.deleted_count:
        raise HTTPException(status_code=404, detail="Staff not found")
    await audit("staff.delete", p, detail={"staff_id": id})
