"""Shared backup scope + integrity fingerprint. Pure module: importable from both the
async app (lib/backup.py) and the standalone sync restore script (restore_backup.py)
without pulling in motor or environment variables.

COLLECTIONS is the single source of truth for "what a full backup contains". Adding a
collection here automatically covers create, list-verify, and restore.
"""

import hashlib
from typing import Any

# Every business collection. Keep in sync with reality — this list is the backup scope.
COLLECTIONS = [
    "orders", "stores", "users",
    "menu_overrides", "option_overrides",
    "menu_products", "menu_groups", "menu_options", "menu_categories", "menu_edits",
    "product_codes", "media",
    "custom_products", "custom_options", "custom_categories", "custom_groups",
    "counters", "audit", "drawer_events",
]

# Collections introduced after older backups existed; restore tolerates their absence
# (a v1 backup has no menu_products etc.) but reports them as missing.
CORE_COLLECTIONS = ("orders", "stores", "users", "counters")


def canonical_dumps(data: dict[str, Any]) -> str:
    """Deterministic serialized form of the collections payload (checksum input)."""
    from bson import json_util

    return json_util.dumps(
        {"collections": data["collections"]},
        json_options=json_util.CANONICAL_JSON_OPTIONS,
    )


def fingerprint_payload(data: dict[str, Any]) -> str:
    """SHA-256 over the canonical collections payload — written into the backup file."""
    return hashlib.sha256(canonical_dumps(data).encode("utf-8")).hexdigest()


def verify_data(data: dict[str, Any]) -> tuple[bool, str]:
    """Validate a parsed backup dict. Returns (ok, message). Never raises on bad input."""
    if data.get("app") != "nubuah":
        return False, "This is not a NuBuah backup file."
    collections = data.get("collections")
    if not isinstance(collections, dict):
        return False, "Backup has no collections payload."
    missing_core = [c for c in CORE_COLLECTIONS if c not in collections]
    if missing_core:
        return False, f"Backup is missing core collections: {missing_core}"
    declared = data.get("sha256")
    if declared:
        actual = fingerprint_payload(data)
        if actual != declared:
            return False, "Integrity check FAILED: sha256 mismatch (file is corrupt or tampered)."
    else:
        # Backups written before checksums existed: structurally valid but unverifiable.
        return True, "No checksum in file (pre-checksum backup); structure OK but contents unverified."
    return True, "Integrity check OK."
