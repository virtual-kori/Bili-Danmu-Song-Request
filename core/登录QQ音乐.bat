@echo off
title Login - QQ Music
cd /d "%~dp0.."


rem --- BUNDLED_NODE_DETECT: prefer the bundled Node, fall back to system Node ---
set "NODE_BIN="
set "NODE_SRC="
if exist "core\node\node.exe" set "NODE_BIN=core\node\node.exe"
if not defined NODE_BIN if exist "node\node.exe" set "NODE_BIN=node\node.exe"
if defined NODE_BIN set "NODE_SRC=bundled"
if not defined NODE_BIN (
  where node >nul 2>nul
  if not errorlevel 1 (
    set "NODE_BIN=node"
    set "NODE_SRC=system"
  )
)

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

if not defined NODE_BIN goto NONODE
"%NODE_BIN%" "core\Alogorithm-main\tools\login.js" qq
pause
exit /b %errorlevel%

:NOFILES
echo [ERROR] Missing core\Alogorithm-main\tools\login.js
echo         This script must stay inside the "core" folder of the player.
echo.
pause
exit /b 1

:NONODE
echo [ERROR] Node.js runtime not found.
echo         Expected a bundled runtime at: node\node.exe
echo         Or install Node.js 18 or newer: https://nodejs.org/
echo.
pause
exit /b 1
