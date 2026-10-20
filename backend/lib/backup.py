"""Daily automatic backup of the NuBuah data to compressed JSON files (pure Python, no mongodump needed).

- One backup per day is made automatically while the app is running (checked at start and every 30 minutes).
- Files go to <project>/backups (or BACKUP_DIR) and the newest BACKUP_KEEP_DAYS days are kept (default 14).
- Restore with restore-backup.bat (Windows) or `python restore_backup.py <file>`.
"""

import asyncio
import gzip
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from bson import json_util

from lib.backup_collections import COLLECTIONS, fingerprint_payload, verify_data
from lib.db import db

logger = logging.getLogger(__name__)

STORE_TZ = os.environ.get("STORE_TZ", "Asia/Jakarta")
BACKUP_DIR = Path(os.environ.get("BACKUP_DIR") or (Path(__file__).resolve().parent.parent.parent / "backups"))
KEEP_DAYS = max(1, int(os.environ.get("BACKUP_KEEP_DAYS", "14")))
NAME_RE = re.compile(r"^nubuah-backup-(\d{4}-\d{2}-\d{2})-(\d{4})\.json\.gz$")


def _now_local() -> datetime:
    return datetime.now(ZoneInfo(STORE_TZ))


def list_backups() -> list[dict]:
    """Newest first."""
    if not BACKUP_DIR.exists():
        return []
    items = []
    for f in BACKUP_DIR.iterdir():
        m = NAME_RE.match(f.name)
        if m and f.is_file():
            items.append({"name": f.name, "size": f.stat().st_size, "date": m.group(1), "time": f"{m.group(2)[:2]}:{m.group(2)[2:]}"})
    return sorted(items, key=lambda x: x["name"], reverse=True)


def has_backup_today() -> bool:
    today = _now_local().date().isoformat()
    return any(b["date"] == today for b in list_backups())


def _write(path: Path, text: str) -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(BACKUP_DIR, 0o700)  # backups contain sales data and password hashes
    except OSError:
        logger.warning("could not chmod backup dir %s", BACKUP_DIR)
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as fh:
        fh.write(text)
    tmp.replace(path)  # never leaves a half-written backup under the real name
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _prune() -> None:
    dates = sorted({b["date"] for b in list_backups()}, reverse=True)
    for old in dates[KEEP_DAYS:]:
        for b in list_backups():
            if b["date"] == old:
                try:
                    (BACKUP_DIR / b["name"]).unlink()
                except OSError:
                    logger.warning("could not delete old backup %s", b["name"])


async def create_backup() -> dict:
    now = _now_local()
    data = {"app": "nubuah", "version": 1, "created_at": datetime.now(timezone.utc), "collections": {}}
    for name in COLLECTIONS:
        data["collections"][name] = await db[name].find({}, {"_id": 0}).to_list(None)
    counts = {k: len(v) for k, v in data["collections"].items()}
    # integrity checksum over the collections payload — verified again before any restore
    data["counts"] = counts
    data["sha256"] = fingerprint_payload(data)
    text = json_util.dumps(data, json_options=json_util.CANONICAL_JSON_OPTIONS)
    path = BACKUP_DIR / f"nubuah-backup-{now:%Y-%m-%d-%H%M}.json.gz"
    await asyncio.to_thread(_write, path, text)
    await asyncio.to_thread(_prune)
    logger.info("backup saved: %s %s", path.name, counts)
    return {"name": path.name, "size": path.stat().st_size, "counts": counts, "sha256": data["sha256"]}


def _verify_file(path: Path) -> dict:
    """Parse a backup file and check its integrity. Pure file read; no database access."""
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        data = json_util.loads(fh.read())
    ok, message = verify_data(data)
    counts = {k: len(v) for k, v in data.get("collections", {}).items()}
    return {
        "name": path.name,
        "ok": ok,
        "message": message,
        "created_at": str(data.get("created_at", "?")),
        "counts": counts,
        "sha256": data.get("sha256"),
    }


async def verify_backup(name: str) -> dict:
    """Verify a named backup file (owner-facing). Raises ValueError on a bad name/path."""
    if not NAME_RE.match(name):
        raise ValueError("Invalid file name")
    path = BACKUP_DIR / name
    if not path.is_file():
        raise FileNotFoundError(name)
    return await asyncio.to_thread(_verify_file, path)


async def backup_loop(first_delay: int = 20, every: int = 1800) -> None:
    """Background task: make sure there is a backup for today. Never raises."""
    await asyncio.sleep(first_delay)
    while True:
        try:
            if not has_backup_today():
                await create_backup()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("automatic backup failed; will retry")
        await asyncio.sleep(every)
