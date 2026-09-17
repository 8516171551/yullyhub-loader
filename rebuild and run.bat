@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo === killing old loader, island and node instances ===
taskkill /F /IM loader.exe >nul 2>nul
taskkill /F /IM node.exe >nul 2>nul
taskkill /F /IM electron.exe >nul 2>nul

echo === freeing port 3000 ===
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%p >nul 2>nul
)

echo === refreshing PATH from registry ===
for /f "usebackq tokens=2,*" %%A in (`reg query "HKCU\Environment" /v Path 2^>nul`) do set "USRPATH=%%B"
for /f "usebackq tokens=2,*" %%A in (`reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul`) do set "SYSPATH=%%B"
if defined SYSPATH set "PATH=!SYSPATH!"
if defined USRPATH set "PATH=!PATH!;!USRPATH!"

echo === checking C++ compiler ===
where cl >nul 2>nul
if !ERRORLEVEL! EQU 0 goto :has_compiler
where g++ >nul 2>nul
if !ERRORLEVEL! EQU 0 goto :has_compiler

set "WINLIBS=%LOCALAPPDATA%\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT.LLVM_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin"
if exist "%WINLIBS%\g++.exe" (
    echo Adding WinLibs MinGW to PATH...
    set "PATH=%WINLIBS%;%PATH%"
    goto :has_compiler
)

echo === no compiler found, installing MinGW via winget ===
where winget >nul 2>nul
if not !ERRORLEVEL! EQU 0 (
    echo winget not available. Install manually from https://winlibs.com/
    pause
    exit /b 1
)
winget install --id=BrechtSanders.WinLibs.POSIX.UCRT.LLVM -e --accept-package-agreements --accept-source-agreements --silent
if exist "%WINLIBS%\g++.exe" (
    set "PATH=%WINLIBS%;%PATH%"
) else (
    echo MinGW install failed.
    pause
    exit /b 1
)

:has_compiler

echo === rebuilding loader ===
pushd Loader
call build.bat
set BUILD_ERR=!ERRORLEVEL!
popd
if not !BUILD_ERR! EQU 0 (
    echo.
    echo Loader build failed. See errors above.
    echo.
    pause
    exit /b 1
)
if not exist "Loader\loader.exe" (
    echo.
    echo loader.exe missing after build.
    echo.
    pause
    exit /b 1
)

REM Copy the fresh loader.exe into the dashboard's public/ so Vercel
REM (and the local Next dev server) can serve it as /loader.exe. The
REM PowerShell stager fetches from there.
echo === syncing loader.exe -^> Web Dashboard\public\loader.exe ===
if not exist "Web Dashboard\public" mkdir "Web Dashboard\public"
copy /Y "Loader\loader.exe" "Web Dashboard\public\loader.exe" >nul

echo === checking node ===
where node >nul 2>nul
if !ERRORLEVEL! EQU 0 goto :has_node

REM Common install locations
for %%d in ("%ProgramFiles%\nodejs" "%ProgramFiles(x86)%\nodejs" "%LOCALAPPDATA%\Programs\nodejs") do (
    if exist %%d\node.exe (
        echo Using Node at %%d
        set "PATH=%%~d;!PATH!"
        goto :has_node
    )
)

echo === node not found, installing via winget ===
where winget >nul 2>nul
if not !ERRORLEVEL! EQU 0 (
    echo winget not available. Install Node.js manually from https://nodejs.org
    pause
    exit /b 1
)
winget install --id=OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements --silent
if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%ProgramFiles%\nodejs;!PATH!"
    goto :has_node
)
echo Node install failed.
pause
exit /b 1

:has_node

echo === installing dashboard deps (idempotent) ===
pushd "Web Dashboard"
call npm install --no-audit --no-fund
if not !ERRORLEVEL! EQU 0 (
    echo npm install failed.
    popd
    pause
    exit /b 1
)
popd

echo === launching dashboard on http://localhost:3000 ===
start "Web Dashboard" cmd /k "cd /d "%~dp0Web Dashboard" && npm start"

echo === waiting for server to bind ===
REM ping instead of timeout — timeout.exe lives in System32 which
REM the PATH refresh above may have dropped.
ping -n 3 127.0.0.1 >nul

echo === installing DynamicIsland deps if missing ===
pushd DynamicIsland
if not exist node_modules (
    call npm install --no-audit --no-fund
    if not !ERRORLEVEL! EQU 0 (
        echo island npm install failed.
        popd
        pause
        exit /b 1
    )
)
popd

echo === launching loader (spawns island overlay itself) ===
start "Loader" cmd /k "cd /d "%~dp0Loader" && loader.exe"

echo === opening dashboard in default browser ===
start "" "http://localhost:3000"

echo.
echo Done. Loader.exe now owns the Dynamic Island overlay — it spawns it
echo automatically on startup. Kill loader.exe (or this session) to close it.
echo Stager one-liner:  irm http://localhost:3000/loader ^| iex
echo.
pause
endlocal
