@echo off
REM ====================================================================
REM  yully.wtf VPS one-click deploy.
REM  Double-click on the VPS (or run from any RDP cmd/PS prompt).
REM  Auto-elevates, downloads the deploy script to a tempfile, then
REM  invokes it with -File (avoids cmd/powershell quoting fun).
REM ====================================================================

setlocal EnableExtensions
title yully.wtf deploy

REM --- Elevate to Administrator if we're not already ---
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Re-launching as Administrator...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo.
echo === yully.wtf VPS deploy ===
echo Fetching deploy script...

set "PS_URL=https://yullyhub.com/deploy-website.ps1"
set "PS_TMP=%TEMP%\yully-deploy-%RANDOM%.ps1"

REM Download the script to a tempfile as its own step.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '%PS_URL%' -OutFile '%PS_TMP%'"

if not exist "%PS_TMP%" (
    echo [ERROR] Failed to download %PS_URL%
    goto :end
)

echo Running deploy script from %PS_TMP%
echo.

REM Run it with -File so we avoid the fragile cmd-quoting of -Command.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_TMP%"

set "EXITCODE=%errorlevel%"
del "%PS_TMP%" 2>nul

:end
echo.
echo === deploy finished (exit %EXITCODE%) ===
echo Press any key to close.
pause >nul
exit /b %EXITCODE%
