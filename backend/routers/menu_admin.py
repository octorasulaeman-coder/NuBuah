"""Unified menu administration: full CRUD over menu_products / menu_groups / menu_options /
menu_categories, plus product photo upload (stored in MongoDB so backups cover it).

Owner-only. Every mutation is validated (category/group references must exist, codes unique,
image bytes sniffed) and audited. IDs are immutable slugs; past orders keep their own copies.
"""
import base64
import binascii
import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from lib.audit import audit
from lib.auth import Principal, require_owner
from lib.builtin_codes import BUILTIN_CODES, suggest_code
from lib.db import db
from models.menu import (
    MenuCategoryIn, MenuCategoryRow, MenuGroupIn, MenuGroupRow,
    MenuOptionIn, MenuOptionRow, MenuProductIn, MenuProductRow, ProductImageIn,
)

router = APIRouter()

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,79}$")

_MAGIC = {
    "image/webp": (b"RIFF",),
    "image/jpeg": (b"\xff\xd8",),
    "image/png": (b"\x89PNG",),
}
MAX_IMAGE_BYTES = 1_500_000  # hard cap on the decoded image


@router.get("/menu/admin/all")
async def menu_admin_snapshot(_: Principal = Depends(require_owner)):
    """Everything the editor needs in one shot (unified rows, no merging needed)."""
    products = await db.menu_products.find({}, {"_id": 0}).sort("name", 1).to_list(1000)
    groups = await db.menu_groups.find({}, {"_id": 0}).to_list(500)
    options = await db.menu_options.find({}, {"_id": 0}).to_list(3000)
    categories = await db.menu_categories.find({}, {"_id": 0}).to_list(200)
    edits = await db.menu_edits.find({}, {"_id": 0}).to_list(2000)
    codes = {d["product_id"]: d["code"] async for d in db.product_codes.find({}, {"_id": 0, "product_id": 1, "code": 1})}
    return {"products": products, "groups": groups, "options": options, "categories": categories, "edits": edits, "codes": codes}


def _slug(s: str) -> str:
    return re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9]+", "-", s.lower())) or uuid.uuid4().hex[:6]


async def _check_category(category: str) -> None:
    if not await db.menu_categories.find_one({"id": category}, {"_id": 1}):
        raise HTTPException(status_code=422, detail=f"Kategori tidak dikenal: {category}")


async def _check_groups(groups: list[str]) -> None:
    for gid in groups:
        if not await db.menu_groups.find_one({"id": gid}, {"_id": 1}):
            raise HTTPException(status_code=422, detail=f"Grup opsi tidak dikenal: {gid}")


async def _unique_code(code: str, exclude_product: str | None = None) -> None:
    async for d in db.product_codes.find({"code": code}, {"_id": 0, "product_id": 1}):
        if d["product_id"] != exclude_product:
            raise HTTPException(status_code=409, detail=f"Kode {code} sudah dipakai item lain")
    if code in BUILTIN_CODES:
        existing = await db.menu_products.find_one({"id": {"$ne": exclude_product}, "code": code}, {"_id": 0, "id": 1})
        if existing:
            raise HTTPException(status_code=409, detail=f"Kode {code} sudah dipakai item lain")


# ---------------- products ----------------

@router.post("/menu/products", response_model=MenuProductRow, status_code=201)
async def create_product(payload: MenuProductIn, p: Principal = Depends(require_owner)):
    await _check_category(payload.category)
    if payload.groups:
        await _check_groups(payload.groups)
    taken = {d["code"] async for d in db.product_codes.find({}, {"_id": 0, "code": 1})}
    taken |= {d.get("code") for d in await db.menu_products.find({"code": {"$ne": None}}, {"_id": 0, "code": 1}).to_list(1000)}
    code = payload.code.strip().upper() or suggest_code(payload.name, taken)
    await _unique_code(code)
    pid = f"{_slug(payload.category)[:14]}-{_slug(payload.name)[:40]}-{uuid.uuid4().hex[:4]}"[:80]
    while await db.menu_products.find_one({"id": pid}, {"_id": 1}):
        pid = f"{_slug(payload.category)[:14]}-{_slug(payload.name)[:40]}-{uuid.uuid4().hex[:4]}"[:80]
    row = MenuProductRow(id=pid, builtin=False, **payload.model_dump())
    await db.menu_products.insert_one(row.model_dump())
    if row.code:
        await db.product_codes.update_one({"product_id": pid}, {"$set": {"product_id": pid, "code": row.code}}, upsert=True)
    await audit("menu.product.create", p, detail={"product_id": pid, "name": row.name})
    return row


@router.put("/menu/products/{pid}", response_model=MenuProductRow)
async def update_product(pid: str, payload: MenuProductIn, p: Principal = Depends(require_owner)):
    if not await db.menu_products.find_one({"id": pid}, {"_id": 1}):
        raise HTTPException(status_code=404, detail="Item tidak ditemukan")
    await _check_category(payload.category)
    if payload.groups:
        await _check_groups(payload.groups)
    code = payload.code.strip().upper() or None
    if code:
        await _unique_code(code, exclude_product=pid)
    data = payload.model_dump()
    data["code"] = code
    await db.menu_products.update_one({"id": pid}, {"$set": data})
    if code:
        await db.product_codes.update_one({"product_id": pid}, {"$set": {"product_id": pid, "code": code}}, upsert=True)
    else:
        await db.product_codes.delete_many({"product_id": pid})
    await audit("menu.product.update", p, detail={"product_id": pid, "name": payload.name})
    fresh = await db.menu_products.find_one({"id": pid}, {"_id": 0})
    return MenuProductRow(**fresh)


@router.delete("/menu/products/{pid}", status_code=204)
async def delete_product(pid: str, p: Principal = Depends(require_owner)):
    doc = await db.menu_products.find_one({"id": pid}, {"_id": 0, "img_id": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Item tidak ditemukan")
    await db.menu_products.delete_one({"id": pid})
    await db.menu_overrides.delete_many({"product_id": pid})   # past orders keep their own copy
    await db.product_codes.delete_many({"product_id": pid})
    if doc.get("img_id"):
        await db.media.delete_one({"id": doc["img_id"]})
    # detach from topping groups
    await db.menu_groups.update_many({"product_ids": pid}, {"$pull": {"product_ids": pid}})
    await audit("menu.product.delete", p, detail={"product_id": pid})
    return None


# ---------------- photo upload ----------------

@router.post("/menu/products/{pid}/image", status_code=201)
async def upload_product_image(pid: str, payload: ProductImageIn, p: Principal = Depends(require_owner)):
    doc = await db.menu_products.find_one({"id": pid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Item tidak ditemukan")
    try:
        raw = base64.b64decode(payload.data, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=422, detail="Gambar tidak valid (base64 rusak)")
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Gambar terlalu besar — maksimal ~1MB setelah dikompresi aplikasi")
    if not raw.startswith(_MAGIC[payload.content_type]):
        raise HTTPException(status_code=422, detail="Isi file bukan gambar yang sesuai jenisnya")
    media_id = uuid.uuid4().hex
    await db.media.replace_one({"id": media_id}, {"id": media_id, "data": payload.data, "content_type": payload.content_type, "size": len(raw), "created_at": datetime.now(timezone.utc)}, upsert=True)
    old = doc.get("img_id")
    if old:
        await db.media.delete_one({"id": old})  # replaced, not accumulated
    await db.menu_products.update_one({"id": pid}, {"$set": {"img_id": media_id}})
    await audit("menu.product.image", p, detail={"product_id": pid, "bytes": len(raw)})
    return {"img_id": media_id, "url": f"/api/media/{media_id}"}


@router.delete("/menu/products/{pid}/image", status_code=204)
async def delete_product_image(pid: str, p: Principal = Depends(require_owner)):
    doc = await db.menu_products.find_one({"id": pid}, {"_id": 0, "img_id": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Item tidak ditemukan")
    if doc.get("img_id"):
        await db.media.delete_one({"id": doc["img_id"]})
    await db.menu_products.update_one({"id": pid}, {"$set": {"img_id": None}})
    await audit("menu.product.image_remove", p, detail={"product_id": pid})
    return None


@router.get("/media/{media_id}")
async def serve_media(media_id: str):
    if not re.fullmatch(r"[a-f0-9]{32}", media_id):
        raise HTTPException(status_code=400, detail="Invalid media id")
    doc = await db.media.find_one({"id": media_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Media tidak ditemukan")
    return Response(
        content=base64.b64decode(doc["data"]),
        media_type=doc["content_type"],
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


# ---------------- groups / options / categories ----------------

@router.post("/menu/groups", response_model=MenuGroupRow, status_code=201)
async def create_group(payload: MenuGroupIn, p: Principal = Depends(require_owner)):
    gid = f"cx-{_slug(payload.label)[:30]}-{uuid.uuid4().hex[:4]}"
    row = MenuGroupRow(id=gid, builtin=False, **payload.model_dump())
    await db.menu_groups.insert_one(row.model_dump())
    await audit("menu.group.create", p, detail={"group_id": gid, "label": row.label})
    return row


@router.put("/menu/groups/{gid}", response_model=MenuGroupRow)
async def update_group(gid: str, payload: MenuGroupIn, p: Principal = Depends(require_owner)):
    if not await db.menu_groups.find_one({"id": gid}, {"_id": 1}):
        raise HTTPException(status_code=404, detail="Grup tidak ditemukan")
    await db.menu_groups.update_one({"id": gid}, {"$set": payload.model_dump()})
    await audit("menu.group.update", p, detail={"group_id": gid, "label": payload.label})
    return MenuGroupRow(id=gid, builtin=False, created_at=datetime.now(timezone.utc), **payload.model_dump())


@router.delete("/menu/groups/{gid}", status_code=204)
async def delete_group(gid: str, p: Principal = Depends(require_owner)):
    if not await db.menu_groups.find_one({"id": gid}, {"_id": 1}):
        raise HTTPException(status_code=404, detail="Grup tidak ditemukan")
    option_ids = [d["id"] async for d in db.menu_options.find({"group_id": gid}, {"_id": 0, "id": 1})]
    await db.menu_groups.delete_one({"id": gid})
    await db.menu_options.delete_many({"group_id": gid})
    await db.option_overrides.delete_many({"group_id": gid})
    for oid in option_ids:
        await db.option_overrides.delete_many({"option_id": oid})
    # detach from products that list it
    await db.menu_products.update_many({}, {"$pull": {"groups": gid}})
    await db.menu_groups.update_many({}, {"$pull": {"product_ids": {"$in": [gid]}}})  # no-op normally
    await audit("menu.group.delete", p, detail={"group_id": gid, "options_removed": len(option_ids)})
    return None


@router.post("/menu/options", response_model=MenuOptionRow, status_code=201)
async def create_option(payload: MenuOptionIn, p: Principal = Depends(require_owner)):
    if not await db.menu_groups.find_one({"id": payload.group_id}, {"_id": 1}):
        raise HTTPException(status_code=422, detail=f"Grup tidak dikenal: {payload.group_id}")
    oid = f"cx-{uuid.uuid4().hex[:6]}"
    row = MenuOptionRow(id=oid, builtin=False, **payload.model_dump())
    await db.menu_options.insert_one(row.model_dump())
    await audit("menu.option.create", p, detail={"option_id": oid, "label": row.label})
    return row


@router.put("/menu/options/{oid}", response_model=MenuOptionRow)
async def update_option(oid: str, payload: MenuOptionIn, p: Principal = Depends(require_owner)):
    if not await db.menu_options.find_one({"id": oid}, {"_id": 1}):
        raise HTTPException(status_code=404, detail="Opsi tidak ditemukan")
    if payload.group_id != (await db.menu_options.find_one({"id": oid}, {"_id": 0, "group_id": 1}))["group_id"]:
        await db.option_overrides.delete_many({"option_id": oid})  # moved groups drop stale overrides
    await db.menu_options.update_one({"id": oid}, {"$set": payload.model_dump()})
    await audit("menu.option.update", p, detail={"option_id": oid, "label": payload.label})
    return MenuOptionRow(id=oid, builtin=False, created_at=datetime.now(timezone.utc), **payload.model_dump())


@router.delete("/menu/options/{oid}", status_code=204)
async def delete_option(oid: str, p: Principal = Depends(require_owner)):
    if not await db.menu_options.delete_one({"id": oid}).deleted_count:
        raise HTTPException(status_code=404, detail="Opsi tidak ditemukan")
    await db.option_overrides.delete_many({"option_id": oid})
    await audit("menu.option.delete", p, detail={"option_id": oid})
    return None


@router.post("/menu/categories", response_model=MenuCategoryRow, status_code=201)
async def create_category(payload: MenuCategoryIn, p: Principal = Depends(require_owner)):
    cid = f"cx-{_slug(payload.label)[:30]}-{uuid.uuid4().hex[:4]}"
    row = MenuCategoryRow(id=cid, builtin=False, **payload.model_dump())
    await db.menu_categories.insert_one(row.model_dump())
    await audit("menu.category.create", p, detail={"category_id": cid, "label": row.label})
    return row


@router.put("/menu/categories/{cid}", response_model=MenuCategoryRow)
async def update_category(cid: str, payload: MenuCategoryIn, p: Principal = Depends(require_owner)):
    if not await db.menu_categories.find_one({"id": cid}, {"_id": 1}):
        raise HTTPException(status_code=404, detail="Kategori tidak ditemukan")
    await db.menu_categories.update_one({"id": cid}, {"$set": payload.model_dump()})
    await audit("menu.category.update", p, detail={"category_id": cid, "label": payload.label})
    return MenuCategoryRow(id=cid, builtin=False, created_at=datetime.now(timezone.utc), **payload.model_dump())


@router.delete("/menu/categories/{cid}", status_code=204)
async def delete_category(cid: str, p: Principal = Depends(require_owner)):
    if not await db.menu_categories.find_one({"id": cid}, {"_id": 1}):
        raise HTTPException(status_code=404, detail="Kategori tidak ditemukan")
    if await db.menu_products.find_one({"category": cid}, {"_id": 1}):
        raise HTTPException(status_code=409, detail="Kategori masih dipakai item — pindahkan item dulu")
    await db.menu_categories.delete_one({"id": cid})
    await audit("menu.category.delete", p, detail={"category_id": cid})
    return None
