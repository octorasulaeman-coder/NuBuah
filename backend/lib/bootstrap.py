"""Idempotent startup bootstrap: default store, owner account, legacy data migration."""
import logging
import os
import uuid
from datetime import datetime, timezone

from lib.auth import hash_secret
from lib.db import db
from lib.scheduling import DEFAULT_SCHEDULE

logger = logging.getLogger(__name__)

DEFAULT_STORE = {
    "name": os.environ.get("DEFAULT_STORE_NAME", "NuBuah Cimahi"),
    "code": os.environ.get("DEFAULT_STORE_CODE", "NB"),
    "address_lines": [a.strip() for a in os.environ.get("DEFAULT_STORE_ADDRESS", "").split("|") if a.strip()]
    or ["Jl. Babakan No.10, RT.001/RW.003", "Cimahi, Kecamatan C, Kota Cimahi", "Jawa Barat 40525"],
    "phone": os.environ.get("DEFAULT_STORE_PHONE", "0896-5607-5653"),
}


async def bootstrap() -> None:
    try:
        store = await db.stores.find_one({}, {"_id": 0}, sort=[("created_at", 1)])
        if not store:
            store = {
                "id": str(uuid.uuid4()),
                **DEFAULT_STORE,
                "pin_hash": hash_secret(os.environ.get("DEFAULT_STORE_PIN", "1234")),
                "pin_version": 1,
                "schedule": dict(DEFAULT_SCHEDULE),  # P2 pickup-slot scheduling config
                "created_at": datetime.now(timezone.utc),
            }
            await db.stores.insert_one(dict(store))
            logger.info("bootstrap: created default store %s", store["name"])
            if not os.environ.get("DEFAULT_STORE_PIN"):
                logger.warning("bootstrap: default store PIN is 1234. Change it in Admin -> Toko.")

        email = os.environ.get("OWNER_EMAIL", "owner@nubuah.id").lower()
        if not await db.users.find_one({"role": "owner"}):
            owner_password = os.environ.get("OWNER_PASSWORD")
            await db.users.insert_one({
                "id": str(uuid.uuid4()),
                "name": "Owner NuBuah",
                "email": email,
                "password_hash": hash_secret(owner_password or "nubuah123"),
                "role": "owner",
                "store_id": None,
                "active": True,
                "must_change_password": owner_password is None,  # force a real password on first login
                "created_at": datetime.now(timezone.utc),
            })
            logger.info("bootstrap: created owner %s", email)
            if owner_password is None:
                logger.warning("bootstrap: owner password is the default 'nubuah123'; the owner must change it on first login.")

        # P2/P5 migrations (idempotent, additive — no records are rewritten destructively):
        # 1) stores created before scheduling existed get the default schedule config
        await db.stores.update_many({"schedule": {"$exists": False}}, {"$set": {"schedule": dict(DEFAULT_SCHEDULE)}})
        # 1b) stores without a loyalty config get the defaults (env-tunable values)
        from lib.loyalty import CONFIG as DEFAULT_LOYALTY
        await db.stores.update_many({"loyalty": {"$exists": False}}, {"$set": {"loyalty": dict(DEFAULT_LOYALTY.__dict__)}})
        # 2) orders saved before the status field: paid+not-voided orders were effectively
        #    finished business, so backfill them as completed; everything else starts received
        await db.orders.update_many(
            {"status": {"$exists": False}, "payment_status": "paid", "voided": {"$ne": True}},
            {"$set": {"status": "completed"}},
        )
        await db.orders.update_many({"status": {"$exists": False}}, {"$set": {"status": "received"}})

        # Legacy single-store data -> default store.
        snap = {"store_id": store["id"], "store_name": store["name"], "store_address_lines": store["address_lines"], "store_phone": store["phone"]}
        await db.orders.update_many({"store_id": {"$exists": False}}, {"$set": snap})
        for coll, old in (("menu_overrides", "product_id"), ("option_overrides", "group_option")):
            await db[coll].update_many({"store_id": {"$exists": False}}, {"$set": {"store_id": store["id"]}})
            try:
                await db[coll].drop_index(old)
            except Exception:
                pass
    except Exception as exc:  # never block boot
        logger.error("bootstrap failed: %s", exc)
