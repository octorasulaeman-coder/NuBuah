"""Shared Mongo handle — import `client`/`db` from here (server.py, routers, seed.py)."""

import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ASCENDING, DESCENDING, IndexModel

load_dotenv(Path(__file__).parent.parent / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

logger = logging.getLogger(__name__)

# One entry per collection: every field a route filters, sorts, or dedupes on. Applied by ensure_indexes() at startup.
INDEXES: dict[str, list[IndexModel]] = {
    "orders": [
        IndexModel([("id", ASCENDING)], name="id", unique=True),
        IndexModel([("order_no", ASCENDING)], name="order_no", unique=True),
        # Idempotency key scoped to its store: the same client_order_id may legitimately
        # be used in two stores, but never twice in one. Partial index so orders without
        # a key stay out of it. Replaces the old GLOBAL client_order_id unique index —
        # run scripts/migrate_idempotency_index.py once on existing deployments to drop it.
        IndexModel([("store_id", ASCENDING), ("client_order_id", ASCENDING)], name="store_client_order", unique=True, partialFilterExpression={"client_order_id": {"$type": "string"}}),
        IndexModel([("business_date", ASCENDING), ("created_at", DESCENDING)], name="date_created"),
        IndexModel([("store_id", ASCENDING), ("business_date", ASCENDING), ("created_at", DESCENDING)], name="store_date_created"),
        # scheduled orders (P2): queue by pickup time; status filters for the order workflow
        IndexModel([("store_id", ASCENDING), ("scheduled_for", ASCENDING)], name="store_scheduled"),
        IndexModel([("store_id", ASCENDING), ("status", ASCENDING), ("scheduled_for", ASCENDING)], name="store_status"),
    ],
    "payment_attempts": [
        # one attempt per provider obligation; one logical attempt per client retry key
        IndexModel([("provider", ASCENDING), ("provider_ref", ASCENDING)], name="pay_prov_ref", unique=True),
        IndexModel([("idempotency_key", ASCENDING)], name="pay_idem",
                   unique=True, partialFilterExpression={"idempotency_key": {"$type": "string"}}),
        IndexModel([("order_id", ASCENDING)], name="pay_order"),
        IndexModel([("store_id", ASCENDING), ("status", ASCENDING)], name="pay_store_status"),
        IndexModel([("store_id", ASCENDING), ("refund_status", ASCENDING)], name="pay_store_refund"),
    ],
    "payment_events": [
        # webhook dedupe lock: exactly one business effect per provider event id
        IndexModel([("provider", ASCENDING), ("event_id", ASCENDING)], name="payevt_dedupe", unique=True),
        IndexModel([("attempt_id", ASCENDING)], name="payevt_attempt"),
    ],
    # P5: customers / loyalty / coupons
    "customers": [
        IndexModel([("store_id", ASCENDING), ("phone", ASCENDING)], name="cust_store_phone", unique=True),
        # member numbers are unique per store; non-members stay outside this partial index
        IndexModel([("store_id", ASCENDING), ("member_no", ASCENDING)], name="cust_store_member",
                   unique=True, partialFilterExpression={"member_no": {"$type": "string"}}),
    ],
    "points_ledger": [
        # automatic movements are exactly-once per (order, reason); manual "adjust"
        # entries carry no order_id and stay outside this partial index
        IndexModel([("order_id", ASCENDING), ("reason", ASCENDING)], name="ledger_order_reason",
                   unique=True, partialFilterExpression={"order_id": {"$type": "string"}}),
        IndexModel([("customer_id", ASCENDING), ("created_at", DESCENDING)], name="ledger_customer"),
    ],
    "coupons": [
        IndexModel([("store_id", ASCENDING), ("code", ASCENDING)], name="coupon_store_code", unique=True),
    ],
    "coupon_redemptions": [
        IndexModel([("coupon_id", ASCENDING), ("order_id", ASCENDING)], name="redemption_unique", unique=True),
        IndexModel([("customer_phone", ASCENDING)], name="redemption_phone"),
    ],
    "counters": [IndexModel([("key", ASCENDING)], name="key", unique=True)],
    "audit": [IndexModel([("created_at", DESCENDING)], name="created_at")],
    "drawer_events": [
        IndexModel([("store_id", ASCENDING), ("date", ASCENDING), ("created_at", ASCENDING)], name="store_date_created"),
        IndexModel([("store_id", ASCENDING), ("date", ASCENDING)], name="close_unique", unique=True, partialFilterExpression={"kind": "close"}),
    ],
    # unified, fully-editable menu (built-in items migrated here; see scripts/migrate_menu_to_db.py)
    "menu_products": [IndexModel([("id", ASCENDING)], name="id", unique=True), IndexModel([("category", ASCENDING)], name="category")],
    "menu_groups": [IndexModel([("id", ASCENDING)], name="id", unique=True)],
    "menu_options": [IndexModel([("id", ASCENDING)], name="id", unique=True), IndexModel([("group_id", ASCENDING)], name="group_id")],
    "menu_categories": [IndexModel([("id", ASCENDING)], name="id", unique=True)],
    "media": [IndexModel([("id", ASCENDING)], name="id", unique=True)],
    "menu_overrides": [IndexModel([("store_id", ASCENDING), ("product_id", ASCENDING)], name="store_product", unique=True)],
    "option_overrides": [
        IndexModel([("store_id", ASCENDING), ("group_id", ASCENDING), ("option_id", ASCENDING)], name="store_group_option", unique=True)
    ],
    "menu_edits": [IndexModel([("kind", ASCENDING), ("key", ASCENDING)], name="kind_key", unique=True)],
    "custom_groups": [IndexModel([("id", ASCENDING)], name="id", unique=True)],
    "product_codes": [IndexModel([("product_id", ASCENDING)], name="product_id", unique=True), IndexModel([("code", ASCENDING)], name="code", unique=True)],
    "custom_categories": [IndexModel([("id", ASCENDING)], name="id", unique=True)],
    "custom_options": [IndexModel([("id", ASCENDING)], name="id", unique=True)],
    "custom_products": [IndexModel([("id", ASCENDING)], name="id", unique=True)],
    "stores": [IndexModel([("id", ASCENDING)], name="id", unique=True), IndexModel([("code", ASCENDING)], name="code", unique=True)],
    "users": [IndexModel([("id", ASCENDING)], name="id", unique=True), IndexModel([("email", ASCENDING)], name="email", unique=True)],
}


async def ensure_indexes() -> None:
    for collection, models in INDEXES.items():
        for model in models:  # one at a time so a bad spec skips only itself
            try:
                await db[collection].create_indexes([model])
            except Exception as exc:  # never block boot on an index; the log line names what to fix
                logger.error("ensure_indexes(%s.%s): %s", collection, model.document["name"], exc)
