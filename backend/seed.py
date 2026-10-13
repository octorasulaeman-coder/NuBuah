"""Seed NuBuah demo data (idempotent).

- Ensures the default store (NuBuah Cimahi, PIN 1234) + owner account via bootstrap.
- Adds a second demo store (NuBuah Bandung, code BDG, PIN 5678) and a cashier login for Cimahi.
- Replaces previously seeded orders with ~7 days of orders per store (WIB).
"""
import asyncio
import random
import uuid
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from lib.auth import hash_secret
from lib.bootstrap import bootstrap
from lib.dates import today_iso
from lib.db import db, ensure_indexes
from models.order import Order, OrderLine

TZ = ZoneInfo("Asia/Jakarta")

# (product_id, code, name, price_r, price_l or None)
ITEMS = [
    ("sm-bdb", "BDB", "Berry Dragon Boost", 14000, 17000),
    ("sm-gb", "GB", "Green Breeze", 16000, 19000),
    ("sm-wpc", "WPC", "Watermelon Pineapple Cooler", 13000, 16000),
    ("sm-sbb", "SBB", "Strawberry Banana Blend", 14000, 17000),
    ("sm-cp", "CP", "Creamy Power", 15000, 18000),
    ("sm-vcp", "VCP", "Vitamin C Punch", 15000, 18000),
    ("bw-mix-berry-smooth", "MBS", "Mix Berry Smooth", 34000, None),
    ("bw-mango-banana-punch", "MBP", "Mango Banana Punch", 29000, None),
    ("bw-strawnana", None, "Strawnana", 29000, None),
    ("js-alpukat", None, "Jus Alpukat", 15000, 18000),
    ("js-jeruk-peras", None, "Jus Jeruk Peras", 12000, 15000),
    ("js-mangga-harum-manis", None, "Jus Mangga Harum Manis", 15000, 18000),
    ("js-sirsak", None, "Jus Sirsak", 15000, 18000),
]
SWEET = ["No Sugar", "Less Sugar", "Normal Sugar"]


async def ensure_demo() -> list[dict]:
    await bootstrap()
    if not await db.stores.find_one({"code": "BDG"}):
        await db.stores.insert_one({
            "id": str(uuid.uuid4()), "name": "NuBuah Bandung", "code": "BDG",
            "address_lines": ["Jl. Contoh No.1 (alamat demo)", "Kota Bandung, Jawa Barat"], "phone": "0896-5607-5653",
            "pin_hash": hash_secret("5678"), "pin_version": 1, "created_at": datetime.now(timezone.utc),
        })
    stores = await db.stores.find({}, {"_id": 0}).sort("created_at", 1).to_list(50)
    if not await db.users.find_one({"email": "kasir@nubuah.id"}):
        await db.users.insert_one({
            "id": str(uuid.uuid4()), "name": "Kasir Cimahi", "email": "kasir@nubuah.id",
            "password_hash": hash_secret("kasir123"), "role": "cashier", "store_id": stores[0]["id"],
            "active": True, "created_at": datetime.now(timezone.utc),
        })
    return stores


async def main() -> None:
    stores = await ensure_demo()
    await db.orders.delete_many({"seeded": True})
    rng = random.Random(42)
    today = date.fromisoformat(today_iso("Asia/Jakarta"))
    total_orders = 0
    for store in stores[:2]:
        for back in range(7, 0, -1):
            d = today - timedelta(days=back)
            existing = await db.orders.count_documents({"store_id": store["id"], "business_date": d.isoformat()})
            n = rng.randint(4, 10)
            stamps = sorted(datetime.combine(d, time(rng.randint(8, 20), rng.randint(0, 59)), TZ) for _ in range(n))
            for i, ts in enumerate(stamps, start=existing + 1):
                lines = []
                for _ in range(rng.randint(1, 3)):
                    pid, code, name, pr, pl = rng.choice(ITEMS)
                    size, price, options = None, pr, []
                    if pl is not None:
                        size = rng.choice(["R", "L"])
                        price = pl if size == "L" else pr
                        options.append({"label": rng.choice(SWEET), "price": 0})
                    qty = rng.choice([1, 1, 1, 2])
                    lines.append(OrderLine(product_id=pid, code=code, name=name, size=size, options=options,
                                           unit_price=price, qty=qty, line_total=price * qty))
                total = sum(ln.line_total for ln in lines)
                method = rng.choice(["cash", "cash", "qris", "card"])
                tendered = change = None
                if method == "cash":
                    tendered = next(x for x in (20000, 50000, 100000, 200000) if x >= total)
                    change = tendered - total
                order = Order(
                    order_no=f"{store['code']}-{d.strftime('%y%m%d')}-{i:03d}",
                    business_date=d.isoformat(),
                    store_id=store["id"], store_name=store["name"],
                    store_address_lines=store.get("address_lines", []), store_phone=store.get("phone", ""),
                    created_at=ts.astimezone(timezone.utc),
                    lines=lines, item_count=sum(ln.qty for ln in lines), total=total,
                    payment_method=method, cash_tendered=tendered, change=change,
                )
                await db.orders.insert_one({**order.model_dump(), "seeded": True})
                total_orders += 1
    await ensure_indexes()
    print(f"Seeded {total_orders} orders across {min(2, len(stores))} stores for the 7 days before {today}")


if __name__ == "__main__":
    asyncio.run(main())
