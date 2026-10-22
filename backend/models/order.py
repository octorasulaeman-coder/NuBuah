import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field

PaymentMethod = Literal["cash", "card", "qris"]


class OrderLineOption(BaseModel):
    label: str
    price: int = 0


class OrderLineIn(BaseModel):
    product_id: str
    name: str
    code: Optional[str] = None
    size: Optional[Literal["R", "L"]] = None
    options: list[OrderLineOption] = []
    note: Optional[str] = None
    unit_price: int = Field(ge=0)
    qty: int = Field(ge=1, le=99)
    category_id: Optional[str] = None  # IGNORED from clients; set server-side from the live menu


class OrderLine(OrderLineIn):
    line_total: int


class PublicOrderIn(BaseModel):
    """Untrusted customer-side order (order on phone, pay at the counter).
    No discounts, no payment fields — the cashier collects payment at pickup.
    scheduled_for: optional future pickup slot (UTC); validated server-side."""
    store_code: str = Field(min_length=1, max_length=5)
    lines: list[OrderLineIn] = Field(min_length=1, max_length=30)
    customer_name: str = Field(min_length=2, max_length=60)
    # optional for MEMBERS (their profile phone is authoritative once member_no resolves);
    # required in practice for non-members — the server falls back to it when no member
    customer_phone: Optional[str] = Field(default=None, min_length=6, max_length=20, pattern=r"^[0-9A-Za-z+-]+$")  # phone OR member ID (NB######)
    client_order_id: Optional[str] = Field(default=None, max_length=64)
    scheduled_for: Optional[datetime] = None
    coupon_code: Optional[str] = Field(default=None, max_length=32)
    member_no: Optional[str] = Field(default=None, max_length=16)  # members earn/redeem
    redeem_points: int = Field(default=0, ge=0, le=100000)


class CancelIn(BaseModel):
    """Cashier/owner cancels a pending customer order (no-show, duplicate, customer request)."""
    reason: str = Field(min_length=2, max_length=120)


class OrderPayIn(BaseModel):
    """Cashier collects payment for a pending customer order at pickup.
    Discounts use the same cap rule as checkout: above the store cap needs the owner PIN."""
    payment_method: PaymentMethod
    cash_tendered: Optional[int] = Field(default=None, ge=0)
    discount_type: Optional[Literal["percent", "fixed"]] = None
    discount_value: int = Field(default=0, ge=0, le=100_000_000)
    discount_note: Optional[str] = Field(default=None, max_length=60)
    approval_pin: Optional[str] = Field(default=None, min_length=4, max_length=6, pattern=r"^\d+$")
    coupon_code: Optional[str] = Field(default=None, max_length=30)
    redeem_points: int = Field(default=0, ge=0, le=1_000_000)


class PublicOrderStatus(BaseModel):
    """Customer-facing view: no cashier names, no internals beyond its own id."""
    id: str
    order_no: str
    store_name: str
    payment_status: str  # "pending" = bayar di kasir, "paid"
    total: int
    lines: list[OrderLine]
    created_at: datetime
    fulfillment: str = "immediate"  # "immediate" | "scheduled"
    scheduled_for: Optional[datetime] = None  # UTC slot start, null = immediate
    status: str = "received"  # so customers can watch preparation progress
    points_earned: int = 0  # loyalty points this order earned (computed, shown once paid)


class OrderCreate(BaseModel):
    lines: list[OrderLineIn] = Field(min_length=1)
    payment_method: PaymentMethod
    cash_tendered: Optional[int] = Field(default=None, ge=0)
    customer_name: Optional[str] = Field(default=None, max_length=60)
    customer_phone: Optional[str] = Field(default=None, max_length=20, pattern=r"^[0-9+\-\s]*$")
    # Optional discount: a percentage (0-100) or a fixed Rupiah amount, applied to the whole order.
    discount_type: Optional[Literal["percent", "fixed"]] = None
    discount_value: int = Field(default=0, ge=0, le=100_000_000)
    discount_note: Optional[str] = Field(default=None, max_length=60)
    store_id: Optional[str] = None  # required for owner sessions; cashiers are pinned to their store
    client_order_id: Optional[str] = Field(default=None, max_length=64)  # idempotency key: safe to retry a checkout
    approval_pin: Optional[str] = Field(default=None, min_length=4, max_length=6, pattern=r"^\d+$")  # owner PIN for over-cap discounts
    # Scheduling: pick up at a future slot instead of immediately (validated server-side).
    scheduled_for: Optional[datetime] = None  # UTC slot start
    # Leave payment open for pickup (scheduled orders only); cash/card/qris recorded at pickup.
    pay_at_pickup: bool = False
    member_no: Optional[str] = Field(default=None, max_length=16)  # cashier-side member identification
    # P5 customer programs
    coupon_code: Optional[str] = Field(default=None, max_length=32)
    redeem_points: int = Field(default=0, ge=0, le=100000)


class Order(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_order_id: Optional[str] = None  # echoed back so a retried checkout can find its order
    # SHA-256 fingerprint of the order-defining payload (see lib/idempotency.py). Lets the
    # backend reject a retried key carrying *different* content instead of silently
    # returning the previous order. None on orders saved before this field existed.
    idempotency_hash: Optional[str] = None
    order_no: str
    business_date: str  # YYYY-MM-DD in store timezone (WIB)
    store_id: str
    store_name: str = "NuBuah"
    store_address_lines: list[str] = []
    store_phone: str = ""
    cashier_name: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    lines: list[OrderLine]
    item_count: int
    subtotal: Optional[int] = None  # before discount (None on orders saved before discounts existed)
    discount_type: Optional[Literal["percent", "fixed"]] = None
    discount_value: int = 0
    discount_amount: int = 0  # Rupiah actually taken off
    discount_note: Optional[str] = None
    # P5 customer programs, snapshotted at creation so later coupon edits never rewrite history
    coupon_id: Optional[str] = None   # internal release key (void/cancel frees the quota)
    coupon_code: Optional[str] = None
    coupon_amount: int = 0
    points_redeemed: int = 0       # points debited for this order
    redeem_value_amount: int = 0   # rupiah value of that redemption
    total: int  # what the customer pays (subtotal minus all discounts)
    payment_method: PaymentMethod
    payment_status: str = "paid"  # customer-channel orders start "pending" until paid at pickup
    channel: str = "pos"  # "pos" | "customer"
    # Scheduling + preparation flow (P2). status is preparation flow, independent of payment.
    fulfillment: str = "immediate"  # "immediate" | "scheduled"
    scheduled_for: Optional[datetime] = None  # UTC slot start; null = immediate
    pay_at_pickup: bool = False  # scheduled order whose payment is collected at pickup
    status: str = "received"  # received|confirmed|preparing|ready|completed|cancelled (lib/orderflow.py)
    cash_tendered: Optional[int] = None
    change: Optional[int] = None
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    # Void: the order stays on record but is left out of all totals.
    voided: bool = False
    void_reason: Optional[str] = None
    voided_at: Optional[datetime] = None
    voided_by: Optional[str] = None


class VoidIn(BaseModel):
    reason: str = Field(min_length=3, max_length=200)


class RescheduleIn(BaseModel):
    """Move an order to a different slot (null = convert to immediate). Staff only."""
    scheduled_for: Optional[datetime] = None


class StatusIn(BaseModel):
    """Advance the preparation flow (lib/orderflow.py transitions)."""
    status: str = Field(min_length=3, max_length=20)


class OrdersSummary(BaseModel):
    count: int
    revenue: int
    items: int
    by_method: dict[str, int]
    voided_count: int = 0
    voided_total: int = 0
    discount_total: int = 0


class OrderList(BaseModel):
    start: str
    end: str
    store_id: Optional[str] = None  # None = all stores (owner)
    orders: list[Order]
    summary: OrdersSummary


class TodayInfo(BaseModel):
    date: str
    timezone: str
