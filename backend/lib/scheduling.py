"""Scheduling engine for pickup slots — pure functions, no database access.

A store's schedule config (see models/schedule.py) defines: slot length, minimum lead
time, how far ahead orders may be placed, per-slot capacity (0 = unlimited), weekly
opening hours in LOCAL store time, and holiday closures.

All wall-clock math happens in the store's timezone; all persisted timestamps are UTC.
Slots are aligned to the local clock grid (anchored at local midnight). Daylight-saving
transitions are handled by converting wall times through the zone (Asia/Jakarta has no
DST, but the code does not assume that).

Validation is deliberately strict: a slot must exist on the grid, be inside opening
hours, respect lead time and the advance window, and not fall on a closed day. Anything
else is rejected — the backend never guesses the customer's intent.
"""

from datetime import date, datetime, time, timedelta
from typing import Optional
from zoneinfo import ZoneInfo


class ScheduleError(Exception):
    """carries a machine-readable reason + human message for the API layer"""

    def __init__(self, reason: str, detail: str):
        super().__init__(detail)
        self.reason = reason
        self.detail = detail


# Reason codes shared by the API responses and the slot listing.
R_CLOSED = "closed"
R_PAST = "past"
R_LEAD_TIME = "lead_time"
R_FULL = "full"
R_NOT_SLOT = "not_a_slot"
R_TOO_FAR = "too_far"

DEFAULT_SCHEDULE: dict = {
    "enabled": True,
    "slot_minutes": 15,
    "lead_time_minutes": 30,
    "max_days_ahead": 7,
    "capacity_per_slot": 0,  # 0 = unlimited
    "hours": {str(d): ["09:00", "21:00"] for d in range(7)},  # local time; omit a day = closed
    "holidays": [],  # YYYY-MM-DD local dates the store is closed
}


def normalize_schedule(raw: Optional[dict]) -> dict:
    """Overlay a stored (possibly partial/legacy) config on the defaults.

    `hours` is taken as-is when present (an owner closing Sundays by omitting "6" must
    actually be closed) and only falls back to the default 7-day hours when absent.
    The owner PUT endpoint always sends the full validated dict, so stored configs are
    complete; this rule only governs hand-edited or legacy documents.
    """
    raw = raw or {}
    cfg = {**DEFAULT_SCHEDULE, **raw}
    if not raw.get("hours"):
        cfg["hours"] = DEFAULT_SCHEDULE["hours"]
    return cfg


def _hhmm(value: str) -> int:
    h, m = value.split(":")
    return int(h) * 60 + int(m)


def day_bounds(cfg: dict, day: date) -> Optional[tuple[int, int]]:
    """(open_minute, close_minute) in local wall time, or None when closed."""
    if day.isoformat() in (cfg.get("holidays") or []):
        return None
    window = (cfg.get("hours") or {}).get(str(day.weekday()))
    if not window or len(window) != 2:
        return None
    open_m, close_m = _hhmm(window[0]), _hhmm(window[1])
    if close_m <= open_m:
        return None
    return open_m, close_m


def store_is_open_now(cfg: dict, tz: ZoneInfo, now: datetime) -> bool:
    """Whether the store is inside its configured opening hours at `now`.

    Independent of `enabled`: the scheduled-order switch controls whether customers may
    book pickup slots, not the store's opening hours for immediate orders.
    """
    cfg = normalize_schedule(cfg)
    local_now = now.astimezone(tz)
    bounds = day_bounds(cfg, local_now.date())
    if bounds is None:
        return False
    open_m, close_m = bounds
    minute = local_now.hour * 60 + local_now.minute
    return open_m <= minute < close_m


def slot_grid_starts(cfg: dict, day: date) -> list[int]:
    """All slot start minutes-of-day that fit inside opening hours."""
    bounds = day_bounds(cfg, day)
    if bounds is None:
        return []
    open_m, close_m = bounds
    step = max(5, int(cfg.get("slot_minutes") or 15))
    starts = []
    m = open_m
    while m + step <= close_m:
        starts.append(m)
        m += step
    return starts


def _combine(day: date, minute: int, tz: ZoneInfo) -> datetime:
    return datetime.combine(day, time(minute // 60, minute % 60), tzinfo=tz)


def local_day_range(day: date, tz: ZoneInfo) -> tuple[datetime, datetime]:
    """UTC [start, end) of a local calendar day — for counting slot reservations."""
    start_local = datetime.combine(day, time(0, 0), tzinfo=tz)
    return start_local.astimezone(ZoneInfo("UTC")), (start_local + timedelta(days=1)).astimezone(ZoneInfo("UTC"))


def validate_requested_slot(cfg: dict, requested_utc: datetime, tz: ZoneInfo, now: datetime) -> datetime:
    """Check a client-requested slot; return the canonical UTC slot start on success.

    raises ScheduleError with a reason code on any violation.
    """
    cfg = normalize_schedule(cfg)
    if not cfg.get("enabled", True):
        raise ScheduleError(R_CLOSED, "Pemesanan jadwal tidak aktif di toko ini")
    if requested_utc.tzinfo is None:
        raise ScheduleError(R_NOT_SLOT, "Waktu jadwal harus menyertakan zona waktu")
    now_utc = now.astimezone(ZoneInfo("UTC"))
    local = requested_utc.astimezone(tz)
    day = local.date()
    step = max(5, int(cfg.get("slot_minutes") or 15))

    if day > (now.astimezone(tz).date() + timedelta(days=int(cfg.get("max_days_ahead", 7)))):
        raise ScheduleError(R_TOO_FAR, f"Jadwal maksimal {cfg.get('max_days_ahead', 7)} hari ke depan")

    bounds = day_bounds(cfg, day)
    if bounds is None:
        raise ScheduleError(R_CLOSED, "Toko tutup pada tanggal itu")
    minute = local.hour * 60 + local.minute
    if minute % step != 0 or local.second or local.microsecond:
        raise ScheduleError(R_NOT_SLOT, f"Waktu harus selaras slot {step} menit")
    open_m, close_m = bounds
    if minute < open_m or minute + step > close_m:
        raise ScheduleError(R_CLOSED, "Di luar jam buka toko")

    slot_start_local = _combine(day, minute, tz)
    slot_start_utc = slot_start_local.astimezone(ZoneInfo("UTC"))
    if slot_start_utc <= now_utc:
        raise ScheduleError(R_PAST, "Slot waktu sudah lewat")
    lead = timedelta(minutes=int(cfg.get("lead_time_minutes") or 0))
    if slot_start_utc < now_utc + lead:
        raise ScheduleError(R_LEAD_TIME, f"Minimal {cfg.get('lead_time_minutes', 30)} menit sebelum ambil")
    return slot_start_utc.replace(second=0, microsecond=0)


def build_day_slots(cfg: dict, day: date, tz: ZoneInfo, now: datetime, taken: Optional[dict[str, int]] = None) -> dict:
    """Slot listing for one local day, with availability + reasons. taken: {slot_start_iso_utc: count}."""
    cfg = normalize_schedule(cfg)
    taken = taken or {}
    now_utc = now.astimezone(ZoneInfo("UTC"))
    step = max(5, int(cfg.get("slot_minutes") or 15))
    lead = timedelta(minutes=int(cfg.get("lead_time_minutes") or 0))
    capacity = int(cfg.get("capacity_per_slot") or 0)
    bounds = day_bounds(cfg, day)

    slots = []
    if not cfg.get("enabled", True):
        return {"date": day.isoformat(), "open": False, "reason": R_CLOSED, "slots": []}
    if bounds is None:
        return {"date": day.isoformat(), "open": False, "reason": R_CLOSED, "slots": []}

    for minute in slot_grid_starts(cfg, day):
        start_local = _combine(day, minute, tz)
        end_local = start_local + timedelta(minutes=step)
        start_utc = start_local.astimezone(ZoneInfo("UTC"))
        key = start_utc.isoformat()
        count = taken.get(key, 0)
        available, reason = True, None
        if start_utc <= now_utc:
            available, reason = False, R_PAST
        elif start_utc < now_utc + lead:
            available, reason = False, R_LEAD_TIME
        elif capacity > 0 and count >= capacity:
            available, reason = False, R_FULL
        slots.append({
            "start_local": start_local.isoformat(),
            "end_local": end_local.isoformat(),
            "start_utc": start_utc,
            "available": available,
            "reason": reason,
            "taken": count,
            "capacity": capacity or None,
        })
    return {"date": day.isoformat(), "open": True, "reason": None, "slots": slots}


def upcoming_days(cfg: dict, tz: ZoneInfo, now: datetime) -> list[dict]:
    """The bookable calendar days (today .. today+max_days_ahead) with open/closed status."""
    cfg = normalize_schedule(cfg)
    today = now.astimezone(tz).date()
    days = []
    for i in range(int(cfg.get("max_days_ahead", 7)) + 1):
        day = today + timedelta(days=i)
        bounds = day_bounds(cfg, day)
        days.append({"date": day.isoformat(), "open": bounds is not None and cfg.get("enabled", True),
                     "reason": None if bounds is not None else R_CLOSED})
    return days
