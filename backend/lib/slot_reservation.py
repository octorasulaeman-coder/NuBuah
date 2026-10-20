"""Atomic per-slot capacity counters, built on the existing `counters` collection.

One counter per (store, slot): key "slot:<store_id>:<slot_start_utc iso>". Reservation
increments first and rolls back when the cap is exceeded, so concurrent requests can
never oversell a slot and a failed order never leaks a reservation for long.

Rerun safety: reservations are only made after the idempotency check, and the order
routers release on cancellation/reschedule/duplicate-race — see routers/orders.py.
"""

from datetime import datetime
from typing import Optional

from pymongo import ReturnDocument

from lib.db import db


def slot_key(store_id: str, slot_start_utc: datetime) -> str:
    return f"slot:{store_id}:{slot_start_utc.isoformat()}"


async def reserve_slot(store_id: str, slot_start_utc: datetime, capacity: int) -> bool:
    """Take one seat. Returns False when the slot is full (counter left unchanged)."""
    if capacity <= 0:  # unlimited
        return True
    key = slot_key(store_id, slot_start_utc)
    doc = await db.counters.find_one_and_update(
        {"key": key}, {"$inc": {"seq": 1}}, upsert=True, return_document=ReturnDocument.AFTER
    )
    if doc["seq"] > capacity:
        await db.counters.update_one({"key": key, "seq": {"$gt": 0}}, {"$inc": {"seq": -1}})
        return False
    return True


async def release_slot(store_id: str, slot_start_utc: Optional[datetime]) -> None:
    if not slot_start_utc:
        return
    await db.counters.update_one(
        {"key": slot_key(store_id, slot_start_utc), "seq": {"$gt": 0}}, {"$inc": {"seq": -1}}
    )


async def slot_counts(store_id: str, day_start_utc: datetime, day_end_utc: datetime) -> dict[str, int]:
    """{slot_start_iso_utc: reserved count} for a UTC time range (one local day)."""
    prefix = f"slot:{store_id}:"
    docs = await db.counters.find(
        {"key": {"$gte": prefix + day_start_utc.isoformat(), "$lt": prefix + day_end_utc.isoformat()}}
    ).to_list(1000)
    return {d["key"][len(prefix):]: d.get("seq", 0) for d in docs}
