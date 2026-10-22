"""Focused service regression tests for refund accounting/idempotency.

These tests run without MongoDB by injecting a small in-memory async collection with the
atomic conditional-update behavior the service relies on. They are not a substitute for
the MongoDB integration suite, but they verify the service's own ordering guarantees:
ledger insert -> atomic capacity reservation -> provider call -> authoritative state.
"""

from __future__ import annotations

import asyncio
import copy
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace


# --- dependency stubs (must exist before importing lib.payments.service) ------------
class DuplicateKeyError(Exception):
    pass


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
    def __init__(self, matched=0, modified=0, deleted=0):
        self.matched_count = matched
        self.modified_count = modified
        self.deleted_count = deleted


def _matches(filter_doc, doc):
    if not filter_doc:
        return True
    for key, value in filter_doc.items():
        if key == "$or":
            if not any(_matches(sub, doc) for sub in value):
                return False
            continue
        if key == "$expr":
            continue  # evaluated separately by update_one for refund reservation
        current = doc.get(key)
        if isinstance(value, dict):
            for op, operand in value.items():
                if op == "$in" and current not in operand:
                    return False
                if op == "$ne" and current == operand:
                    return False
                if op == "$gte" and not (current is not None and current >= operand):
                    return False
                if op == "$gt" and not (current is not None and current > operand):
                    return False
                if op == "$lt" and not (current is not None and current < operand):
                    return False
                if op == "$lte" and not (current is not None and current <= operand):
                    return False
        elif current != value:
            return False
    return True


def _eval_expr(expr, doc):
    # only the refund-reservation expression shape used by the service
    if isinstance(expr, dict):
        if "$lte" in expr:
            left, right = expr["$lte"]
            return _eval_expr(left, doc) <= _eval_expr(right, doc)
        if "$add" in expr:
            total = 0
            for part in expr["$add"]:
                total += _eval_expr(part, doc)
            return total
        if "$ifNull" in expr:
            field, default = expr["$ifNull"]
            value = doc.get(field, default)
            return default if value is None else value
    if isinstance(expr, str) and expr.startswith("$"):
        return doc.get(expr[1:], 0)
    return expr


class FakeCollection:
    def __init__(self, name):
        self.name = name
        self.docs = {}

    async def insert_one(self, doc):
        doc = copy.deepcopy(doc)
        doc.setdefault("id", f"{self.name}-{len(self.docs) + 1}")
        if doc.get("id") in self.docs:
            raise DuplicateKeyError("duplicate id")
        if self.name == "refunds" and doc.get("idempotency_key"):
            for existing in self.docs.values():
                if (existing.get("attempt_id"), existing.get("idempotency_key")) == (doc.get("attempt_id"), doc.get("idempotency_key")):
                    raise DuplicateKeyError("duplicate refund idempotency key")
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
        return _Cursor([doc for doc in self.docs.values() if _matches(filter_doc or {}, doc)])

    async def update_one(self, filter_doc, update):
        for doc in list(self.docs.values()):
            if not _matches({k: v for k, v in (filter_doc or {}).items() if k != "$expr"}, doc):
                continue
            if "$expr" in (filter_doc or {}) and not _eval_expr(filter_doc["$expr"], doc):
                return _Result(0, 0)
            self._apply_update(doc, update)
            return _Result(1, 1)
        return _Result(0, 0)

    async def update_many(self, filter_doc, update):
        matched = 0
        for doc in list(self.docs.values()):
            if _matches(filter_doc or {}, doc):
                self._apply_update(doc, update)
                matched += 1
        return _Result(matched, matched)

    def _apply_update(self, doc, update):
        for key, value in (update or {}).get("$set", {}).items():
            doc[key] = value
        for key, delta in (update or {}).get("$inc", {}).items():
            doc[key] = int(doc.get(key) or 0) + int(delta)


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

from lib.payments.base import RefundResult, RefundStatus  # noqa: E402
from lib.payments import service  # noqa: E402
from lib.payments.service import PaymentProviderError  # noqa: E402
from models.payment import PAID, PaymentAttempt  # noqa: E402


class FakeAdapter(service.PaymentProviderAdapter if hasattr(service, "PaymentProviderAdapter") else object):
    name = "fake"

    def __init__(self, behavior="success"):
        self.behavior = behavior
        self.refund_status = "pending"
        self.request_calls = []
        self.status_calls = []

    async def request_refund(self, provider_ref, amount, reason, idempotency_key=None):
        self.request_calls.append((provider_ref, amount, reason, idempotency_key))
        if self.behavior == "exception":
            raise RuntimeError("provider call boundary crashed")
        if self.behavior == "failure":
            return RefundResult(ok=False, failure_code="rejected")
        if self.behavior in ("timeout", "ambiguous"):
            return RefundResult(ok=False, refund_ref="RF-AMBIGUOUS-1", failure_code="timeout")
        return RefundResult(ok=True, refund_ref=f"RF-{len(self.request_calls)}")

    async def get_refund_status(self, provider_ref, refund_ref=None):
        self.status_calls.append((provider_ref, refund_ref))
        return RefundStatus(status=self.refund_status, refund_ref=refund_ref or "RF-AMBIGUOUS-1")


class SameKeyRefundRaceCollection(FakeCollection):
    """Deterministically orchestrates the duplicate-key refund race.

    The first request inserts an in-flight row and pauses. The second request observes
    the in-flight unique key, raises DuplicateKeyError, and must recover the in-flight
    row without reserving capacity or calling the provider. Then the first request is
    allowed to finish.
    """

    def __init__(self, race_key="race-key"):
        super().__init__("refunds")
        self.race_key = race_key
        self.in_flight = None
        self.committed = False
        self.allow_recovery = False
        self.first_insert_inflight = asyncio.Event()
        self.second_insert_attempted = asyncio.Event()
        self.first_may_commit = asyncio.Event()

    @staticmethod
    def _has_race_key(filter_doc):
        return (filter_doc or {}).get("idempotency_key") == "race-key"

    async def find_one(self, filter_doc=None, projection=None, sort=None):
        if self._has_race_key(filter_doc):
            if self.in_flight is not None and self.allow_recovery:
                return copy.deepcopy(self.in_flight)
            if not self.committed:
                return None
        return await super().find_one(filter_doc, projection, sort)

    async def insert_one(self, doc):
        if doc.get("idempotency_key") == self.race_key:
            if self.in_flight is not None:
                self.allow_recovery = True
                self.second_insert_attempted.set()
                raise DuplicateKeyError("simulated same-key race")
            self.in_flight = copy.deepcopy(doc)
            self.first_insert_inflight.set()
            await self.first_may_commit.wait()
            self.committed = True
            self.docs[doc["id"]] = copy.deepcopy(self.in_flight)
            self.in_flight = None
            return SimpleNamespace(inserted_id=doc["id"])
        return await super().insert_one(doc)


def _fresh_db():
    fake = FakeDB()
    service.db = fake
    _lib_db.db = fake
    return fake


async def _paid_attempt(db, amount=50_000):
    att = PaymentAttempt(
        order_id="order-1", order_no="NB-0001", store_id="store-1", provider="fake",
        provider_ref="NBP-TEST-1", amount=amount, currency="IDR", method="qris",
        status=PAID, expires_at=datetime.now(timezone.utc) + timedelta(minutes=15),
        paid_at=datetime.now(timezone.utc),
    )
    await db.payment_attempts.insert_one(att.model_dump())
    return att


class RefundServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db = _fresh_db()
        self.attempt = await _paid_attempt(self.db)

    async def _refund_rows(self):
        return await self.db.refunds.find().to_list(100)

    async def test_full_refund(self):
        adapter = FakeAdapter("success")
        result = await service.request_refund("store-1", self.attempt.id, 50_000, "salah total", adapter,
                                              actor="kasir", idempotency_key="full-1")
        self.assertEqual(result.refunded_amount, 50_000)
        self.assertEqual(result.refund_status, "refunded")
        rows = await self._refund_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "succeeded")
        self.assertEqual(len(adapter.request_calls), 1)

    async def test_partial_refund(self):
        adapter = FakeAdapter("success")
        result = await service.request_refund("store-1", self.attempt.id, 20_000, "salah item", adapter,
                                              idempotency_key="part-1")
        self.assertEqual(result.refunded_amount, 20_000)
        self.assertEqual(result.refund_status, "partial")
        self.assertEqual(result.refund_reserved_amount, 20_000)

    async def test_multiple_partial_refunds(self):
        adapter = FakeAdapter("success")
        await service.request_refund("store-1", self.attempt.id, 20_000, "salah item 1", adapter, idempotency_key="p1")
        result = await service.request_refund("store-1", self.attempt.id, 30_000, "salah item 2", adapter,
                                              idempotency_key="p2")
        self.assertEqual(result.refunded_amount, 50_000)
        self.assertEqual(result.refund_status, "refunded")
        self.assertEqual(len(await self._refund_rows()), 2)

    async def test_over_refund_rejected(self):
        adapter = FakeAdapter("success")
        await service.request_refund("store-1", self.attempt.id, 40_000, "salah besar", adapter, idempotency_key="ok")
        with self.assertRaises(PaymentProviderError) as ctx:
            await service.request_refund("store-1", self.attempt.id, 20_000, "kebanyakan", adapter,
                                         idempotency_key="over")
        self.assertEqual(ctx.exception.code, "amount_exceeded")
        self.assertEqual(len(adapter.request_calls), 1)
        rows = await self._refund_rows()
        self.assertEqual(len(rows), 1)

    async def test_duplicate_refund_request_is_idempotent(self):
        adapter = FakeAdapter("success")
        first = await service.request_refund("store-1", self.attempt.id, 25_000, "salah item", adapter,
                                             idempotency_key="dup-1")
        second = await service.request_refund("store-1", self.attempt.id, 25_000, "salah item", adapter,
                                              idempotency_key="dup-1")
        self.assertEqual(first.id, second.id)
        self.assertEqual(second.refunded_amount, 25_000)
        self.assertEqual(len(adapter.request_calls), 1)
        self.assertEqual(len(await self._refund_rows()), 1)

    async def test_concurrent_refund_requests_cannot_over_refund(self):
        adapter = FakeAdapter("success")
        outcomes = await asyncio.gather(
            service.request_refund("store-1", self.attempt.id, 30_000, "partial satu", adapter),
            service.request_refund("store-1", self.attempt.id, 30_000, "partial dua", adapter),
            return_exceptions=True,
        )
        successes = [o for o in outcomes if not isinstance(o, PaymentProviderError)]
        failures = [o for o in outcomes if isinstance(o, PaymentProviderError)]
        self.assertEqual(len(successes), 1)
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0].code, "amount_exceeded")
        final = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        self.assertLessEqual(final["refunded_amount"], 50_000)
        self.assertLessEqual(final["refund_reserved_amount"], 50_000)
        self.assertEqual(len(adapter.request_calls), 1)

    async def _run_same_key_race(self, adapter):
        race_collection = SameKeyRefundRaceCollection("race-key")
        self.db._collections["refunds"] = race_collection
        task1 = asyncio.create_task(service.request_refund(
            "store-1", self.attempt.id, 20_000, "same logical refund", adapter,
            idempotency_key="race-key",
        ))
        await asyncio.sleep(0)  # let task1 reach the in-flight insert
        task2 = asyncio.create_task(service.request_refund(
            "store-1", self.attempt.id, 20_000, "same logical refund", adapter,
            idempotency_key="race-key",
        ))
        await asyncio.wait_for(race_collection.second_insert_attempted.wait(), timeout=2)
        race_collection.first_may_commit.set()
        return await asyncio.gather(task1, task2, return_exceptions=True)

    async def test_same_key_duplicate_race_creates_one_pending_reservation_and_provider_call(self):
        adapter = FakeAdapter("success")
        outcomes = await self._run_same_key_race(adapter)
        self.assertFalse(any(isinstance(o, PaymentProviderError) for o in outcomes), outcomes)
        self.assertEqual(len(adapter.request_calls), 1)
        self.assertEqual(adapter.status_calls, [])
        rows = await self.db.refunds.find().to_list(10)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "succeeded")
        final = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        self.assertEqual(final["refunded_amount"], 20_000)
        self.assertEqual(final["refund_reserved_amount"], 20_000)

    async def test_duplicate_pending_before_provider_call_does_not_query_status_or_reserve(self):
        adapter = FakeAdapter("success")
        # Dangerous provider probe: it would report success even though no refund has
        # been submitted. The service must not query it for an ordinary pending retry.
        adapter.refund_status = "succeeded"
        race_collection = SameKeyRefundRaceCollection("race-key")
        self.db._collections["refunds"] = race_collection

        task1 = asyncio.create_task(service.request_refund(
            "store-1", self.attempt.id, 20_000, "same logical refund", adapter,
            idempotency_key="race-key",
        ))
        await asyncio.wait_for(race_collection.first_insert_inflight.wait(), timeout=2)
        early = await service.request_refund(
            "store-1", self.attempt.id, 20_000, "same logical refund", adapter,
            idempotency_key="race-key",
        )
        self.assertEqual(early.id, self.attempt.id)
        self.assertEqual(adapter.request_calls, [])
        self.assertEqual(adapter.status_calls, [])
        self.assertEqual(race_collection.in_flight["status"], "pending")
        final_before_commit = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        self.assertEqual(final_before_commit["refund_reserved_amount"], 0)

        race_collection.first_may_commit.set()
        winner = await asyncio.wait_for(task1, timeout=2)
        self.assertEqual(winner.refunded_amount, 20_000)
        self.assertEqual(len(adapter.request_calls), 1)
        self.assertEqual(adapter.status_calls, [])
        rows = await self.db.refunds.find().to_list(10)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "succeeded")
        final = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        self.assertEqual(final["refund_reserved_amount"], 20_000)

    async def test_same_key_duplicate_race_does_not_duplicate_ambiguous_provider_refund(self):
        adapter = FakeAdapter("timeout")
        adapter.refund_status = "succeeded"  # must still not be queried for pending rows
        outcomes = await self._run_same_key_race(adapter)
        errors = [o for o in outcomes if isinstance(o, PaymentProviderError)]
        returns = [o for o in outcomes if not isinstance(o, PaymentProviderError)]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0].code, "refund_ambiguous")
        self.assertEqual(len(returns), 1)
        self.assertEqual(len(adapter.request_calls), 1)
        self.assertEqual(adapter.status_calls, [])
        rows = await self.db.refunds.find().to_list(10)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "ambiguous")
        final = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        self.assertEqual(final["refunded_amount"], 0)
        self.assertEqual(final["refund_reserved_amount"], 20_000)

    async def test_provider_call_boundary_exception_is_ambiguous_not_confirmed_outcome(self):
        adapter = FakeAdapter("exception")
        with self.assertRaises(PaymentProviderError) as ctx:
            await service.request_refund("store-1", self.attempt.id, 20_000, "boundary crash", adapter,
                                         idempotency_key="boundary-1")
        self.assertEqual(ctx.exception.code, "refund_ambiguous")
        rows = await self.db.refunds.find().to_list(10)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "ambiguous")
        self.assertEqual(rows[0]["failure_code"], "provider_exception")
        final = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        self.assertEqual(final["refunded_amount"], 0)
        self.assertEqual(final["refund_reserved_amount"], 20_000)
        self.assertEqual(len(adapter.request_calls), 1)

    async def test_provider_timeout_is_ambiguous_and_reconciled(self):
        adapter = FakeAdapter("timeout")
        with self.assertRaises(PaymentProviderError) as ctx:
            await service.request_refund("store-1", self.attempt.id, 30_000, "timeout refund", adapter,
                                         idempotency_key="timeout-1")
        self.assertEqual(ctx.exception.code, "refund_ambiguous")
        rows = await self._refund_rows()
        self.assertEqual(rows[0]["status"], "ambiguous")
        final = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        self.assertEqual(final["refund_reserved_amount"], 30_000)

        # A retry with the same key probes provider status instead of creating a second refund.
        await service.request_refund("store-1", self.attempt.id, 30_000, "timeout refund", adapter,
                                     idempotency_key="timeout-1")
        self.assertEqual(len(adapter.request_calls), 1)
        self.assertEqual(len(adapter.status_calls), 1)

        adapter.refund_status = "succeeded"
        reconciled = await service.refresh_refund(rows[0]["id"], adapter)
        self.assertEqual(reconciled.status, "succeeded")
        final = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        self.assertEqual(final["refunded_amount"], 30_000)

    async def test_failed_refund_releases_capacity(self):
        adapter = FakeAdapter("failure")
        with self.assertRaises(PaymentProviderError) as ctx:
            await service.request_refund("store-1", self.attempt.id, 30_000, "refund gagal", adapter,
                                         idempotency_key="fail-1")
        self.assertEqual(ctx.exception.code, "rejected")
        rows = await self._refund_rows()
        self.assertEqual(rows[0]["status"], "failed")
        final = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        self.assertEqual(final["refunded_amount"], 0)
        self.assertEqual(final["refund_reserved_amount"], 0)

    async def test_repeated_refund_confirmation_does_not_duplicate(self):
        adapter = FakeAdapter("success")
        await service.request_refund("store-1", self.attempt.id, 30_000, "confirm sekali", adapter,
                                     idempotency_key="confirm-1")
        rows = await self._refund_rows()
        once = await service.refresh_refund(rows[0]["id"], adapter)
        twice = await service.refresh_refund(rows[0]["id"], adapter)
        self.assertEqual(once.status, "succeeded")
        self.assertEqual(twice.status, "succeeded")
        self.assertEqual(len(adapter.request_calls), 1)
        final = await self.db.payment_attempts.find_one({"id": self.attempt.id})
        self.assertEqual(final["refunded_amount"], 30_000)


if __name__ == "__main__":
    unittest.main()
