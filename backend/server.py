import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, APIRouter
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
import os
import logging
from pathlib import Path


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
from lib.db import client, db, ensure_indexes


# Startup runs before the yield, shutdown after it. Add your own setup/teardown here.
@asynccontextmanager
async def lifespan(app: FastAPI):
    from lib.bootstrap import bootstrap

    await bootstrap()  # default store + owner account + legacy migration (idempotent, fast)
    app.state.index_task = asyncio.create_task(ensure_indexes())  # background: a big index build must not block boot
    from lib.backup import backup_loop

    app.state.backup_task = asyncio.create_task(backup_loop())  # one automatic backup per day
    yield
    app.state.backup_task.cancel()
    client.close()


# Create the main app without a prefix
app = FastAPI(lifespan=lifespan, docs_url=None if os.environ.get("DISABLE_API_DOCS") == "1" else "/docs")

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")


from routers.orders import router as orders_router  # noqa: E402
from routers.menu import router as menu_router  # noqa: E402
from routers.reports import router as reports_router  # noqa: E402
from routers.backup import router as backup_router  # noqa: E402
from routers.auth import router as auth_router  # noqa: E402
from routers.drawer import router as drawer_router  # noqa: E402

api_router.include_router(auth_router)
api_router.include_router(orders_router)
api_router.include_router(menu_router)
api_router.include_router(reports_router)
api_router.include_router(backup_router)
api_router.include_router(drawer_router)

# Include the router in the main app
app.include_router(api_router)

# Offline / single-computer mode: if the frontend has been built (frontend/dist), serve it from
# this same server so the whole app runs at http://localhost:8001. Mounted after the API so /api wins.
FRONTEND_DIST = ROOT_DIR.parent / "frontend" / "dist"
if FRONTEND_DIST.is_dir() and os.environ.get("SERVE_FRONTEND", "1") == "1":
    from fastapi.responses import FileResponse  # noqa: E402
    from fastapi.staticfiles import StaticFiles  # noqa: E402

    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str):
        if full_path.startswith("api/"):
            from fastapi import HTTPException

            raise HTTPException(status_code=404, detail="Not Found")
        candidate = (FRONTEND_DIST / full_path).resolve()
        if full_path and candidate.is_file() and FRONTEND_DIST.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")

# Same-origin by default: the built frontend is served by this app and the Vite dev server
# proxies /api, so cross-origin requests are unnecessary. Set CORS_ORIGINS explicitly if you
# really host the frontend elsewhere (e.g. "http://192.168.1.10:3000").
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=[o.strip() for o in os.environ.get('CORS_ORIGINS', '').split(',') if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers(request, call_next):
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    )
    return resp

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)
