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

sys.path.insert(0, str(Path(__file__).parent))
from lib.backup_collections import COLLECTIONS, verify_data  # noqa: E402


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
    ok, message = verify_data(data)
    print(f"Verification: {message}")
    if not ok:
        sys.exit("Restore ABORTED: backup failed verification. Nothing was changed.")
    info = {k: len(v) for k, v in data["collections"].items()}
    print(f"Backup {path.name} contains: {info}")
    print("This REPLACES all current data (a safety copy of the current data is saved first).")
    if input("Type YES to continue: ").strip() != "YES":
        sys.exit("Cancelled. Nothing was changed.")
    safety = path.parent / f"nubuah-before-restore-{datetime.now():%Y%m%d-%H%M%S}.json.gz"
    with gzip.open(safety, "wt", encoding="utf-8") as fh:
        fh.write(dump_current(db))
    print(f"Safety copy saved: {safety}")
    restored = restore(db, data)
    print("Restored:", restored)
    # post-restore sanity: every collection present in the backup reports its count back
    mismatches = {c: (restored.get(c), len(data["collections"].get(c) or [])) for c in restored
                  if restored.get(c) != len(data["collections"].get(c) or [])}
    if mismatches:
        print("WARNING: post-restore count mismatches:", mismatches)
        print("The safety copy can be restored with the same command if needed.")
    else:
        print("Post-restore verification OK: counts match the backup for every collection.")
    print("Done. Restart the app.")


if __name__ == "__main__":
    main()
