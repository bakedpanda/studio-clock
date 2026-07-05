@echo off
taskkill /FI "WINDOWTITLE eq StudioClock*" /T /F >nul 2>&1
echo Studio Clock stopped.
pause
