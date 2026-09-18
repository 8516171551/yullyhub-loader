@echo off
setlocal EnableDelayedExpansion

set "COMPILER="
where cl  >nul 2>nul && set "COMPILER=msvc" && goto :compile
where g++ >nul 2>nul && set "COMPILER=gcc"  && goto :compile

set "WINLIBS=%LOCALAPPDATA%\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT.LLVM_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin"
if exist "%WINLIBS%\g++.exe" set "PATH=%WINLIBS%;%PATH%" & set "COMPILER=gcc" & goto :compile
if exist "C:\mingw64\bin\g++.exe"       set "PATH=C:\mingw64\bin;%PATH%"       & set "COMPILER=gcc" & goto :compile
if exist "C:\msys64\mingw64\bin\g++.exe" set "PATH=C:\msys64\mingw64\bin;%PATH%" & set "COMPILER=gcc" & goto :compile

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" set "VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" goto :nocompiler
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
if defined VSINSTALL if exist "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" (
    call "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" >nul
    where cl >nul 2>nul && set "COMPILER=msvc" && goto :compile
)

:nocompiler
echo ERROR: no compiler found.
exit /b 1

:compile
if "!COMPILER!"=="msvc" (
    echo Building minimal.exe + advanced.exe with MSVC...
    cl /nologo /EHsc /std:c++17 /O2 /MT /I include src\minimal_example.cpp  /link winhttp.lib /OUT:minimal.exe  || exit /b 1
    cl /nologo /EHsc /std:c++17 /O2 /MT /I include src\advanced_example.cpp /link winhttp.lib /OUT:advanced.exe || exit /b 1
) else (
    echo Building minimal.exe + advanced.exe with g++...
    g++ -std=c++17 -O2 -static -static-libgcc -static-libstdc++ -I include src\minimal_example.cpp  -o minimal.exe  -lwinhttp -Wl,-Bstatic -lstdc++ -lpthread -lwinpthread || exit /b 1
    g++ -std=c++17 -O2 -static -static-libgcc -static-libstdc++ -I include src\advanced_example.cpp -o advanced.exe -lwinhttp -Wl,-Bstatic -lstdc++ -lpthread -lwinpthread || exit /b 1
)
echo Built minimal.exe + advanced.exe
exit /b 0
