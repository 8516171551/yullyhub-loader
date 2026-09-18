# YullyHub Product Integration

Any `.exe` you upload to a YullyHub product slot gets launched by the
customer's loader with two environment variables set:

| Var           | Description                                         |
|---------------|-----------------------------------------------------|
| `YULLY_TOKEN` | One-shot exchange token minted for this launch      |
| `YULLY_HOST`  | Backend host, e.g. `https://yullyhub.com`           |

Everything your product needs to do fits into three calls:

## 1. Handshake at startup (`POST /api/auth/handshake`)

Prove you were legitimately launched. Response tells you who the user
is and whether their subscription is currently active.

```json
POST /api/auth/handshake
{ "token": "<YULLY_TOKEN>" }

200 OK
{
  "valid": true,
  "user": { "id": "u_abc123", "plan": "lifetime" },
  "subscription": { "active": true, "plan": "lifetime", "expires_at": null },
  "product_id": "prod_xyz",
  "issued_at": 1_700_000_000,
  "expires_at": 1_700_000_300
}
```

If `valid` is `false`, close immediately — the token was revoked,
belongs to a different product, or expired.

## 2. Heartbeat while running (`POST /api/auth/heartbeat`)

Every 30 seconds, hit heartbeat with the same token. The moment the
server replies `{ "valid": false }` (subscription expired, cancelled,
etc.), tear the product down. The loader also heartbeats independently,
but a product that checks its own sub can fail closed even if the
loader is tampered with.

```json
POST /api/auth/heartbeat
{ "token": "<YULLY_TOKEN>", "loaderId": "<...>", "productId": "<...>" }

200 OK
{ "valid": true, "ttl_seconds": 30 }
```

## 3. Graceful shutdown

The loader kills you via `TerminateProcess` when the sub expires or the
user hits close, so you rarely see a clean signal. Still, register a
`SetConsoleCtrlHandler` for `CTRL_CLOSE_EVENT` to flush any state you
care about — it fires when the user closes the console yourself.

---

## What's in this folder

```
Integration Example/
├── README.md               ← you are here
├── build.bat               ← builds both examples (MSVC or g++/MinGW)
├── include/
│   └── yullyhub.h          ← single-header client (drop into any project)
└── src/
    ├── minimal_example.cpp ← handshake, print result, exit
    └── advanced_example.cpp← handshake + heartbeat + graceful shutdown
```

`yullyhub.h` is header-only, zero deps beyond `winhttp.lib`. Copy it into
your own project and you can talk to the YullyHub backend in ~10 lines.

## Building

```bat
cd "Integration Example"
build.bat
```

Produces `minimal.exe` and `advanced.exe`. Test locally by setting the
env vars yourself:

```powershell
$env:YULLY_TOKEN = "<paste-a-real-token-from-/api/auth/exchange>"
$env:YULLY_HOST  = "https://yullyhub.com"
.\minimal.exe
```

## Uploading to production

Once you're happy, upload your compiled `.exe` in the **Admin** modal
of the dashboard. The next customer who clicks *Launch* on your product
will have their loader download, verify, and spawn it — with
`YULLY_TOKEN` + `YULLY_HOST` already set in its environment.
