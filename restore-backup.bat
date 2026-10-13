@echo off
REM Restore NuBuah data from a backup file. Usage: restore-backup.bat backups\nubuah-backup-2026-10-11-0900.json.gz
cd /d "%~dp0"
if "%~1"=="" (
  echo Usage: restore-backup.bat backups\nama-file-backup.json.gz
  echo Backups available:
  dir /b backups\nubuah-backup-*.json.gz
  pause
  exit /b 1
)
cd backend
.venv\Scripts\python restore_backup.py "..\%~1"
pause
