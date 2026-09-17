# Web Loader V1

Real-time C++ loader controlled by a Next.js dashboard over WebSocket.

## Stack
- **Web Dashboard/** — Next.js 14 (App Router, React 18) + custom Node server (`server.js`) with `ws` WebSocket hub
- **Loader/** — Windows C++ (Winsock + BCrypt) raw WebSocket client

## Wire protocol
- Loader connects `ws://localhost:3000/ws` (RFC 6455 handshake)
- Browser connects `ws://localhost:3000/ws-ui` for live loader state pushes
- Dashboard POST `/api/command {type:"ping"}` → server broadcasts JSON to every loader → loader parses `type` → `MessageBoxA("Pong")`

## Run
Double-click **`rebuild and run.bat`** in the project root. It will:
1. Kill old loader/node instances
2. Free port 3000
3. Refresh PATH from registry
4. Install MinGW-w64 via winget if no C++ compiler is found
5. Install Node.js via winget if missing
6. Rebuild `loader.exe`
7. `npm install` (first run only)
8. Launch `node server.js` in one window, `loader.exe` in another
9. Open http://localhost:3000

## Live features
- Nav pill shows `N loaders online` with pulsing green dot as soon as the C++ client connects
- Settings tab lists each connected agent (id, address, uptime seconds)
- Event log streams `loader_connected`, `loader_disconnected`, `command_sent` events in real time
- Test Ping button disables when no loader is online
- Clicking **START** on Home fires a ping too, so the injection screen doubles as a live test
