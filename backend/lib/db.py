"""MongoDB access (P3 + refund ledger).

The connection is created once at import time from MONGO_URL / DB_NAME. ``DB_NAME`` is
the canonical application database setting; ``MONGO_DB_NAME`` is accepted as a legacy
alias. All indexes the application relies on are declared in COLLECTION_INDEXES and
created by ensure_indexes() at startup. The refund ledger has unique constraints that
make refund retries and partial-refund accounting safe under concurrency; production
deploys should run scripts/migrate_payment_hardening.py to confirm these indexes exist
before serving traffic.
"""

import os

from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ASCENDING, IndexModel

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017/nubuah")
DB_NAME = os.environ.get("DB_NAME") or os.environ.get("MONGO_DB_NAME") or "nubuah"

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]


def _idem_indexes():
    """Indexes that make payment retries and refund accounting concurrency-safe."""
    return [
        # id is the primary key the API exposes
        IndexModel([("id", ASCENDING)], name="pay_id", unique=True),
        # provider callback/poll key
        IndexModel([("provider_ref", ASCENDING)], name="pay_provider_ref", unique=True),
        # client retry key — unique per store, then validated against the full logical
        # payload (order/amount/currency/provider/method). The provider is part of the
        # fingerprint, not the uniqueness scope: reusing a key for another provider in
        # the same store is a conflict, never a second payment obligation.
        IndexModel([("store_id", ASCENDING), ("idempotency_key", ASCENDING)],
                   name="pay_store_idem", unique=True,
                   partialFilterExpression={"idempotency_key": {"$type": "string"}}),
        # legacy stricter scope retained for deployments that already built it; harmless
        # because it is narrower than pay_store_idem
        IndexModel([("store_id", ASCENDING), ("provider", ASCENDING), ("idempotency_key", ASCENDING)],
                   name="pay_store_provider_idem", unique=True,
                   partialFilterExpression={"idempotency_key": {"$type": "string"}}),
        # permissive single-field index for the pre-P3 query shape; kept for migration
        IndexModel([("idempotency_key", ASCENDING)], name="pay_idem",
                   partialFilterExpression={"idempotency_key": {"$type": "string"}}),
        IndexModel([("order_id", ASCENDING)], name="pay_order"),
        IndexModel([("store_id", ASCENDING), ("status", ASCENDING)], name="pay_store_status"),
    ]


COLLECTION_INDEXES: dict[str, list[IndexModel]] = {
    "stores": [
        IndexModel([("id", ASCENDING)], name="store_id", unique=True),
        IndexModel([("slug", ASCENDING)], name="store_slug", unique=True),
    ],
    "users": [
        IndexModel([("id", ASCENDING)], name="user_id", unique=True),
        IndexModel([("username", ASCENDING)], name="user_username", unique=True),
        IndexModel([("role", ASCENDING), ("store_id", ASCENDING)], name="user_role_store"),
    ],
    "products": [
        IndexModel([("id", ASCENDING)], name="prod_id", unique=True),
        IndexModel([("store_id", ASCENDING), ("category", ASCENDING)], name="prod_store_cat"),
    ],
    "orders": [
        IndexModel([("id", ASCENDING)], name="order_id", unique=True),
        IndexModel([("order_no", ASCENDING)], name="order_no", unique=True),
        IndexModel([("store_id", ASCENDING), ("created_at", ASCENDING)], name="order_store_created"),
        IndexModel([("store_id", ASCENDING), ("status", ASCENDING)], name="order_store_status"),
        IndexModel([("customer_phone", ASCENDING)], name="order_phone"),
        IndexModel([("scheduled_for", ASCENDING)], name="order_sched_for",
                   partialFilterExpression={"scheduled_for": {"$type": "date"}}),
        IndexModel([("payment_status", ASCENDING), ("expires_at", ASCENDING)], name="order_pay_exp"),
    ],
    "payment_attempts": _idem_indexes(),
    "payment_events": [
        # unique per notification id — duplicates become cheap no-ops
        IndexModel([("event_id", ASCENDING)], name="payev_id", unique=True,
                   partialFilterExpression={"event_id": {"$type": "string"}}),
        IndexModel([("provider_ref", ASCENDING)], name="payev_ref"),
        IndexModel([("order_id", ASCENDING)], name="payev_order"),
        IndexModel([("store_id", ASCENDING), ("processed_at", ASCENDING)], name="payev_store_proc"),
        IndexModel([("status", ASCENDING), ("updated_at", ASCENDING)], name="payev_status_updated"),
        IndexModel([("status", ASCENDING), ("next_retry_at", ASCENDING)], name="payev_retry_due",
                   partialFilterExpression={"retryable": True}),
        IndexModel([("manual_reconciliation_required", ASCENDING)], name="payev_manual",
                   partialFilterExpression={"manual_reconciliation_required": True}),
    ],
    # durable refund ledger — partial history, idempotency, and reconciliation anchors
    "refunds": [
        IndexModel([("id", ASCENDING)], name="refund_id", unique=True),
        # one logical refund per attempt+client key; retries with a different amount or
        # reason are rejected by the service instead of silently reusing the record
        IndexModel([("attempt_id", ASCENDING), ("idempotency_key", ASCENDING)],
                   name="refund_attempt_idem", unique=True,
                   partialFilterExpression={"idempotency_key": {"$type": "string"}}),
        IndexModel([("provider_ref", ASCENDING), ("refund_ref", ASCENDING)],
                   name="refund_provider_ref", unique=True,
                   partialFilterExpression={"refund_ref": {"$type": "string"}}),
        IndexModel([("order_id", ASCENDING)], name="refund_order"),
        IndexModel([("store_id", ASCENDING), ("status", ASCENDING)], name="refund_store_status"),
        IndexModel([("status", ASCENDING), ("updated_at", ASCENDING)], name="refund_status_updated"),
    ],
    "coupons": [
        IndexModel([("id", ASCENDING)], name="coupon_id", unique=True),
        IndexModel([("code", ASCENDING)], name="coupon_code", unique=True),
    ],
    "coupon_redemptions": [
        IndexModel([("id", ASCENDING)], name="redeem_id", unique=True),
        # one redemption per coupon+order — concurrent checkouts cannot double-redeem
        IndexModel([("coupon_id", ASCENDING), ("order_id", ASCENDING)], name="redeem_coupon_order", unique=True),
        IndexModel([("customer_phone", ASCENDING)], name="redeem_phone"),
        IndexModel([("store_id", ASCENDING), ("redeemed_at", ASCENDING)], name="redeem_store_time"),
    ],
    "points_ledger": [
        IndexModel([("id", ASCENDING)], name="points_id", unique=True),
        # one earn and one reversal per order — retries cannot award twice
        IndexModel([("order_id", ASCENDING), ("entry_type", ASCENDING)], name="points_order_entry", unique=True),
        IndexModel([("customer_phone", ASCENDING), ("created_at", ASCENDING)], name="points_phone_time"),
    ],
    "closing_reports": [
        IndexModel([("id", ASCENDING)], name="closing_id", unique=True),
        IndexModel([("store_id", ASCENDING), ("closed_at", ASCENDING)], name="closing_store_time"),
    ],
    "analytics_events": [
        IndexModel([("id", ASCENDING)], name="analytic_id", unique=True),
        IndexModel([("store_id", ASCENDING), ("ts", ASCENDING)], name="analytic_store_time"),
    ],
}


async def ensure_indexes() -> None:
    """Create all application indexes. Failure of a payment-critical index is logged at
    ERROR level (visible in server logs) rather than silently skipped."""
    for collection, indexes in COLLECTION_INDEXES.items():
        try:
            await db[collection].create_indexes(indexes)
        except Exception as exc:  # startup logging — server.py logs a warning
            critical = collection in {"payment_attempts", "payment_events", "refunds"}
            import logging
            log = logging.getLogger("nubuah.db")
            (log.error if critical else log.warning)("index creation failed for %s: %s", collection, exc)
