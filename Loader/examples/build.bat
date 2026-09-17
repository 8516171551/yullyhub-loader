@echo off
setlocal EnableDelayedExpansion
REM Builds auth_handshake.exe — the reference product integration.
REM Uses whatever toolchain rebuild-and-run.bat already set up (MSVC or MinGW).

if exist auth_handshake.exe del /f /q auth_handshake.exe

where cl >nul 2>nul && goto :msvc
where g++ >nul 2>nul && goto :gcc

echo No C++ compiler on PATH. Run the top-level "rebuild and run.bat" first
echo to set up MinGW / MSVC, then re-run this script.
exit /b 1

:msvc
echo Building with MSVC...
cl /nologo /EHsc /std:c++17 auth_handshake.cpp /link winhttp.lib
goto :done

:gcc
echo Building with g++...
g++ -std=c++17 -O2 auth_handshake.cpp -o auth_handshake.exe -lwinhttp

:done
if exist auth_handshake.exe (
    echo Built auth_handshake.exe
    exit /b 0
)
echo Build failed.
exit /b 1
