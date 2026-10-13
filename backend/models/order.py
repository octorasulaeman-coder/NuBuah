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


class OrderLine(OrderLineIn):
    line_total: int


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


class Order(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_order_id: Optional[str] = None  # echoed back so a retried checkout can find its order
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
    total: int  # what the customer pays (subtotal minus discount)
    payment_method: PaymentMethod
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
