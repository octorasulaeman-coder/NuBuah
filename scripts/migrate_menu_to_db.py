#!/usr/bin/env python3
"""One-time migration: the menu becomes fully data-driven.

Seeds the unified collections from frontend/src/data/menu.ts (built-in items, keeping
every ID identical) and folds existing owner-created items (custom_products / custom_options /
custom_categories / custom_groups) into them. Existing renames (menu_edits) are folded into
the rows and then removed. Idempotent: re-running never overwrites owner edits.

Run AFTER deploying the new backend, BEFORE restarting it, with the POS closed:
    .venv\\Scripts\\python scripts\\migrate_menu_to_db.py          # writes
    .venv\\Scripts\\python scripts\\migrate_menu_to_db.py --dry-run # preview
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from sync_menu import parse_full_menu  # noqa: E402

DRY = "--dry-run" in sys.argv
REPAIR = "--repair" in sys.argv  # restore img paths wiped by the pre-fix update endpoint

import pymongo  # noqa: E402

client = pymongo.MongoClient("mongodb://localhost:27017")
db = client["nubuah"]  # match backend/.env DB_NAME


def upsert(coll: str, row: dict) -> str:
    """Insert only — never clobber rows the owner already edited."""
    row = dict(row)
    row.setdefault("created_at", datetime.now(timezone.utc))
    if DRY:
        return "would-insert" if not db[coll].find_one({"id": row["id"]}) else "exists"
    db[coll].update_one({"id": row["id"]}, {"$setOnInsert": row}, upsert=True)
    return "inserted" if db[coll].find_one({"id": row["id"], "created_at": row["created_at"]}) else "exists"


def main() -> None:
    full = parse_full_menu()
    counts = {"inserted": 0, "exists": 0}

    def bump(res: str) -> None:
        counts[res if res in counts else "exists"] = counts.get(res if res in counts else "exists", 0) + 1

    print("== built-in products ==")
    for row in full["products"]:
        bump(upsert("menu_products", row))
    print("== built-in groups / options / categories ==")
    for row in full["groups"]:
        bump(upsert("menu_groups", row))
    for row in full["options"]:
        bump(upsert("menu_options", row))
    for row in full["categories"]:
        bump(upsert("menu_categories", row))

    print("== owner-created items (custom_* -> unified) ==")
    for doc in db.custom_products.find({}, {"_id": 0}):
        row = {
            "id": doc["id"], "name": doc["name"], "code": doc.get("code") or "",
            "category": doc["category"], "section": doc.get("section", ""),
            "groups": doc.get("groups"), "desc": doc.get("desc", ""),
            "benefit": doc.get("benefit", ""), "emoji": doc.get("emoji"), "img": None, "img_id": None,
            "color": doc.get("color", "#F5B83D"), "sizes": doc.get("l") is not None,
            "pricing": "fixed", "r": doc["r"], "l": doc.get("l"), "builtin": False,
        }
        bump(upsert("menu_products", row))
    for doc in db.custom_options.find({}, {"_id": 0}):
        bump(upsert("menu_options", {"id": doc["id"], "group_id": doc["group_id"], "label": doc["label"],
                                     "r": doc["r"], "l": doc.get("l"), "default": False, "tier": None, "builtin": False}))
    for doc in db.custom_categories.find({}, {"_id": 0}):
        bump(upsert("menu_categories", {"id": doc["id"], "label": doc["label"], "blurb": doc.get("blurb", ""),
                                        "color": "#0d9488", "builtin": False}))
    for doc in db.custom_groups.find({}, {"_id": 0}):
        bump(upsert("menu_groups", {"id": doc["id"], "label": doc["label"], "type": doc.get("type", "multi"),
                                    "min": doc.get("min", 0), "max": doc.get("max"), "hint": doc.get("hint", ""),
                                    "product_ids": doc.get("product_ids", []), "builtin": False}))

    print("== fold renames (menu_edits) into rows ==")
    folded = 0
    for edit in db.menu_edits.find({}, {"_id": 0}):
        kind, key = edit["kind"], edit["key"]
        applied = False
        if kind == "product" and edit.get("name"):
            applied = db.menu_products.update_one({"id": key}, {"$set": {"name": edit["name"]}}).matched_count > 0
        elif kind == "option" and "/" in key and edit.get("name"):
            gid, oid = key.split("/", 1)
            applied = db.menu_options.update_one({"id": oid}, {"$set": {"label": edit["name"]}}).matched_count > 0
        elif kind == "category" and edit.get("name"):
            applied = db.menu_categories.update_one({"id": key}, {"$set": {"label": edit["name"]}}).matched_count > 0
        elif kind == "group" and edit.get("name"):
            applied = db.menu_groups.update_one({"id": key}, {"$set": {"label": edit["name"]}}).matched_count > 0
        if applied:
            folded += 1
            if not DRY:
                db.menu_edits.delete_one({"kind": kind, "key": key})

    print(f"renames folded into rows: {folded}")

    if REPAIR:
        print("== repair: restore img paths on built-in rows that lost them (edit-wipe bug) ==")
        fixed = 0
        for row in full["products"]:
            doc = db.menu_products.find_one({"id": row["id"]}, {"_id": 0, "img": 1, "img_id": 1})
            if doc and doc.get("img") is None and doc.get("img_id") is None and row.get("img"):
                if not DRY:
                    db.menu_products.update_one({"id": row["id"]}, {"$set": {"img": row["img"]}})
                fixed += 1
        print(f"img paths restored: {fixed}")
    print(f"rows written: {counts.get('inserted', 0)} new, {counts.get('exists', 0)} already present")
    print()
    print("Sanity checks:")
    print(f"  menu_products   = {db.menu_products.count_documents({})}")
    print(f"  menu_groups     = {db.menu_groups.count_documents({})}")
    print(f"  menu_options    = {db.menu_options.count_documents({})}")
    print(f"  menu_categories = {db.menu_categories.count_documents({})}")
    if DRY:
        print("\n(dry run — nothing was written)")


if __name__ == "__main__":
    main()
