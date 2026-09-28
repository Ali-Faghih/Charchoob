@echo off
REM Start backend :8000 + frontend :8443.
REM Logs go to %LOCALAPPDATA%\Temp\opencode\.
cd /d "%~dp0"
start "crop-backend" .venv\Scripts\python.exe -m uvicorn server:app --host 0.0.0.0 --port 8000
start "crop-web" cmd /c "npm run dev"
echo All servers starting - backend :8000, frontend :8443.
