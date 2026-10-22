"""Unit tests for pure payment migration-check helpers (no Mongo required)."""

import unittest

from lib.payments.migration_checks import (
    duplicate_intent_key_groups,
    duplicate_refund_key_groups,
    missing_required_indexes,
)


class MigrationCheckTests(unittest.TestCase):
    def test_missing_required_indexes(self):
        self.assertEqual(missing_required_indexes([], "payment_attempts"), [
            "pay_id", "pay_order", "pay_provider_ref", "pay_store_idem", "pay_store_status",
        ])
        self.assertEqual(missing_required_indexes([], "payment_events"), [
            "payev_id", "payev_manual", "payev_order", "payev_ref", "payev_retry_due",
            "payev_status_updated", "payev_store_proc",
        ])
        self.assertEqual(
            missing_required_indexes({"pay_id", "pay_store_idem", "x"}, "payment_attempts"),
            ["pay_order", "pay_provider_ref", "pay_store_status"],
        )

    def test_duplicate_intent_key_groups_detect_conflicting_payloads(self):
        rows = [
            {"id": "a1", "store_id": "s1", "idempotency_key": "k", "order_id": "o1", "amount": 50000, "currency": "IDR", "method": "qris", "provider": "mock", "request_fingerprint": "f1"},
            {"id": "a2", "store_id": "s1", "idempotency_key": "k", "order_id": "o1", "amount": 50000, "currency": "IDR", "method": "qris", "provider": "mock", "request_fingerprint": "f2"},
        ]
        groups = duplicate_intent_key_groups(rows)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["rows"], 2)
        self.assertEqual(groups[0]["distinct_payloads"], 2)

    def test_identical_intent_key_groups_are_safe(self):
        rows = [
            {"id": "a1", "store_id": "s1", "idempotency_key": "k", "order_id": "o1", "amount": 50000, "currency": "IDR", "method": "qris", "provider": "mock", "request_fingerprint": "f1"},
            {"id": "a2", "store_id": "s1", "idempotency_key": "k", "order_id": "o1", "amount": 50000, "currency": "IDR", "method": "qris", "provider": "mock", "request_fingerprint": "f1"},
        ]
        # The service's DB uniqueness should prevent this, but if it ever happens the
        # rows are not conflicting; the check still reports duplicate rows for cleanup.
        groups = duplicate_intent_key_groups(rows)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["distinct_payloads"], 1)

    def test_cross_store_same_key_is_not_flagged(self):
        rows = [
            {"id": "a1", "store_id": "s1", "idempotency_key": "k", "order_id": "o1", "amount": 50000, "currency": "IDR", "method": "qris", "provider": "mock", "request_fingerprint": "f1"},
            {"id": "a2", "store_id": "s2", "idempotency_key": "k", "order_id": "o2", "amount": 60000, "currency": "IDR", "method": "qris", "provider": "mock", "request_fingerprint": "f2"},
        ]
        self.assertEqual(duplicate_intent_key_groups(rows), [])

    def test_duplicate_refund_key_groups_detect_conflicting_payloads(self):
        rows = [
            {"id": "r1", "attempt_id": "a1", "idempotency_key": "k", "amount": 10000, "currency": "IDR", "reason": "salah", "status": "succeeded"},
            {"id": "r2", "attempt_id": "a1", "idempotency_key": "k", "amount": 20000, "currency": "IDR", "reason": "salah", "status": "pending"},
        ]
        groups = duplicate_refund_key_groups(rows)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["distinct_payloads"], 2)


if __name__ == "__main__":
    unittest.main()
