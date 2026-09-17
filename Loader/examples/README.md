# YullyHub — product integration example

The auth flow between the dashboard, the loader and a cheat / product.

```
+----------------+       POST /api/auth/exchange       +----------------+
|   Dashboard    | ----------------------------------> |   Web API      |
|  (customer)    |    {productId, userId, plan}        |  (token mint)  |
|                | <---------------------------------- |                |
|                |    { token, expires_at, user }      |                |
+----------------+                                     +----------------+
        |                                                     ^
        | passes token to the loader via the                  |
        | WS launch message (or env var)                      |
        v                                                     |
+----------------+                                             |
|   loader.exe   |                                             |
|                |                                             |
|  Sets          |    ShellExecuteEx starts the product        |
|  YULLY_TOKEN   |    with env var set                         |
|  env var       |                                             |
+----------------+                                             |
        |                                                     |
        | product launches                                    |
        v                                                     |
+----------------+       GET  /api/auth/handshake?token=X      |
|    product     | -------------------------------------------->
|  (your cheat)  |    { valid, user, subscription }
|                | <-------------------------------------------
|  runs only if  |
|  valid==true   |
+----------------+
```

## Files

- **auth_handshake.cpp** — reference client. `yh_handshake()` is the one call you copy into your product's startup. Uses WinHTTP so there's no library to link — just `winhttp.lib`.
- **build.bat** — compiles the example with MSVC or MinGW (whichever's on PATH from the top-level `rebuild and run.bat`).

## API endpoints

Both live on the same Next.js dev / Vercel host as the dashboard.

### POST `/api/auth/exchange`

Mints a short-lived exchange token for a launch.

```json
// request
{ "productId": "2e28319ce4de", "userId": "customer-42", "plan": "lifetime" }
// response
{
  "token":       "9f3b7c1a…",
  "expires_at":  1789651000,
  "issued_at":   1789650700,
  "ttl_seconds": 300,
  "user":        { "id": "customer-42", "plan": "lifetime" },
  "product_id":  "2e28319ce4de"
}
```

### GET `/api/auth/handshake?token=…` (or POST with `{token}`)

The product calls this. Response:

```json
{
  "valid":         true,
  "user":          { "id": "customer-42", "plan": "lifetime" },
  "subscription":  { "plan": "lifetime", "active": true, "expires_at": null },
  "product_id":    "2e28319ce4de",
  "issued_at":     1789650700,
  "expires_at":    1789651000
}
```

Errors return `{ "valid": false, "error": "missing" | "unknown" | "expired" }` with status 400 / 401.

## Quick local test

Start the dashboard (`npm run dev` inside `Web Dashboard/`), then:

```bash
# 1) Mint a token
curl -s -X POST http://localhost:3000/api/auth/exchange \
     -H "Content-Type: application/json" \
     -d '{"userId":"me","productId":"p1","plan":"lifetime"}'
# → { "token": "<T>", ... }

# 2) Build the example
build.bat

# 3) Hand the token to the product
auth_handshake.exe <T> http://127.0.0.1:3000
# → [yh] session OK — user=me plan=lifetime
```

## Going to production

The example already auto-detects `https://` in the base URL and switches WinHTTP to TLS. Once your Vercel domain is live just pass it as `baseUrl`:

```cpp
yh_handshake(token, "https://yullyhub.example.com", user, plan);
```

No code change beyond that.

## Notes

- The current token store is an in-memory `Map` (see `Web Dashboard/lib/token-store.js`). For a real deployment swap it for Vercel KV, Redis, or a DB — the exports (`issueToken`, `redeemToken`, `sweep`) keep the same contract.
- `yh_handshake` uses a naive JSON pluck. Real products should link a proper JSON parser (nlohmann/json is header-only and drop-in).
- The dashboard currently doesn't require authentication to mint tokens — that's fine for the local demo, but wire this endpoint behind a real login before shipping.
