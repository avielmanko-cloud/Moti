@echo off
title MOTI - Room AI Control
color 0B

REM Start server in background
start /B cmd /C "call venv\Scripts\activate.bat && python -m uvicorn app:app --host 0.0.0.0 --port 8000"

REM Wait for server to start
timeout /t 3 /nobreak > nul

REM Open in Chrome kiosk mode (big screen / fullscreen)
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --app=http://localhost:8000 --disable-infobars --no-first-run

echo MOTI is running. Close Chrome window to exit.
