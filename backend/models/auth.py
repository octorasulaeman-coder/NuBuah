import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=120)
    password: str = Field(min_length=1, max_length=200)


class PinLoginIn(BaseModel):
    store_id: str
    pin: str = Field(min_length=4, max_length=6, pattern=r"^\d+$")


class Me(BaseModel):
    id: str
    kind: Literal["user", "pin"]
    name: str
    email: Optional[str] = None
    role: Literal["owner", "cashier"]
    store_id: Optional[str] = None
    must_change_password: bool = False  # true while the bootstrap default password is still in use


class StoreIn(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    code: str = Field(min_length=2, max_length=5, pattern=r"^[A-Z0-9]+$")
    address_lines: list[str] = Field(default_factory=list, max_length=4)
    phone: str = Field(default="", max_length=30)
    pin: Optional[str] = Field(default=None, min_length=4, max_length=6, pattern=r"^\d+$")
    approval_pin: Optional[str] = Field(default=None, min_length=4, max_length=6, pattern=r"^\d+$")  # owner PIN that approves over-cap cashier discounts


class StoreUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=60)
    code: Optional[str] = Field(default=None, min_length=2, max_length=5, pattern=r"^[A-Z0-9]+$")
    address_lines: Optional[list[str]] = Field(default=None, max_length=4)
    phone: Optional[str] = Field(default=None, max_length=30)
    pin: Optional[str] = Field(default=None, min_length=4, max_length=6, pattern=r"^\d+$")
    approval_pin: Optional[str] = Field(default=None, min_length=4, max_length=6, pattern=r"^\d+$")


class PublicStore(BaseModel):
    id: str
    name: str
    code: str
    address_lines: list[str]
    phone: str


class Store(PublicStore):
    has_pin: bool
    has_approval_pin: bool = False
    discount_cap: int = 10  # percent; cashier discounts above this need the owner approval PIN
    created_at: datetime


class StaffIn(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    email: str = Field(min_length=3, max_length=120, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: str = Field(min_length=8, max_length=200)
    store_id: str


class Staff(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    email: str
    role: Literal["owner", "cashier"]
    store_id: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


EMAIL_RE = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class StaffUpdate(BaseModel):
    """Owner edits a cashier account. Leave a field out to keep it. A new password signs that cashier out everywhere."""

    name: Optional[str] = Field(default=None, min_length=2, max_length=60)
    email: Optional[str] = Field(default=None, min_length=3, max_length=120, pattern=EMAIL_RE)
    password: Optional[str] = Field(default=None, min_length=8, max_length=200)
    store_id: Optional[str] = None


class ProfileUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=60)
    email: Optional[str] = Field(default=None, min_length=3, max_length=120, pattern=EMAIL_RE)


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)
