"""Focused webhook/order-update tests for the payment service (no real MongoDB)."""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace


class DuplicateKeyError(Exception):
    pass


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

    def sort(self, key, direction=1):
        self._rows = sorted(self._rows, key=lambda row: row.get(key) or "", reverse=direction < 0)
        return self

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
                if op == "$lt" and not (current is not None and current < operand):
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
        if self.name == "payment_events" and doc.get("event_id"):
            for existing in self.docs.values():
                if existing.get("event_id") == doc.get("event_id"):
                    raise DuplicateKeyError("duplicate event")
        self.docs[doc["id"]] = doc
        return SimpleNamespace(inserted_id=doc["id"])

    async def find_one(self, filter_doc=None, projection=None, sort=None):
        for doc in self.docs.values():
            if _matches(filter_doc or {}, doc):
                return copy.deepcopy(doc)
        return None

    def find(self, filter_doc=None, projection=None):
        rows = [copy.deepcopy(doc) for doc in self.docs.values() if _matches(filter_doc or {}, doc)]
        if projection:
            include = {key for key, value in projection.items() if value and key != "_id"}
            exclude_id = projection.get("_id") == 0
            projected = []
            for row in rows:
                if include:
                    row = {key: value for key, value in row.items() if key in include}
                if exclude_id:
                    row.pop("_id", None)
                projected.append(row)
            rows = projected
        return _Cursor(rows)

    async def update_one(self, filter_doc, update):
        for doc in self.docs.values():
            if _matches(filter_doc or {}, doc):
                for key, value in (update or {}).get("$set", {}).items():
                    doc[key] = value
                for key, delta in (update or {}).get("$inc", {}).items():
                    doc[key] = int(doc.get(key) or 0) + int(delta)
                return _Result(1, 1)
        return _Result(0, 0)

    async def find_one_and_update(self, filter_doc, update, upsert=False, return_document=None):
        for doc in self.docs.values():
            if _matches(filter_doc or {}, doc):
                for key, value in (update or {}).get("$setOnInsert", {}).items():
                    doc.setdefault(key, value)
                for key, value in (update or {}).get("$set", {}).items():
                    doc[key] = value
                return copy.deepcopy(doc)
        if not upsert:
            return None
        doc = {"id": f"{self.name}-{len(self.docs) + 1}"}
        for key, value in (update or {}).get("$setOnInsert", {}).items():
            doc[key] = value
        for key, value in (update or {}).get("$set", {}).items():
            doc[key] = value
        self.docs[doc["id"]] = doc
        return copy.deepcopy(doc)

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

from lib.payments.base import VerifiedNotification  # noqa: E402
from lib.payments import service  # noqa: E402
from lib.payments.service import PaymentProviderError  # noqa: E402
from lib.payments.transitions import EXPIRED, FAILED, PAID, PENDING  # noqa: E402
from models.payment import PaymentAttempt  # noqa: E402


class SignedWebhookAdapter:
    name = "fake"

    def __init__(self):
        self.secret = b"test-secret"

    def sign(self, body: bytes) -> str:
        return hmac.new(self.secret, body, hashlib.sha256).hexdigest()

    def build(self, provider_ref: str, amount: int, raw_status: str, event_id: str,
              transaction_ref: str | None = "TX-1") -> tuple[dict, bytes]:
        body = json.dumps({
            "event_id": event_id,
            "provider_ref": provider_ref,
            "amount": amount,
            "currency": "IDR",
            "raw_status": raw_status,
            "transaction_ref": transaction_ref,
        }).encode()
        return {"x-signature": self.sign(body)}, body

    def verify_webhook(self, headers: dict, body: bytes) -> VerifiedNotification:
        signature = headers.get("x-signature", "")
        if not hmac.compare_digest(signature, self.sign(body)):
            return VerifiedNotification(valid=False, reason="bad signature")
        payload = json.loads(body.decode())
        return VerifiedNotification(
            valid=True,
            event_id=payload["event_id"],
            provider_ref=payload["provider_ref"],
            raw_status=payload.get("raw_status"),
            amount=payload.get("amount"),
            currency=payload.get("currency"),
            transaction_ref=payload.get("transaction_ref"),
        )

    def normalize_status(self, raw_status, failure_code=None):
        return {"PAID": PAID, "FAILED": FAILED, "PENDING": PENDING}.get(raw_status)


class FailOnceNormalizeAdapter(SignedWebhookAdapter):
    def __init__(self):
        super().__init__()
        self.fail_next = False

    def normalize_status(self, raw_status, failure_code=None):
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError("simulated crash after event claim")
        return super().normalize_status(raw_status, failure_code)


def _fresh_db():
    fake = FakeDB()
    service.db = fake
    _lib_db.db = fake
    # Some support modules captured the DB object at import time. Repoint those cached
    # module globals so each isolated async test uses its own fake DB.
    for module_name in ("lib.audit", "lib.customers", "lib.loyalty"):
        module = sys.modules.get(module_name)
        if module is not None and hasattr(module, "db"):
            module.db = fake
    return fake


def _order_doc(order_id="order-1", store_id="store-1", total=50_000, payment_status="pending", status="received"):
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
        "customer_phone": "08123456789",
        "customer_name": "Test Customer",
        "channel": "customer",
        "fulfillment": "immediate",
        "status": status,
    }


async def _seed_order_and_attempt(db, *, status=PENDING, expires_at=None):
    await db.orders.insert_one(_order_doc())
    attempt = PaymentAttempt(
        order_id="order-1", order_no="NB-R-1", store_id="store-1", provider="fake",
        provider_ref="NBP-REF-1", amount=50_000, currency="IDR", method="qris",
        status=status, expires_at=expires_at or (datetime.now(timezone.utc) + timedelta(minutes=10)),
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    await db.payment_attempts.insert_one(attempt.model_dump())
    return attempt


class PaymentWebhookTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db = _fresh_db()
        self.adapter = SignedWebhookAdapter()
        self.attempt = await _seed_order_and_attempt(self.db)
        await self.db.customers.insert_one({
            "id": "customer-1", "store_id": "store-1", "name": "Test Customer",
            "phone": "08123456789", "is_member": True, "points": 0,
            "created_at": datetime.now(timezone.utc), "updated_at": datetime.now(timezone.utc),
        })
        await self.db.stores.insert_one({
            "id": "store-1",
            "loyalty": {"enabled": True, "earn_per_10000": 1, "minimum_spend": 0, "redemption_value": 1},
        })

    async def _notification(self, raw_status="PAID", event_id="evt-1", amount=50_000, tx="TX-1"):
        headers, body = self.adapter.build(self.attempt.provider_ref, amount, raw_status, event_id, tx)
        verified = self.adapter.verify_webhook(headers, body)
        self.assertTrue(verified.valid)
        return verified

    async def test_forged_webhook_is_rejected_and_has_no_effect(self):
        headers, body = self.adapter.build(self.attempt.provider_ref, 50_000, "PAID", "evt-forged")
        headers["x-signature"] = "0" * 64
        status, message = await service.handle_webhook("fake", headers, body, self.adapter)
        self.assertEqual(status, "rejected")
        self.assertEqual(message, "bad signature")
        attempt = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        order = await self.db.orders.find_one({"id": "order-1"})
        self.assertEqual(attempt["status"], PENDING)
        self.assertEqual(order["payment_status"], "pending")

    async def test_valid_paid_webhook_marks_order_paid_once(self):
        first = await service.handle_webhook("fake", *self.adapter.build(self.attempt.provider_ref, 50_000, "PAID", "evt-paid"), self.adapter)
        self.assertEqual(first[0], "applied")
        attempt = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        order = await self.db.orders.find_one({"id": "order-1"})
        self.assertEqual(attempt["status"], PAID)
        self.assertEqual(order["payment_status"], PAID)
        points = await self.db.points_ledger.find({"order_id": "order-1"}).to_list(10)
        self.assertEqual(len(points), 1)

        second = await service.handle_webhook("fake", *self.adapter.build(self.attempt.provider_ref, 50_000, "PAID", "evt-paid"), self.adapter)
        self.assertEqual(second[0], "duplicate")
        points = await self.db.points_ledger.find({"order_id": "order-1"}).to_list(10)
        self.assertEqual(len(points), 1)

    async def test_amount_mismatch_is_rejected(self):
        status, message = await service.handle_webhook("fake", *self.adapter.build(self.attempt.provider_ref, 49_999, "PAID", "evt-amount"), self.adapter)
        self.assertEqual(status, "rejected")
        self.assertEqual(message, "amount_mismatch")
        attempt = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        self.assertEqual(attempt["status"], PENDING)

    async def test_unknown_provider_status_requires_review(self):
        result = await service.apply_notification(await self._notification(raw_status="WHAT", event_id="evt-unknown"), "store-1", self.adapter)
        self.assertEqual(result["status"], "ambiguous")
        attempt = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        self.assertTrue(attempt["needs_review"])

    async def test_failure_then_success_out_of_order_is_allowed(self):
        failed = await service.apply_notification(await self._notification(raw_status="FAILED", event_id="evt-fail"), "store-1", self.adapter)
        self.assertEqual(failed["status"], "applied")
        paid = await service.apply_notification(await self._notification(raw_status="PAID", event_id="evt-success"), "store-1", self.adapter)
        self.assertEqual(paid["status"], "applied")
        attempt = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        order = await self.db.orders.find_one({"id": "order-1"})
        self.assertEqual(attempt["status"], PAID)
        self.assertEqual(order["payment_status"], PAID)

    async def test_late_success_after_expiry_is_flagged_and_reconciled(self):
        past = datetime.now(timezone.utc) - timedelta(minutes=5)
        await self.db.payment_attempts.update_one({"id": self.attempt.id}, {"$set": {"status": EXPIRED, "expires_at": past}})
        result = await service.apply_notification(await self._notification(raw_status="PAID", event_id="evt-late"), "store-1", self.adapter)
        self.assertEqual(result["status"], "applied")
        attempt = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        order = await self.db.orders.find_one({"id": "order-1"})
        self.assertEqual(attempt["status"], PAID)
        self.assertTrue(attempt["late_payment"])
        self.assertEqual(order["payment_status"], PAID)

    async def test_wrong_store_scope_is_ignored(self):
        result = await service.apply_notification(await self._notification(), "store-2", self.adapter)
        self.assertEqual(result["status"], "ignored")
        attempt = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        self.assertEqual(attempt["status"], PENDING)

    async def test_paid_attempt_with_lost_order_update_is_reconciled_by_poll(self):
        await self.db.payment_attempts.update_one({"id": self.attempt.id}, {"$set": {"status": PAID}})
        # order intentionally remains pending
        public = await service.refresh_status(self.attempt.id, "store-1", self.adapter)
        self.assertEqual(public.status, PAID)
        order = await self.db.orders.find_one({"id": "order-1"})
        self.assertEqual(order["payment_status"], PAID)

    async def test_failed_processing_is_recoverable_without_duplicate_side_effects(self):
        adapter = FailOnceNormalizeAdapter()
        adapter.fail_next = True
        first = await service.handle_webhook("fake", *adapter.build(self.attempt.provider_ref, 50_000, "PAID", "evt-recover"), adapter)
        self.assertEqual(first[0], "failed")
        event = await self.db.payment_events.find_one({"event_id": "evt-recover"})
        self.assertEqual(event["status"], "failed")
        self.assertEqual(event["failure_code"], "processing_error:RuntimeError")
        self.assertTrue(event["retryable"])
        self.assertEqual(event["processing_attempts"], 1)

        past = datetime.now(timezone.utc) - timedelta(seconds=1)
        await self.db.payment_events.update_one({"event_id": "evt-recover"}, {"$set": {"next_retry_at": past}})
        second = await service.handle_webhook("fake", *adapter.build(self.attempt.provider_ref, 50_000, "PAID", "evt-recover"), adapter)
        self.assertEqual(second[0], "applied")
        event = await self.db.payment_events.find_one({"event_id": "evt-recover"})
        self.assertEqual(event["status"], "processed")
        self.assertEqual(event["processing_attempts"], 2)
        order = await self.db.orders.find_one({"id": "order-1"})
        self.assertEqual(order["payment_status"], PAID)
        self.assertEqual(len(await self.db.points_ledger.find({"order_id": "order-1"}).to_list(10)), 1)

    async def test_concurrent_duplicate_delivery_does_not_double_process_locked_event(self):
        future = datetime.now(timezone.utc) + timedelta(minutes=5)
        await self.db.payment_events.insert_one({
            "id": "event-lock-1", "event_id": "evt-locked", "provider": "fake",
            "provider_ref": self.attempt.provider_ref, "attempt_id": self.attempt.id,
            "order_id": "order-1", "store_id": "store-1", "status": "processing",
            "processing_attempts": 1, "locked_until": future,
            "received_at": datetime.now(timezone.utc), "updated_at": datetime.now(timezone.utc),
        })
        result = await service.apply_notification(await self._notification(event_id="evt-locked"), "store-1", self.adapter)
        self.assertEqual(result["status"], "processing")
        event = await self.db.payment_events.find_one({"event_id": "evt-locked"})
        self.assertEqual(event["processing_attempts"], 1)
        attempt = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        self.assertEqual(attempt["status"], PENDING)

    async def test_crash_after_side_effects_before_event_finalization_converges(self):
        applied = await service.handle_webhook("fake", *self.adapter.build(self.attempt.provider_ref, 50_000, "PAID", "evt-crash-final"), self.adapter)
        self.assertEqual(applied[0], "applied")
        past = datetime.now(timezone.utc) - timedelta(seconds=1)
        await self.db.payment_events.update_one({"event_id": "evt-crash-final"}, {"$set": {
            "status": "processing", "processed_at": None, "locked_until": past,
            "processing_attempts": 1, "retryable": True,
        }})
        replay = await service.handle_webhook("fake", *self.adapter.build(self.attempt.provider_ref, 50_000, "PAID", "evt-crash-final"), self.adapter)
        self.assertEqual(replay[0], "duplicate")
        event = await self.db.payment_events.find_one({"event_id": "evt-crash-final"})
        self.assertEqual(event["status"], "processed")
        self.assertEqual(len(await self.db.points_ledger.find({"order_id": "order-1"}).to_list(10)), 1)

    async def test_bounded_retries_require_manual_reconciliation(self):
        await self.db.payment_events.insert_one({
            "id": "event-manual-1", "event_id": "evt-manual", "provider": "fake",
            "provider_ref": self.attempt.provider_ref, "attempt_id": self.attempt.id,
            "order_id": "order-1", "store_id": "store-1", "status": "failed",
            "processing_attempts": 3, "retryable": True, "manual_reconciliation_required": False,
            "next_retry_at": datetime.now(timezone.utc) - timedelta(seconds=1),
            "received_at": datetime.now(timezone.utc), "updated_at": datetime.now(timezone.utc),
        })
        result = await service.apply_notification(await self._notification(event_id="evt-manual"), "store-1", self.adapter)
        self.assertEqual(result["status"], "manual")
        event = await self.db.payment_events.find_one({"event_id": "evt-manual"})
        self.assertTrue(event["manual_reconciliation_required"])
        self.assertFalse(event["retryable"])
        attention = await service.list_events_needing_attention("store-1")
        self.assertIn("evt-manual", {row["event_id"] for row in attention})

    async def test_missing_mandatory_fields_is_rejected_and_preserved(self):
        payload = {
            "event_id": "evt-missing", "provider_ref": self.attempt.provider_ref,
            "raw_status": "PAID", "transaction_ref": "TX-MISSING",
        }
        body = json.dumps(payload).encode()
        headers = {"x-signature": self.adapter.sign(body)}
        status, message = await service.handle_webhook("fake", headers, body, self.adapter)
        self.assertEqual(status, "rejected")
        self.assertTrue(message.startswith("missing_fields:"))
        event = await self.db.payment_events.find_one({"event_id": "evt-missing"})
        self.assertEqual(event["status"], "failed")
        self.assertEqual(event["failure_code"], "missing_fields")
        self.assertTrue(event["manual_reconciliation_required"])

    async def test_duplicate_provider_reference_is_rejected_without_side_effects(self):
        other = PaymentAttempt(
            order_id="order-other", order_no="NB-O-1", store_id="store-1", provider="fake",
            provider_ref=self.attempt.provider_ref, amount=50_000, currency="IDR", method="qris",
            status=PENDING, expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
        )
        await self.db.payment_attempts.insert_one(other.model_dump())
        status, message = await service.handle_webhook("fake", *self.adapter.build(self.attempt.provider_ref, 50_000, "PAID", "evt-dupe-ref"), self.adapter)
        self.assertEqual(status, "rejected")
        self.assertEqual(message, "duplicate_provider_ref")
        event = await self.db.payment_events.find_one({"event_id": "evt-dupe-ref"})
        self.assertEqual(event["failure_code"], "duplicate_provider_ref")
        order = await self.db.orders.find_one({"id": "order-1"})
        self.assertEqual(order["payment_status"], "pending")

    async def test_payment_after_cancellation_is_recorded_and_flagged_for_review(self):
        await self.db.orders.update_one({"id": "order-1"}, {"$set": {"status": "cancelled"}})
        result = await service.handle_webhook("fake", *self.adapter.build(self.attempt.provider_ref, 50_000, "PAID", "evt-late-cancel"), self.adapter)
        self.assertEqual(result[0], "applied")
        attempt = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        order = await self.db.orders.find_one({"id": "order-1"})
        self.assertEqual(attempt["status"], PAID)
        self.assertTrue(attempt["needs_review"])
        self.assertEqual(attempt["failure_code"], "order_cancelled")
        self.assertEqual(order["status"], "cancelled")
        self.assertEqual(order["payment_status"], "pending")

    async def test_failure_after_confirmed_success_does_not_overwrite_paid(self):
        paid = await service.handle_webhook("fake", *self.adapter.build(self.attempt.provider_ref, 50_000, "PAID", "evt-paid-first"), self.adapter)
        self.assertEqual(paid[0], "applied")
        failed = await service.handle_webhook("fake", *self.adapter.build(self.attempt.provider_ref, 50_000, "FAILED", "evt-failed-later"), self.adapter)
        self.assertEqual(failed[0], "duplicate")
        attempt = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        order = await self.db.orders.find_one({"id": "order-1"})
        self.assertEqual(attempt["status"], PAID)
        self.assertEqual(order["payment_status"], PAID)

    async def test_review_projection_excludes_bson_id_and_internal_fields(self):
        class FakeObjectId:
            def __repr__(self):
                return "ObjectId('656565656565656565656565')"

        await self.db.payment_events.insert_one({
            "_id": FakeObjectId(),
            "id": "event-public-1",
            "event_id": "evt-public-review",
            "provider": "fake",
            "provider_ref": self.attempt.provider_ref,
            "attempt_id": self.attempt.id,
            "order_id": "order-1",
            "store_id": "store-1",
            "raw_status": "PAID",
            "amount": 50_000,
            "currency": "IDR",
            "status": "failed",
            "failure_code": "unknown_status",
            "retryable": False,
            "manual_reconciliation_required": True,
            "internal_raw_payload": {"should": "not leak"},
            "updated_at": datetime.now(timezone.utc),
        })
        rows = await service.list_events_needing_attention("store-1")
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertNotIn("_id", row)
        self.assertNotIn("internal_raw_payload", row)
        self.assertEqual(row["event_id"], "evt-public-review")
        self.assertEqual(row["manual_reconciliation_required"], True)


if __name__ == "__main__":
    unittest.main()
