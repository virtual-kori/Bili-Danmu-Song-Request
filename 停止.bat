@echo off
title DianGeJi - Stop
cd /d "%~dp0"

echo Stopping DanMu DianGeJi and all child processes ...
echo.

if not exist "core\Alogorithm-main\tools\stop-all.js" goto NOSCRIPT

node "core\Alogorithm-main\tools\stop-all.js"
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
