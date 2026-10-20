"""Full demo dataset: one month of orders (1–30 September) on a realistic NuBuah menu.

Designed to be run right after dropping the database. Creates (idempotent, re-runnable):
- store "NuBuah Demo" (code NBD, PIN 1234) with schedule config — or reuses the first
  existing store and ITS menu if one already exists
- 5 menu categories + 14 products with proper r/l prices and category ids
- 5 customers (3 members with generated IDs + points ledger, 2 non-members)
- 3 coupons (HEMAT10 / POTONG5K / EXPIRED)
- ~150 PAID orders spread across 1–30 September (multi-item, mixed payment methods,
  occasional discounts, member & walk-in customers, some scheduled pickups)
- 2 upcoming scheduled orders (next 2 days) + 1 pending online order for panel testing

Run from the backend folder:
    python ../scripts/seed_demo.py
"""

import json
import os
import random
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from dotenv import load_dotenv  # noqa: E402
from pymongo import MongoClient  # noqa: E402
from zoneinfo import ZoneInfo  # noqa: E402

load_dotenv(Path(__file__).resolve().parent.parent / "backend" / ".env")

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "nubuah")
TZ = ZoneInfo(os.environ.get("STORE_TZ", "Asia/Jakarta"))

db = MongoClient(MONGO_URL)[DB_NAME]
NOW = datetime.now(timezone.utc)


def upsert(collection: str, key: dict, doc: dict) -> None:
    db[collection].update_one(key, {"$set": doc}, upsert=True)


def business_date(dt_utc: datetime) -> str:
    return dt_utc.astimezone(TZ).date().isoformat()


# ---------------------------------------------------------------- store + menu
store = db.stores.find_one({}, {"_id": 0})
if not store:
    # empty database → restore the REAL store(s) + REAL global menu from the embedded
    # snapshot (extracted from the owner's 2026-10-21 backup), then demo on top of it
    snap_path = Path(__file__).resolve().parent / "seed_data.json"
    if snap_path.is_file():
        # the snapshot is MongoDB EXTENDED JSON ($numberInt/$date wrappers) — plain
        # json.loads would turn every number/date into a dict (NaNK prices, broken
        # store docs). bson.json_util decodes it exactly like restore_backup.py does.
        from bson import json_util

        snap = json_util.loads(snap_path.read_text(encoding="utf-8"))
        for collection, docs in snap.items():
            for doc in docs:
                key = {"id": doc["id"]} if "id" in doc else doc  # product_codes has no id
                db[collection].update_one(key, {"$set": doc}, upsert=True)
        store = db.stores.find_one({}, {"_id": 0}, sort=[("created_at", 1)])
        print(f"Database kosong — store + menu ASLI dipulihkan dari seed_data.json "
              f"({len(snap.get('menu_products', []))} produk, {len(snap.get('stores', []))} toko).")
    else:
        print("seed_data.json tidak ditemukan di folder scripts — tidak ada yang bisa dipulihkan.")
        sys.exit(1)
else:
    print(f"Makai toko yang sudah ada: {store['name']} ({store['code']}).")
STORE_ID = store["id"]

# the real menu is GLOBAL (store_id null) with per-store overrides — read both scopes
products = [
    p for p in db.menu_products.find({"$or": [{"store_id": None}, {"store_id": STORE_ID}]}, {"_id": 0})
    if not p.get("hidden")
]
if not products:
    print("Toko tidak punya produk — buat dulu lewat Kelola Menu, lalu jalankan ulang.")
    sys.exit(1)

# (products already loaded above, from the global menu + this store's overrides)

# ---------------------------------------------------------------- customers (3 members, 2 non)
CUSTOMERS = [
    {"id": "cust-budi", "name": "Budi Santoso", "phone": "0812000001", "member": True, "member_no": "NB100001", "points": 120, "spend": 0, "orders": 0},
    {"id": "cust-sari", "name": "Sari Dewi", "phone": "0812000002", "member": True, "member_no": "NB100002", "points": 45, "spend": 0, "orders": 0},
    {"id": "cust-rahma", "name": "Rahma Ayu", "phone": "0812000004", "member": True, "member_no": "NB100003", "points": 210, "spend": 0, "orders": 0},
    {"id": "cust-agus", "name": "Agus Wijaya", "phone": "0812000003", "member": False, "member_no": None, "points": 0, "spend": 0, "orders": 0},
    {"id": "cust-dina", "name": "Dina Putri", "phone": "0812000005", "member": False, "member_no": None, "points": 0, "spend": 0, "orders": 0},
]

# ---------------------------------------------------------------- coupons
for c in [
    {"id": "cpn-hemat10", "code": "HEMAT10", "type": "percent", "value": 10, "desc": "Diskon 10% semua produk"},
    {"id": "cpn-potong5k", "code": "POTONG5K", "type": "fixed", "value": 5000, "desc": "Potongan Rp 5.000 (min. belanja 20rb)", "min_spend": 20000},
    {"id": "cpn-expired", "code": "EXPIRED", "type": "fixed", "value": 3000, "desc": "Kupon nonaktif untuk demo penolakan", "active": False},
]:
    upsert("coupons", {"id": c["id"]}, {
        "id": c["id"], "store_id": STORE_ID, "code": c["code"], "description": c["desc"],
        "type": c["type"], "value": c["value"], "min_spend": c.get("min_spend", 0),
        "starts_at": None, "ends_at": None, "max_redemptions": 0, "per_customer_limit": 0,
        "used_count": 0, "applies_to": {"type": "all"}, "active": c.get("active", True),
        "created_at": NOW - timedelta(days=60),
    })

# ---------------------------------------------------------------- one month of orders (1–30 Sept)
random.seed(20260930)
SEPT_START = datetime(2026, 9, 1, 0, 0, tzinfo=TZ)
cust_spend = {c["id"]: {"spend": 0, "orders": 0} for c in CUSTOMERS}


def price_of(prod: dict, size: str | None) -> int:
    """Real menu rows are mostly int r/l, but potong-style products keep a price TABLE
    (dict) — extract a concrete number either way."""
    v = prod.get("l") if size == "L" else prod.get("r")
    if isinstance(v, dict):
        nums = [x for x in v.values() if isinstance(x, (int, float))]
        v = nums[0] if nums else 0
    if v is None:
        v = prod.get("price")
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0

# seed orders only if September 2026 has none — so restoring your real data first
# and then running this seed ADDS the demo month on top of your real menu
STORES = list(db.stores.find({}, {"_id": 0, "id": 1, "name": 1, "code": 1}))
if db.orders.count_documents({"business_date": {"$gte": "2026-09-01", "$lte": "2026-09-30"}}) > 0:
    print("September 2026 sudah punya pesanan — melewati pembuatan pesanan demo (tidak diduplikasi).")
else:
    seq = 0
    for day in range(30):  # 1..30 September
        date = SEPT_START + timedelta(days=day)
        weekday = date.weekday()
        count = random.randint(2, 4) + (3 if weekday >= 5 else 0)  # weekends busier
        for _ in range(count):
            seq += 1
            n_lines = 1 if random.random() < 0.7 else 2
            lines, subtotal = [], 0
            for _ in range(n_lines):
                prod = random.choice(products)
                has_l = bool(prod.get("sizes")) and prod.get("l") is not None
                size_l = has_l and random.random() < 0.3
                size = "L" if size_l else ("R" if prod.get("sizes") else None)
                unit = price_of(prod, "L" if size_l else None)
                qty = random.randint(1, 3)
                subtotal += unit * qty
                lines.append({
                    "product_id": prod["id"], "name": prod["name"], "size": size,
                    "options": [], "note": None, "unit_price": unit, "qty": qty, "line_total": unit * qty,
                    "category_id": prod.get("category_id") or prod.get("category"),
                })
            # occasional discount (cashier-applied)
            discount_amount, discount_type, discount_value = 0, None, 0
            if random.random() < 0.12:
                if random.random() < 0.5:
                    discount_type, discount_value = "percent", random.choice([5, 10])
                    discount_amount = round(subtotal * discount_value / 100)
                else:
                    discount_type, discount_value = "fixed", 5000
                    discount_amount = min(5000, subtotal)
            total = subtotal - discount_amount
            method = random.choice(["cash", "cash", "cash", "qris", "qris", "card"])
            created = (date + timedelta(hours=random.randint(9, 20), minutes=random.choice([0, 7, 15, 22, 30, 45]))).astimezone(timezone.utc)
            cust = random.choice([None, None] + CUSTOMERS)
            if cust:
                cust_spend[cust["id"]]["spend"] += total
                cust_spend[cust["id"]]["orders"] += 1
            st = random.choice(STORES)  # spread demo orders across ALL stores so every cashier sees data
            scheduled = random.random() < 0.15
            slot = (date + timedelta(hours=random.randint(10, 19), minutes=random.choice([0, 15, 30, 45]))).astimezone(timezone.utc) if scheduled else None
            db.orders.insert_one({
                "id": uuid.uuid4().hex,
                "order_no": f"{st['code']}-{business_date(created).replace('-', '')[2:]}-{seq:03d}",
                "store_id": st["id"], "store_name": st["name"], "business_date": business_date(created),
                "lines": lines, "item_count": sum(l["qty"] for l in lines),
                "subtotal": subtotal, "discount_type": discount_type, "discount_value": discount_value,
                "discount_amount": discount_amount, "discount_note": "Promo member" if discount_amount else None,
                "total": total, "payment_method": method, "payment_status": "paid", "channel": "pos",
                "fulfillment": "scheduled" if scheduled else "immediate",
                "scheduled_for": slot, "status": "completed" if scheduled else "received",
                "cash_tendered": total if method == "cash" else None,
                "change": 0 if method == "cash" else None,
                "customer_name": cust["name"] if cust else None,
                "customer_phone": cust["phone"] if cust else None,
                "voided": False, "created_at": created,
            })
    print(f"Dibuat {seq} pesanan lunas, 1–30 September 2026.")

# ---------------------------------------------------------------- customer profiles + ledger
LEDGER_REASONS = ["order_paid", "order_paid", "order_paid", "order_paid", "redeem", "adjust"]
for c in CUSTOMERS:
    spend = cust_spend[c["id"]]
    upsert("customers", {"id": c["id"]}, {
        "id": c["id"], "store_id": STORE_ID, "name": c["name"], "phone": c["phone"],
        "is_member": c["member"], "member_no": c["member_no"],
        "points": c["points"] if c["member"] else 0,
        "lifetime_spend": spend["spend"], "order_count": spend["orders"],
        "last_order_at": SEPT_START.astimezone(timezone.utc) + timedelta(days=29),
        "marketing_opt_in": False, "created_at": NOW - timedelta(days=60), "updated_at": NOW,
    })
    # plausible ledger for members (non-members have none — they earn nothing)
    if c["member"]:
        db.points_ledger.delete_many({"customer_id": c["id"]})
        remaining, when = c["points"], NOW - timedelta(days=40)
        for i, reason in enumerate(LEDGER_REASONS):
            when += timedelta(days=6)
            if reason == "order_paid":
                delta = min(remaining, random.randint(8, 60)) if remaining > 0 else 0
            elif reason == "redeem":
                delta = -min(30, random.randint(10, 30))
            else:
                delta = 10  # goodwill adjust
            remaining -= delta
            if delta == 0:
                continue
            db.points_ledger.insert_one({
                "id": uuid.uuid4().hex, "customer_id": c["id"], "store_id": STORE_ID,
                "order_id": None, "delta": delta, "reason": reason,
                "actor": "owner" if reason == "adjust" else None,
                "note": "Selamat datang member" if reason == "adjust" else None,
                "created_at": when,
            })

# ---------------------------------------------------------------- panel fixtures (upcoming)
slot1 = (NOW.astimezone(TZ) + timedelta(days=1)).replace(hour=17, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
slot2 = (NOW.astimezone(TZ) + timedelta(days=2)).replace(hour=10, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
fixtures = [
    ("ord-fix-1", "901", slot1, "paid", "received", "cust-agus"),
    ("ord-fix-2", "902", slot2, "pending", "received", "cust-dina"),
    ("ord-fix-3", "903", slot1, "pending", "received", None),
]
for oid, suffix, slot, pay, status, cid in fixtures:
    cust = next((c for c in CUSTOMERS if c["id"] == cid), None)
    prod = products[0]
    unit = price_of(prod, None) or 10000
    upsert("orders", {"id": oid}, {
        "id": oid, "order_no": f"{store['code']}-{business_date(NOW).replace('-', '')[2:]}-{suffix}",
        "store_id": STORE_ID, "store_name": store["name"], "business_date": business_date(NOW),
        "lines": [{"product_id": prod["id"], "name": prod["name"], "size": "R", "options": [],
                   "note": None, "unit_price": unit, "qty": 2, "line_total": unit * 2,
                   "category_id": prod.get("category_id") or prod.get("category")}],
        "item_count": 2, "subtotal": unit * 2, "total": unit * 2, "payment_method": "cash",
        "payment_status": pay, "channel": "customer", "fulfillment": "scheduled", "scheduled_for": slot,
        "status": status, "customer_name": cust["name"] if cust else "Walk-in",
        "customer_phone": cust["phone"] if cust else "081299988877",
        "voided": False, "created_at": NOW,
    })

print("Pelanggan: Budi NB100001 (120 poin), Sari NB100002 (45), Rahma NB100003 (210) — member; Agus & Dina bukan member.")
print("Kupon: HEMAT10 / POTONG5K / EXPIRED. Fixture: 2 pesanan terjadwal (besok & lusa) + 1 online pending.")
print("Selesai.")
