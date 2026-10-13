"""Restore NuBuah data from a backup file made by the app.

Usage:  python restore_backup.py ..\backups\nubuah-backup-2026-10-11-0900.json.gz
It first saves a safety copy of the CURRENT data, then replaces the data with the backup.
"""

import gzip
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from bson import json_util
from dotenv import load_dotenv
from pymongo import MongoClient

COLLECTIONS = ["orders", "stores", "users", "menu_overrides", "option_overrides", "custom_products", "custom_options", "custom_categories", "product_codes", "custom_groups", "menu_edits", "counters", "audit", "drawer_events"]


def dump_current(db) -> str:
    data = {"app": "nubuah", "version": 1, "created_at": datetime.now(timezone.utc), "collections": {c: list(db[c].find({}, {"_id": 0})) for c in COLLECTIONS}}
    return json_util.dumps(data, json_options=json_util.CANONICAL_JSON_OPTIONS)


def restore(db, data: dict) -> dict:
    counts = {}
    for name in COLLECTIONS:
        docs = data["collections"].get(name)
        if docs is None:
            continue
        db[name].delete_many({})
        if docs:
            db[name].insert_many(docs)
        counts[name] = len(docs)
    return counts


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    path = Path(sys.argv[1])
    if not path.is_file():
        sys.exit(f"File not found: {path}")
    load_dotenv(Path(__file__).parent / ".env")
    db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        data = json_util.loads(fh.read())
    if data.get("app") != "nubuah":
        sys.exit("This is not a NuBuah backup file.")
    info = {k: len(v) for k, v in data["collections"].items()}
    print(f"Backup {path.name} contains: {info}")
    print("This REPLACES all current data (a safety copy of the current data is saved first).")
    if input("Type YES to continue: ").strip() != "YES":
        sys.exit("Cancelled. Nothing was changed.")
    safety = path.parent / f"nubuah-before-restore-{datetime.now():%Y%m%d-%H%M%S}.json.gz"
    with gzip.open(safety, "wt", encoding="utf-8") as fh:
        fh.write(dump_current(db))
    print(f"Safety copy saved: {safety}")
    print("Restored:", restore(db, data))
    print("Done. Restart the app.")


if __name__ == "__main__":
    main()
