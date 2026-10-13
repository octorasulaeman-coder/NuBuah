"""Session auth: httpOnly JWT cookie. Two kinds of session: a user (owner / cashier email login) or a store PIN."""
import logging
import os
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from fastapi import HTTPException, Request, Response
from passlib.context import CryptContext

from lib.db import db

logger = logging.getLogger(__name__)

COOKIE = "nb_session"
# Never ship a predictable secret: without JWT_SECRET we generate a random per-process one
# (all sessions reset on restart) and say so loudly. Set JWT_SECRET in backend/.env.
SECRET = os.environ.get("JWT_SECRET")
if not SECRET:
    SECRET = secrets.token_hex(32)
    logger.warning("JWT_SECRET is not set; using a random per-process secret. All sessions reset on restart. Set JWT_SECRET in backend/.env.")
TTL_HOURS = 24 * 7
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Routes a must-change-password user may still call until they set a real password.
PASSWORD_CHANGE_ALLOWED_PATHS = ("/api/auth/me", "/api/auth/me/password", "/api/auth/logout")


@dataclass
class Principal:
    kind: str  # "user" | "pin"
    id: str
    name: str
    role: str  # "owner" | "cashier"
    store_id: Optional[str]
    email: Optional[str] = None
    must_change_password: bool = False

    @property
    def is_owner(self) -> bool:
        return self.role == "owner"


def hash_secret(s: str) -> str:
    return pwd.hash(s)


def verify_secret(s: str, h: str) -> bool:
    try:
        return pwd.verify(s, h)
    except ValueError:
        return False


def set_session(request: Request, response: Response, claims: dict) -> None:
    exp = datetime.now(timezone.utc) + timedelta(hours=TTL_HOURS)
    token = jwt.encode({**claims, "exp": exp}, SECRET, algorithm="HS256")
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax", secure=secure, max_age=TTL_HOURS * 3600, path="/")


def clear_session(response: Response) -> None:
    response.delete_cookie(COOKIE, path="/")


async def get_principal(request: Request) -> Principal:
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        c = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Session expired")
    if c.get("kind") == "pin":
        store = await db.stores.find_one({"id": c.get("store_id")}, {"_id": 0, "name": 1, "pin_version": 1})
        if not store or store.get("pin_version", 0) != c.get("pv", 0):
            raise HTTPException(status_code=401, detail="Session expired")
        return Principal(kind="pin", id=f"pin:{c['store_id']}", name=f"Kasir {store['name']}", role="cashier", store_id=c["store_id"])
    user = await db.users.find_one({"id": c.get("sub")}, {"_id": 0})
    if not user or not user.get("active", True):
        raise HTTPException(status_code=401, detail="Not authenticated")
    if user.get("token_version", 0) != c.get("tv", 0):  # password or email was changed: old sessions are signed out
        raise HTTPException(status_code=401, detail="Session expired")
    if user.get("must_change_password") and request.url.path not in PASSWORD_CHANGE_ALLOWED_PATHS:
        logger.info("blocked %s %s: owner must change the default password first", request.method, request.url.path)
        raise HTTPException(status_code=403, detail="Ganti password dulu (password bawaan masih dipakai)")
    return Principal(kind="user", id=user["id"], name=user["name"], role=user["role"], store_id=user.get("store_id"), email=user["email"], must_change_password=user.get("must_change_password", False))


async def require_owner(request: Request) -> Principal:
    p = await get_principal(request)
    if not p.is_owner:
        raise HTTPException(status_code=403, detail="Owner only")
    return p


async def resolve_store(p: Principal, requested: Optional[str], allow_all: bool = False) -> Optional[str]:
    """Store a request acts on. Cashiers are pinned to their store; owners must name one (or 'all' where allowed)."""
    if not p.is_owner:
        if requested and requested not in ("all", p.store_id):
            raise HTTPException(status_code=403, detail="No access to this store")
        return p.store_id
    if requested == "all" and allow_all:
        return None
    if not requested or requested == "all":
        raise HTTPException(status_code=400, detail="store_id is required")
    if not await db.stores.find_one({"id": requested}, {"_id": 1}):
        raise HTTPException(status_code=404, detail="Store not found")
    return requested
