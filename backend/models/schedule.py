"""Pydantic models for pickup scheduling: store schedule config + slot responses."""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator

_HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"


class ScheduleConfig(BaseModel):
    """Owner-editable scheduling settings for a store. All wall times are LOCAL store time."""
    enabled: bool = True
    slot_minutes: int = Field(default=15, ge=5, le=120)
    lead_time_minutes: int = Field(default=30, ge=0, le=24 * 60)
    max_days_ahead: int = Field(default=7, ge=0, le=30)
    capacity_per_slot: int = Field(default=0, ge=0, le=500)  # 0 = unlimited
    hours: dict[str, list[str]] = Field(default_factory=lambda: {str(d): ["09:00", "21:00"] for d in range(7)})
    holidays: list[str] = Field(default_factory=list)

    @field_validator("hours")
    @classmethod
    def _hours_shape(cls, v: dict[str, list[str]]) -> dict[str, list[str]]:
        for dow, window in v.items():
            if dow not in {str(d) for d in range(7)}:
                raise ValueError(f"invalid weekday key: {dow}")
            if len(window) != 2:
                raise ValueError(f"hours[{dow}] must be [open, close]")
            import re
            if not all(re.match(_HHMM, t) for t in window):
                raise ValueError(f"hours[{dow}] must be HH:MM strings")
            if window[1] <= window[0]:
                raise ValueError(f"hours[{dow}]: close must be after open")
        return v

    @field_validator("holidays")
    @classmethod
    def _holiday_shape(cls, v: list[str]) -> list[str]:
        from datetime import date
        for h in v:
            date.fromisoformat(h)  # raises ValueError on bad format
        return v


class SlotOut(BaseModel):
    start_local: str
    end_local: str
    start_utc: datetime
    available: bool
    reason: Optional[str] = None  # closed | past | lead_time | full
    taken: int = 0
    capacity: Optional[int] = None  # null = unlimited


class SlotsDay(BaseModel):
    date: str
    open: bool
    reason: Optional[str] = None
    slots: list[SlotOut] = []


class ScheduleInfo(BaseModel):
    """Public/staff view of the scheduling config (nothing sensitive). Includes the
    full editable config so the admin form can prefill (PUT accepts the same shape
    minus timezone/days)."""
    enabled: bool
    slot_minutes: int
    lead_time_minutes: int
    max_days_ahead: int
    capacity_per_slot: int
    timezone: str
    days: list[dict] = []  # upcoming_days() output
    hours: dict[str, list[str]] = {}
    holidays: list[str] = []
