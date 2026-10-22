import gzip

from bson import json_util
from fastapi import APIRouter, Body, Depends, Header, HTTPException
from fastapi.responses import FileResponse

from lib import backup as bk
from lib.backup_collections import COLLECTIONS, verify_data
from lib.db import db
from lib.audit import audit
from lib.auth import Principal, get_principal

router = APIRouter()


def _owner(p: Principal) -> None:
    if not p.is_owner:
        raise HTTPException(status_code=403, detail="Owner only")


@router.get("/backup")
async def backup_status(p: Principal = Depends(get_principal)):
    _owner(p)
    items = bk.list_backups()
    return {"folder": str(bk.BACKUP_DIR), "keep_days": bk.KEEP_DAYS, "backups": items[:30], "has_today": bk.has_backup_today()}


@router.post("/backup/run", status_code=201)
async def backup_run(p: Principal = Depends(get_principal)):
    _owner(p)
    result = await bk.create_backup()
    await audit("backup.run", p, detail={"name": result["name"], "counts": result["counts"]})
    return result


MAX_RESTORE_BYTES = 100 * 1024 * 1024


@router.post("/backup/restore")
async def backup_restore(
    payload: bytes = Body(...),
    filename: str | None = Header(default=None, alias="X-Filename"),
    p: Principal = Depends(get_principal),
):
    """Owner-only full restore from an official NuBuah .json.gz backup.

    A fresh safety backup is always created before replacing collection contents.
    """
    _owner(p)
    raw = payload
    if len(raw) > MAX_RESTORE_BYTES:
        raise HTTPException(status_code=413, detail="File backup terlalu besar (maks 100 MB)")
    try:
        payload = gzip.decompress(raw)
    except (OSError, EOFError) as exc:
        raise HTTPException(status_code=400, detail="File harus berupa .json.gz hasil backup NuBuah") from exc
    try:
        data = json_util.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Isi backup tidak valid") from exc
    ok, message = verify_data(data)
    if not ok:
        raise HTTPException(status_code=400, detail=f"Backup tidak valid: {message}")

    safety = await bk.create_backup()
    counts: dict[str, int] = {}
    for name in COLLECTIONS:
        docs = data["collections"].get(name)
        if docs is None:
            continue
        await db[name].delete_many({})
        if docs:
            await db[name].insert_many(docs)
        counts[name] = len(docs)

    await audit("backup.restore", p, detail={
        "uploaded": filename,
        "safety_backup": safety["name"],
        "counts": counts,
    })
    return {
        "restored": counts,
        "safety_backup": safety["name"],
        "message": message,
    }


@router.get("/backup/verify/{name}")
async def backup_verify(name: str, p: Principal = Depends(get_principal)):
    """Integrity-check a backup file before trusting it (owner only)."""
    _owner(p)
    try:
        result = await bk.verify_backup(name)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file name")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Backup not found")
    await audit("backup.verify", p, detail={"name": name, "ok": result["ok"]})
    return result


@router.get("/backup/download/{name}")
async def backup_download(name: str, p: Principal = Depends(get_principal)):
    _owner(p)
    if not bk.NAME_RE.match(name):  # also blocks path tricks like ../
        raise HTTPException(status_code=400, detail="Invalid file name")
    path = bk.BACKUP_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Backup not found")
    await audit("backup.download", p, detail={"name": name, "size": path.stat().st_size})
    return FileResponse(path, media_type="application/gzip", filename=name)
