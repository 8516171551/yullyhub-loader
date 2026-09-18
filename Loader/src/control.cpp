#include "pch.h"
#include "control.h"
#include "http.h"
#include "json.h"
#include "launcher.h"

// Global handles owned by this TU.
HANDLE g_kill_switch_job = NULL;

namespace control {

int local_port = 0;

// ---- Job Object ----

void install_kill_switch() {
    g_kill_switch_job = CreateJobObjectA(NULL, NULL);
    if (!g_kill_switch_job) return;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
    jeli.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
    SetInformationJobObject(g_kill_switch_job,
        JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
    AssignProcessToJobObject(g_kill_switch_job, GetCurrentProcess());
}

static BOOL WINAPI on_console_ctrl(DWORD) {
    if (g_kill_switch_job) { CloseHandle(g_kill_switch_job); g_kill_switch_job = NULL; }
    return FALSE;
}

void install_console_ctrl_handler() {
    SetConsoleCtrlHandler(on_console_ctrl, TRUE);
}

// ---- Local HTTP server ----

static const char* kCORS =
    "Access-Control-Allow-Origin: https://yullyhub.com\r\n"
    "Access-Control-Allow-Credentials: true\r\n"
    "Access-Control-Allow-Methods: GET,POST,OPTIONS\r\n"
    "Access-Control-Allow-Headers: content-type\r\n"
    "Access-Control-Allow-Private-Network: true\r\n"
    "Access-Control-Max-Age: 86400\r\n"
    "Vary: Origin\r\n";

static void send_http(SOCKET s, int code, const char* status,
                      const std::string& body, const char* ctype = "text/plain") {
    std::string r = "HTTP/1.1 " + std::to_string(code) + " " + status + "\r\n";
    r += kCORS;
    r += "Content-Type: "; r += ctype; r += "\r\n";
    r += "Content-Length: " + std::to_string(body.size()) + "\r\n";
    r += "Connection: close\r\n\r\n";
    r += body;
    send(s, r.data(), (int)r.size(), 0);
}

static void handle_client(SOCKET c) {
    char buf[65536]; int total = 0;
    std::string req; req.reserve(4096);
    while (total < (int)sizeof(buf)) {
        int n = recv(c, buf + total, (int)sizeof(buf) - total, 0);
        if (n <= 0) break;
        total += n;
        req.assign(buf, total);
        size_t hdrEnd = req.find("\r\n\r\n");
        if (hdrEnd == std::string::npos) continue;
        // Check content-length; keep reading if we owe more body bytes.
        std::string lower; lower.reserve(hdrEnd);
        for (size_t i = 0; i < hdrEnd; ++i) lower.push_back((char)tolower((unsigned char)req[i]));
        size_t clPos = lower.find("content-length:");
        if (clPos != std::string::npos) {
            int cl = atoi(lower.c_str() + clPos + strlen("content-length:"));
            int haveBody = total - (int)(hdrEnd + 4);
            if (haveBody < cl && total < (int)sizeof(buf)) continue;
        }
        break;
    }

    size_t sp1 = req.find(' ');
    size_t sp2 = (sp1 == std::string::npos) ? std::string::npos : req.find(' ', sp1 + 1);
    std::string method = (sp1 == std::string::npos) ? "" : req.substr(0, sp1);
    std::string path   = (sp2 == std::string::npos) ? "" : req.substr(sp1 + 1, sp2 - sp1 - 1);

    if (method == "OPTIONS")             { send_http(c, 204, "No Content", ""); closesocket(c); return; }
    if (method == "GET" && path == "/ping") { send_http(c, 200, "OK", "pong");     closesocket(c); return; }

    if (method == "POST" && (path == "/command" || path == "/shutdown")) {
        size_t hdrEnd = req.find("\r\n\r\n");
        std::string body = (hdrEnd == std::string::npos) ? "" : req.substr(hdrEnd + 4);
        if (path == "/shutdown") {
            send_http(c, 200, "OK", "{\"ok\":true}", "application/json");
            closesocket(c);
            std::thread([]{ launcher::handle_command("{\"type\":\"shutdown\"}"); }).detach();
            return;
        }
        std::thread([body]{ launcher::handle_command(body); }).detach();
        send_http(c, 200, "OK", "{\"ok\":true}", "application/json");
        closesocket(c);
        return;
    }
    send_http(c, 404, "Not Found", "not found");
    closesocket(c);
}

void start_local_server() {
    SOCKET srv = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (srv == INVALID_SOCKET) return;
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(0x7F000001);
    addr.sin_port = 0;
    if (bind(srv, (sockaddr*)&addr, sizeof(addr)) != 0) { closesocket(srv); return; }
    int alen = sizeof(addr);
    getsockname(srv, (sockaddr*)&addr, &alen);
    local_port = ntohs(addr.sin_port);
    if (listen(srv, 8) != 0) { closesocket(srv); return; }
    std::thread([srv]{
        while (true) {
            sockaddr_in ca; int cl = sizeof(ca);
            SOCKET c = accept(srv, (sockaddr*)&ca, &cl);
            if (c == INVALID_SOCKET) { std::this_thread::sleep_for(std::chrono::milliseconds(50)); continue; }
            std::thread([c]{ handle_client(c); }).detach();
        }
    }).detach();
}

// ---- Remote polling ----

void run_poll_loop() {
    std::string path = "/api/loader/poll?id=" + g_loader_id;
    while (true) {
        std::string body;
        long sc = 0;
        bool ok = http::get_string(g_api_host, g_api_port, g_api_https, path, body, &sc);
        if (!ok || sc != 200) {
            std::this_thread::sleep_for(std::chrono::seconds(5));
            continue;
        }
        for (auto& cmd : json::get_object_array(body, "commands")) {
            std::string payload = cmd;
            std::thread([payload]{ launcher::handle_command(payload); }).detach();
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(cfg::POLL_INTERVAL_MS));
    }
}

} // namespace control
