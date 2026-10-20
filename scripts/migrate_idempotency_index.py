"""One-time migration: replace the GLOBAL unique `client_order_id` index on orders with a
compound UNIQUE (store_id, client_order_id) index so idempotency keys are scoped per store.

Safety argument: the old global-unique index already guaranteed that no two orders share a
client_order_id, which is stronger than (store_id, client_order_id) uniqueness. Therefore
the compound index can NEVER conflict with existing data — no order is modified, renamed,
or deleted. We still audit for duplicates first and refuse to proceed if any exist, so a
corrupted database can never be made worse silently.

Idempotent: safe to re-run (drops/creates are no-ops when already in the desired state).

Run from the backend folder (needs backend/.env with MONGO_URL / DB_NAME):
    python ../scripts/migrate_idempotency_index.py
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from pymongo import ASCENDING  # noqa: E402
from pymongo.errors import OperationFailure  # noqa: E402

from lib.db import client, db  # noqa: E402

OLD_INDEX = "client_order_id"
NEW_INDEX = "store_client_order"


async def audit_duplicates() -> int:
    """Count (store_id, client_order_id) pairs held by more than one order. Must be 0."""
    pipeline = [
        {"$match": {"client_order_id": {"$type": "string"}}},
        {"$group": {"_id": {"store_id": "$store_id", "client_order_id": "$client_order_id"}, "n": {"$sum": 1}}},
        {"$match": {"n": {"$gt": 1}}},
    ]
    dupes = await db.orders.aggregate(pipeline).to_list(100)
    for d in dupes:
        print(f"  CONFLICT: {d['_id']} appears {d['n']} times")
    return len(dupes)


async def main() -> int:
    info = await db.orders.index_information()
    has_old = OLD_INDEX in info
    has_new = NEW_INDEX in info
    print(f"current indexes: old={has_old} new={has_new}")

    if not has_new:
        conflicts = await audit_duplicates()
        if conflicts:
            print(f"ABORT: {conflicts} duplicate (store, key) pairs found; resolve manually before migrating.")
            return 1
        print("no duplicate (store, key) pairs — creating compound unique index ...")
        await db.orders.create_index(
            [("store_id", ASCENDING), ("client_order_id", ASCENDING)],
            name=NEW_INDEX,
            unique=True,
            partialFilterExpression={"client_order_id": {"$type": "string"}},
        )
        print(f"created {NEW_INDEX}")

    if has_old or OLD_INDEX in await db.orders.index_information():
        print(f"dropping old global index {OLD_INDEX} ...")
        try:
            await db.orders.drop_index(OLD_INDEX)
            print(f"dropped {OLD_INDEX}")
        except OperationFailure as exc:
            print(f"could not drop {OLD_INDEX}: {exc}")
            return 1

    print("done. verify with: db.orders.getIndexes()")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    finally:
        client.close()
