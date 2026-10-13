from datetime import datetime

from pydantic import BaseModel


class TopItem(BaseModel):
    name: str
    qty: int
    revenue: int


class MethodTotal(BaseModel):
    method: str
    count: int
    total: int


class StoreTotal(BaseModel):
    store_name: str
    count: int
    revenue: int
    discount_total: int = 0


class ClosingReport(BaseModel):
    store_name: str | None = None
    start: str
    end: str
    generated_at: datetime
    count: int
    revenue: int
    items: int
    average: int
    first_order_no: str | None
    last_order_no: str | None
    methods: list[MethodTotal]
    cash_in_drawer: int  # cash sales (tendered minus change)
    top_items: list[TopItem]
    voided_count: int = 0  # voided orders in the range (not included in the totals above)
    voided_total: int = 0
    gross: int = 0  # sales before discounts
    discount_total: int = 0
    by_store: list[StoreTotal] = []  # only filled when the owner views all stores
