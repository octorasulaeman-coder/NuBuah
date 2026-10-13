"""Bug fix: renaming a store's name/code updates existing orders' snapshot + order_no prefix."""
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


def test_store_rename_updates_order_prefix_and_snapshot(owner_client):
    suffix = uuid.uuid4().hex[:5].upper()
    code = f"R{suffix}"[:5]
    name = f"tscheck-rename-{suffix}"

    r = owner_client.post("/stores", json={"name": name, "code": code, "pin": "1357"})
    assert r.status_code == 201, r.text
    store = r.json()
    store_id = store["id"]

    try:
        r = owner_client.post(
            "/orders",
            json={
                "store_id": store_id,
                "lines": [{"product_id": "tscheck-prod", "name": "Tscheck Item", "unit_price": 10000, "qty": 1}],
                "payment_method": "cash",
            },
        )
        assert r.status_code == 201, r.text
        order = r.json()
        assert order["order_no"].startswith(f"{code}-")
        assert order["store_name"] == name

        new_suffix = uuid.uuid4().hex[:5].upper()
        new_code = f"N{new_suffix}"[:5]
        new_name = f"tscheck-renamed-{new_suffix}"
        r = owner_client.put(f"/stores/{store_id}", json={"name": new_name, "code": new_code})
        assert r.status_code == 200, r.text

        r = owner_client.get("/orders", params={"store_id": store_id})
        assert r.status_code == 200, r.text
        body = r.json()
        matches = [o for o in body["orders"] if o["id"] == order["id"]]
        assert len(matches) == 1, body
        updated = matches[0]
        assert updated["order_no"].startswith(f"{new_code}-"), updated["order_no"]
        assert updated["order_no"] == f"{new_code}-{order['order_no'][len(code) + 1:]}"
        assert updated["store_name"] == new_name
    finally:
        owner_client.delete(f"/stores/{store_id}")
