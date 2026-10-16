@echo off
title DianGeJi
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
echo            DanMu DianGeJi  v1.0.2  Launcher
echo ============================================================
echo.
if not exist "core\Alogorithm-main\server.js" goto NOFILES

echo [1/2] Starting services ...
echo.

if not defined NODE_BIN goto NONODE
"%NODE_BIN%" "core\Alogorithm-main\server.js"
set EXITCODE=%errorlevel%

echo.
echo ============================================================
echo  Service exited with code %EXITCODE%
echo ============================================================
pause
exit /b %EXITCODE%

:NONODE
echo [ERROR] Node.js runtime not found.
echo         Expected a bundled runtime at "core\node\node.exe",
echo         (or "node\node.exe"), otherwise install Node.js 18+ and add it to PATH.
echo.
pause
exit /b 1

:NOFILES
echo [ERROR] Missing core\Alogorithm-main\server.js
echo         Make sure the "core" folder is next to this script.
echo.
pause
exit /b 1
