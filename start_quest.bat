@echo off
title MOTI - Mixed Reality (Meta Quest)
color 0B
echo.
echo  =============================================
echo   MOTI  -  Mixed Reality server for Quest
echo  =============================================
echo.

if not exist ".env" (
  echo [SETUP] Run setup.bat first.
  pause
  exit /b
)

if not exist "venv" (
  echo [SETUP] Run setup.bat first.
  pause
  exit /b
)

call venv\Scripts\activate.bat

echo [SETUP] Checking HTTPS certificate...
python scripts\generate_cert.py
if errorlevel 1 (
  echo [ERROR] Could not create certificate. Is "cryptography" installed? Re-run setup.bat.
  pause
  exit /b
)

echo.
echo [MOTI] WebXR only works over HTTPS (or localhost), so this uses a
echo [MOTI] self-signed certificate. On the Quest browser you'll see a
echo [MOTI] privacy warning the first time - tap "Advanced" then "Visit site"
echo [MOTI] to continue. That warning is expected for a local server you own.
echo.
echo [MOTI] Starting HTTPS server on port 8443. Press Ctrl+C to stop.
echo.

python -m uvicorn app:app --host 0.0.0.0 --port 8443 --ssl-keyfile certs\key.pem --ssl-certfile certs\cert.pem
pause
