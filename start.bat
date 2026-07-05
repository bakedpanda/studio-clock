@echo off
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)

start "StudioClock" /min cmd /c "node server.js"
timeout /t 2 /nobreak >nul
start "" "http://localhost:7823/operator"

echo Studio Clock is running.
echo   Operator: http://localhost:7823/operator
echo   Viewer:   http://localhost:7823/
echo.
echo To stop it, run stop.bat
pause
