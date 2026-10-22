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
from models.report import (
    ClosingReport, DailyPoint, Dashboard, MethodTotal, ProductPerformance,
    ProductPerf, StoreTotal, TopItem,
)
from routers.orders import STORE_TZ, date_range, find_orders

router = APIRouter()

# Metric definitions, returned with every report so the UI can label numbers honestly.
# Single source of truth — the aggregations below implement exactly these rules.
DEFINITIONS = {
    "qualifying_order": "not voided AND payment_status == 'paid'",
    "gross_sales": "sum(total + discount_amount) over qualifying orders (before discounts)",
    "net_sales": "sum(total) over qualifying orders (after discounts, before refunds)",
    "discounts_total": "sum(discount_amount) over qualifying orders (never double-counted: stored once per order)",
    "refunds_total": "sum(amount) of refund ledger rows with status == 'succeeded' whose order is in range (legacy attempts without ledger rows use their refunded_amount summary once)",
    "net_after_refunds": "net_sales - refunds_total",
    "average_order_value": "net_sales / qualifying_orders",
    "voided_orders": "excluded from every sales figure; counted separately",
    "pending_orders": "unpaid customer orders — listed, never counted as revenue",
    "gross_profit": "UNAVAILABLE: product cost data does not exist in this system; never fabricated",
    "date_boundary": "business_date strings in the store's timezone (STORE_TZ)",
}


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

    # refunds: attempts refunded against in-range orders (P4.3). Refunds are subtracted,
    # never treated as new sales.
    refunds_count, refunds_total = await _refunds_for_orders([d["id"] for d in docs])

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
        refunds_count=refunds_count,
        refunds_total=refunds_total,
        net_after_refunds=revenue - refunds_total,
        gross_profit_available=False,   # no product cost data — reported, not invented
        gross_profit=None,
        definitions=DEFINITIONS,
        by_store=[StoreTotal(store_name=k, **v) for k, v in sorted(by_store.items())],
    )


async def _successful_refund_rows_for_orders(order_ids: list[str]) -> dict[str, int]:
    """Authoritative successful refunds from the durable refund ledger, mapped by order.

    Legacy attempts have summary fields but no refund ledger rows. They are included
    only when the attempt has no ledger rows, which avoids double-counting after the
    refund accounting migration while preserving historical totals.
    """
    if not order_ids:
        return {}
    ledger_rows = await db.refunds.find(
        {"order_id": {"$in": order_ids}, "status": "succeeded"},
        {"_id": 0, "order_id": 1, "amount": 1, "attempt_id": 1},
    ).to_list(10000)
    by_order: dict[str, int] = {}
    attempts_with_ledger: set[str] = set()
    for row in ledger_rows:
        by_order[row["order_id"]] = by_order.get(row["order_id"], 0) + int(row.get("amount") or 0)
        if row.get("attempt_id"):
            attempts_with_ledger.add(row["attempt_id"])

    legacy_attempts = await db.payment_attempts.find(
        {"order_id": {"$in": order_ids}, "$or": [{"refunded_amount": {"$gt": 0}}, {"refund_status": "refunded"}]},
        {"_id": 0, "id": 1, "order_id": 1, "amount": 1, "refunded_amount": 1, "refund_status": 1},
    ).to_list(10000)
    for attempt in legacy_attempts:
        if attempt["id"] in attempts_with_ledger:
            continue
        amount = int(attempt.get("refunded_amount") or 0)
        if amount <= 0 and attempt.get("refund_status") == "refunded":
            amount = int(attempt.get("amount") or 0)
        if amount > 0:
            by_order[attempt["order_id"]] = by_order.get(attempt["order_id"], 0) + amount
    return by_order


async def _refunds_for_orders(order_ids: list[str]) -> tuple[int, int]:
    """(count, total) of successful refunded amounts tied to these orders.

    ``count`` follows the existing report contract: refunded payment attempts (or refund
    ledger rows for attempts using the new ledger), not distinct orders.
    """
    rows = await _successful_refund_rows_for_orders(order_ids)
    if not order_ids:
        return 0, 0
    ledger_rows = await db.refunds.find(
        {"order_id": {"$in": order_ids}, "status": "succeeded"},
        {"_id": 0, "attempt_id": 1},
    ).to_list(10000)
    attempts_with_ledger = {r.get("attempt_id") for r in ledger_rows if r.get("attempt_id")}
    legacy_attempts = await db.payment_attempts.find(
        {"order_id": {"$in": order_ids}, "$or": [{"refunded_amount": {"$gt": 0}}, {"refund_status": "refunded"}]},
        {"_id": 0, "id": 1, "refunded_amount": 1, "refund_status": 1},
    ).to_list(10000)
    legacy_count = 0
    for attempt in legacy_attempts:
        if attempt["id"] in attempts_with_ledger:
            continue
        amount = int(attempt.get("refunded_amount") or 0)
        if amount <= 0 and attempt.get("refund_status") == "refunded":
            amount = 1  # legacy full-refund marker; count it even if the summary amount is absent
        if amount > 0:
            legacy_count += 1
    return len(ledger_rows) + legacy_count, sum(rows.values())


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


@router.get("/reports/dashboard", response_model=Dashboard)
async def dashboard(start: str = Query(...), end: str = Query(...), store_id: str = Query(None), p: Principal = Depends(get_principal)):
    """Sales dashboard. All figures follow DEFINITIONS; pending/voided orders are never
    counted as revenue, refunds are subtracted once, and gross profit is reported as
    unavailable rather than fabricated."""
    start_d, end_d = date_range(start, end)
    sid = await resolve_store(p, store_id, allow_all=True)
    all_docs = await find_orders(sid, start_d, end_d, sort=1)
    docs = [d for d in all_docs if not d.get("voided") and d.get("payment_status") != "pending"]
    voided = [d for d in all_docs if d.get("voided")]

    net = sum(d["total"] for d in docs)
    discounts = sum(d.get("discount_amount", 0) for d in docs)
    refunds_count, refunds_total = await _refunds_for_orders([d["id"] for d in docs])

    methods: dict[str, dict] = {}
    for d in docs:
        m = methods.setdefault(d.get("payment_method", "unknown"), {"count": 0, "total": 0})
        m["count"] += 1
        m["total"] += d["total"]

    by_day: dict[str, dict] = {}
    for d in docs:
        day = by_day.setdefault(d["business_date"], {"revenue": 0, "orders": 0, "refunds_total": 0})
        day["revenue"] += d["total"]
        day["orders"] += 1
    if refunds_total:
        refunded_by_order = await _successful_refund_rows_for_orders([d["id"] for d in docs])
        day_of = {d["id"]: d["business_date"] for d in docs}
        for order_id, refunded_amount in refunded_by_order.items():
            dd = day_of.get(order_id)
            if dd in by_day:
                by_day[dd]["refunds_total"] += refunded_amount

    return Dashboard(
        start=start_d, end=end_d, generated_at=datetime.now(timezone.utc),
        gross_sales=net + discounts,
        net_sales=net,
        net_after_refunds=net - refunds_total,
        qualifying_orders=len(docs),
        average_order_value=round(net / len(docs)) if docs else 0,
        discounts_total=discounts,
        refunds_total=refunds_total,
        refunds_count=refunds_count,
        voided_count=len(voided),
        methods=[MethodTotal(method=k, **v) for k, v in methods.items()],
        series=[DailyPoint(date=k, **v) for k, v in sorted(by_day.items())],
        gross_profit_available=False,
        definitions=DEFINITIONS,
    )


@router.get("/reports/products", response_model=ProductPerformance)
async def product_performance(start: str = Query(...), end: str = Query(...), store_id: str = Query(None), p: Principal = Depends(get_principal)):
    """Per-product and per-category performance from authoritative order lines.
    Category names resolve from the live menu; lines whose product was since deleted
    report category=None instead of guessing."""
    start_d, end_d = date_range(start, end)
    sid = await resolve_store(p, store_id, allow_all=True)
    docs = [d for d in await find_orders(sid, start_d, end_d, sort=1)
            if not d.get("voided") and d.get("payment_status") != "pending"]

    category_of: dict[str, str | None] = {}
    prod_ids = list({ln.get("product_id") for d in docs for ln in d["lines"] if ln.get("product_id")})
    if prod_ids:
        # the menu is GLOBAL (store_id null) with per-store overrides — never filter
        # to a single store or every per-store view loses category/name resolution
        store_filter = {} if not sid else {"$or": [{"store_id": None}, {"store_id": sid}]}
        prods = await db.menu_products.find({**store_filter, "id": {"$in": prod_ids}}, {"_id": 0, "id": 1, "category_id": 1, "category": 1}).to_list(None)
        # `category` (legacy) and `category_id` both carry the category id; the
        # categories collection names them in `label` (newer) or `name` (oldest)
        cat_ids = list({pr.get("category_id") or pr.get("category") for pr in prods if pr.get("category_id") or pr.get("category")})
        cat_rows = await db.menu_categories.find({"id": {"$in": cat_ids}}, {"_id": 0, "id": 1, "label": 1, "name": 1}).to_list(None) if cat_ids else []
        cats = {c["id"]: c.get("label") or c.get("name") for c in cat_rows}
        category_of = {pr["id"]: cats.get(pr.get("category_id") or pr.get("category")) for pr in prods}

    per: dict[str, dict] = {}
    order_sets: dict[str, set] = {}
    for d in docs:
        for ln in d["lines"]:
            # base name — cup size must NOT split a product into separate rows
            base = (ln["name"].split(" · ")[0]).strip() or ln["name"]
            rec = per.setdefault(base, {"product_id": ln.get("product_id"), "qty": 0, "revenue": 0})
            rec["qty"] += ln["qty"]
            rec["revenue"] += ln["qty"] * ln["unit_price"]
            order_sets.setdefault(base, set()).add(d["id"])

    # most-chosen add-ons across all lines (size labels are line metadata, not add-ons),
    # each attributed to its addon GROUP (Level Manis / Es / Add Topping / …)
    opt_counts: dict[str, int] = {}
    for d in docs:
        for ln in d["lines"]:
            for o in ln.get("options") or []:
                label = (o.get("label") or "").strip()
                if label and label not in ("R", "L", "-"):
                    opt_counts[label] = opt_counts.get(label, 0) + 1
    scope = {"$or": [{"store_id": None}, {"store_id": sid}]}
    opt_rows = await db.menu_options.find(scope, {"_id": 0, "label": 1, "group_id": 1}).to_list(None) if opt_counts else []
    grp_rows = await db.menu_groups.find(scope, {"_id": 0, "id": 1, "label": 1, "name": 1}).to_list(None) if opt_rows else []
    grp_name = {g["id"]: g.get("label") or g.get("name") or g["id"] for g in grp_rows}
    label_to_group: dict[str, str] = {}
    for o in opt_rows:
        lbl = (o.get("label") or "").strip()
        if lbl and lbl not in label_to_group:
            label_to_group[lbl] = grp_name.get(o.get("group_id"), "(lainnya)")
    top_options = [
        {"group": label_to_group.get(k, "(lainnya)"), "label": k, "count": v}
        for k, v in sorted(opt_counts.items(), key=lambda kv: -kv[1])[:15]
    ]

    rows = [
        ProductPerf(key=k, product_id=v["product_id"], category=category_of.get(v["product_id"]),
                    qty=v["qty"], revenue=v["revenue"], orders_count=len(order_sets[k]))
        for k, v in per.items()
    ]
    by_qty = sorted(rows, key=lambda r: (-r.qty, -r.revenue))
    by_rev = sorted(rows, key=lambda r: (-r.revenue, -r.qty))
    low = sorted([r for r in rows if r.qty > 0], key=lambda r: (r.revenue, -r.qty))[:10]

    cat_rows: dict[str, dict] = {}
    for r in rows:
        c = cat_rows.setdefault(r.category or "(tanpa kategori)", {"qty": 0, "revenue": 0})
        c["qty"] += r.qty
        c["revenue"] += r.revenue

    # the FULL menu taxonomy — filter chips must list every category/group that EXISTS,
    # not only the ones that happened to sell in this date range (otherwise newly
    # created categories never appear in the dashboard filters)
    all_categories = [c.get("label") or c.get("name") or c["id"] for c in await db.menu_categories.find(scope, {"_id": 0, "label": 1, "name": 1, "id": 1}).to_list(None)]
    all_option_groups = [g.get("label") or g.get("name") or g["id"] for g in await db.menu_groups.find(scope, {"_id": 0, "label": 1, "name": 1, "id": 1}).to_list(None)]

    return ProductPerformance(
        start=start_d, end=end_d, generated_at=datetime.now(timezone.utc),
        by_quantity=by_qty[:20], by_revenue=by_rev[:20], low_performers=low,
        categories=[{"category": k, **v} for k, v in sorted(cat_rows.items(), key=lambda kv: -kv[1]["revenue"])],
        top_options=top_options,
        all_categories=all_categories,
        all_option_groups=all_option_groups,
        gross_profit_available=False,
        definitions=DEFINITIONS,
    )


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
