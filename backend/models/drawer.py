import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field


class DrawerEventIn(BaseModel):
    store_id: Optional[str] = None  # owner picks; cashiers are pinned to their store
    kind: Literal["open", "cash_out", "expense"]
    amount: int = Field(gt=0, le=100_000_000)
    note: Optional[str] = Field(default=None, max_length=120)


class DrawerCloseIn(BaseModel):
    store_id: Optional[str] = None
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")  # business date being closed
    counted: int = Field(ge=0, le=1_000_000_000)  # cash physically counted in the drawer


class DrawerEvent(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    kind: str  # "open" | "cash_out" | "expense" | "close"
    amount: int
    variance: Optional[int] = None  # close events only: counted - expected
    note: Optional[str] = None
    store_id: str
    date: str  # business date the event belongs to
    actor: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class DrawerSummary(BaseModel):
    date: str
    store_id: str
    opening: int  # modal awal
    cash_sales: int  # today's non-voided cash orders
    cash_out: int  # pengambilan uang dari laci
    expense: int  # pengeluaran operasional
    expected_cash: int  # opening + cash_sales - cash_out - expense
    closing: Optional[DrawerEvent] = None  # the close count, if already done
    events: list[DrawerEvent]
