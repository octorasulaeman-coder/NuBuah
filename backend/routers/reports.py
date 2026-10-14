import csv
import io
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from lib.auth import Principal, get_principal, resolve_store
from lib.db import db
from models.report import ClosingReport, MethodTotal, StoreTotal, TopItem
from routers.orders import STORE_TZ, date_range, find_orders

router = APIRouter()


@router.get("/reports/closing", response_model=ClosingReport)
async def closing_report(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    store_id: Optional[str] = Query(None),
    p: Principal = Depends(get_principal),
):
    return await build_closing(p, start, end, store_id)


async def build_closing(p: Principal, start: Optional[str], end: Optional[str], store_id: Optional[str], top_n: Optional[int] = 10) -> ClosingReport:
    start_d, end_d = date_range(start, end)
    sid = await resolve_store(p, store_id, allow_all=True)
    all_docs = await find_orders(sid, start_d, end_d, sort=1)
    # voided orders and unpaid customer (phone) orders never count toward totals
    docs = [d for d in all_docs if not d.get("voided") and d.get("payment_status") != "pending"]
    voided = [d for d in all_docs if d.get("voided")]

    methods = {m: {"count": 0, "total": 0} for m in ("cash", "qris", "card")}
    items: dict[str, dict[str, int]] = defaultdict(lambda: {"qty": 0, "revenue": 0})
    cash_in = 0
    for d in docs:
        m = methods[d["payment_method"]]
        m["count"] += 1
        m["total"] += d["total"]
        if d["payment_method"] == "cash":
            cash_in += d["total"]
        for ln in d["lines"]:
            key = f"{ln.get('code') + ' ' if ln.get('code') else ''}{ln['name']}"
            if ln.get("size"):
                key += f" ({ln['size']})"
            items[key]["qty"] += ln["qty"]
            items[key]["revenue"] += ln["line_total"]

    by_store: dict[str, dict[str, int]] = {}
    if sid is None:
        for d in docs:
            b = by_store.setdefault(d.get("store_name") or "?", {"count": 0, "revenue": 0, "discount_total": 0})
            b["count"] += 1
            b["revenue"] += d["total"]
            b["discount_total"] += d.get("discount_amount", 0)

    revenue = sum(d["total"] for d in docs)
    count = len(docs)
    top = sorted(items.items(), key=lambda kv: (-kv[1]["qty"], -kv[1]["revenue"]))[:top_n]
    return ClosingReport(
        store_name=(await db.stores.find_one({"id": sid}, {"_id": 0, "name": 1}) or {}).get("name") if sid else "Semua toko",
        start=start_d,
        end=end_d,
        generated_at=datetime.now(timezone.utc),
        count=count,
        revenue=revenue,
        items=sum(d["item_count"] for d in docs),
        average=round(revenue / count) if count else 0,
        first_order_no=docs[0]["order_no"] if docs else None,
        last_order_no=docs[-1]["order_no"] if docs else None,
        methods=[MethodTotal(method=k, **v) for k, v in methods.items()],
        cash_in_drawer=cash_in,
        top_items=[TopItem(name=k, **v) for k, v in top],
        voided_count=len(voided),
        voided_total=sum(d["total"] for d in voided),
        gross=revenue + sum(d.get("discount_amount", 0) for d in docs),
        discount_total=sum(d.get("discount_amount", 0) for d in docs),
        by_store=[StoreTotal(store_name=k, **v) for k, v in sorted(by_store.items())],
    )


def _safe(v: object) -> object:
    """Stop spreadsheet formula injection: text starting with = + - @ is shown as plain text."""
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v
    return v


def _discount_label(d: dict) -> str:
    if not d.get("discount_amount"):
        return ""
    kind = f"{d.get('discount_value', 0)}%" if d.get("discount_type") == "percent" else "Rp"
    return f"{kind} {d.get('discount_note') or ''}".strip()


@router.get("/reports/export.csv")
async def export_csv(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    store_id: Optional[str] = Query(None),
    p: Principal = Depends(get_principal),
):
    """Owner only. One row per sold item for the date range; opens directly in Excel."""
    if not p.is_owner:
        raise HTTPException(status_code=403, detail="Owner only")
    start_d, end_d = date_range(start, end)
    sid = await resolve_store(p, store_id, allow_all=True)
    docs = await find_orders(sid, start_d, end_d, sort=1)
    tz = ZoneInfo(STORE_TZ)

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([
        "No. Pesanan", "Tanggal", "Jam", "Toko", "Kasir", "Pelanggan", "Telepon", "Pembayaran", "Status", "Alasan Void",
        "Kode", "Item", "Ukuran", "Opsi", "Catatan", "Qty", "Harga Satuan", "Subtotal Item", "Subtotal Pesanan", "Diskon", "Ket. Diskon", "Total Pesanan", "Total Dihitung",
    ])
    for d in docs:
        created = d["created_at"]
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        jam = created.astimezone(tz).strftime("%H:%M")
        status = "VOID" if d.get("voided") else ("BELUM BAYAR" if d.get("payment_status") == "pending" else "SELESAI")
        for i, ln in enumerate(d["lines"]):
            opts = "; ".join(f"{o['label']}" + (f" ({o['price']:+d})" if o.get("price") else "") for o in ln.get("options", []))
            row = [
                d["order_no"], d["business_date"], jam, d.get("store_name", ""), d.get("cashier_name") or "",
                d.get("customer_name") or "", d.get("customer_phone") or "", d["payment_method"].upper(), status, d.get("void_reason") or "",
                ln.get("code") or "", ln["name"], ln.get("size") or "", opts, ln.get("note") or "", ln["qty"], ln["unit_price"], ln["line_total"],
                (d.get("subtotal") if d.get("subtotal") is not None else d["total"]) if i == 0 else "",
                d.get("discount_amount", 0) if i == 0 else "",
                _discount_label(d) if i == 0 else "",
                d["total"] if i == 0 else "",  # order total only once per order so a SUM() is not double counted
                (0 if d.get("voided") or d.get("payment_status") == "pending" else d["total"]) if i == 0 else "",  # void/unpaid count as 0: sum this column for real revenue
            ]
            w.writerow([_safe(c) for c in row])

    name = f"nubuah-penjualan-{start_d}" + (f"-sd-{end_d}" if end_d != start_d else "") + ".csv"
    body = "\ufeff" + buf.getvalue()  # BOM so Excel reads UTF-8 correctly
    return Response(content=body.encode("utf-8"), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{name}"'})


METHOD_NAME = {"cash": "Tunai", "qris": "QRIS", "card": "Kartu"}


@router.get("/reports/closing.csv")
async def closing_csv(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    store_id: Optional[str] = Query(None),
    p: Principal = Depends(get_principal),
):
    """Owner only. The closing report as a file for one store or for all stores (with a per-store section)."""
    if not p.is_owner:
        raise HTTPException(status_code=403, detail="Owner only")
    r = await build_closing(p, start, end, store_id, top_n=None)
    tz = ZoneInfo(STORE_TZ)
    buf = io.StringIO()
    w = csv.writer(buf)

    def row(*cells: object) -> None:
        w.writerow([_safe(c) for c in cells])

    row("LAPORAN CLOSING")
    row("Toko", r.store_name or "")
    row("Periode", r.start if r.start == r.end else f"{r.start} s/d {r.end}")
    row("Dibuat", r.generated_at.astimezone(tz).strftime("%Y-%m-%d %H:%M") + " WIB")
    row()
    row("RINGKASAN")
    row("Jumlah transaksi", r.count)
    row("Jumlah item terjual", r.items)
    row("Penjualan kotor", r.gross)
    row("Diskon", r.discount_total)
    row("Pendapatan bersih", r.revenue)
    row("Rata-rata per transaksi", r.average)
    row("Pesanan pertama", r.first_order_no or "")
    row("Pesanan terakhir", r.last_order_no or "")
    row("Pesanan VOID (tidak dihitung)", r.voided_count)
    row("Nilai VOID (tidak dihitung)", r.voided_total)
    row()
    row("PEMBAYARAN")
    row("Metode", "Transaksi", "Total")
    for m in r.methods:
        row(METHOD_NAME.get(m.method, m.method), m.count, m.total)
    row("Uang tunai masuk (penjualan tunai)", "", r.cash_in_drawer)
    if r.by_store:
        row()
        row("PER TOKO")
        row("Toko", "Transaksi", "Diskon", "Pendapatan bersih")
        for b in r.by_store:
            row(b.store_name, b.count, b.discount_total, b.revenue)
    row()
    row("MENU TERLARIS")
    row("No", "Item", "Qty", "Pendapatan")
    for i, t in enumerate(r.top_items, 1):
        row(i, t.name, t.qty, t.revenue)

    who = "semua-toko" if not r.by_store and (r.store_name in (None, "Semua toko")) else (r.store_name or "toko").lower().replace(" ", "-")
    name = f"nubuah-closing-{who}-{r.start}" + (f"-sd-{r.end}" if r.end != r.start else "") + ".csv"
    body = "\ufeff" + buf.getvalue()
    return Response(content=body.encode("utf-8"), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{name}"'})
