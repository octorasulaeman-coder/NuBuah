"""Add (or remove) SAMPLE data so you can test NuBuah properly.

  python seed_sample_data.py            add sample orders, menu items and toppings
  python seed_sample_data.py --remove   delete ONLY the sample data again (your real data is never touched)
  python seed_sample_data.py --store NB1   use a specific store code (default: the first store)

Everything it creates is marked with sample_data=true, so --remove can find it exactly.
Sample orders cover the last 10 days (including today): cash / QRIS / card, percent and fixed discounts,
customer names, and a few voided orders, so History, the chart, the closing report and the CSV export have real content.
"""

import os
import random
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

STORE_TZ = os.environ.get("STORE_TZ", "Asia/Jakarta")
DAYS = 10

# (product_id, code, name, regular price, large price or None)  - copied from the real menu
SMOOTHIES = [
    ("sm-bdb", "BDB", "Berry Dragon Boost", 14000, 17000),
    ("sm-gb", "GB", "Green Breeze", 16000, 19000),
    ("sm-wub", "WUB", "Wake Up Booster", 13000, 16000),
    ("sm-sbb", "SBB", "Strawberry Banana Blend", 14000, 17000),
    ("sm-cp", "CP", "Creamy Power", 15000, 18000),
    ("sm-ib", "IB", "Immunity Boost", 15000, 18000),
]
JUS = [
    ("js-strawberry", None, "Jus Strawberry", 15000, 18000),
    ("js-alpukat", None, "Jus Alpukat", 15000, 18000),
    ("js-jeruk-peras", None, "Jus Jeruk Peras", 12000, 15000),
    ("js-nanas", None, "Jus Nanas", 12000, 15000),
    ("js-melon", None, "Jus Melon", 15000, 18000),
]
BOWLS = [
    ("bw-berry-dragon-boost", "BDB", "Berry Dragon Boost", 30000, None),
    ("bw-mango-banana-punch", "MBP", "Mango Banana Punch", 29000, None),
    ("bw-strawnana", None, "Strawnana", 29000, None),
]
DRINK_OPTIONS = [("Normal Sugar", 0, 0), ("Less Sugar", 0, 0), ("Tambah yogurt", 3000, 5000), ("Ganti gula jadi madu", 3000, 5000)]
BOWL_TOPPINGS = [("Pisang", 1000), ("Strawberry", 1000), ("Granola", 2000)]
NAMES = [("Budi", "081234567801"), ("Siti", "081234567802"), ("Andi", "081234567803"), ("Dewi", None), ("Rina", "081234567805"), ("Agus", None)]
DISCOUNTS = [("percent", 10, "member"), ("percent", 5, "promo akhir pekan"), ("fixed", 3000, "voucher"), ("fixed", 5000, "teman owner")]
VOID_REASONS = ["Salah input pesanan", "Pelanggan batal", "Pesanan dobel"]


def make_line(rng: random.Random) -> dict:
    kind = rng.choice(["smoothie", "jus", "bowl"])
    if kind == "bowl":
        pid, code, name, r, _ = rng.choice(BOWLS)
        tops = rng.sample(BOWL_TOPPINGS, rng.randint(0, 2))
        options = [{"label": t, "price": p} for t, p in tops]
        size = None
        unit = r + sum(p for _, p in tops)
    else:
        pid, code, name, r, l = rng.choice(SMOOTHIES if kind == "smoothie" else JUS)
        size = rng.choice(["R", "R", "L"])
        label, pr, pl = rng.choice(DRINK_OPTIONS)
        options = [{"label": label, "price": pl if size == "L" else pr}]
        unit = (l if size == "L" else r) + options[0]["price"]
    qty = rng.choice([1, 1, 1, 2, 3])
    return {"product_id": pid, "name": name, "code": code, "size": size, "options": options, "note": None, "unit_price": unit, "qty": qty, "line_total": unit * qty}


def build_sample(store: dict, cashier_name: str, existing_per_day: dict, now_local: datetime) -> dict:
    """Return {"orders": [...], "custom_products": [...], "custom_options": [...]} (nothing is written here)."""
    rng = random.Random(2026)
    tz = ZoneInfo(STORE_TZ)
    orders = []
    for back in range(DAYS - 1, -1, -1):
        day = (now_local - timedelta(days=back)).date()
        bdate = day.isoformat()
        count = rng.randint(3, 7) if back else rng.randint(3, 5)
        seq = existing_per_day.get(bdate, 0)
        # random times in opening hours, oldest first so order numbers ascend
        times = sorted(rng.randint(9 * 60, 20 * 60) for _ in range(count))
        if back == 0:  # today: only times that already passed
            limit = now_local.hour * 60 + now_local.minute
            times = [t for t in times if t < limit] or [max(9 * 60, limit - 5)]
        for minutes in times:
            seq += 1
            lines = [make_line(rng) for _ in range(rng.randint(1, 3))]
            subtotal = sum(ln["line_total"] for ln in lines)
            dtype, dvalue, dnote, damount = None, 0, None, 0
            if rng.random() < 0.3:
                dtype, dvalue, dnote = rng.choice(DISCOUNTS)
                damount = (subtotal * dvalue + 50) // 100 if dtype == "percent" else min(dvalue, subtotal)
            total = subtotal - damount
            method = rng.choices(["cash", "qris", "card"], weights=[5, 4, 1])[0]
            tendered = change = None
            if method == "cash":
                tendered = ((total + 4999) // 5000) * 5000 if rng.random() < 0.7 else total
                change = tendered - total
            cust = rng.choice(NAMES) if rng.random() < 0.5 else (None, None)
            created = datetime(day.year, day.month, day.day, minutes // 60, minutes % 60, tzinfo=tz).astimezone(timezone.utc)
            doc = {
                "id": str(uuid.uuid4()),
                "order_no": f"{store['code']}-{bdate.replace('-', '')[2:]}-{seq:03d}",
                "business_date": bdate,
                "store_id": store["id"],
                "store_name": store["name"],
                "store_address_lines": store.get("address_lines", []),
                "store_phone": store.get("phone", ""),
                "cashier_name": cashier_name,
                "created_at": created,
                "lines": lines,
                "item_count": sum(ln["qty"] for ln in lines),
                "subtotal": subtotal,
                "discount_type": dtype,
                "discount_value": dvalue,
                "discount_amount": damount,
                "discount_note": dnote,
                "total": total,
                "payment_method": method,
                "cash_tendered": tendered,
                "change": change,
                "customer_name": cust[0],
                "customer_phone": cust[1],
                "voided": False,
                "void_reason": None,
                "voided_at": None,
                "voided_by": None,
                "sample_data": True,
            }
            orders.append(doc)
        existing_per_day[bdate] = seq
    # void two older orders (never today's, so today's closing report is easy to check)
    older = [o for o in orders if o["business_date"] != now_local.date().isoformat()]
    for o in rng.sample(older, 2):
        o.update(voided=True, void_reason=rng.choice(VOID_REASONS), voided_at=o["created_at"] + timedelta(minutes=20), voided_by="Owner")

    now = datetime.now(timezone.utc)
    products = [
        {"id": "cx-sample-jus-jambu-kristal", "name": "Jus Jambu Kristal", "category": "jus", "desc": "Contoh menu tambahan", "benefit": "", "r": 14000, "l": 17000, "color": "#EC6F80", "created_at": now, "sample_data": True},
        {"id": "cx-sample-bowl-granola-madu", "name": "Bowl Granola Madu", "category": "bowl", "desc": "Contoh menu tambahan", "benefit": "", "r": 32000, "l": None, "color": "#E8B04A", "created_at": now, "sample_data": True},
    ]
    options = [
        {"id": "cx-sample-chia-seed", "group_id": "bowl_topping", "label": "Chia Seed", "r": 3000, "l": None, "created_at": now, "sample_data": True},
        {"id": "cx-sample-boba", "group_id": "drink_extra", "label": "Tambah boba", "r": 4000, "l": 6000, "created_at": now, "sample_data": True},
    ]
    return {"orders": orders, "custom_products": products, "custom_options": options}


def has_sample(db) -> bool:
    return any(db[c].count_documents({"sample_data": True}, limit=1) for c in ("orders", "custom_products", "custom_options"))


def add_sample(db, store_code: str | None = None) -> dict:
    store = db.stores.find_one({"code": store_code}, {"_id": 0}) if store_code else db.stores.find_one({}, {"_id": 0}, sort=[("created_at", 1)])
    if not store:
        raise SystemExit("No store found. Start the app once first (it creates the default store), or check --store.")
    cashier = db.users.find_one({"role": "cashier", "store_id": store["id"]}, {"_id": 0, "name": 1})
    cashier_name = (cashier or {}).get("name") or "Kasir Contoh"
    now_local = datetime.now(ZoneInfo(STORE_TZ))
    per_day = {}
    for d in db.orders.aggregate([{"$match": {"store_id": store["id"]}}, {"$group": {"_id": "$business_date", "n": {"$sum": 1}}}]):
        per_day[d["_id"]] = d["n"]
    data = build_sample(store, cashier_name, per_day, now_local)
    for coll, docs in data.items():
        if docs:
            db[coll].insert_many(docs)
    return {"store": store["name"], **{k: len(v) for k, v in data.items()}, "voided": sum(1 for o in data["orders"] if o["voided"])}


def remove_sample(db) -> dict:
    return {c: db[c].delete_many({"sample_data": True}).deleted_count for c in ("orders", "custom_products", "custom_options")}


def main() -> None:
    from dotenv import load_dotenv
    from pymongo import MongoClient

    load_dotenv(Path(__file__).parent / ".env")
    db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
    args = sys.argv[1:]
    if "--remove" in args:
        print("Removed sample data:", remove_sample(db))
        return
    if has_sample(db):
        sys.exit("Sample data is already in the database. Run with --remove first if you want to recreate it.")
    store = args[args.index("--store") + 1] if "--store" in args else None
    print("Added sample data:", add_sample(db, store))
    print("Open /history and pick the last 10 days. Remove it later with: seed-sample-data.bat --remove")


if __name__ == "__main__":
    main()
