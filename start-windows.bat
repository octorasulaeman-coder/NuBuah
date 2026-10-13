@echo off
REM NuBuah POS - start on Windows. Double-click this file.
REM Needs: Python 3.11+, Node.js 20+, MongoDB Community Server (running as a service).
cd /d "%~dp0"

if not exist backend\.env (
  echo MONGO_URL=mongodb://localhost:27017> backend\.env
  echo DB_NAME=nubuah>> backend\.env
  echo CORS_ORIGINS=*>> backend\.env
)

if not exist backend\.venv (
  echo [1/4] Membuat Python environment...
  python -m venv backend\.venv || goto :error
)
echo [2/4] Install backend...
backend\.venv\Scripts\python -m pip install -q -r backend\requirements-local.txt || goto :error

if not exist frontend\dist\index.html (
  echo [3/4] Build frontend ^(sekali saja, butuh internet untuk install pertama^)...
  cd frontend
  call npx --yes yarn install || goto :error
  call npx --yes yarn vite build || goto :error
  cd ..
) else (
  echo [3/4] Frontend sudah di-build. Hapus folder frontend\dist untuk build ulang.
)

echo [4/4] Menjalankan NuBuah di http://localhost:8001
start "" http://localhost:8001/pos
cd backend
.venv\Scripts\python -m uvicorn server:app --host 127.0.0.1 --port 8001
goto :eof

:error
echo.
echo Gagal. Pastikan Python, Node.js dan MongoDB sudah terpasang. Lihat OFFLINE_SETUP.md
pause
