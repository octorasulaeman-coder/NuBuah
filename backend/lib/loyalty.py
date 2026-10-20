"""Loyalty + coupon BUSINESS RULES — pure module (no database). Database-touching code
lives in lib/customers.py and calls these functions; the rules themselves are fully
unit-testable.

Defaults (all overridable via environment, see load_loyalty_config):
- earning: 1 point per Rp 1.000 of net paid order value, orders below Rp 5.000 don't earn
- redeeming: 1 point = Rp 10, minimum 100 points per redemption, at most 50% of an order
- points are earned only when the order is PAID, and reversed on void/cancel/refund
"""

import os
from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass(frozen=True)
class LoyaltyConfig:
    points_per: int = 1000          # IDR of net value per 1 point earned
    min_spend_to_earn: int = 5000   # orders below this earn nothing
    redeem_value_per_point: int = 10  # IDR per point when redeeming
    redeem_min_points: int = 100
    redeem_max_fraction: float = 0.5  # redeemed value may cover at most this share


def load_loyalty_config(env: dict | None = None) -> LoyaltyConfig:
    env = env or os.environ
    return LoyaltyConfig(
        points_per=max(1, int(env.get("LOYALTY_POINTS_PER", "1000"))),
        min_spend_to_earn=max(0, int(env.get("LOYALTY_MIN_SPEND", "5000"))),
        redeem_value_per_point=max(1, int(env.get("LOYALTY_REDEEM_VALUE", "10"))),
        redeem_min_points=max(1, int(env.get("LOYALTY_REDEEM_MIN", "100"))),
        redeem_max_fraction=min(1.0, max(0.0, float(env.get("LOYALTY_REDEEM_MAX_FRACTION", "0.5")))),
    )


CONFIG = load_loyalty_config()


def effective_config(store_cfg_raw: dict | None, cfg: LoyaltyConfig = CONFIG) -> LoyaltyConfig:
    """Merge a store's saved loyalty settings over the environment defaults.
    Stores that never customized anything return the env-based defaults unchanged."""
    if not store_cfg_raw:
        return cfg
    base = cfg.__dict__ | {k: store_cfg_raw[k] for k in cfg.__dict__ if k in store_cfg_raw}
    return LoyaltyConfig(**base)


def points_for_order(net_total: int, cfg: LoyaltyConfig = CONFIG) -> int:
    """Points earned by a paid order. Idempotent-safe: derived purely from the total."""
    if net_total < cfg.min_spend_to_earn:
        return 0
    return net_total // cfg.points_per


def redeem_value(points: int, cfg: LoyaltyConfig = CONFIG) -> int:
    return points * cfg.redeem_value_per_point


def redeemable_points(customer_points: int, order_total: int, cfg: LoyaltyConfig = CONFIG) -> int:
    """How many points may be applied to this order (min-points and fraction caps)."""
    if customer_points < cfg.redeem_min_points:
        return 0
    cap_by_fraction = int(order_total * cfg.redeem_max_fraction) // cfg.redeem_value_per_point
    return min(customer_points, cap_by_fraction)


# ---------------------------------------------------------------- coupons
class CouponError(Exception):
    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def coupon_discount(coupon: dict, subtotal: int, lines: list[dict], now: datetime,
                    customer_phone: Optional[str], used_by_customer: int) -> int:
    """Validate a coupon against an order and return the discount amount in IDR.

    Raises CouponError with a machine-readable code on ANY ineligibility. The result is
    recomputed by the server at order time — a coupon's later edit can never rewrite a
    submitted order because the amount is snapshotted onto it.
    """
    if not coupon.get("active", True):
        raise CouponError("inactive", "Kupon tidak aktif")
    if coupon.get("starts_at") and now < coupon["starts_at"]:
        raise CouponError("not_started", "Kupon belum berlaku")
    if coupon.get("ends_at") and now > coupon["ends_at"]:
        raise CouponError("expired", "Kupon sudah kedaluwarsa")
    max_redemptions = int(coupon.get("max_redemptions") or 0)
    if max_redemptions and int(coupon.get("used_count") or 0) >= max_redemptions:
        raise CouponError("sold_out", "Kuota kupon habis")
    per_customer = int(coupon.get("per_customer_limit") or 0)
    if per_customer and used_by_customer >= per_customer:
        raise CouponError("customer_limit", "Kupon sudah dipakai maksimal untuk pelanggan ini")

    # scope: all | specific products | specific categories (checked against order lines)
    scope = coupon.get("applies_to") or {"type": "all"}
    scoped_lines = lines
    if scope.get("type") == "products":
        ids = set(scope.get("ids") or [])
        scoped_lines = [ln for ln in lines if ln.get("product_id") in ids]
        if not scoped_lines:
            raise CouponError("not_applicable", "Kupon tidak berlaku untuk produk ini")
    elif scope.get("type") == "categories":
        # category_id travels on each verified line (see verify_line / _apply_customer_programs)
        ids = set(scope.get("ids") or [])
        scoped_lines = [ln for ln in lines if ln.get("category_id") in ids]
        if not scoped_lines:
            raise CouponError("not_applicable", "Kupon tidak berlaku untuk kategori ini")

    scoped_subtotal = sum(ln["qty"] * ln["unit_price"] for ln in scoped_lines)
    if scoped_subtotal < int(coupon.get("min_spend") or 0):
        raise CouponError("min_spend", f"Minimal belanja kupon Rp {coupon.get('min_spend'):,}")

    if coupon.get("type") == "percent":
        pct = float(coupon.get("value") or 0)
        if not (0 < pct <= 100):
            raise CouponError("invalid", "Nilai kupon tidak valid")
        return max(0, round(scoped_subtotal * pct / 100))
    # fixed value, never exceeding the scoped subtotal
    return max(0, min(int(coupon.get("value") or 0), scoped_subtotal))
