"""Unit tests for P5 loyalty + coupon rules (lib/loyalty.py) — pure, no database."""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from lib.loyalty import (  # noqa: E402
    CONFIG, CouponError, coupon_discount, load_loyalty_config, points_for_order,
    redeem_value, redeemable_points,
)

NOW = datetime(2026, 1, 5, 12, 0, tzinfo=timezone.utc)
LINES = [
    {"product_id": "p1", "qty": 2, "unit_price": 10000, "category_id": "c1"},
    {"product_id": "p2", "qty": 1, "unit_price": 5000, "category_id": "c2"},
]
SUBTOTAL = 25000


def coupon(**kw):
    base = dict(type="fixed", value=5000, min_spend=0, starts_at=None, ends_at=None,
                max_redemptions=0, per_customer_limit=0, used_count=0,
                applies_to={"type": "all"}, active=True)
    base.update(kw)
    return base


class TestPoints:
    def test_earn_rate(self):
        assert points_for_order(25000, CONFIG) == 25
        assert points_for_order(999, CONFIG) == 0

    def test_min_spend_gate(self):
        assert points_for_order(4999, CONFIG) == 0
        assert points_for_order(5000, CONFIG) == 5

    def test_custom_config(self):
        cfg = load_loyalty_config({"LOYALTY_POINTS_PER": "500", "LOYALTY_MIN_SPEND": "0"})
        assert points_for_order(1000, cfg) == 2

    def test_redeem_value(self):
        assert redeem_value(100, CONFIG) == 1000

    def test_redeemable_caps(self):
        # balance 300, order 10.000 -> fraction cap 5.000/10 = 500 points; balance wins
        assert redeemable_points(300, 10000, CONFIG) == 300
        # balance 1000, order 10.000 -> 500-point cap
        assert redeemable_points(1000, 10000, CONFIG) == 500
        # below minimum -> nothing
        assert redeemable_points(50, 100000, CONFIG) == 0


class TestCouponDiscount:
    def test_fixed(self):
        assert coupon_discount(coupon(), SUBTOTAL, LINES, NOW, None, 0) == 5000

    def test_fixed_capped_at_subtotal(self):
        assert coupon_discount(coupon(value=99999), SUBTOTAL, LINES, NOW, None, 0) == SUBTOTAL

    def test_percent(self):
        assert coupon_discount(coupon(type="percent", value=10), SUBTOTAL, LINES, NOW, None, 0) == 2500

    def test_min_spend(self):
        with pytest.raises(CouponError) as e:
            coupon_discount(coupon(min_spend=30000), SUBTOTAL, LINES, NOW, None, 0)
        assert e.value.code == "min_spend"

    def test_inactive_and_window(self):
        with pytest.raises(CouponError) as e:
            coupon_discount(coupon(active=False), SUBTOTAL, LINES, NOW, None, 0)
        assert e.value.code == "inactive"
        with pytest.raises(CouponError) as e:
            coupon_discount(coupon(starts_at=NOW + timedelta(days=1)), SUBTOTAL, LINES, NOW, None, 0)
        assert e.value.code == "not_started"
        with pytest.raises(CouponError) as e:
            coupon_discount(coupon(ends_at=NOW - timedelta(days=1)), SUBTOTAL, LINES, NOW, None, 0)
        assert e.value.code == "expired"

    def test_redemption_caps(self):
        with pytest.raises(CouponError) as e:
            coupon_discount(coupon(max_redemptions=10, used_count=10), SUBTOTAL, LINES, NOW, None, 0)
        assert e.value.code == "sold_out"
        with pytest.raises(CouponError) as e:
            coupon_discount(coupon(per_customer_limit=1), SUBTOTAL, LINES, NOW, "+628", 1)
        assert e.value.code == "customer_limit"

    def test_product_scope(self):
        c = coupon(applies_to={"type": "products", "ids": ["p9"]})
        with pytest.raises(CouponError) as e:
            coupon_discount(c, SUBTOTAL, LINES, NOW, None, 0)
        assert e.value.code == "not_applicable"
        c2 = coupon(applies_to={"type": "products", "ids": ["p2"]})
        # only the p2 line (5.000) counts toward a fixed discount
        assert coupon_discount(c2, SUBTOTAL, LINES, NOW, None, 0) == 5000

    def test_category_scope(self):
        c = coupon(applies_to={"type": "categories", "ids": ["c1"]})
        # percent over the c1 subtotal (2 x 10.000 = 20.000), 10% -> 2.000
        assert coupon_discount(c(type="percent", value=10) if False else coupon(applies_to={"type": "categories", "ids": ["c1"]}, type="percent", value=10),
                               SUBTOTAL, LINES, NOW, None, 0) == 2000

    def test_bad_percent_rejected(self):
        with pytest.raises(CouponError) as e:
            coupon_discount(coupon(type="percent", value=150), SUBTOTAL, LINES, NOW, None, 0)
        assert e.value.code == "invalid"
