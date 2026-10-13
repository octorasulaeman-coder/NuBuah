@echo off
REM NuBuah POS - start on Windows AND let tablets / phones on the same Wi-Fi open it.
REM Double-click this file on the main shop computer. See NETWORK_SETUP.md.
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

echo [4/4] Menjalankan NuBuah. Di komputer ini: http://localhost:8001
echo.
echo Di tablet / HP (Wi-Fi yang sama), buka salah satu alamat ini di Chrome:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo     http://%%a:8001/pos
echo.
echo Biarkan jendela ini tetap terbuka selama toko buka.
start "" http://localhost:8001/pos
cd backend
.venv\Scripts\python -m uvicorn server:app --host 0.0.0.0 --port 8001
goto :eof

:error
echo.
echo Gagal. Pastikan Python, Node.js dan MongoDB sudah terpasang. Lihat OFFLINE_SETUP.md
pause
