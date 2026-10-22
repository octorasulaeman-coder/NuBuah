"""Pure helpers for payment-hardening migration checks.

These functions are intentionally database-agnostic so they can be unit-tested without
MongoDB. The script in backend/scripts/check_payment_hardening.py feeds database rows
into these helpers and reports/optionally creates the required indexes.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Iterable

REQUIRED_INDEX_NAMES: dict[str, set[str]] = {
    "payment_attempts": {
        "pay_id",
        "pay_provider_ref",
        "pay_store_idem",
        "pay_order",
        "pay_store_status",
    },
    "payment_events": {
        "payev_id",
        "payev_ref",
        "payev_order",
        "payev_store_proc",
        "payev_status_updated",
        "payev_retry_due",
        "payev_manual",
    },
    "refunds": {
        "refund_id",
        "refund_attempt_idem",
        "refund_provider_ref",
        "refund_order",
        "refund_store_status",
        "refund_status_updated",
    },
}


def missing_required_indexes(existing_index_names: Iterable[str], collection: str) -> list[str]:
    existing = set(existing_index_names)
    return sorted(REQUIRED_INDEX_NAMES[collection] - existing)


def duplicate_intent_key_groups(rows: Iterable[dict]) -> list[dict]:
    """Find payment-intent keys that cannot safely become unique per store.

    A group is unsafe when the same (store_id, idempotency_key) has more than one row
    or the rows disagree on any order/payment payload field. Those rows must be resolved
    before creating/depending on ``pay_store_idem``.
    """
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in rows:
        key = row.get("idempotency_key")
        store_id = row.get("store_id")
        if key and store_id:
            groups[(store_id, str(key))].append(row)

    unsafe = []
    for (store_id, key), items in groups.items():
        signatures = {
            (
                item.get("order_id"),
                int(item.get("amount") or 0),
                item.get("currency"),
                item.get("method"),
                item.get("provider"),
                item.get("request_fingerprint"),
            )
            for item in items
        }
        if len(items) > 1 or len(signatures) > 1:
            unsafe.append({
                "store_id": store_id,
                "idempotency_key": key,
                "rows": len(items),
                "distinct_payloads": len(signatures),
                "attempt_ids": [item.get("id") for item in items[:10]],
            })
    return sorted(unsafe, key=lambda g: (g["store_id"], g["idempotency_key"]))


def duplicate_refund_key_groups(rows: Iterable[dict]) -> list[dict]:
    """Find refund idempotency keys that cannot safely be unique per attempt."""
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in rows:
        key = row.get("idempotency_key")
        attempt_id = row.get("attempt_id")
        if key and attempt_id:
            groups[(attempt_id, str(key))].append(row)

    unsafe = []
    for (attempt_id, key), items in groups.items():
        signatures = {
            (
                int(item.get("amount") or 0),
                item.get("currency"),
                item.get("reason"),
                item.get("status"),
            )
            for item in items
        }
        if len(items) > 1 or len(signatures) > 1:
            unsafe.append({
                "attempt_id": attempt_id,
                "idempotency_key": key,
                "rows": len(items),
                "distinct_payloads": len(signatures),
                "refund_ids": [item.get("id") for item in items[:10]],
            })
    return sorted(unsafe, key=lambda g: (g["attempt_id"], g["idempotency_key"]))
