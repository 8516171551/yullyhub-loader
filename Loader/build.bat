@echo off
setlocal EnableDelayedExpansion

set "COMPILER="

REM Prefer Visual Studio's cl.exe when it's already on PATH.
where cl >nul 2>nul && set "COMPILER=msvc" && goto :compile
where g++ >nul 2>nul && set "COMPILER=gcc" && goto :compile

REM WinGet WinLibs MinGW
set "WINLIBS=%LOCALAPPDATA%\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT.LLVM_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin"
if exist "%WINLIBS%\g++.exe" set "PATH=%WINLIBS%;%PATH%" & set "COMPILER=gcc" & goto :compile

REM Other MinGW locations
if exist "C:\mingw64\bin\g++.exe"       set "PATH=C:\mingw64\bin;%PATH%"       & set "COMPILER=gcc" & goto :compile
if exist "C:\msys64\mingw64\bin\g++.exe" set "PATH=C:\msys64\mingw64\bin;%PATH%" & set "COMPILER=gcc" & goto :compile

REM Fall back to VS via vswhere.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" set "VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" goto :nocompiler
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
if not defined VSINSTALL goto :nocompiler
if not exist "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" goto :nocompiler
call "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" >nul
where cl >nul 2>nul && set "COMPILER=msvc" && goto :compile

:nocompiler
echo ERROR: No C++ compiler found.
exit /b 1

:compile
if exist loader.exe del /f /q loader.exe
if "!COMPILER!"=="msvc" goto :build_msvc
if "!COMPILER!"=="gcc"  goto :build_gcc
goto :nocompiler

:build_msvc
echo Building with MSVC...
cl /nologo /EHsc /std:c++17 /O2 /MT /I include ^
   src\*.cpp ^
   /link ws2_32.lib bcrypt.lib shell32.lib rpcrt4.lib ole32.lib winhttp.lib gdi32.lib user32.lib psapi.lib advapi32.lib ^
   /OUT:loader.exe
if not !ERRORLEVEL! EQU 0 goto :buildfail
goto :done

:build_gcc
echo Building with g++...
REM -static* rolls libgcc / libstdc++ / winpthread INTO the exe so no
REM MinGW runtime DLLs are required on the customer's machine.
g++ -std=c++17 -O2 ^
    -static -static-libgcc -static-libstdc++ ^
    -I include ^
    src\main.cpp src\crypto.cpp src\protect.cpp ^
    src\http.cpp src\json.cpp src\control.cpp src\launcher.cpp src\session.cpp ^
    -o loader.exe ^
    -lws2_32 -lbcrypt -lshell32 -lrpcrt4 -lole32 -lwinhttp -lgdi32 -luser32 -lpsapi ^
    -Wl,-Bstatic -lstdc++ -lpthread -lwinpthread
if not !ERRORLEVEL! EQU 0 goto :buildfail
goto :done

:buildfail
echo BUILD FAILED
exit /b 1

:done
if exist loader.exe (
    echo Built loader.exe
    exit /b 0
)
echo Build failed ^(no loader.exe produced^).
exit /b 1
