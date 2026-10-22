"""Unit tests for the scheduling engine (lib/scheduling.py) — pure, no database.

Fixed clock: 2026-01-05 08:00:00 UTC = 15:00 WIB (Asia/Jakarta, UTC+7), a Monday.
Default schedule: every day 09:00-21:00 local, 15-minute slots, 30-min lead, 7-day window.
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from lib.orderflow import (  # noqa: E402
    CANCELLED, COMPLETED, PREPARING, READY, RECEIVED, assert_transition, can_transition,
)
from lib.scheduling import (  # noqa: E402
    R_CLOSED, R_LEAD_TIME, R_NOT_SLOT, R_PAST, R_TOO_FAR, ScheduleError,
    build_day_slots, normalize_schedule, store_is_open_now, upcoming_days,
    validate_requested_slot,
)

TZ = ZoneInfo("Asia/Jakarta")
NOW = datetime(2026, 1, 5, 8, 0, 0, tzinfo=timezone.utc)  # 15:00 WIB Monday
CFG = normalize_schedule({})  # defaults


def at_wib(day: str, hhmm: str) -> datetime:
    d = datetime.fromisoformat(day)
    h, m = hhmm.split(":")
    return datetime(d.year, d.month, d.day, int(h), int(m), tzinfo=TZ).astimezone(timezone.utc)


class TestValidateSlot:
    def test_valid_slot_same_day(self):
        # 2026-01-05 is Monday; next aligned slot after 15:30 WIB is 15:45
        slot = validate_requested_slot(CFG, at_wib("2026-01-05", "15:45"), TZ, NOW)
        assert slot == at_wib("2026-01-05", "15:45")
        assert slot.tzinfo is not None

    def test_past_slot_rejected(self):
        with pytest.raises(ScheduleError) as e:
            validate_requested_slot(CFG, at_wib("2026-01-05", "14:45"), TZ, NOW)
        assert e.value.reason == R_PAST

    def test_lead_time_rejected(self):
        # with the clock at 14:30 WIB, a 30-min lead blocks anything before 15:00 WIB
        earlier = NOW - timedelta(minutes=30)  # 14:30 WIB
        with pytest.raises(ScheduleError) as e:
            validate_requested_slot(CFG, at_wib("2026-01-05", "14:45"), TZ, earlier)
        assert e.value.reason == R_LEAD_TIME
        # exactly at now+lead is acceptable
        ok = validate_requested_slot(CFG, at_wib("2026-01-05", "15:00"), TZ, earlier)
        assert ok == at_wib("2026-01-05", "15:00")

    def test_off_grid_rejected(self):
        with pytest.raises(ScheduleError) as e:
            validate_requested_slot(CFG, at_wib("2026-01-05", "16:07"), TZ, NOW)
        assert e.value.reason == R_NOT_SLOT

    def test_outside_opening_hours_rejected(self):
        with pytest.raises(ScheduleError) as e:
            validate_requested_slot(CFG, at_wib("2026-01-05", "21:00"), TZ, NOW)  # 21:00-21:15 over close
        assert e.value.reason == R_CLOSED
        with pytest.raises(ScheduleError) as e2:
            validate_requested_slot(CFG, at_wib("2026-01-05", "08:45"), TZ, NOW)
        assert e2.value.reason == R_CLOSED

    def test_closed_day_rejected(self):
        cfg = normalize_schedule({"hours": {"0": ["09:00", "21:00"]}})  # weekday(): Monday == 0
        with pytest.raises(ScheduleError) as e:
            validate_requested_slot(cfg, at_wib("2026-01-06", "12:00"), TZ, NOW)  # Tuesday
        assert e.value.reason == R_CLOSED

    def test_holiday_rejected(self):
        cfg = normalize_schedule({"holidays": ["2026-01-06"]})
        with pytest.raises(ScheduleError) as e:
            validate_requested_slot(cfg, at_wib("2026-01-06", "12:00"), TZ, NOW)
        assert e.value.reason == R_CLOSED

    def test_too_far_rejected(self):
        with pytest.raises(ScheduleError) as e:
            validate_requested_slot(CFG, at_wib("2026-01-14", "12:00"), TZ, NOW)  # 9 days out > 7
        assert e.value.reason == R_TOO_FAR
        # boundary: today+7 is still bookable
        ok = validate_requested_slot(CFG, at_wib("2026-01-12", "12:00"), TZ, NOW)
        assert ok == at_wib("2026-01-12", "12:00")

    def test_disabled_rejected(self):
        cfg = normalize_schedule({"enabled": False})
        with pytest.raises(ScheduleError) as e:
            validate_requested_slot(cfg, at_wib("2026-01-05", "16:00"), TZ, NOW)
        assert e.value.reason == R_CLOSED

    def test_naive_datetime_rejected(self):
        with pytest.raises(ScheduleError) as e:
            validate_requested_slot(CFG, datetime(2026, 1, 5, 16, 0), TZ, NOW)
        assert e.value.reason == R_NOT_SLOT


class TestDaySlots:
    def test_grid_covers_opening_hours(self):
        day = build_day_slots(CFG, datetime.fromisoformat("2026-01-05").date(), TZ, NOW)
        assert day["open"] is True
        starts = [s["start_local"][11:16] for s in day["slots"]]
        assert starts[0] == "09:00"
        assert starts[-1] == "20:45"  # last slot must END by 21:00
        assert all(s["start_local"][14:16] in {"00", "15", "30", "45"} for s in day["slots"])

    def test_past_and_lead_slots_marked_unavailable(self):
        # clock 15:00 WIB, 30-min lead -> 15:15 blocked, 15:30 exactly at the boundary ok
        day = build_day_slots(CFG, datetime.fromisoformat("2026-01-05").date(), TZ, NOW)
        by_time = {s["start_local"][11:16]: s for s in day["slots"]}
        assert by_time["14:45"]["available"] is False
        assert by_time["14:45"]["reason"] == R_PAST
        assert by_time["15:15"]["available"] is False
        assert by_time["15:15"]["reason"] == R_LEAD_TIME
        assert by_time["15:30"]["available"] is True

    def test_full_slot_marked_unavailable(self):
        day_iso = "2026-01-05"
        taken = {at_wib(day_iso, "16:00").isoformat(): 3}
        cfg = normalize_schedule({"capacity_per_slot": 3})
        day = build_day_slots(cfg, datetime.fromisoformat(day_iso).date(), TZ, NOW, taken)
        by_time = {s["start_local"][11:16]: s for s in day["slots"]}
        assert by_time["16:00"]["available"] is False
        assert by_time["16:00"]["reason"] == "full"
        assert by_time["16:00"]["taken"] == 3

    def test_closed_day_has_no_slots(self):
        cfg = normalize_schedule({"hours": {"0": ["09:00", "21:00"]}})  # Monday only
        day = build_day_slots(cfg, datetime.fromisoformat("2026-01-06").date(), TZ, NOW)  # Tuesday
        assert day["open"] is False
        assert day["slots"] == []


class TestUpcomingDays:
    def test_window_and_open_flags(self):
        days = upcoming_days(CFG, TZ, NOW)
        assert len(days) == 8  # today + 7
        assert days[0]["date"] == "2026-01-05"
        assert all(d["open"] for d in days)
        cfg = normalize_schedule({"holidays": ["2026-01-07"]})
        days = upcoming_days(cfg, TZ, NOW)
        wed = next(d for d in days if d["date"] == "2026-01-07")
        assert wed["open"] is False


class TestOrderFlow:
    def test_happy_path(self):
        assert can_transition(RECEIVED, PREPARING)
        assert can_transition(PREPARING, READY)
        assert can_transition(READY, COMPLETED)

    def test_no_skipping_and_no_backward(self):
        assert not can_transition(RECEIVED, READY)
        assert not can_transition(READY, PREPARING)
        assert not can_transition(COMPLETED, READY)

    def test_terminal_states(self):
        for terminal in (COMPLETED, CANCELLED):
            for other in (RECEIVED, PREPARING, READY, COMPLETED, CANCELLED):
                assert not can_transition(terminal, other)

    def test_assert_raises_on_invalid(self):
        import pytest as _pytest
        with _pytest.raises(ValueError):
            assert_transition(RECEIVED, COMPLETED)
        with _pytest.raises(ValueError):
            assert_transition(RECEIVED, "bogus")


class TestStoreOpenNow:
    def cfg(self):
        return {
            "enabled": True,
            "slot_minutes": 30,
            "min_lead_minutes": 0,
            "max_days_ahead": 7,
            "hours": {"0": ["09:00", "21:00"]},
            "holidays": [],
        }

    def test_open_during_hours(self):
        # Monday 10:00 UTC = 17:00 WIB.
        assert store_is_open_now(self.cfg(), TZ, datetime(2024, 1, 1, 10, tzinfo=timezone.utc))

    def test_closed_before_opening(self):
        # Monday 00:30 UTC = 07:30 WIB.
        assert not store_is_open_now(self.cfg(), TZ, datetime(2024, 1, 1, 0, 30, tzinfo=timezone.utc))

    def test_closed_after_closing(self):
        # Monday 15:00 UTC = 22:00 WIB.
        assert not store_is_open_now(self.cfg(), TZ, datetime(2024, 1, 1, 15, tzinfo=timezone.utc))

    def test_closed_day(self):
        # Tuesday 02:00 UTC = 09:00 WIB, but only Monday is enabled.
        assert not store_is_open_now(self.cfg(), TZ, datetime(2024, 1, 2, 2, tzinfo=timezone.utc))

    def test_holiday_closed(self):
        cfg = self.cfg()
        cfg["holidays"] = ["2024-01-01"]
        assert not store_is_open_now(cfg, TZ, datetime(2024, 1, 1, 10, tzinfo=timezone.utc))
