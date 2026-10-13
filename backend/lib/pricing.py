"""Server-side order line verification: recompute the unit price from the authoritative
menu (built-in catalog + custom items + per-store overrides) instead of trusting the client.

Mirrors frontend/src/lib/pricing.ts exactly. Any mismatch or unknown item/option is
rejected, so a tampered client cannot sell at arbitrary prices.
"""

import re
from typing import Optional

from fastapi import HTTPException

from lib.db import db
from lib.price_catalog import CATEGORY_DEFAULT_GROUPS, GROUPS, OPTION_LABELS, PRODUCTS


async def _store_overrides(store_id: str) -> tuple[dict, dict, dict]:
    """menu overrides, option overrides, and owner renames of built-in option labels."""
    menu_ov = {d["product_id"]: d async for d in db.menu_overrides.find({"store_id": store_id}, {"_id": 0})}
    opt_ov = {(d["group_id"], d["option_id"]): d async for d in db.option_overrides.find({"store_id": store_id}, {"_id": 0})}
    renames = {d["key"]: d["name"] async for d in db.menu_edits.find({"kind": "option", "name": {"$ne": None}}, {"_id": 0, "key": 1, "name": 1})}
    return menu_ov, opt_ov, renames


async def _resolve_product(product_id: str):
    """(base_r, base_l, sizes, pricing, groups) or None if the item is unknown."""
    if product_id in PRODUCTS:
        return PRODUCTS[product_id]
    doc = await db.custom_products.find_one({"id": product_id}, {"_id": 0, "r": 1, "l": 1, "category": 1, "groups": 1})
    if not doc:
        return None
    groups = doc.get("groups")
    if groups is None:
        groups = CATEGORY_DEFAULT_GROUPS.get(doc.get("category"), [])
    return (doc["r"], doc.get("l"), doc.get("l") is not None, "fixed", list(groups))


def _override_price(base: int, doc: Optional[dict]) -> int:
    """An override with a null price keeps the base price (that is how the frontend reads it)."""
    if not doc:
        return base
    return base if doc.get("r") is None else doc["r"]


def _override_price_sized(base_r: int, base_l: Optional[int], size: Optional[str], doc: Optional[dict]) -> int:
    """Pick r/l (size-aware), then apply the store override for that size slot."""
    if doc:
        if size == "L":
            v = doc.get("l")
            if v is not None:
                return v
        else:
            v = doc.get("r")
            if v is not None:
                return v
    return base_l if (size == "L" and base_l is not None) else base_r


_XN_RE = re.compile(r"^(?P<label>.+?) x(?P<n>[23])$")


async def verify_line(store_id: str, line) -> int:
    """Recompute the expected unit price for one order line; raise 4xx on any mismatch."""
    pid = line.product_id
    product = await _resolve_product(pid)
    if not product:
        raise HTTPException(status_code=422, detail=f"Menu tidak dikenal: {pid}")
    base_r, base_l, sizes, pricing, groups = product
    groups = list(groups)  # copy: never mutate the shared catalog list
    size = line.size if sizes else None

    menu_ov, opt_ov, renames = await _store_overrides(store_id)
    # Owner-created topping groups attach to whichever items list them (Kelola Menu ->
    # Grup topping). Their options live in custom_options with group_id = the group's id.
    async for g in db.custom_groups.find({"product_ids": pid}, {"_id": 0, "id": 1}):
        if g["id"] not in groups:
            groups.append(g["id"])
    if menu_ov.get(pid, {}).get("sold_out"):
        raise HTTPException(status_code=409, detail=f"\"{line.name}\" sedang habis")

    # --- base price ---
    if pricing == "potong":
        n_fruits = sum(1 for o in line.options if o.label.split(" x")[0] in _labels("potong_fruit"))
        base = base_l if (n_fruits > 4 and base_l is not None) else base_r
        base = _override_price(base, menu_ov.get(pid))
    else:
        base = _override_price_sized(base_r, base_l, size, menu_ov.get(pid))

    # --- options ---
    custom_opts = [d async for d in db.custom_options.find({}, {"_id": 0})]
    by_label: dict[tuple[str, str], dict] = {}  # (group_id, label) -> option source doc or builtin id
    for gid in groups:
        builtin = GROUPS.get(gid)
        if builtin:
            for oid, (r, l) in builtin.items():
                label = renames.get(f"{gid}/{oid}")
                by_label[(gid, _opt_label(gid, oid))] = {"kind": "builtin", "group": gid, "id": oid, "r": r, "l": l}
                if label:
                    by_label[(gid, label)] = by_label[(gid, _opt_label(gid, oid))]
    for d in custom_opts:
        if d["group_id"] in groups:
            by_label[(d["group_id"], d["label"])] = {"kind": "custom", "group": d["group_id"], "id": d["id"], "r": d["r"], "l": d.get("l")}

    total = base
    for picked in line.options:
        # find the option across the product's groups (custom fruit may carry an " xN" suffix)
        found = next((by_label[(gid, picked.label)] for gid in groups if (gid, picked.label) in by_label), None)
        mult = 1
        label = picked.label
        if not found and pricing == "custom":
            m = _XN_RE.match(picked.label)
            if m:
                for gid in groups:
                    cand = by_label.get((gid, m.group("label")))
                    if cand:
                        found, label, mult = cand, m.group("label"), int(m.group("n"))
                        break
        if not found:
            raise HTTPException(status_code=422, detail=f"Opsi tidak dikenal: {picked.label}")

        expected = _override_price_sized(found["r"], found["l"], size, opt_ov.get((found["group"], found["id"])))
        if found["group"] == "custom_fruit":
            expected = found["r"] * mult  # size-independent; the xN suffix carries the multiplier
        ov = opt_ov.get((found["group"], found["id"]))
        if ov and ov.get("sold_out"):
            raise HTTPException(status_code=409, detail=f"Opsi \"{label}\" sedang habis")
        total += expected
        if expected != picked.price:
            raise HTTPException(status_code=409, detail="Harga telah berubah, muat ulang menu lalu coba lagi")

    expected_unit = max(0, total)
    if expected_unit != line.unit_price:
        raise HTTPException(status_code=409, detail="Harga tidak sesuai, muat ulang menu lalu coba lagi")
    return expected_unit


def _opt_label(gid: str, oid: str) -> str:
    """Built-in option label as shown in the POS — GENERATED per (group, option) from menu.ts,
    because the same option id can have different labels in different groups (e.g. "madu" is
    "Ganti gula jadi madu" for drinks but "Ganti gula dengan madu" for bowls)."""
    label = OPTION_LABELS.get(gid, {}).get(oid)
    if label:
        return label
    # free-pick options (fruits): the menu slug reverses to the display label
    # ("bp-buah-naga" -> "Buah Naga", "cf-apel-hijau" -> "Apel Hijau")
    for prefix in ("cf-", "bp-", "eko-"):
        if oid.startswith(prefix):
            return " ".join(w.capitalize() for w in oid[len(prefix):].split("-"))
    return oid


def _labels(group_id: str) -> set[str]:
    """All labels that identify options of a free-pick group (fruits are matched by name)."""
    out = set()
    for oid in GROUPS.get(group_id, {}):
        out.add(oid)
        out.add(_opt_label(group_id, oid))
    return out
