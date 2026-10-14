import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from lib.audit import audit
from lib.auth import Principal, get_principal, resolve_store
from lib.dates import today_iso
from lib.db import db
from models.drawer import DrawerCloseIn, DrawerEvent, DrawerEventIn, DrawerSummary

router = APIRouter()

STORE_TZ = os.environ.get("STORE_TZ", "Asia/Jakarta")


@router.post("/drawer/events", response_model=DrawerEvent, status_code=201)
async def add_drawer_event(payload: DrawerEventIn, p: Principal = Depends(get_principal)):
    store_id = await resolve_store(p, payload.store_id)
    doc = DrawerEvent(
        kind=payload.kind,
        amount=payload.amount,
        note=payload.note.strip() if payload.note else None,
        store_id=store_id,
        date=today_iso(STORE_TZ),
        actor=p.name,
    )
    await db.drawer_events.insert_one(doc.model_dump())
    await audit(f"drawer.{payload.kind}", p, store_id=store_id, detail={"amount": payload.amount, "note": doc.note})
    return doc


@router.get("/drawer/summary", response_model=DrawerSummary)
async def drawer_summary(
    date: Optional[str] = Query(default=None),
    store_id: Optional[str] = Query(default=None),
    p: Principal = Depends(get_principal),
):
    sid = await resolve_store(p, store_id)
    d = date or today_iso(STORE_TZ)
    events = [DrawerEvent(**doc) async for doc in db.drawer_events.find({"store_id": sid, "date": d}, {"_id": 0}).sort("created_at", 1)]
    opening = sum(e.amount for e in events if e.kind == "open")
    cash_out = sum(e.amount for e in events if e.kind == "cash_out")
    expense = sum(e.amount for e in events if e.kind == "expense")
    cash_sales = 0
    async for o in db.orders.find({"store_id": sid, "business_date": d, "payment_method": "cash", "voided": {"$ne": True}, "payment_status": {"$ne": "pending"}}, {"total": 1}):
        cash_sales += o.get("total", 0)
    closing = next((e for e in events if e.kind == "close"), None)
    return DrawerSummary(date=d, store_id=sid, opening=opening, cash_sales=cash_sales, cash_out=cash_out, expense=expense, expected_cash=opening + cash_sales - cash_out - expense, closing=closing, events=events)


@router.post("/drawer/close", response_model=DrawerEvent, status_code=201)
async def close_drawer(payload: DrawerCloseIn, p: Principal = Depends(get_principal)):
    sid = await resolve_store(p, payload.store_id)
    summary = await drawer_summary(date=payload.date, store_id=sid, p=p)
    doc = DrawerEvent(
        kind="close",
        amount=payload.counted,
        variance=payload.counted - summary.expected_cash,
        note=f"expected {summary.expected_cash}",
        store_id=sid,
        date=payload.date,
        actor=p.name,
    )
    # one close per store per day; recounting replaces the previous close
    await db.drawer_events.replace_one({"store_id": sid, "date": payload.date, "kind": "close"}, doc.model_dump(), upsert=True)
    await audit("drawer.close", p, store_id=sid, detail={"counted": payload.counted, "expected": summary.expected_cash, "variance": doc.variance})
    return doc
