@echo off
REM Add sample orders / menu items / toppings for testing:   seed-sample-data.bat
REM Remove ONLY the sample data again:                       seed-sample-data.bat --remove
cd /d "%~dp0backend"
.venv\Scripts\python seed_sample_data.py %*
pause
