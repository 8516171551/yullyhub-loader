@echo off
REM ====================================================================
REM  yully.wtf VPS one-click deploy.
REM  Double-click on the VPS (or run from any RDP cmd prompt).
REM  Auto-elevates to Administrator, then runs the hosted deploy script.
REM ====================================================================

setlocal
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
echo Downloading + running deploy script from https://yullyhub.com/deploy-website.ps1
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop'; irm https://yullyhub.com/deploy-website.ps1 | iex"

set EXITCODE=%errorlevel%
echo.
echo === deploy finished (exit %EXITCODE%) ===
echo Press any key to close.
pause >nul
exit /b %EXITCODE%
