@echo off
title DianGeJi
cd /d "%~dp0"

echo ============================================================
echo            DanMu DianGeJi  v1.0.2  Launcher
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NONODE

if not exist "core\Alogorithm-main\server.js" goto NOFILES

echo [1/2] Starting services ...
echo.

node "core\Alogorithm-main\server.js"
set EXITCODE=%errorlevel%

echo.
echo ============================================================
echo  Service exited with code %EXITCODE%
echo ============================================================
pause
exit /b %EXITCODE%

:NONODE
echo [ERROR] Node.js not found. Please install Node.js 18 or newer.
echo         https://nodejs.org/
echo.
pause
exit /b 1

:NOFILES
echo [ERROR] Missing core\Alogorithm-main\server.js
echo         Make sure the "core" folder is next to this script.
echo.
pause
exit /b 1
