"""Store settings: scheduling config (staff read, owner write)."""

import os
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query

from lib.audit import audit
from lib.auth import Principal, get_principal, resolve_store
from lib.db import db
from lib.scheduling import build_day_slots, local_day_range, normalize_schedule, upcoming_days
from lib.slot_reservation import slot_counts
from models.schedule import ScheduleConfig, ScheduleInfo, SlotsDay

router = APIRouter()

STORE_TZ = os.environ.get("STORE_TZ", "Asia/Jakarta")


@router.get("/store/schedule", response_model=ScheduleInfo)
async def get_store_schedule(store_id: str = Query(None), p: Principal = Depends(get_principal)):
    sid = await resolve_store(p, store_id)
    store = await db.stores.find_one({"id": sid}, {"_id": 0, "schedule": 1})
    if not store:
        raise HTTPException(status_code=404, detail="Store not found")
    cfg = normalize_schedule(store.get("schedule"))
    return ScheduleInfo(
        enabled=cfg.get("enabled", True),
        slot_minutes=cfg.get("slot_minutes"),
        lead_time_minutes=cfg.get("lead_time_minutes"),
        max_days_ahead=cfg.get("max_days_ahead"),
        capacity_per_slot=cfg.get("capacity_per_slot"),
        timezone=STORE_TZ,
        days=upcoming_days(cfg, ZoneInfo(STORE_TZ), datetime.now(timezone.utc)),
        hours=cfg.get("hours") or {},
        holidays=cfg.get("holidays") or [],
    )


@router.get("/store/slots", response_model=SlotsDay)
async def get_store_slots(date_: str = Query(alias="date", min_length=10, max_length=10), store_id: str = Query(None), p: Principal = Depends(get_principal)):
    """Same slot listing as the public endpoint, for the POS schedule picker."""
    try:
        day = date.fromisoformat(date_)
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    sid = await resolve_store(p, store_id)
    store = await db.stores.find_one({"id": sid}, {"_id": 0, "schedule": 1})
    if not store:
        raise HTTPException(status_code=404, detail="Store not found")
    cfg = normalize_schedule(store.get("schedule"))
    tz = ZoneInfo(STORE_TZ)
    start_utc, end_utc = local_day_range(day, tz)
    taken = await slot_counts(sid, start_utc, end_utc)
    return SlotsDay(**build_day_slots(cfg, day, tz, datetime.now(timezone.utc), taken))


@router.put("/store/schedule", response_model=ScheduleInfo)
async def update_store_schedule(payload: ScheduleConfig, store_id: str = Query(None), p: Principal = Depends(get_principal)):
    """Owner only. The Pydantic model validates hours/holiday shapes before anything is saved."""
    if not p.is_owner:
        raise HTTPException(status_code=403, detail="Owner only")
    sid = await resolve_store(p, store_id)
    res = await db.stores.update_one({"id": sid}, {"$set": {"schedule": payload.model_dump()}})
    if not res.matched_count:
        raise HTTPException(status_code=404, detail="Store not found")
    await audit("store.schedule", p, store_id=sid, detail=payload.model_dump())
    return await get_store_schedule(sid, p)
