@echo off
title DianGeJi - Platform Login
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

:menu
cls
echo ============================================================
echo   DanMu DianGeJi  -  Platform Login
echo ============================================================
echo.
echo   Make sure the player service is running first
echo   (double-click "start.bat" in the player folder).
echo.
echo   1.  Netease Cloud Music   (QR login)
echo   2.  QQ Music              (QR login, Cookie fallback)
echo   3.  Kugou Music           (QR login)
echo   4.  Kuwo Music            (WeChat QR login, Cookie fallback)
echo   5.  Show login status of all four platforms
echo   0.  Exit
echo.

set /p CHOICE=  Choose [0-5]: 

set PLATFORM=
if "%CHOICE%"=="1" set PLATFORM=netease
if "%CHOICE%"=="2" set PLATFORM=qq
if "%CHOICE%"=="3" set PLATFORM=kugou
if "%CHOICE%"=="4" set PLATFORM=kuwo
if "%CHOICE%"=="5" goto status
if "%CHOICE%"=="0" exit /b 0

if not defined PLATFORM goto menu

if not exist "core\Alogorithm-main\tools\login.js" goto NOFILES

if not defined NODE_BIN goto NONODE
"%NODE_BIN%" "core\Alogorithm-main\tools\login.js" %PLATFORM%
set PLATFORM=
echo.
pause
goto menu

:status
if not exist "core\Alogorithm-main\tools\login.js" goto NOFILES
for %%P in (netease qq kugou kuwo) do (
  echo.
  "%NODE_BIN%" "core\Alogorithm-main\tools\login.js" %%P --status
)
echo.
pause
goto menu

:NOFILES
echo.
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
