from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from lib import backup as bk
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
