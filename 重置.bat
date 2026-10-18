@echo off
title DianGeJi - Reset
cd /d "%~dp0"

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
echo   DanMu DianGeJi  -  RESET
echo ============================================================
echo.
echo   This will DELETE all user data:
echo     * platform login cookies (all four platforms)
echo     * Bilibili login
echo     * live room number
echo     * your rules / switches / player path
echo     * runtime logs and caches
echo.
echo   The program itself, node_modules and mpv are NOT touched.
echo.
echo   After resetting, start the program again and log in
echo   from the Web UI. The danmaku server is re-picked
echo   automatically on every connect.
echo.

if not exist "core\Alogorithm-main\tools\reset-all.js" goto NOFILES

if not defined NODE_BIN goto NONODE
"%NODE_BIN%" "core\Alogorithm-main\tools\reset-all.js"
set EXITCODE=%errorlevel%

echo.
if "%EXITCODE%"=="0" (
  echo [OK] Reset finished.
) else (
  echo [WARN] Reset finished with warnings ^(see above^).
)
echo.
pause
exit /b %EXITCODE%

:NONODE
echo [ERROR] Node.js runtime not found.
echo         Expected a bundled runtime at "core\node\node.exe",
echo         or install Node.js 18+ and add it to PATH.
echo.
pause
exit /b 1

:NOFILES
echo [ERROR] Missing core\Alogorithm-main\tools\reset-all.js
echo         Make sure the "core" folder is next to this script.
echo.
pause
exit /b 1
