"""Idempotency helpers: stable payload fingerprints for client_order_id semantics.

A client_order_id scopes "the same logical checkout, retried". Two requests share an
order only if the *order content* is identical. Auth-only material (approval PIN) and
the key itself are excluded from the fingerprint so a legitimate retry never looks
like a different checkout.

Pure module (json + hashlib only): unit-testable without a database.
"""

import hashlib
import json
from typing import Any

# Auth-only fields that must not make two retries of the same checkout look different.
_EXCLUDED_KEYS = {"client_order_id", "approval_pin"}


def payload_fingerprint(payload: dict[str, Any]) -> str:
    """SHA-256 over the canonical JSON of the order-defining fields.

    Canonical = sorted keys, compact separators, stable str() fallback for values
    JSON cannot natively encode. Same order content always hashes identically;
    any meaningful change (lines, qty, prices, discounts, customer, payment)
    produces a different hash.
    """
    material = {k: v for k, v in payload.items() if k not in _EXCLUDED_KEYS and v is not None}
    canonical = json.dumps(material, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
