import re
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from lib.auth import Principal, get_principal, resolve_store
from lib.audit import audit
from lib.db import db
from lib.builtin_codes import BUILTIN_PRODUCTS, suggest_code
from models.menu import EDITABLE_GROUPS, MenuEdit, MenuEditIn, PRODUCT_GROUPS, CodeIn, CustomGroup, CustomGroupIn, STATIC_PRODUCT_CATEGORIES, CustomCategory, CustomCategoryIn, CustomOption, CustomOptionIn, CustomProduct, CustomProductIn, MenuOverride, MenuOverrideIn, OptionOverride, OptionOverrideIn

router = APIRouter()

PRODUCT_ID = re.compile(r"^[a-z0-9-]{2,60}$")
GROUP_ID = re.compile(r"^[a-z0-9_-]{2,60}$")


def _check(product_id: str) -> None:
    if not PRODUCT_ID.match(product_id):
        raise HTTPException(status_code=400, detail="Invalid product id")


def _check_option(group_id: str, option_id: str) -> None:
    if not GROUP_ID.match(group_id) or not PRODUCT_ID.match(option_id):
        raise HTTPException(status_code=400, detail="Invalid group or option id")


async def _default_store_id() -> Optional[str]:
    s = await db.stores.find_one({}, {"_id": 0, "id": 1}, sort=[("created_at", 1)])
    return s["id"] if s else None


async def _keep_prices_for_cashier(p: Principal, coll: str, key: dict, data: dict) -> dict:
    """Cashiers may only toggle sold-out; prices stay as the owner set them."""
    if p.is_owner:
        return data
    existing = await db[coll].find_one(key, {"_id": 0}) or {}
    return {**data, "r": existing.get("r"), "l": existing.get("l"), "hidden": existing.get("hidden", False)}


# Public reads (landing page shows each store's prices / sold-out).
@router.get("/menu/overrides", response_model=list[MenuOverride])
async def list_overrides(store_id: Optional[str] = Query(None)):
    sid = store_id or await _default_store_id()
    docs = await db.menu_overrides.find({"store_id": sid}, {"_id": 0}).to_list(1000)
    return [MenuOverride(**d) for d in docs]


@router.get("/menu/option-overrides", response_model=list[OptionOverride])
async def list_option_overrides(store_id: Optional[str] = Query(None)):
    sid = store_id or await _default_store_id()
    docs = await db.option_overrides.find({"store_id": sid}, {"_id": 0}).to_list(1000)
    return [OptionOverride(**d) for d in docs]


@router.put("/menu/overrides/{product_id}", response_model=MenuOverride)
async def upsert_override(product_id: str, payload: MenuOverrideIn, store_id: Optional[str] = Query(None), p: Principal = Depends(get_principal)):
    _check(product_id)
    sid = await resolve_store(p, store_id)
    key = {"store_id": sid, "product_id": product_id}
    data = await _keep_prices_for_cashier(p, "menu_overrides", key, payload.model_dump())
    item = MenuOverride(**key, **data)
    await db.menu_overrides.replace_one(key, item.model_dump(), upsert=True)
    await audit("menu.price_override.set", p, detail={"product_id": product_id, "store_id": sid, "data": {k: v for k, v in data.items() if v is not None}})
    return item


@router.delete("/menu/overrides/{product_id}", status_code=204)
async def reset_override(product_id: str, store_id: Optional[str] = Query(None), p: Principal = Depends(get_principal)):
    _check(product_id)
    if not p.is_owner:
        raise HTTPException(status_code=403, detail="Owner only")
    sid = await resolve_store(p, store_id)
    await db.menu_overrides.delete_one({"store_id": sid, "product_id": product_id})
    await audit("menu.price_override.reset", p, detail={"product_id": product_id, "store_id": sid})


@router.put("/menu/option-overrides/{group_id}/{option_id}", response_model=OptionOverride)
async def upsert_option_override(
    group_id: str, option_id: str, payload: OptionOverrideIn, store_id: Optional[str] = Query(None), p: Principal = Depends(get_principal)
):
    _check_option(group_id, option_id)
    sid = await resolve_store(p, store_id)
    key = {"store_id": sid, "group_id": group_id, "option_id": option_id}
    data = await _keep_prices_for_cashier(p, "option_overrides", key, payload.model_dump())
    item = OptionOverride(**key, **data)
    await db.option_overrides.replace_one(key, item.model_dump(), upsert=True)
    await audit("menu.option_override.set", p, detail={"group_id": group_id, "option_id": option_id, "store_id": sid, "data": {k: v for k, v in data.items() if v is not None}})
    return item


@router.delete("/menu/option-overrides/{group_id}/{option_id}", status_code=204)
async def reset_option_override(group_id: str, option_id: str, store_id: Optional[str] = Query(None), p: Principal = Depends(get_principal)):
    _check_option(group_id, option_id)
    if not p.is_owner:
        raise HTTPException(status_code=403, detail="Owner only")
    sid = await resolve_store(p, store_id)
    await db.option_overrides.delete_one({"store_id": sid, "group_id": group_id, "option_id": option_id})
    await audit("menu.option_override.reset", p, detail={"group_id": group_id, "option_id": option_id, "store_id": sid})


# ---- Item codes: every menu item has a unique code (BDB, EKKPP, ...). Owner can change any of them. ----
CODE_RE = re.compile(r"^[A-Z0-9]{1,8}$")


def _norm_code(raw: str) -> str:
    code = raw.strip().upper()
    if not CODE_RE.match(code):
        raise HTTPException(status_code=422, detail="Kode harus 1-8 huruf atau angka tanpa spasi")
    return code


async def _effective_codes() -> dict[str, tuple[str, str]]:
    """product id -> (code, name) for built-in items (default or owner-changed) and items added in the app."""
    names = {d["id"]: d["name"] async for d in db.custom_products.find({}, {"_id": 0, "id": 1, "name": 1})}
    eff = dict(BUILTIN_PRODUCTS)
    async for d in db.product_codes.find({}, {"_id": 0}):
        pid = d["product_id"]
        eff[pid] = (d["code"], eff[pid][1] if pid in eff else names.get(pid, pid))
    return eff


async def _code_taken_by(code: str, product_id: Optional[str]) -> Optional[str]:
    for pid, (c, name) in (await _effective_codes()).items():
        if pid != product_id and c == code:
            return name
    return None


async def _set_code(product_id: str, code: str) -> None:
    owner = await _code_taken_by(code, product_id)
    if owner:
        raise HTTPException(status_code=409, detail=f"Kode {code} sudah dipakai oleh {owner}")
    await db.product_codes.update_one({"product_id": product_id}, {"$set": {"product_id": product_id, "code": code}}, upsert=True)


@router.get("/menu/codes")
async def list_codes():
    """Codes the owner changed or gave to items added in the app (built-in defaults live in the frontend)."""
    return {d["product_id"]: d["code"] async for d in db.product_codes.find({}, {"_id": 0})}


@router.put("/menu/codes/{product_id}")
async def set_code(product_id: str, payload: CodeIn, p: Principal = Depends(get_principal)):
    _owner_only(p)
    _check(product_id)
    if product_id not in BUILTIN_PRODUCTS and not await db.custom_products.find_one({"id": product_id}, {"_id": 1}):
        raise HTTPException(status_code=404, detail="Item not found")
    code = _norm_code(payload.code)
    current = (await _effective_codes()).get(product_id, ("", ""))[0]
    if code != current:  # saving the code an item already has is always fine
        await _set_code(product_id, code)
    await audit("menu.code.set", p, detail={"product_id": product_id, "code": code})
    return {"product_id": product_id, "code": code}


# ---- Custom menu items added from the app (owner only to change; public to read) ----
def _owner_only(p: Principal) -> None:
    if not p.is_owner:
        raise HTTPException(status_code=403, detail="Owner only")


async def _clean(payload: CustomProductIn) -> dict:
    data = payload.model_dump()
    data["name"] = data["name"].strip()
    data["section"] = data["section"].strip()
    if not data["name"]:
        raise HTTPException(status_code=422, detail="Name required")
    if data["category"] not in STATIC_PRODUCT_CATEGORIES and not await db.custom_categories.find_one({"id": data["category"]}, {"_id": 1}):
        raise HTTPException(status_code=422, detail="Unknown category")
    if data["groups"] is not None:
        if any(g not in PRODUCT_GROUPS for g in data["groups"]):
            raise HTTPException(status_code=422, detail="Unknown option group")
        data["groups"] = list(dict.fromkeys(data["groups"]))
    if data["category"] == "bowl":
        data["l"] = None  # bowls have a single size
    return data


@router.get("/menu/custom-products", response_model=list[CustomProduct])
async def list_custom_products():
    docs = await db.custom_products.find({}, {"_id": 0}).sort("created_at", 1).to_list(1000)
    codes = {d["product_id"]: d["code"] async for d in db.product_codes.find({}, {"_id": 0})}
    return [CustomProduct(**{**d, "code": codes.get(d["id"], "")}) for d in docs]


@router.post("/menu/custom-products", response_model=CustomProduct, status_code=201)
async def create_custom_product(payload: CustomProductIn, p: Principal = Depends(get_principal)):
    _owner_only(p)
    data = await _clean(payload)
    slug = re.sub(r"[^a-z0-9]+", "-", data["name"].lower()).strip("-")[:40] or "item"
    taken = {c for c, _ in (await _effective_codes()).values()}
    code = _norm_code(data["code"]) if data["code"].strip() else suggest_code(data["name"], taken)
    owner = await _code_taken_by(code, None)
    if owner:  # checked before saving so a clash does not leave a half-created item
        raise HTTPException(status_code=409, detail=f"Kode {code} sudah dipakai oleh {owner}")
    data["code"] = code
    item = CustomProduct(id=f"cx-{slug}-{uuid.uuid4().hex[:6]}", **data)
    doc = item.model_dump()
    doc.pop("code")  # codes live in product_codes
    await db.custom_products.insert_one(doc)
    await _set_code(item.id, code)
    await audit("menu.custom_product.create", p, detail={"product_id": item.id, "name": item.name})
    return item


@router.put("/menu/custom-products/{product_id}", response_model=CustomProduct)
async def update_custom_product(product_id: str, payload: CustomProductIn, p: Principal = Depends(get_principal)):
    _owner_only(p)
    _check(product_id)
    existing = await db.custom_products.find_one({"id": product_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Item not found")
    data = await _clean(payload)
    current = (await _effective_codes()).get(product_id, ("", ""))[0]
    code = _norm_code(data["code"]) if data["code"].strip() else current or suggest_code(data["name"], {c for c, _ in (await _effective_codes()).values()})
    if code != current:
        owner = await _code_taken_by(code, product_id)
        if owner:
            raise HTTPException(status_code=409, detail=f"Kode {code} sudah dipakai oleh {owner}")
    data["code"] = code
    item = CustomProduct(id=product_id, created_at=existing["created_at"], **data)
    doc = item.model_dump()
    doc.pop("code")
    await db.custom_products.replace_one({"id": product_id}, doc)
    if code != current or not current:
        await _set_code(product_id, code)
    await audit("menu.custom_product.update", p, detail={"product_id": product_id, "name": item.name})
    return item


@router.delete("/menu/custom-products/{product_id}", status_code=204)
async def delete_custom_product(product_id: str, p: Principal = Depends(get_principal)):
    _owner_only(p)
    _check(product_id)
    res = await db.custom_products.delete_one({"id": product_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Item not found")
    await db.menu_overrides.delete_many({"product_id": product_id})  # past orders keep their own copy
    await db.product_codes.delete_many({"product_id": product_id})  # frees the code for reuse
    await audit("menu.custom_product.delete", p, detail={"product_id": product_id})


# ---- Custom toppings / options added from the app (owner only to change; public to read) ----
@router.get("/menu/custom-options", response_model=list[CustomOption])
async def list_custom_options():
    docs = await db.custom_options.find({}, {"_id": 0}).sort("created_at", 1).to_list(2000)
    return [CustomOption(**d) for d in docs]


async def _clean_option(payload: CustomOptionIn) -> dict:
    data = payload.model_dump()
    if data["group_id"] not in EDITABLE_GROUPS and not await db.custom_groups.find_one({"id": data["group_id"]}, {"_id": 1}):
        raise HTTPException(status_code=422, detail="Unknown option group")
    data["label"] = data["label"].strip()
    if not data["label"]:
        raise HTTPException(status_code=422, detail="Name required")
    return data


@router.post("/menu/custom-options", response_model=CustomOption, status_code=201)
async def create_custom_option(payload: CustomOptionIn, p: Principal = Depends(get_principal)):
    _owner_only(p)
    data = await _clean_option(payload)
    slug = re.sub(r"[^a-z0-9]+", "-", data["label"].lower()).strip("-")[:40] or "opsi"
    item = CustomOption(id=f"cx-{slug}-{uuid.uuid4().hex[:6]}", **data)
    await db.custom_options.insert_one(item.model_dump())
    await audit("menu.custom_option.create", p, detail={"option_id": item.id, "label": item.label})
    return item


@router.put("/menu/custom-options/{option_id}", response_model=CustomOption)
async def update_custom_option(option_id: str, payload: CustomOptionIn, p: Principal = Depends(get_principal)):
    _owner_only(p)
    _check(option_id)
    existing = await db.custom_options.find_one({"id": option_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Option not found")
    item = CustomOption(id=option_id, created_at=existing["created_at"], **(await _clean_option(payload)))
    await db.custom_options.replace_one({"id": option_id}, item.model_dump())
    if item.group_id != existing["group_id"]:  # moved to another group: old per-store overrides no longer apply
        await db.option_overrides.delete_many({"option_id": option_id})
    await audit("menu.custom_option.update", p, detail={"option_id": option_id, "label": item.label})
    return item


@router.delete("/menu/custom-options/{option_id}", status_code=204)
async def delete_custom_option(option_id: str, p: Principal = Depends(get_principal)):
    _owner_only(p)
    _check(option_id)
    res = await db.custom_options.delete_one({"id": option_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Option not found")
    await db.option_overrides.delete_many({"option_id": option_id})  # past orders keep their own copy
    await audit("menu.custom_option.delete", p, detail={"option_id": option_id})


# ---- Custom categories (owner only to change; public to read) ----
@router.get("/menu/custom-categories", response_model=list[CustomCategory])
async def list_custom_categories():
    docs = await db.custom_categories.find({}, {"_id": 0}).sort("created_at", 1).to_list(200)
    return [CustomCategory(**d) for d in docs]


@router.post("/menu/custom-categories", response_model=CustomCategory, status_code=201)
async def create_custom_category(payload: CustomCategoryIn, p: Principal = Depends(get_principal)):
    _owner_only(p)
    label = payload.label.strip()
    if not label:
        raise HTTPException(status_code=422, detail="Name required")
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")[:30] or "kategori"
    item = CustomCategory(id=f"cx-{slug}-{uuid.uuid4().hex[:6]}", label=label, blurb=payload.blurb.strip())
    await db.custom_categories.insert_one(item.model_dump())
    await audit("menu.custom_category.create", p, detail={"category_id": item.id, "label": label})
    return item


@router.put("/menu/custom-categories/{category_id}", response_model=CustomCategory)
async def update_custom_category(category_id: str, payload: CustomCategoryIn, p: Principal = Depends(get_principal)):
    _owner_only(p)
    _check(category_id)
    existing = await db.custom_categories.find_one({"id": category_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Category not found")
    item = CustomCategory(id=category_id, created_at=existing["created_at"], label=payload.label.strip(), blurb=payload.blurb.strip())
    await db.custom_categories.replace_one({"id": category_id}, item.model_dump())
    await audit("menu.custom_category.update", p, detail={"category_id": category_id, "label": item.label})
    return item


@router.delete("/menu/custom-categories/{category_id}", status_code=204)
async def delete_custom_category(category_id: str, p: Principal = Depends(get_principal)):
    _owner_only(p)
    _check(category_id)
    if await db.custom_products.find_one({"category": category_id}, {"_id": 1}):
        raise HTTPException(status_code=409, detail="Category still has items. Delete or move them first.")
    res = await db.custom_categories.delete_one({"id": category_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Category not found")
    await audit("menu.custom_category.delete", p, detail={"category_id": category_id})


@router.get("/menu/bundle")
async def menu_bundle_authed(store_id: Optional[str] = Query(None), p: Principal = Depends(get_principal)):
    """Same payload as /public/menu/{code} but for an authenticated session (the POS)."""
    sid = await resolve_store(p, store_id)
    store = await db.stores.find_one({"id": sid}, {"_id": 0, "pin_hash": 0, "approval_pin_hash": 0})
    from routers.public import menu_bundle
    return await menu_bundle(store, include_legacy=True)


# ---- Custom topping groups (owner only to change; public to read) ----
def _clean_group(payload: CustomGroupIn) -> dict:
    data = payload.model_dump()
    data["label"] = data["label"].strip()
    if not data["label"]:
        raise HTTPException(status_code=422, detail="Name required")
    if any(not PRODUCT_ID.match(x) for x in data["product_ids"]):
        raise HTTPException(status_code=422, detail="Invalid item id")
    data["product_ids"] = list(dict.fromkeys(data["product_ids"]))
    return data


@router.get("/menu/custom-groups", response_model=list[CustomGroup])
async def list_custom_groups():
    docs = await db.custom_groups.find({}, {"_id": 0}).sort("created_at", 1).to_list(200)
    return [CustomGroup(**d) for d in docs]


@router.post("/menu/custom-groups", response_model=CustomGroup, status_code=201)
async def create_custom_group(payload: CustomGroupIn, p: Principal = Depends(get_principal)):
    _owner_only(p)
    data = _clean_group(payload)
    slug = re.sub(r"[^a-z0-9]+", "-", data["label"].lower()).strip("-")[:30] or "grup"
    item = CustomGroup(id=f"cx-{slug}-{uuid.uuid4().hex[:6]}", **data)
    await db.custom_groups.insert_one(item.model_dump())
    await audit("menu.custom_group.create", p, detail={"group_id": item.id, "label": item.label})
    return item


@router.put("/menu/custom-groups/{group_id}", response_model=CustomGroup)
async def update_custom_group(group_id: str, payload: CustomGroupIn, p: Principal = Depends(get_principal)):
    _owner_only(p)
    _check(group_id)
    existing = await db.custom_groups.find_one({"id": group_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Group not found")
    item = CustomGroup(id=group_id, created_at=existing["created_at"], **_clean_group(payload))
    await db.custom_groups.replace_one({"id": group_id}, item.model_dump())
    await audit("menu.custom_group.update", p, detail={"group_id": group_id, "label": item.label})
    return item


@router.delete("/menu/custom-groups/{group_id}", status_code=204)
async def delete_custom_group(group_id: str, p: Principal = Depends(get_principal)):
    """Removes the group and the toppings inside it. Past orders keep their own copy."""
    _owner_only(p)
    _check(group_id)
    res = await db.custom_groups.delete_one({"id": group_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Group not found")
    ids = [d["id"] async for d in db.custom_options.find({"group_id": group_id}, {"_id": 0, "id": 1})]
    await db.custom_options.delete_many({"group_id": group_id})
    await db.option_overrides.delete_many({"group_id": group_id})
    await audit("menu.custom_group.delete", p, detail={"group_id": group_id, "options_removed": len(ids)})
    return None


# ---- Edits to built-in items, toppings, categories and groups (owner only to change; public to read) ----
BUILTIN_CATEGORIES = ("smoothie", "bowl", "jus", "potong", "custom", "snack", "sopsalad")
SPECIAL_PRODUCTS = ("bp-buah-potong", "cu-jus", "cu-bowl")  # builders with their own pricing: cannot change category
EDIT_FIELDS = {
    "product": ("name", "desc", "benefit", "category", "section", "color"),
    "option": ("name",),
    "category": ("name", "desc"),
    "group": ("name",),
}


@router.get("/menu/edits")
async def list_edits():
    docs = await db.menu_edits.find({}, {"_id": 0}).to_list(5000)
    return docs


@router.put("/menu/edits")
async def save_edit(payload: MenuEditIn, p: Principal = Depends(get_principal)):
    _owner_only(p)
    kind, key = payload.kind, payload.key
    if kind == "product":
        if key not in BUILTIN_PRODUCTS:
            raise HTTPException(status_code=404, detail="Item not found (items added in the app are edited with their own form)")
    elif kind == "option":
        if "/" not in key or key.split("/")[1].startswith("cx-"):
            raise HTTPException(status_code=422, detail="Use the topping form for toppings added in the app")
    elif kind == "category":
        if key not in BUILTIN_CATEGORIES:
            raise HTTPException(status_code=404, detail="Category not found (your own categories are renamed directly)")
    else:  # group
        if "/" in key or key.startswith("cx-"):
            raise HTTPException(status_code=422, detail="Use the group form for groups made in the app")
    fields = {f: getattr(payload, f) for f in EDIT_FIELDS[kind] if getattr(payload, f) is not None}
    for f in ("name", "category"):
        if isinstance(fields.get(f), str):
            fields[f] = fields[f].strip()
            if not fields[f]:
                raise HTTPException(status_code=422, detail="Name required")
    if "category" in fields:
        target = fields["category"]
        if key in SPECIAL_PRODUCTS or target in ("potong", "custom"):
            raise HTTPException(status_code=422, detail="This item cannot be moved to or from that category")
        if target not in BUILTIN_CATEGORIES and not await db.custom_categories.find_one({"id": target}, {"_id": 1}):
            raise HTTPException(status_code=422, detail="Unknown category")
    if not fields:
        raise HTTPException(status_code=422, detail="Nothing to change")
    doc = MenuEdit(**{"kind": kind, "key": key, **fields}).model_dump(exclude_none=True)
    await db.menu_edits.replace_one({"kind": kind, "key": key}, doc, upsert=True)
    await audit("menu.edit.save", p, detail={"kind": kind, "key": key, "fields": sorted(fields.keys())})
    return doc


@router.delete("/menu/edits", status_code=204)
async def reset_edit(kind: str, key: str, p: Principal = Depends(get_principal)):
    """Put the item back to how it is built in."""
    _owner_only(p)
    await db.menu_edits.delete_one({"kind": kind, "key": key})
    await audit("menu.edit.reset", p, detail={"kind": kind, "key": key})
