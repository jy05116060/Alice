@echo off
chcp 65001 >nul
setlocal enableextensions
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

rem ===== portable layout: every runtime file stays inside this one folder =====
set "ALICE_USER_DIR=%ROOT%\data"
set "ALICE_RESOURCES_DIR=%ROOT%"
set "ALICE_PORTABLE_DIR=%ROOT%"
if not defined ALICE_PORT set "ALICE_PORT=3721"

set "ELECTRON=%ROOT%\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo [Alice] electron runtime not found:
  echo    %ELECTRON%
  echo [Alice] run "npm ci" plus approve-scripts/rebuild first ^(see the install report^).
  pause
  exit /b 1
)

if not exist "%ALICE_USER_DIR%" mkdir "%ALICE_USER_DIR%"

echo [Alice] install root : %ROOT%
echo [Alice] data dir     : %ALICE_USER_DIR%
echo [Alice] Brain UI     : http://127.0.0.1:%ALICE_PORT%/brain-ui
echo.

"%ELECTRON%" "%ROOT%" --user-data-dir="%ALICE_USER_DIR%"
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [Alice] exited with code %CODE%
  pause
)
exit /b %CODE%
