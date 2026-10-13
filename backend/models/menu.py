from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field


class MenuOverrideIn(BaseModel):
    r: Optional[int] = Field(default=None, ge=0, le=10_000_000)
    l: Optional[int] = Field(default=None, ge=0, le=10_000_000)
    sold_out: bool = False
    hidden: bool = False  # hidden items disappear from POS and landing page but can be restored


class MenuOverride(MenuOverrideIn):
    store_id: str
    product_id: str
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class OptionOverrideIn(BaseModel):
    r: Optional[int] = Field(default=None, ge=-1_000_000, le=10_000_000)
    l: Optional[int] = Field(default=None, ge=-1_000_000, le=10_000_000)
    sold_out: bool = False
    hidden: bool = False  # hidden options disappear from the order screen but can be restored


class OptionOverride(OptionOverrideIn):
    store_id: str
    group_id: str
    option_id: str
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# Categories a custom item may go into: built-in ones (the "custom" builder and "potong" have special pricing, so not those)
# plus any category the owner created (custom_categories).
STATIC_PRODUCT_CATEGORIES = ("smoothie", "bowl", "jus", "snack", "sopsalad")
# Option groups an item can offer. None means "the default for its category".
PRODUCT_GROUPS = ("sweet", "ice", "drink_extra", "kuah", "bowl_topping", "bowl_extra")


class CustomCategoryIn(BaseModel):
    label: str = Field(min_length=1, max_length=40)
    blurb: str = Field(default="", max_length=120)


class CustomCategory(CustomCategoryIn):
    id: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class CustomProductIn(BaseModel):
    """A menu item the owner adds from inside the app (stored in MongoDB, shared by all stores)."""

    name: str = Field(min_length=1, max_length=60)
    code: str = Field(default="", max_length=8)  # unique item code (letters/digits); blank = made automatically
    category: str = Field(min_length=1, max_length=60)
    section: str = Field(default="", max_length=40)  # optional sub-heading inside a category, e.g. "Es Kul Kul"
    groups: Optional[list[str]] = Field(default=None, max_length=10)
    desc: str = Field(default="", max_length=200)
    benefit: str = Field(default="", max_length=120)
    r: int = Field(ge=0, le=10_000_000)
    l: Optional[int] = Field(default=None, ge=0, le=10_000_000)
    color: str = Field(default="#F5B83D", pattern=r"^#[0-9a-fA-F]{6}$")


class CustomProduct(CustomProductIn):
    id: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


EDITABLE_GROUPS = ("bowl_topping", "bowl_extra", "drink_extra", "custom_bowl_extra", "potong_extra", "ice", "kuah")


class CustomOptionIn(BaseModel):
    """A topping / extra option the owner adds to one of the editable groups from inside the app."""

    group_id: str = Field(pattern=r"^[a-z0-9_-]{2,60}$")  # a built-in editable group or a custom group (cx-...)
    label: str = Field(min_length=1, max_length=60)
    r: int = Field(ge=-1_000_000, le=10_000_000)
    l: Optional[int] = Field(default=None, ge=-1_000_000, le=10_000_000)


class CustomOption(CustomOptionIn):
    id: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class CodeIn(BaseModel):
    code: str = Field(min_length=1, max_length=8)


class CustomGroupIn(BaseModel):
    """A topping / option category the owner creates: a name, pick-one or pick-many, and the menu items that show it."""

    label: str = Field(min_length=1, max_length=40)
    type: Literal["single", "multi"] = "multi"
    product_ids: list[str] = Field(default_factory=list, max_length=500)


class CustomGroup(CustomGroupIn):
    id: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class MenuEditIn(BaseModel):
    """Owner edits to a built-in item, topping/option, category or option group (stored in menu_edits, applied on top of the built-in menu).

    kind=product : key = product id           fields: name, desc, benefit, category, section, color
    kind=option  : key = "group_id/option_id" fields: name (the label)
    kind=category: key = built-in category id fields: name (label), desc (blurb)
    kind=group   : key = built-in group id    fields: name (title)
    """

    kind: Literal["product", "option", "category", "group"]
    key: str = Field(pattern=r"^[a-z0-9_-]{2,60}(/[a-z0-9_-]{2,60})?$")
    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    desc: Optional[str] = Field(default=None, max_length=200)
    benefit: Optional[str] = Field(default=None, max_length=120)
    category: Optional[str] = Field(default=None, min_length=1, max_length=60)
    section: Optional[str] = Field(default=None, max_length=40)
    color: Optional[str] = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


class MenuEdit(MenuEditIn):
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
