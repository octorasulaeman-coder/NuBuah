"""In-memory rate limiting and brute-force lockout (per process; sufficient for a single-server POS).

- check_rate: sliding-window throttle per key (e.g. "login:<ip>"), 429 with Retry-After.
- check_locked / record_fail / record_success: consecutive-failure lockout per account
  (e.g. "acct:<email>" or "pin:<store_id>") — after LOCK_AFTER failures the account is
  locked out for LOCK_SECONDS. Locks survive successful logins on other keys; a success
  clears that account's failure count.
"""

import time
from typing import Optional

from fastapi import HTTPException, Request

RATE_LIMIT = 15  # attempts per window per key
RATE_WINDOW = 300  # seconds
LOCK_AFTER = 8  # consecutive failures
LOCK_SECONDS = 600  # lockout length

_attempts: dict[str, list[float]] = {}
_fails: dict[str, tuple[int, float]] = {}  # key -> (consecutive failures, first failure ts)


def _prune() -> None:
    if len(_attempts) < 5000 and len(_fails) < 5000:
        return
    now = time.monotonic()
    for k in [k for k, v in _attempts.items() if not v or now - v[-1] > RATE_WINDOW]:
        _attempts.pop(k, None)
    for k, (_, first) in list(_fails.items()):
        if now - first > LOCK_SECONDS:
            _fails.pop(k, None)


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def check_rate(key: str) -> None:
    _prune()
    now = time.monotonic()
    window = [t for t in _attempts.get(key, []) if now - t < RATE_WINDOW]
    if len(window) >= RATE_LIMIT:
        retry = int(RATE_WINDOW - (now - window[0])) + 1
        raise HTTPException(status_code=429, detail="Terlalu banyak percobaan. Coba lagi nanti.", headers={"Retry-After": str(retry)})
    window.append(now)
    _attempts[key] = window


def check_locked(key: str) -> None:
    _prune()
    fails, first = _fails.get(key, (0, 0.0))
    if fails >= LOCK_AFTER and time.monotonic() - first < LOCK_SECONDS:
        retry = int(LOCK_SECONDS - (time.monotonic() - first)) + 1
        raise HTTPException(status_code=429, detail="Akun terkunci sementara karena terlalu banyak percobaan gagal.", headers={"Retry-After": str(retry)})


def record_fail(key: str) -> None:
    fails, first = _fails.get(key, (0, 0.0))
    if time.monotonic() - first > LOCK_SECONDS:
        fails, first = 0, time.monotonic()
    _fails[key] = (fails + 1, first)


def record_success(key: str) -> None:
    _fails.pop(key, None)
    _attempts.pop(key, None)
