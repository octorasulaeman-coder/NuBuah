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
        IndexModel([("client_order_id", ASCENDING)], name="client_order_id", unique=True, partialFilterExpression={"client_order_id": {"$type": "string"}}),
        IndexModel([("business_date", ASCENDING), ("created_at", DESCENDING)], name="date_created"),
        IndexModel([("store_id", ASCENDING), ("business_date", ASCENDING), ("created_at", DESCENDING)], name="store_date_created"),
    ],
    "counters": [IndexModel([("key", ASCENDING)], name="key", unique=True)],
    "audit": [IndexModel([("created_at", DESCENDING)], name="created_at")],
    "drawer_events": [
        IndexModel([("store_id", ASCENDING), ("date", ASCENDING), ("created_at", ASCENDING)], name="store_date_created"),
        IndexModel([("store_id", ASCENDING), ("date", ASCENDING)], name="close_unique", unique=True, partialFilterExpression={"kind": "close"}),
    ],
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
