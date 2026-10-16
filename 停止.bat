@echo off
title DianGeJi - Stop
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

echo Stopping DanMu DianGeJi and all child processes ...
echo.

if not exist "core\Alogorithm-main\tools\stop-all.js" goto NOSCRIPT

if not defined NODE_BIN goto NONODE_SOFT
"%NODE_BIN%" "core\Alogorithm-main\tools\stop-all.js"
if errorlevel 1 goto FALLBACK

echo.
echo Done.
exit /b 0

:FALLBACK
echo [WARN] Automatic stop failed, cleaning up by port ...
for %%P in (33000 33011 33012 33013 33014) do (
  for /f "tokens=5" %%I in ('netstat -ano ^| findstr ":%%P " ^| findstr LISTENING') do (
    taskkill /PID %%I /T /F >nul 2>nul
    echo   killed PID %%I on port %%P
  )
)
taskkill /IM mpv.exe /F >nul 2>nul
echo.
echo Done.
exit /b 0

:NOSCRIPT
echo [ERROR] Missing core\Alogorithm-main\tools\stop-all.js
echo         Make sure the "core" folder is next to this script.
echo.
pause
exit /b 1

:NONODE_SOFT
echo [WARN] Node.js runtime not found; skipping this step.
echo.
