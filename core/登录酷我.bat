@echo off
title Login - Kuwo Music
cd /d "%~dp0.."

echo ============================================================
echo   Kuwo Music  -  WeChat QR Login  (Cookie available too)
echo ============================================================
echo.
echo   A QR code will be printed below.
echo   Open WeChat on your phone - Scan - then tap Confirm.
echo   If you prefer, you can paste a Cookie instead.
echo.
echo   Make sure the player service is running first.
echo   If not, close this window and double-click "start.bat"
echo   in the player folder, then run this login program again.
echo.

if not exist "core\Alogorithm-main\tools\login.js" goto NOFILES

node "core\Alogorithm-main\tools\login.js" kuwo
pause
exit /b %errorlevel%

:NOFILES
echo [ERROR] Missing core\Alogorithm-main\tools\login.js
echo         This script must stay inside the "core" folder of the player.
echo.
pause
exit /b 1
