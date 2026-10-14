# NuBuah POS - one container: FastAPI backend serves the built frontend.
# Needs env vars at runtime: MONGO_URL, DB_NAME, JWT_SECRET (see DEPLOY notes).

# ---------- Stage 1: build frontend ----------
FROM node:22-slim AS web
WORKDIR /app/frontend

# Drop the two Emergent dev-only packages before install (they come from a private URL).
COPY frontend/package.json ./
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));for(const k of ['@emergentbase/overlay','@emergentbase/visual-edits']){delete p.devDependencies[k];}fs.writeFileSync('package.json',JSON.stringify(p,null,2));" \
 && npm install --no-audit --no-fund --legacy-peer-deps

COPY frontend/ ./
# Overwrite package.json copy from above is harmless: node_modules is already installed.
RUN npx vite build --config vite.config.docker.ts

# ---------- Stage 2: backend + built frontend ----------
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

COPY backend/requirements-local.txt backend/requirements-local.txt
RUN pip install --no-cache-dir -r backend/requirements-local.txt

COPY backend/ backend/
COPY --from=web /app/frontend/dist frontend/dist

# Backups go to a folder inside the container (lost on restart on most free hosts).
ENV BACKUP_DIR=/tmp/backups

WORKDIR /app/backend
EXPOSE 8001
# $PORT is set by most hosts; falls back to 8001. proxy-headers so the login cookie is
# marked Secure when the host terminates HTTPS.
CMD ["sh", "-c", "exec uvicorn server:app --host 0.0.0.0 --port ${PORT:-8001} --proxy-headers --forwarded-allow-ips='*'"]
