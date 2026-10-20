"""Unit tests for lib/idempotency.payload_fingerprint (pure, no database needed).

Semantics under test:
- identical order content (any key order, extra Nones) -> identical fingerprint
- any meaningful change (lines, qty, prices, discounts, customer, payment) -> different
- client_order_id and approval_pin are excluded: a legitimate retry never mismatches
  just because the client regenerated a key or an owner PIN was/wasn't supplied.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib.idempotency import payload_fingerprint  # noqa: E402

BASE = {
    "client_order_id": "abc-123",
    "lines": [{"product_id": "p1", "name": "Jus Mangga", "qty": 2, "unit_price": 15000}],
    "payment_method": "cash",
    "cash_tendered": 31000,
    "discount_type": None,
    "discount_value": 0,
    "customer_name": "Budi",
    "approval_pin": "123456",
}


def test_stable_across_key_order_and_none_noise():
    reordered = {k: BASE[k] for k in reversed(list(BASE))}
    reordered["discount_note"] = None
    assert payload_fingerprint(BASE) == payload_fingerprint(reordered)


def test_same_content_new_key_is_same_checkout():
    other = dict(BASE, client_order_id="xyz-999")
    assert payload_fingerprint(BASE) == payload_fingerprint(other)


def test_retry_without_approval_pin_is_same_checkout():
    other = dict(BASE, approval_pin=None)
    assert payload_fingerprint(BASE) == payload_fingerprint(other)


def _assert_different(**changes):
    other = dict(BASE, **changes)
    assert payload_fingerprint(BASE) != payload_fingerprint(other), f"expected change: {changes}"


def test_line_change_is_different_checkout():
    lines = [dict(BASE["lines"][0], qty=3)]
    _assert_different(lines=lines)


def test_price_change_is_different_checkout():
    lines = [dict(BASE["lines"][0], unit_price=14000)]
    _assert_different(lines=lines)


def test_payment_change_is_different_checkout():
    _assert_different(payment_method="qris")


def test_customer_change_is_different_checkout():
    _assert_different(customer_name="Ani")


def test_discount_change_is_different_checkout():
    _assert_different(discount_type="percent", discount_value=10)
