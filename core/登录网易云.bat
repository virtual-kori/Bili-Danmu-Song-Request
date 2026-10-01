@echo off
title Login - Netease Cloud Music
cd /d "%~dp0.."

echo ============================================================
echo   Netease Cloud Music  -  QR Login
echo ============================================================
echo.
echo   Make sure the player service is running first.
echo   If not, close this window and double-click "start.bat"
echo   in the player folder, then run this login program again.
echo.

if not exist "core\Alogorithm-main\tools\login.js" goto NOFILES

node "core\Alogorithm-main\tools\login.js" netease
pause
exit /b %errorlevel%

:NOFILES
echo [ERROR] Missing core\Alogorithm-main\tools\login.js
echo         This script must stay inside the "core" folder of the player.
echo.
pause
exit /b 1
