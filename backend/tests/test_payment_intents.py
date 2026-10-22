"""Focused payment-intent idempotency/concurrency tests (isolated, no real MongoDB).

These tests prove the service ordering and conflict behavior against an in-memory async
collection. They do NOT prove MongoDB's unique-index or concurrency guarantees; run the
MongoDB integration suite when a database is available.
"""

from __future__ import annotations

import asyncio
import copy
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace


class DuplicateKeyError(Exception):
    pass


# When run together with other focused tests, the service may already have imported a
# pymongo.errors stub from another test module. Reuse that exact exception class so
# service except-clauses catch our simulated duplicate-key race.
_existing_pymongo_errors = sys.modules.get("pymongo.errors")
if _existing_pymongo_errors is not None and hasattr(_existing_pymongo_errors, "DuplicateKeyError"):
    DuplicateKeyError = _existing_pymongo_errors.DuplicateKeyError

_pymongo = types.ModuleType("pymongo")
_pymongo_errors = types.ModuleType("pymongo.errors")
_pymongo_errors.DuplicateKeyError = DuplicateKeyError
_pymongo.errors = _pymongo_errors
_pymongo.ReturnDocument = SimpleNamespace(BEFORE=1, AFTER=2)
sys.modules.setdefault("pymongo", _pymongo)
sys.modules.setdefault("pymongo.errors", _pymongo_errors)


class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    async def to_list(self, length):
        return [copy.deepcopy(r) for r in self._rows[:length]]


class _Result:
    def __init__(self, matched=0, modified=0):
        self.matched_count = matched
        self.modified_count = modified


def _matches(filter_doc, doc):
    for key, value in (filter_doc or {}).items():
        if key == "$or":
            if not any(_matches(sub, doc) for sub in value):
                return False
            continue
        current = doc.get(key)
        if isinstance(value, dict):
            for op, operand in value.items():
                if op == "$in" and current not in operand:
                    return False
                if op == "$ne" and current == operand:
                    return False
                if op == "$gte" and not (current is not None and current >= operand):
                    return False
        elif current != value:
            return False
    return True


class FakeCollection:
    def __init__(self, name):
        self.name = name
        self.docs = {}

    async def insert_one(self, doc):
        doc = copy.deepcopy(doc)
        doc.setdefault("id", f"{self.name}-{len(self.docs) + 1}")
        if doc.get("id") in self.docs:
            raise DuplicateKeyError("duplicate id")
        if self.name == "payment_attempts" and doc.get("idempotency_key"):
            for existing in self.docs.values():
                if (existing.get("store_id"), existing.get("idempotency_key")) == (doc.get("store_id"), doc.get("idempotency_key")):
                    raise DuplicateKeyError("duplicate payment intent key")
        self.docs[doc["id"]] = doc
        return SimpleNamespace(inserted_id=doc["id"])

    async def find_one(self, filter_doc=None, projection=None, sort=None):
        for doc in self.docs.values():
            if _matches(filter_doc or {}, doc):
                return copy.deepcopy(doc)
        return None

    def find(self, filter_doc=None, projection=None):
        return _Cursor([doc for doc in self.docs.values() if _matches(filter_doc or {}, doc)])

    async def update_one(self, filter_doc, update):
        for doc in self.docs.values():
            if _matches(filter_doc or {}, doc):
                for key, value in (update or {}).get("$set", {}).items():
                    doc[key] = value
                for key, delta in (update or {}).get("$inc", {}).items():
                    doc[key] = int(doc.get(key) or 0) + int(delta)
                return _Result(1, 1)
        return _Result(0, 0)

    async def update_many(self, filter_doc, update):
        matched = 0
        for doc in self.docs.values():
            if _matches(filter_doc or {}, doc):
                for key, value in (update or {}).get("$set", {}).items():
                    doc[key] = value
                matched += 1
        return _Result(matched, matched)


class FakeDB:
    def __init__(self):
        self._collections = {}

    def __getattr__(self, name):
        self._collections.setdefault(name, FakeCollection(name))
        return self._collections[name]


_fake_db = FakeDB()
_lib_db = types.ModuleType("lib.db")
_lib_db.db = _fake_db
sys.modules["lib.db"] = _lib_db

from lib.payments.base import CreateResult, ProviderStatus  # noqa: E402
from lib.payments import service  # noqa: E402
from lib.payments.service import PaymentProviderError  # noqa: E402
from lib.payments.transitions import FAILED, PAID, PENDING  # noqa: E402


class FakeAdapter:
    def __init__(self, name="fake", behavior="success", failure_code=None):
        self.name = name
        self.behavior = behavior  # success|failure|timeout|raise
        self.failure_code = failure_code
        self.status_behavior = "pending"  # pending|paid|failed
        self.create_calls = []

    async def create_payment(self, req):
        self.create_calls.append(req)
        if self.behavior == "raise":
            raise ConnectionError("provider connection dropped after request was sent")
        if self.behavior in ("failure", "timeout"):
            return CreateResult(ok=False, provider_ref=req.provider_ref,
                                failure_code=self.failure_code or ("timeout" if self.behavior == "timeout" else "rejected"))
        return CreateResult(ok=True, provider_ref=req.provider_ref, qr_payload=f"QR:{req.provider_ref}")

    async def get_payment_status(self, provider_ref):
        return ProviderStatus(
            raw_status={"paid": "PAID", "failed": "FAILED"}.get(self.status_behavior, "UNKNOWN"),
            transaction_ref="TX-1" if self.status_behavior == "paid" else None,
        )

    def normalize_status(self, raw_status, failure_code=None):
        return {"PAID": PAID, "FAILED": FAILED, "PENDING": PENDING}.get(raw_status)


class RaceRecoveryCollection(FakeCollection):
    """Simulates a duplicate-key race: pre-check misses, insert loses, recovery succeeds."""

    def __init__(self):
        super().__init__("payment_attempts")
        self.raced = False
        self.winner = None

    async def find_one(self, filter_doc=None, projection=None, sort=None):
        if self.raced and self.winner and _matches(filter_doc or {}, self.winner):
            return copy.deepcopy(self.winner)
        return await super().find_one(filter_doc, projection, sort)

    async def insert_one(self, doc):
        if doc.get("idempotency_key") == "race-key" and not self.raced:
            self.raced = True
            self.winner = copy.deepcopy(doc)
            raise DuplicateKeyError("simulated duplicate key")
        return await super().insert_one(doc)


def _fresh_db():
    fake = FakeDB()
    service.db = fake
    _lib_db.db = fake
    return fake


def _order_doc(order_id, store_id, total=50_000, *, status="received", payment_status="pending"):
    return {
        "id": order_id,
        "order_no": f"NB-{order_id[-4:].upper()}",
        "business_date": "2026-10-22",
        "store_id": store_id,
        "store_name": "NuBuah",
        "lines": [{"product_id": "p1", "name": "Product", "unit_price": total, "qty": 1, "line_total": total}],
        "item_count": 1,
        "total": total,
        "payment_method": "qris",
        "payment_status": payment_status,
        "channel": "customer",
        "fulfillment": "immediate",
        "status": status,
    }


async def _seed_order(db, *args, **kwargs):
    doc = _order_doc(*args, **kwargs)
    await db.orders.insert_one(doc)
    return doc


class PaymentIntentIdempotencyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db = _fresh_db()
        self.order = await _seed_order(self.db, "order-1", "store-1")
        self.adapter = FakeAdapter()

    async def _attempts(self):
        return await self.db.payment_attempts.find().to_list(100)

    async def test_identical_key_and_identical_request_returns_same_attempt(self):
        first = await service.create_intent("order-1", "store-1", self.adapter, idempotency_key="same-key")
        second = await service.create_intent("order-1", "store-1", self.adapter, idempotency_key="same-key")
        self.assertEqual(first.id, second.id)
        self.assertEqual(len(await self._attempts()), 1)
        self.assertEqual(len(self.adapter.create_calls), 1)
        self.assertEqual(first.provider_idempotency_key, first.provider_ref)
        order = await self.db.orders.find_one({"id": "order-1"})
        self.assertEqual(order["payment_status"], "pending")

    async def test_identical_key_for_different_order_conflicts(self):
        await _seed_order(self.db, "order-2", "store-1", total=60_000)
        await service.create_intent("order-1", "store-1", self.adapter, idempotency_key="shared")
        with self.assertRaises(PaymentProviderError) as ctx:
            await service.create_intent("order-2", "store-1", self.adapter, idempotency_key="shared")
        self.assertEqual(ctx.exception.code, "idempotency_conflict")
        self.assertEqual(len(self.adapter.create_calls), 1)

    async def test_same_key_is_isolated_across_stores(self):
        await _seed_order(self.db, "order-2", "store-2", total=60_000)
        first = await service.create_intent("order-1", "store-1", self.adapter, idempotency_key="store-scoped")
        second = await service.create_intent("order-2", "store-2", self.adapter, idempotency_key="store-scoped")
        self.assertNotEqual(first.id, second.id)
        self.assertEqual(first.store_id, "store-1")
        self.assertEqual(second.store_id, "store-2")
        self.assertEqual(len(await self._attempts()), 2)

    async def test_same_key_with_changed_amount_currency_provider_or_payload_conflicts(self):
        created = await service.create_intent("order-1", "store-1", self.adapter, idempotency_key="payload-key")
        row = await self.db.payment_attempts.find_one({"id": created.id})

        changed_amount = copy.deepcopy(row)
        changed_amount["amount"] = 45_000
        self.db.payment_attempts.docs[created.id] = changed_amount
        with self.assertRaises(PaymentProviderError) as amount_ctx:
            await service.create_intent("order-1", "store-1", self.adapter, idempotency_key="payload-key")
        self.assertEqual(amount_ctx.exception.code, "idempotency_conflict")

        self.db.payment_attempts.docs[created.id] = copy.deepcopy(row)
        changed_currency = copy.deepcopy(row)
        changed_currency["currency"] = "USD"
        self.db.payment_attempts.docs[created.id] = changed_currency
        with self.assertRaises(PaymentProviderError) as currency_ctx:
            await service.create_intent("order-1", "store-1", self.adapter, idempotency_key="payload-key")
        self.assertEqual(currency_ctx.exception.code, "idempotency_conflict")

        self.db.payment_attempts.docs[created.id] = copy.deepcopy(row)
        with self.assertRaises(PaymentProviderError) as provider_ctx:
            await service.create_intent("order-1", "store-1", FakeAdapter("other-provider"),
                                        idempotency_key="payload-key")
        self.assertEqual(provider_ctx.exception.code, "idempotency_conflict")

        self.db.payment_attempts.docs[created.id] = copy.deepcopy(row)
        changed_method = copy.deepcopy(row)
        changed_method["method"] = "card"
        self.db.payment_attempts.docs[created.id] = changed_method
        with self.assertRaises(PaymentProviderError) as payload_ctx:
            await service.create_intent("order-1", "store-1", self.adapter, idempotency_key="payload-key")
        self.assertEqual(payload_ctx.exception.code, "idempotency_conflict")

    async def test_concurrent_identical_requests_converge_on_one_attempt(self):
        results = await asyncio.gather(*[
            service.create_intent("order-1", "store-1", self.adapter, idempotency_key="concurrent")
            for _ in range(5)
        ])
        self.assertEqual(len({a.id for a in results}), 1)
        self.assertEqual(len(await self._attempts()), 1)
        self.assertEqual(len(self.adapter.create_calls), 1)

    async def test_duplicate_key_race_recovers_and_validates_winner(self):
        race_collection = RaceRecoveryCollection()
        self.db._collections["payment_attempts"] = race_collection
        result = await service.create_intent("order-1", "store-1", self.adapter, idempotency_key="race-key")
        self.assertTrue(race_collection.raced)
        self.assertEqual(result.order_id, "order-1")
        self.assertEqual(result.idempotency_key, "race-key")

    async def test_provider_timeout_after_possible_creation_stays_ambiguous(self):
        adapter = FakeAdapter(behavior="timeout")
        with self.assertRaises(PaymentProviderError) as ctx:
            await service.create_intent("order-1", "store-1", adapter, idempotency_key="timeout-key")
        self.assertEqual(ctx.exception.code, "payment_ambiguous")
        row = (await self._attempts())[0]
        self.assertEqual(row["status"], FAILED)
        self.assertTrue(row["needs_review"])
        self.assertTrue(row["provider_attempted"])

        retry = await service.create_intent("order-1", "store-1", adapter, idempotency_key="timeout-key")
        self.assertEqual(retry.id, row["id"])
        self.assertEqual(len(adapter.create_calls), 1)

    async def test_safe_retry_after_confirmed_pre_creation_failure(self):
        adapter = FakeAdapter(behavior="failure", failure_code="rejected")
        with self.assertRaises(PaymentProviderError) as ctx:
            await service.create_intent("order-1", "store-1", adapter)
        self.assertEqual(ctx.exception.code, "rejected")
        self.assertEqual(len(await self._attempts()), 1)

        adapter.behavior = "success"
        retry = await service.create_intent("order-1", "store-1", adapter)
        self.assertEqual(len(await self._attempts()), 2)
        self.assertEqual(len(adapter.create_calls), 2)
        self.assertNotEqual((await self._attempts())[0]["id"], retry.id)

    async def test_provider_response_loss_is_reconciled_to_paid(self):
        adapter = FakeAdapter(behavior="raise")
        with self.assertRaises(PaymentProviderError) as ctx:
            await service.create_intent("order-1", "store-1", adapter, idempotency_key="lost-response")
        self.assertEqual(ctx.exception.code, "payment_ambiguous")

        adapter.status_behavior = "paid"
        attempt_id = (await self._attempts())[0]["id"]
        public = await service.refresh_status(attempt_id, "store-1", adapter)
        self.assertEqual(public.status, PAID)
        order = await self.db.orders.find_one({"id": "order-1"})
        self.assertEqual(order["payment_status"], PAID)

    async def test_existing_order_and_payment_state_protections(self):
        with self.assertRaises(PaymentProviderError) as wrong_store:
            await service.create_intent("order-1", "store-2", self.adapter)
        self.assertEqual(wrong_store.exception.code, "order_not_found")

        await self.db.orders.update_one({"id": "order-1"}, {"$set": {"payment_status": PAID}})
        with self.assertRaises(PaymentProviderError) as paid:
            await service.create_intent("order-1", "store-1", self.adapter)
        self.assertEqual(paid.exception.code, "order_already_paid")

        await self.db.orders.update_one({"id": "order-1"}, {"$set": {"payment_status": "pending", "status": "cancelled"}})
        with self.assertRaises(PaymentProviderError) as cancelled:
            await service.create_intent("order-1", "store-1", self.adapter)
        self.assertEqual(cancelled.exception.code, "order_cancelled")

        await self.db.orders.update_one({"id": "order-1"}, {"$set": {"status": "completed"}})
        with self.assertRaises(PaymentProviderError) as completed:
            await service.create_intent("order-1", "store-1", self.adapter)
        self.assertEqual(completed.exception.code, "order_completed")


if __name__ == "__main__":
    unittest.main()
