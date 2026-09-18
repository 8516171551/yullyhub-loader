// config.h — build-time knobs and runtime globals shared across modules.
#pragma once
#include <string>

namespace cfg {
    // ---- Server address (overridable at runtime via YULLY_HOST env var) ----
    constexpr const char* DEFAULT_API_HOST = "yullyhub.com";
    constexpr bool        DEFAULT_API_HTTPS = true;
    constexpr int         DEFAULT_API_PORT  = 443;

    // ---- Timers ----
    // Poll cadence: Upstash Redis free tier is ~10k commands/day and
    // each poll does 1-3 commands, so 500ms would burn the quota in
    // under an hour. 3s gives a comfortable margin while still feeling
    // responsive when a command arrives.
    constexpr int  POLL_INTERVAL_MS      = 3000;
    constexpr int  HEARTBEAT_INTERVAL_S  = 30;    // /api/auth/heartbeat cadence
    constexpr int  HEARTBEAT_FAIL_CEIL   = 6;     // consecutive net-fail → fail-secure
    constexpr int  PROTECT_INTERVAL_S    = 4;     // anti-debug polling cadence

    // ---- Payload guard ----
    constexpr size_t MAX_PAYLOAD_BYTES   = 256 * 1024 * 1024; // 256MB launch cap
}

// Global runtime state — assigned in main() from env, read everywhere.
extern std::string g_api_host;
extern int         g_api_port;
extern bool        g_api_https;
extern std::string g_loader_id;

// Job / process handles — set by launcher and console modules.
extern HANDLE      g_kill_switch_job;
extern HANDLE      g_product_process;
extern std::string g_active_token;
extern std::string g_active_product_id;

// Bearer token minted by /api/loader/handshake. Attached as
// Authorization: Bearer <token> on EVERY outbound http:: call when
// non-empty. Read from env YULLY_LOADER_TOKEN (or legacy YULLY_TOKEN).
extern std::string g_bearer_token;
