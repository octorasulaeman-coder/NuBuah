"""Payment configuration from the environment (P3.9).

Rules enforced here, not scattered through the code:
- mock provider is IMPOSSIBLE in production mode (hard refusal at startup).
- a selected provider with no registered adapter makes payment operations fail safe
  (503) instead of pretending.
- nothing here reads credentials into the frontend; all values stay server-side.
"""

import os
from dataclasses import dataclass


class PaymentConfigError(Exception):
    pass


@dataclass(frozen=True)
class PaymentConfig:
    provider: str            # "" = payments disabled
    enabled: bool
    mode: str                # "sandbox" | "production"
    api_key: str
    webhook_secret: str
    request_timeout_seconds: float
    expiry_minutes: int

    @property
    def mock_allowed(self) -> bool:
        return self.mode != "production"


def load_payment_config(env: dict | None = None) -> PaymentConfig:
    env = env or os.environ
    provider = (env.get("PAYMENT_PROVIDER") or "").strip().lower()
    enabled = env.get("PAYMENT_ENABLED", "0") == "1" and bool(provider)
    mode = (env.get("PAYMENT_MODE") or "sandbox").strip().lower()
    if mode not in ("sandbox", "production"):
        raise PaymentConfigError(f"PAYMENT_MODE must be sandbox|production, got {mode!r}")
    if provider == "mock" and mode == "production":
        # the one hard wall: the mock can never exist in a production process
        raise PaymentConfigError("MOCK PAYMENT PROVIDER REFUSED: provider=mock with mode=production")
    return PaymentConfig(
        provider=provider,
        enabled=enabled,
        mode=mode,
        api_key=env.get("PAYMENT_API_KEY", ""),
        webhook_secret=env.get("PAYMENT_WEBHOOK_SECRET", ""),
        request_timeout_seconds=float(env.get("PAYMENT_REQUEST_TIMEOUT", "10")),
        expiry_minutes=int(env.get("PAYMENT_EXPIRY_MINUTES", "15")),
    )


CONFIG = load_payment_config()  # raises at import time if production+mock — app refuses to start
