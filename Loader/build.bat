@echo off
setlocal EnableDelayedExpansion

set "COMPILER="

REM 1) cl on PATH?
where cl >nul 2>nul && set "COMPILER=msvc" && goto :compile

REM 2) g++ on PATH?
where g++ >nul 2>nul && set "COMPILER=gcc" && goto :compile

REM 3) winget-installed WinLibs MinGW?
set "WINLIBS=%LOCALAPPDATA%\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT.LLVM_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin"
if exist "%WINLIBS%\g++.exe" set "PATH=%WINLIBS%;%PATH%" & set "COMPILER=gcc" & echo Using WinLibs MinGW at %WINLIBS% & goto :compile

REM 4) Other MinGW locations
if exist "C:\mingw64\bin\g++.exe" set "PATH=C:\mingw64\bin;%PATH%" & set "COMPILER=gcc" & goto :compile
if exist "C:\msys64\mingw64\bin\g++.exe" set "PATH=C:\msys64\mingw64\bin;%PATH%" & set "COMPILER=gcc" & goto :compile

REM 5) Visual Studio via vswhere
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" set "VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" goto :nocompiler

for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
if not defined VSINSTALL goto :nocompiler
if not exist "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" goto :nocompiler

echo Loading MSVC environment...
call "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" >nul
where cl >nul 2>nul && set "COMPILER=msvc" && goto :compile

:nocompiler
echo.
echo ERROR: No C++ compiler found.
echo.
exit /b 1

:compile
REM Nuke the old exe FIRST so a silent link failure can't masquerade as a
REM successful build. `if exist loader.exe` only means anything after this.
if exist loader.exe del /f /q loader.exe

if "!COMPILER!"=="msvc" goto :build_msvc
if "!COMPILER!"=="gcc"  goto :build_gcc
goto :nocompiler

:build_msvc
echo Building with MSVC...
cl /nologo /EHsc /std:c++17 /O2 loader.cpp /link ws2_32.lib bcrypt.lib shell32.lib rpcrt4.lib ole32.lib winhttp.lib /OUT:loader.exe
if not !ERRORLEVEL! EQU 0 goto :buildfail
goto :done

:build_gcc
echo Building with g++...
REM -static* rolls libgcc / libstdc++ / winpthread INTO the exe. Without
REM these the reflective PS host's mapper LoadLibraryA()'s libgcc_s_seh-1.dll
REM and libstdc++-6.dll on the customer's machine, which won't be there.
g++ -std=c++17 -O2 -static -static-libgcc -static-libstdc++ loader.cpp -o loader.exe -lws2_32 -lbcrypt -lshell32 -lrpcrt4 -lole32 -lwinhttp -lgdi32 -luser32 -Wl,-Bstatic -lstdc++ -lpthread -lwinpthread
if not !ERRORLEVEL! EQU 0 goto :buildfail
goto :done

:buildfail
echo.
echo ============================================
echo   BUILD FAILED — see errors above.
echo ============================================
echo.
exit /b 1

:done
if exist loader.exe (
    echo Built loader.exe
    exit /b 0
)
echo Build failed (no loader.exe produced).
exit /b 1
