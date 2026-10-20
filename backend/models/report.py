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
    refunds_count: int = 0          # refunded payment attempts tied to in-range orders
    refunds_total: int = 0          # sum of their amounts — money returned, not a sale
    net_after_refunds: int = 0      # revenue - refunds_total
    # P4.4: gross profit requires product cost data, which this system does not have.
    # We report its absence explicitly instead of fabricating a number.
    gross_profit_available: bool = False
    gross_profit: int | None = None
    definitions: dict = {}          # machine-readable metric definitions (see reports.py)
    by_store: list[StoreTotal] = []  # only filled when the owner views all stores


class ProductPerf(BaseModel):
    key: str                       # BASE product name — cup size is aggregated away
    product_id: str | None = None
    category: str | None = None    # resolved from the live menu; null if product vanished
    qty: int = 0
    revenue: int = 0
    orders_count: int = 0          # distinct qualifying orders containing it


class ProductPerformance(BaseModel):
    start: str
    end: str
    generated_at: datetime
    by_quantity: list[ProductPerf] = []
    by_revenue: list[ProductPerf] = []
    low_performers: list[ProductPerf] = []   # sold, but smallest revenue in range
    categories: list[dict] = []              # [{category, qty, revenue}]
    top_options: list[dict] = []             # most-chosen add-ons: [{group, label, count}]
    all_categories: list[str] = []           # FULL menu taxonomy (filter chips)
    all_option_groups: list[str] = []        # FULL addon-group taxonomy (filter chips)
    gross_profit_available: bool = False     # no cost data — same honest stance
    definitions: dict = {}


class DailyPoint(BaseModel):
    date: str              # business_date (store timezone)
    revenue: int           # net sales that day
    orders: int            # qualifying orders
    refunds_total: int = 0


class Dashboard(BaseModel):
    start: str
    end: str
    generated_at: datetime
    gross_sales: int       # before discounts
    net_sales: int         # after discounts, before refunds
    net_after_refunds: int
    qualifying_orders: int
    average_order_value: int
    discounts_total: int
    refunds_total: int
    refunds_count: int
    voided_count: int
    methods: list[MethodTotal]
    series: list[DailyPoint] = []
    gross_profit_available: bool = False
    definitions: dict = {}
