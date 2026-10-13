#!/usr/bin/env bash
# NuBuah POS - start on macOS / Linux:  bash start-mac-linux.sh
# Needs: Python 3.11+, Node.js 20+, MongoDB Community Server running on localhost:27017.
set -e
cd "$(dirname "$0")"

if [ ! -f backend/.env ]; then
  printf 'MONGO_URL=mongodb://localhost:27017\nDB_NAME=nubuah\nCORS_ORIGINS=*\n' > backend/.env
fi

if [ ! -d backend/.venv ]; then
  echo "[1/4] Membuat Python environment..."
  python3 -m venv backend/.venv
fi
echo "[2/4] Install backend..."
backend/.venv/bin/python -m pip install -q -r backend/requirements-local.txt

if [ ! -f frontend/dist/index.html ]; then
  echo "[3/4] Build frontend (sekali saja, butuh internet untuk install pertama)..."
  (cd frontend && npx --yes yarn install && npx --yes yarn vite build)
else
  echo "[3/4] Frontend sudah di-build. Hapus folder frontend/dist untuk build ulang."
fi

echo "[4/4] Menjalankan NuBuah di http://localhost:8001"
( sleep 2; (open http://localhost:8001/pos 2>/dev/null || xdg-open http://localhost:8001/pos 2>/dev/null || true) ) &
cd backend
exec .venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8001
