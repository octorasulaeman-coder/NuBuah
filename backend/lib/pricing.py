"""Server-side order line verification: recompute the unit price from the authoritative
menu (unified menu_* collections + per-store overrides) instead of trusting the client.

The money math lives in lib/pricemath.compute_line (pure, unit-tested); this module
only fetches data and translates PriceError into HTTP exceptions. Mirrors the frontend
checkout math exactly — any mismatch is rejected, so a tampered client cannot sell at
arbitrary prices.
"""

from typing import Optional

from fastapi import HTTPException

from lib.db import db
from lib.pricemath import PriceError, build_options_index, compute_line

# Option groups a product gets when its `groups` is None (mirrors the old category defaults).
_FALLBACK_GROUPS = {
    "smoothie": ["sweet", "ice", "drink_extra"],
    "jus": ["sweet", "ice", "drink_extra"],
    "bowl": ["bowl_topping", "bowl_extra"],
    "sopsalad": ["kuah"],
    "snack": [],
}


async def _store_overrides(store_id: str) -> tuple[dict, dict]:
    menu_ov = {d["product_id"]: d async for d in db.menu_overrides.find({"store_id": store_id}, {"_id": 0})}
    opt_ov = {(d["group_id"], d["option_id"]): d async for d in db.option_overrides.find({"store_id": store_id}, {"_id": 0})}
    return menu_ov, opt_ov


async def verify_line(store_id: str, line, reject_hidden: bool = False) -> int:
    """Recompute the expected unit price for one order line; raise 4xx on any mismatch.
    reject_hidden: the customer channel must not order menu-hidden items."""
    pid = line.product_id

    product = await db.menu_products.find_one({"id": pid}, {"_id": 0})
    if not product:
        raise HTTPException(status_code=422, detail=f"Menu tidak dikenal: {pid}")

    groups = product.get("groups")
    if groups is None:
        groups = _FALLBACK_GROUPS.get(product.get("category"), [])
    groups = list(groups)

    # topping groups that attach by product_ids (owner-created groups offer themselves on listed items)
    async for g in db.menu_groups.find({"product_ids": pid}, {"_id": 0, "id": 1}):
        if g["id"] not in groups:
            groups.append(g["id"])

    menu_ov, opt_ov = await _store_overrides(store_id)
    group_rows = [g async for g in db.menu_groups.find({"id": {"$in": groups}}, {"_id": 0})]
    option_rows = [o async for o in db.menu_options.find({"group_id": {"$in": groups}}, {"_id": 0})]
    index = build_options_index(group_rows, option_rows, opt_ov)

    try:
        return compute_line(product, menu_ov.get(pid), index, line, reject_hidden=reject_hidden)
    except PriceError as e:
        raise HTTPException(status_code=e.status, detail=e.detail) from e
