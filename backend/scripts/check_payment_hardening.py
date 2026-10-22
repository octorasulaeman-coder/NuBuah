#!/usr/bin/env python3
"""Operational check for payment hardening migrations.

Default mode is read-only: verify required indexes and detect data that would make the
new uniqueness constraints unsafe. Use ``--create-indexes`` only after reviewing the
report, and resolve duplicate key groups first if any are reported.

Exit codes:
  0 = required hardening checks passed (no missing required indexes, no unsafe duplicate
      idempotency groups)
  1 = blocking migration issue found, or the check could not complete
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from lib.db import COLLECTION_INDEXES, db, ensure_indexes  # noqa: E402
from lib.payments.migration_checks import (  # noqa: E402
    REQUIRED_INDEX_NAMES,
    duplicate_intent_key_groups,
    duplicate_refund_key_groups,
    missing_required_indexes,
)


async def index_names(collection: str) -> set[str]:
    return {doc.get("name") async for doc in db[collection].list_indexes()}


async def read_rows(collection: str, filter_doc: dict, projection: dict) -> list[dict]:
    return await db[collection].find(filter_doc, projection).to_list(200_000)


async def build_report(create_indexes: bool, stale_event_hours: int) -> dict:
    if create_indexes:
        await ensure_indexes()

    existing = {name: await index_names(name) for name in REQUIRED_INDEX_NAMES}
    missing = {
        collection: missing_required_indexes(existing[collection], collection)
        for collection in REQUIRED_INDEX_NAMES
    }

    intent_rows = await read_rows("payment_attempts", {
        "idempotency_key": {"$type": "string"},
    }, {
        "_id": 0, "id": 1, "store_id": 1, "idempotency_key": 1,
        "order_id": 1, "amount": 1, "currency": 1, "method": 1,
        "provider": 1, "request_fingerprint": 1,
    })
    refund_rows = await read_rows("refunds", {
        "idempotency_key": {"$type": "string"},
    }, {
        "_id": 0, "id": 1, "attempt_id": 1, "idempotency_key": 1,
        "amount": 1, "currency": 1, "reason": 1, "status": 1,
    })

    cutoff = datetime.now(timezone.utc) - timedelta(hours=stale_event_hours)
    stale_unprocessed_events = await db.payment_events.count_documents({
        "processed_at": {"$exists": False},
        "received_at": {"$lt": cutoff},
    })

    duplicate_intents = duplicate_intent_key_groups(intent_rows)
    duplicate_refunds = duplicate_refund_key_groups(refund_rows)

    ok = not any(missing.values()) and not duplicate_intents and not duplicate_refunds
    return {
        "ok": ok,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "create_indexes_requested": create_indexes,
        "required_indexes": {k: sorted(v) for k, v in REQUIRED_INDEX_NAMES.items()},
        "missing_required_indexes": missing,
        "duplicate_payment_intent_keys": duplicate_intents,
        "duplicate_refund_keys": duplicate_refunds,
        "stale_unprocessed_events": stale_unprocessed_events,
        "collections_checked": sorted(REQUIRED_INDEX_NAMES),
        "row_counts": {
            "payment_attempts_with_keys": len(intent_rows),
            "refunds_with_keys": len(refund_rows),
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--create-indexes", action="store_true",
                        help="Create application indexes before checking. Default is read-only.")
    parser.add_argument("--stale-event-hours", type=int, default=24,
                        help="Age threshold for warning about unprocessed payment events.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        report = asyncio.run(build_report(args.create_indexes, args.stale_event_hours))
    except Exception as exc:  # operational CLI: fail loudly with actionable JSON-ish output
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, indent=2), file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
