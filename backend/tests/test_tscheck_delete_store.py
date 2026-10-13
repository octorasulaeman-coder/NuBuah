"""Delete store: happy path, 404 unknown id, 401/403 for non-owner; past orders survive under 'Semua toko'."""
import os
import uuid

import httpx
import pytest

API_URL = f"{os.environ.get('BACKEND_URL', 'http://localhost:8001')}/api"


@pytest.fixture
def owner_client():
    c = httpx.Client(base_url=API_URL, timeout=30.0)
    r = c.post("/auth/login", json={"email": "owner@nubuah.id", "password": "nubuah123"})
    assert r.status_code == 200, r.text
    yield c
    c.close()


def test_delete_store_removes_store_keeps_orders_in_all_scope(owner_client):
    suffix = uuid.uuid4().hex[:5].upper()
    code = f"D{suffix}"[:5]
    name = f"tscheck-delete-{suffix}"

    r = owner_client.post("/stores", json={"name": name, "code": code, "pin": "9911"})
    assert r.status_code == 201, r.text
    store_id = r.json()["id"]

    r = owner_client.post(
        "/orders",
        json={
            "store_id": store_id,
            "lines": [{"product_id": "tscheck-prod", "name": "Tscheck Item", "unit_price": 5000, "qty": 1}],
            "payment_method": "cash",
        },
    )
    assert r.status_code == 201, r.text
    order = r.json()

    # non-owner cannot delete
    pin_client = httpx.Client(base_url=API_URL, timeout=30.0)
    r = pin_client.get("/public/stores")
    cimahi = next(s for s in r.json() if s["code"] == "NB")
    r = pin_client.post("/auth/pin", json={"store_id": cimahi["id"], "pin": "1234"})
    assert r.status_code == 200, r.text
    r = pin_client.delete(f"/stores/{store_id}")
    assert r.status_code == 403, r.text
    pin_client.close()

    # unauthenticated cannot delete
    anon = httpx.Client(base_url=API_URL, timeout=30.0)
    r = anon.delete(f"/stores/{store_id}")
    assert r.status_code == 401, r.text
    anon.close()

    # happy path delete
    r = owner_client.delete(f"/stores/{store_id}")
    assert r.status_code == 204, r.text

    # unknown id -> 404
    r = owner_client.delete(f"/stores/{store_id}")
    assert r.status_code == 404, r.text

    # store gone from public list
    r = owner_client.get("/public/stores")
    assert all(s["id"] != store_id for s in r.json())

    # order still visible under "Semua toko" (no store_id filter = all stores for owner)
    r = owner_client.get("/orders", params={"store_id": "all"})
    assert r.status_code == 200, r.text
    ids = [o["id"] for o in r.json()["orders"]]
    assert order["id"] in ids


def test_delete_store_unknown_id_404(owner_client):
    r = owner_client.delete(f"/stores/tscheck-nonexistent-{uuid.uuid4().hex}")
    assert r.status_code == 404, r.text
