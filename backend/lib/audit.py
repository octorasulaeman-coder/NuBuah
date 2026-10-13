"""Append-only audit trail for sensitive actions (voids, staff changes, store changes, backups).

Read it from the Mongo console or a future admin page: db.audit.find().sort("created_at", -1)
"""

from datetime import datetime, timezone
from typing import Any, Optional

from lib.db import db


async def audit(action: str, principal: Optional[Any] = None, *, store_id: Optional[str] = None, detail: Optional[dict] = None) -> None:
    doc = {
        "action": action,
        "actor": getattr(principal, "name", None) if principal is not None else None,
        "actor_id": getattr(principal, "id", None) if principal is not None else None,
        "store_id": store_id if store_id is not None else getattr(principal, "store_id", None),
        "detail": detail or {},
        "created_at": datetime.now(timezone.utc),
    }
    try:
        await db.audit.insert_one(doc)
    except Exception:
        # auditing must never break the action it records
        import logging

        logging.getLogger(__name__).exception("audit insert failed: %s", action)
