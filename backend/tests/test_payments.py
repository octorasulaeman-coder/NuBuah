"""Unit tests for the payment foundation — pure parts only (no database, no network):
- lib/payments/transitions.py  (state machine rules)
- lib/payments/mock.py         (HMAC webhook verification, status normalization)
- lib/payments/config.py       (production refusal of mock, mode validation)
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from lib.payments.config import PaymentConfigError, load_payment_config  # noqa: E402
from lib.payments.mock import MockProvider, RAW_FAILED, RAW_PAID, RAW_PENDING, RAW_UNKNOWN  # noqa: E402
from lib.payments.transitions import (  # noqa: E402
    EXPIRED, FAILED, PAID, PENDING, apply_expiry, apply_notification,
)


class TestTransitions:
    def test_pending_to_paid(self):
        d = apply_notification(PENDING, PAID, expired=False)
        assert (d.target, d.late_payment) == (PAID, False)

    def test_paid_is_terminal_even_for_later_failure(self):
        d = apply_notification(PAID, FAILED, expired=False)
        assert d.target == PAID

    def test_out_of_order_failure_then_success(self):
        d1 = apply_notification(PENDING, FAILED, expired=False)
        assert d1.target == FAILED
        d2 = apply_notification(FAILED, PAID, expired=False)  # a late success notification is real money
        assert d2.target == PAID

    def test_late_payment_after_expiry_flagged(self):
        d = apply_notification(PENDING, PAID, expired=True)
        assert d.target == PAID and d.late_payment is True

    def test_unknown_status_stays_pending_and_flags_review(self):
        d = apply_notification(PENDING, None, expired=False)
        assert d.target == PENDING and d.needs_review is True
        # an explicit "still pending" confirmation is a no-op, NOT a review flag
        d2 = apply_notification(PENDING, PENDING, expired=False)
        assert d2.target == PENDING and d2.needs_review is False

    def test_expiry_sweep(self):
        assert apply_expiry(PENDING).target == EXPIRED
        assert apply_expiry(PAID).target == PAID  # never un-pays
        assert apply_expiry(FAILED).target == FAILED  # history preserved
        assert apply_expiry(EXPIRED).target == EXPIRED


class TestMockProvider:
    def test_sign_and_verify_roundtrip(self):
        m = MockProvider("s3cret")
        hdrs, body = m.build_notification("NB-X-1", 25000, outcome=RAW_PAID, event_id="e1", transaction_ref="T1")
        vn = m.verify_webhook(hdrs, body)
        assert vn.valid and vn.event_id == "e1" and vn.provider_ref == "NB-X-1"
        assert vn.amount == 25000 and vn.currency == "IDR" and vn.raw_status == RAW_PAID

    def test_bad_signature_rejected(self):
        m = MockProvider("s3cret")
        _, body = m.build_notification("NB-X-1", 25000, outcome=RAW_PAID, event_id="e2")
        vn = m.verify_webhook({"x-mock-signature": "deadbeef"}, body)
        assert vn.valid is False

    def test_wrong_secret_rejected(self):
        signer = MockProvider("s3cret")
        verifier = MockProvider("other-secret")
        hdrs, body = signer.build_notification("NB-X-2", 10000, outcome=RAW_PAID, event_id="e3")
        assert verifier.verify_webhook(hdrs, body).valid is False

    def test_unparseable_body_rejected(self):
        m = MockProvider("s3cret")
        body = b"not json"
        hdrs = {"x-mock-signature": m.sign(body)}
        assert m.verify_webhook(hdrs, body).valid is False

    def test_normalize_maps_provider_vocabulary(self):
        m = MockProvider()
        from lib.payments.transitions import PENDING as _P
        assert m.normalize_status(RAW_PAID) == PAID
        assert m.normalize_status(RAW_FAILED) == FAILED
        assert m.normalize_status(RAW_PENDING) == _P
        assert m.normalize_status(RAW_UNKNOWN) is None  # unrecognized -> service flags review


class TestPaymentConfig:
    def test_disabled_by_default(self):
        cfg = load_payment_config({})
        assert cfg.enabled is False and cfg.provider == ""

    def test_mock_allowed_in_sandbox(self):
        cfg = load_payment_config({"PAYMENT_PROVIDER": "mock", "PAYMENT_ENABLED": "1", "PAYMENT_MODE": "sandbox"})
        assert cfg.enabled and cfg.mock_allowed

    def test_mock_refused_in_production(self):
        with pytest.raises(PaymentConfigError):
            load_payment_config({"PAYMENT_PROVIDER": "mock", "PAYMENT_ENABLED": "1", "PAYMENT_MODE": "production"})

    def test_bad_mode_rejected(self):
        with pytest.raises(PaymentConfigError):
            load_payment_config({"PAYMENT_PROVIDER": "mock", "PAYMENT_ENABLED": "1", "PAYMENT_MODE": "staging"})

    def test_enabled_requires_provider(self):
        cfg = load_payment_config({"PAYMENT_ENABLED": "1"})
        assert cfg.enabled is False
