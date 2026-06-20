@echo off
title MOTI - Room AI Control
color 0B
echo.
echo  =============================================
echo   MOTI  -  Room AI Control  -  Starting...
echo  =============================================
echo.

if not exist ".env" (
  echo [SETUP] Creating .env from template...
  copy .env.example .env
  echo [SETUP] Edit .env with your credentials then re-run this script.
  pause
  exit /b
)

if not exist "venv" (
  echo [SETUP] Creating virtual environment...
  python -m venv venv
)

echo [SETUP] Activating virtual environment...
call venv\Scripts\activate.bat

echo [SETUP] Installing dependencies...
pip install -r requirements.txt --quiet

echo.
echo [MOTI] Starting server on http://localhost:8000
echo [MOTI] Press Ctrl+C to stop.
echo.

python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload
pause
