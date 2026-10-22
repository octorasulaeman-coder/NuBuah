"""Pure regression tests for refund accounting policy (no Mongo/provider required)."""

import unittest

from lib.payments.refund_rules import (
    REFUND_AMBIGUOUS,
    REFUND_FAILED,
    REFUND_SUCCEEDED,
    RefundValidationError,
    classify_refund_result,
    refundable_balance,
    same_refund_request,
    summarize_refund_status,
    validate_refund_request,
)


class RefundBalanceTests(unittest.TestCase):
    def test_full_refund_balance(self):
        self.assertEqual(refundable_balance(50_000, refunded_amount=0, reserved_amount=0), 50_000)

    def test_partial_refund_reduces_balance(self):
        self.assertEqual(refundable_balance(50_000, refunded_amount=20_000, reserved_amount=20_000), 30_000)

    def test_multiple_partial_refunds_accumulate(self):
        balance = refundable_balance(50_000, refunded_amount=35_000, reserved_amount=35_000)
        self.assertEqual(balance, 15_000)
        with self.assertRaises(RefundValidationError) as ctx:
            validate_refund_request(amount=20_000, attempt_amount=50_000, currency="IDR",
                                    refunded_amount=35_000, reserved_amount=35_000)
        self.assertEqual(ctx.exception.code, "amount_exceeded")

    def test_pending_and_ambiguous_capacity_is_reserved(self):
        self.assertEqual(refundable_balance(50_000, refunded_amount=0, reserved_amount=30_000), 20_000)

    def test_legacy_refunded_amount_counts_when_reserved_missing(self):
        self.assertEqual(refundable_balance(50_000, refunded_amount=50_000, reserved_amount=0), 0)


class RefundClassificationTests(unittest.TestCase):
    def test_success_requires_authoritative_ok(self):
        self.assertEqual(classify_refund_result(True).status, REFUND_SUCCEEDED)
        self.assertEqual(classify_refund_result(False, "rejected").status, REFUND_FAILED)
        self.assertEqual(classify_refund_result(False, "timeout").status, REFUND_AMBIGUOUS)
        self.assertEqual(classify_refund_result(False, "ambiguous").status, REFUND_AMBIGUOUS)

    def test_same_refund_request_requires_same_payload(self):
        record = {"attempt_id": "a1", "amount": 10_000, "currency": "IDR", "reason": "salah item", "idempotency_key": "k1"}
        self.assertTrue(same_refund_request(record, attempt_id="a1", amount=10_000, currency="IDR", reason="salah item", idempotency_key="k1"))
        self.assertFalse(same_refund_request(record, attempt_id="a1", amount=11_000, currency="IDR", reason="salah item", idempotency_key="k1"))
        self.assertFalse(same_refund_request(record, attempt_id="a1", amount=10_000, currency="IDR", reason="lain", idempotency_key="k1"))
        self.assertFalse(same_refund_request(record, attempt_id="a1", amount=10_000, currency="IDR", reason="salah item", idempotency_key="k2"))


class RefundSummaryTests(unittest.TestCase):
    def test_summary_distinguishes_partial_full_open_failed(self):
        self.assertEqual(summarize_refund_status(attempt_amount=50_000, refunded_amount=50_000, has_open=False, has_success=True, last_failed=False), "refunded")
        self.assertEqual(summarize_refund_status(attempt_amount=50_000, refunded_amount=20_000, has_open=False, has_success=True, last_failed=False), "partial")
        self.assertEqual(summarize_refund_status(attempt_amount=50_000, refunded_amount=20_000, has_open=True, has_success=True, last_failed=False), "requested")
        self.assertEqual(summarize_refund_status(attempt_amount=50_000, refunded_amount=0, has_open=False, has_success=False, last_failed=True), "failed")
        self.assertEqual(summarize_refund_status(attempt_amount=50_000, refunded_amount=0, has_open=False, has_success=False, last_failed=False), "none")


if __name__ == "__main__":
    unittest.main()
