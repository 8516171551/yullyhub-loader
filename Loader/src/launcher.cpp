#include "pch.h"
#include "launcher.h"
#include "http.h"
#include "json.h"
#include "session.h"

// Globals defined in this TU.
HANDLE       g_product_process   = NULL;
std::string  g_active_token;
std::string  g_active_product_id;

// From control.cpp
extern HANDLE g_kill_switch_job;

namespace launcher {

static std::atomic<bool> g_heartbeat_started{false};

void start_heartbeat_thread() {
    bool expected = false;
    if (!g_heartbeat_started.compare_exchange_strong(expected, true)) return;

    std::thread([]{
        int failStreak = 0;
        while (true) {
            std::this_thread::sleep_for(std::chrono::seconds(cfg::HEARTBEAT_INTERVAL_S));
            std::string body = std::string("{\"token\":\"") + g_active_token +
                               "\",\"loaderId\":\"" + g_loader_id +
                               "\",\"productId\":\"" + g_active_product_id + "\"}";
            std::string resp;
            long sc = 0;
            bool ok = http::post_json(g_api_host, g_api_port, g_api_https,
                                      "/api/auth/heartbeat", body, resp, &sc);
            if (!ok || sc != 200) {
                if (++failStreak >= cfg::HEARTBEAT_FAIL_CEIL) break;
                continue;
            }
            failStreak = 0;
            std::string valid = json::get_str(resp, "valid");
            if (valid == "false") break;
        }

        // Kill product + self.
        if (g_product_process) {
            TerminateProcess(g_product_process, 0);
            CloseHandle(g_product_process);
            g_product_process = NULL;
        }
        if (g_kill_switch_job) { CloseHandle(g_kill_switch_job); g_kill_switch_job = NULL; }
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        ExitProcess(0);
    }).detach();
}

// ---- Product launch ----

static void do_launch(const std::string& payload) {
    std::string url        = json::get_str(payload, "url");
    std::string title      = json::get_str(payload, "title");
    std::string productId  = json::get_str(payload, "productId");
    std::string token      = json::get_str(payload, "token");
    std::string apiHost    = json::get_str(payload, "apiHost");
    std::string hideStr    = json::get_str(payload, "hideWindow");
    bool hideWindow        = (hideStr == "true" || hideStr == "1");
    if (url.empty()) return;

    if (!token.empty())     g_active_token = token;
    if (!productId.empty()) g_active_product_id = productId;

    if (!token.empty())   SetEnvironmentVariableA("YULLY_TOKEN", token.c_str());
    if (!apiHost.empty()) SetEnvironmentVariableA("YULLY_HOST", apiHost.c_str());

    std::vector<uint8_t> bytes;
    if (!http::download_bytes(url, bytes) || bytes.empty() ||
        bytes.size() > cfg::MAX_PAYLOAD_BYTES) {
        MessageBoxA(NULL, "Download failed.", "Loader", MB_OK | MB_ICONERROR | MB_TOPMOST);
        return;
    }

    // Random-name .exe under %TEMP%, hidden attribute.
    char tempPath[MAX_PATH]; GetTempPathA(MAX_PATH, tempPath);
    UUID id; UuidCreate(&id);
    char* uuidStr = nullptr; UuidToStringA(&id, (RPC_CSTR*)&uuidStr);
    std::string name = "_ps";
    if (uuidStr) { name += std::string(uuidStr, 10); RpcStringFreeA((RPC_CSTR*)&uuidStr); }
    else         { name += std::to_string(GetTickCount()); }
    std::string outPath = std::string(tempPath) + name + ".exe";

    FILE* f = fopen(outPath.c_str(), "wb");
    if (!f) return;
    fwrite(bytes.data(), 1, bytes.size(), f);
    fclose(f);
    SetFileAttributesA(outPath.c_str(), FILE_ATTRIBUTE_HIDDEN);

    // Try elevated via ShellExecute → fall back to plain CreateProcess.
    SHELLEXECUTEINFOA sei{};
    sei.cbSize = sizeof(sei);
    sei.fMask  = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    sei.lpVerb = "runas";
    sei.lpFile = outPath.c_str();
    sei.nShow  = hideWindow ? SW_HIDE : SW_SHOWNORMAL;
    if (!ShellExecuteExA(&sei)) {
        DWORD err = GetLastError();
        if (err == ERROR_CANCELLED) { DeleteFileA(outPath.c_str()); return; }
        STARTUPINFOA si{}; si.cb = sizeof(si);
        if (hideWindow) { si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE; }
        DWORD flags = hideWindow ? CREATE_NO_WINDOW : 0;
        PROCESS_INFORMATION pi{};
        if (!CreateProcessA(NULL, (LPSTR)outPath.data(), NULL, NULL, FALSE,
                            flags, NULL, NULL, &si, &pi)) {
            DeleteFileA(outPath.c_str());
            return;
        }
        sei.hProcess = pi.hProcess;
        CloseHandle(pi.hThread);
    }

    if (sei.hProcess) {
        g_product_process = sei.hProcess;
        session::register_product(GetProcessId(sei.hProcess));
        start_heartbeat_thread();

        // Best-effort cleanup after payload exits.
        HANDLE proc = sei.hProcess;
        std::string path = outPath;
        std::thread([proc, path]{
            WaitForSingleObject(proc, INFINITE);
            for (int i = 0; i < 20; ++i) {
                if (DeleteFileA(path.c_str())) break;
                std::this_thread::sleep_for(std::chrono::milliseconds(250));
            }
        }).detach();
    }
}

// ---- Command dispatch ----

void handle_command(const std::string& payload) {
    std::string type = json::get_str(payload, "type");
    if (type == "ping") {
        MessageBoxA(NULL, "Pong", "Loader", MB_OK | MB_ICONINFORMATION | MB_TOPMOST);
        return;
    }
    if (type == "launch") { do_launch(payload); return; }
    if (type == "island") return; // deprecated
    if (type == "shutdown") {
        if (g_product_process) {
            TerminateProcess(g_product_process, 0);
            CloseHandle(g_product_process);
            g_product_process = NULL;
        }
        if (g_kill_switch_job) { CloseHandle(g_kill_switch_job); g_kill_switch_job = NULL; }
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        ExitProcess(0);
    }
}

// ---- Browser bootstrap ----

void open_dashboard_browser_if_needed() {
    // If any visible window already has "YullyHub" in its title, skip.
    struct F { bool hit; } f = { false };
    EnumWindows([](HWND h, LPARAM lp) -> BOOL {
        auto* fp = reinterpret_cast<F*>(lp);
        if (!IsWindowVisible(h)) return TRUE;
        char title[512] = {0};
        GetWindowTextA(h, title, 512);
        if (title[0] && strstr(title, "YullyHub")) { fp->hit = true; return FALSE; }
        return TRUE;
    }, reinterpret_cast<LPARAM>(&f));
    if (f.hit) return;

    std::string scheme = g_api_https ? "https://" : "http://";
    std::string url = scheme + g_api_host;
    if ((g_api_https && g_api_port != 443) || (!g_api_https && g_api_port != 80))
        url += ":" + std::to_string(g_api_port);

    struct BS { const char* path; const char* priv; };
    BS browsers[] = {
        {"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",         "--incognito"},
        {"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",   "--incognito"},
        {"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",  "--inprivate"},
        {"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",        "--inprivate"},
        {nullptr, nullptr}
    };
    for (int i = 0; browsers[i].path; i++) {
        if (GetFileAttributesA(browsers[i].path) == INVALID_FILE_ATTRIBUTES) continue;
        std::string cmd = std::string("\"") + browsers[i].path + "\""
                        + " " + browsers[i].priv
                        + " --new-window"
                        + " \"" + url + "\"";
        STARTUPINFOA si{}; si.cb = sizeof(si);
        PROCESS_INFORMATION pi{};
        if (CreateProcessA(NULL, cmd.data(), NULL, NULL, FALSE,
                           DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB,
                           NULL, NULL, &si, &pi)) {
            CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
            return;
        }
    }
    // Fallback: default browser via Shell.
    ShellExecuteA(NULL, "open", url.c_str(), NULL, NULL, SW_SHOWNORMAL);
}

} // namespace launcher
