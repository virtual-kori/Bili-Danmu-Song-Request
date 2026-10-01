@echo off
title Login - QQ Music
cd /d "%~dp0.."

echo ============================================================
echo   QQ Music  -  QR Login  (Cookie fallback available)
echo ============================================================
echo.
echo   QQ's login endpoint may be blocked by risk control.
echo   If scanning fails, choose the "paste Cookie" option
echo   when the program asks, or use the Web UI login dialog.
echo.
echo   Make sure the player service is running first.
echo   If not, close this window and double-click "start.bat"
echo   in the player folder, then run this login program again.
echo.

if not exist "core\Alogorithm-main\tools\login.js" goto NOFILES

node "core\Alogorithm-main\tools\login.js" qq
pause
exit /b %errorlevel%

:NOFILES
echo [ERROR] Missing core\Alogorithm-main\tools\login.js
echo         This script must stay inside the "core" folder of the player.
echo.
pause
exit /b 1
