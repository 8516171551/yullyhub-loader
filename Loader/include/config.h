// config.h — build-time knobs and runtime globals shared across modules.
#pragma once
#include <string>

namespace cfg {
    // ---- Server address (overridable at runtime via YULLY_HOST env var) ----
    constexpr const char* DEFAULT_API_HOST = "yullyhub.com";
    constexpr bool        DEFAULT_API_HTTPS = true;
    constexpr int         DEFAULT_API_PORT  = 443;

    // ---- Timers ----
    constexpr int  POLL_INTERVAL_MS      = 500;   // /api/loader/poll cadence
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
