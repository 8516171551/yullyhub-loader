# YullyHub Loader (C++, Windows)

Thin native launcher. Boots hidden, opens a local control-plane HTTP
socket, polls `/api/loader/poll` for commands, and downloads / spawns
product `.exe`s on demand.

## Build

Run the batch script from this directory:

```bat
build.bat
```

It picks a compiler in this order and produces `loader.exe` next to it:

1. `cl.exe` (MSVC) if already on PATH
2. `g++` (MinGW) if already on PATH
3. WinLibs / other MinGW installs under `C:\mingw64` or `C:\msys64`
4. Visual Studio via `vswhere` (auto `vcvars64.bat`)

Rebuild is the same command — the script deletes any stale
`loader.exe` before compiling.

## Auth (bearer)

Every outbound HTTP call carries an `Authorization: Bearer <token>`
header when a bearer is loaded. The bearer is a 64-hex token minted by
`POST /api/loader/handshake` on yullyhub.com or yully.wtf.

At startup the loader reads it from env in this order:

1. `YULLY_LOADER_TOKEN` (preferred)
2. `YULLY_TOKEN` (legacy fallback)

If neither is set, the loader still runs but the server returns 401 to
anonymous callers, so poll and download fail cleanly.

## Output

`loader.exe` lands in this directory. The dashboard deploy step (a
separate agent) copies it into `Web Dashboard/public/` — do not do
that here.
