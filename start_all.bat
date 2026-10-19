@echo off
REM First run auto-setup: creates .venv + installs Python deps + npm deps.
REM Then starts backend :8000 + frontend :8443.
cd /d "%~dp0"

if not exist .venv\Scripts\python.exe (
  echo [setup] creating venv and installing Python deps ^(takes a few minutes^)...
  python -m venv .venv || goto :fail
  .venv\Scripts\python.exe -m pip install --upgrade pip
  .venv\Scripts\python.exe -m pip install -r requirements.txt || goto :fail
)

if not exist node_modules (
  echo [setup] installing npm deps...
  call npm install || goto :fail
)

start "crop-backend" .venv\Scripts\python.exe -m uvicorn server:app --host 0.0.0.0 --port 8000
start "crop-web" cmd /c "npm run dev"
echo All servers starting - backend :8000, frontend :8443.
echo Open http://localhost:8443
goto :eof

:fail
echo setup failed - see messages above.
pause
