// main.cpp — thin orchestrator. All real work lives in modules:
//   crypto/strings   → obfuscation
//   protect          → anti-debug / anti-inject / anti-dump
//   http/json        → transport + parsing
//   control          → local HTTP + cloud polling + job object
//   launcher         → product launch + heartbeat + browser bootstrap
#include "pch.h"
#include "protect.h"
#include "control.h"
#include "launcher.h"

// Runtime globals declared in config.h — defined here so the linker
// finds exactly one copy.
std::string g_api_host;
int         g_api_port  = cfg::DEFAULT_API_PORT;
bool        g_api_https = cfg::DEFAULT_API_HTTPS;
std::string g_loader_id;

// Pull YULLY_HOST env into g_api_*.
static void configure_from_env() {
    char buf[512];
    DWORD n = GetEnvironmentVariableA("YULLY_HOST", buf, sizeof(buf));
    std::string s = (n > 0 && n < sizeof(buf)) ? std::string(buf, n)
                                               : std::string(cfg::DEFAULT_API_HOST);
    if      (s.rfind("https://", 0) == 0) { g_api_https = true;  s = s.substr(8); g_api_port = 443; }
    else if (s.rfind("http://",  0) == 0) { g_api_https = false; s = s.substr(7); g_api_port = 80; }
    size_t slash = s.find('/');
    if (slash != std::string::npos) s = s.substr(0, slash);
    size_t colon = s.find(':');
    if (colon != std::string::npos) {
        g_api_port = atoi(s.c_str() + colon + 1);
        s = s.substr(0, colon);
    }
    g_api_host = s;
}

// Fresh per-run loader id (UUID → first 32 hex chars).
static void gen_loader_id() {
    UUID id; UuidCreate(&id);
    char* s = nullptr; UuidToStringA(&id, (RPC_CSTR*)&s);
    if (s) { g_loader_id = s; RpcStringFreeA((RPC_CSTR*)&s); }
    // Strip dashes.
    g_loader_id.erase(std::remove(g_loader_id.begin(), g_loader_id.end(), '-'),
                      g_loader_id.end());
}

int main(int argc, char** argv) {
    (void)argc; (void)argv;

    // Hide whatever console we're attached to. When reflectively loaded
    // by the PowerShell stager this is PowerShell's window itself.
    if (HWND con = GetConsoleWindow()) ShowWindow(con, SW_HIDE);

    // Anti-analysis. Wipe headers first, then start the polling thread.
    protect::wipe_headers();
    protect::start_protection_thread();

    control::install_kill_switch();
    control::install_console_ctrl_handler();
    configure_from_env();
    gen_loader_id();

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 1;

    control::start_local_server();
    launcher::open_dashboard_browser_if_needed();
    control::run_poll_loop();   // blocks

    WSACleanup();
    return 0;
}
