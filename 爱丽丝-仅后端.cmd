@echo off
chcp 65001 >nul
setlocal enableextensions
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "ALICE_USER_DIR=%ROOT%\data"
set "ALICE_RESOURCES_DIR=%ROOT%"
set "ALICE_PORTABLE_DIR=%ROOT%"
if not defined ALICE_PORT set "ALICE_PORT=3721"

set "ELECTRON=%ROOT%\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo [Alice] electron runtime not found: %ELECTRON%
  pause
  exit /b 1
)

if not exist "%ALICE_USER_DIR%" mkdir "%ALICE_USER_DIR%"

echo [Alice] backend only, no window
echo   status   : http://127.0.0.1:%ALICE_PORT%/status
echo   brain ui : http://127.0.0.1:%ALICE_PORT%/brain-ui
echo   note     : better-sqlite3 here is built for Electron's ABI, so the
echo              backend is started through Electron-as-Node on purpose.
echo.

rem better-sqlite3 is compiled against Electron 33 (ABI 130); plain Node cannot
rem load it, so run the backend inside Electron with ELECTRON_RUN_AS_NODE=1.
set ELECTRON_RUN_AS_NODE=1
"%ELECTRON%" "%ROOT%\src\index.js"
exit /b %ERRORLEVEL%
