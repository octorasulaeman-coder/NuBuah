"""Order status state machine — pure module (no database access).

Order status tracks preparation/fulfillment and is kept STRICTLY separate from payment
status. A pending payment never blocks the kitchen, and a completed order never implies
payment by itself (the cashier-facing reports still filter on payment_status + voided).
"""

RECEIVED = "received"
CONFIRMED = "confirmed"
PREPARING = "preparing"
READY = "ready"
COMPLETED = "completed"
CANCELLED = "cancelled"

ALL_STATUSES = [RECEIVED, CONFIRMED, PREPARING, READY, COMPLETED, CANCELLED]

# valid forward transitions; cancellation is additionally permission-gated in the router
_TRANSITIONS: dict[str, set[str]] = {
    RECEIVED: {CONFIRMED, PREPARING},
    CONFIRMED: {PREPARING, READY},
    PREPARING: {READY},
    READY: {COMPLETED},
    COMPLETED: set(),
    CANCELLED: set(),
}


def can_transition(current: str, target: str) -> bool:
    return target in _TRANSITIONS.get(current, set())


def assert_transition(current: str, target: str) -> None:
    if target not in ALL_STATUSES:
        raise ValueError(f"status tidak dikenal: {target}")
    if not can_transition(current, target):
        raise ValueError(f"tidak bisa dari '{current}' ke '{target}'")
