@echo off
title MOTI - First Time Setup
color 0B
echo.
echo  =============================================
echo   MOTI  -  First Time Setup
echo  =============================================
echo.

REM Check Python
python --version 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Install Python 3.11+ from python.org
  pause
  exit /b 1
)

REM Create venv
echo [1/4] Creating virtual environment...
python -m venv venv
call venv\Scripts\activate.bat

REM Install deps
echo [2/4] Installing Python packages...
pip install -r requirements.txt

REM Copy .env
if not exist ".env" (
  echo [3/4] Creating .env file...
  copy .env.example .env
  echo.
  echo [!] Open .env in Notepad and fill in your credentials:
  echo     - Spotify Client ID + Secret (from developer.spotify.com)
  echo     - Xiaomi light IP + token
  echo     - Twilio SID + token (for WhatsApp)
  echo     - Phone IP (for ADB wireless)
  echo.
  notepad .env
) else (
  echo [3/4] .env already exists, skipping.
)

echo [4/4] Setup complete!
echo.
echo Run start.bat to launch MOTI.
echo Run start_fullscreen.bat for big-screen kiosk mode.
echo.
pause
