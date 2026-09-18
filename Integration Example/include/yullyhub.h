// yullyhub.h — drop-in single-header client for the YullyHub loader.
//
// Any product .exe that gets launched by the YullyHub loader has to:
//   1. Read the exchange token (env var  YULLY_TOKEN)
//   2. Read the API host      (env var  YULLY_HOST)  — defaults to yullyhub.com
//   3. Call handshake()  → confirms the token is still valid and returns
//      { user_id, plan, subscription {active, expires_at}, product_id }
//   4. Optionally spawn a heartbeat() thread of its own to bail out the
//      moment the subscription is revoked (the loader also heartbeats,
//      but a product that checks its OWN sub can fail closed independently)
//   5. Handle graceful shutdown when the loader terminates it (SIGTERM
//      equivalent on Windows is CTRL_CLOSE_EVENT / process termination).
//
// Zero dependencies beyond WinHTTP.
//
// Example:
//   #include "yullyhub.h"
//   int main() {
//       yh::Client cli;
//       auto res = cli.handshake();
//       if (!res.valid) { MessageBoxA(NULL, res.error.c_str(), "auth", MB_OK); return 1; }
//       MessageBoxA(NULL, ("Welcome " + res.user_id + " (" + res.plan + ")").c_str(),
//                   "YullyHub", MB_OK);
//       cli.start_heartbeat([]{ ExitProcess(0); });   // fires on invalid sub
//       // ... run your cheat ...
//   }

#pragma once
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winhttp.h>
#include <string>
#include <thread>
#include <chrono>
#include <cstdlib>
#include <functional>
#include <atomic>

#pragma comment(lib, "winhttp.lib")

namespace yh {

// ---- Configuration pulled from env at construction time ----
struct Config {
    std::string token;     // YULLY_TOKEN
    std::string host;      // parsed host from YULLY_HOST
    int         port  = 443;
    bool        https = true;

    static std::string env(const char* name) {
        char buf[1024];
        DWORD n = GetEnvironmentVariableA(name, buf, sizeof(buf));
        return (n > 0 && n < sizeof(buf)) ? std::string(buf, n) : std::string();
    }
    static Config from_env() {
        Config c;
        c.token = env("YULLY_TOKEN");
        std::string h = env("YULLY_HOST");
        if (h.empty()) h = "yullyhub.com";
        if      (h.rfind("https://", 0) == 0) { c.https = true;  h = h.substr(8); c.port = 443; }
        else if (h.rfind("http://",  0) == 0) { c.https = false; h = h.substr(7); c.port = 80; }
        size_t slash = h.find('/');
        if (slash != std::string::npos) h = h.substr(0, slash);
        size_t colon = h.find(':');
        if (colon != std::string::npos) { c.port = atoi(h.c_str() + colon + 1); h = h.substr(0, colon); }
        c.host = h;
        return c;
    }
};

// ---- Handshake response fields ----
struct HandshakeResult {
    bool        valid       = false;
    std::string user_id;
    std::string plan;                 // "lifetime", "monthly", etc.
    std::string product_id;
    long long   expires_at  = 0;      // unix seconds (0 = lifetime)
    std::string error;                // populated when valid == false
};

// ---- Client ----
class Client {
public:
    Client() : cfg(Config::from_env()) {}
    explicit Client(Config c) : cfg(std::move(c)) {}

    const Config& config() const { return cfg; }

    // One-shot POST /api/auth/handshake with { token }.
    HandshakeResult handshake() const {
        HandshakeResult r;
        if (cfg.token.empty()) { r.error = "no YULLY_TOKEN"; return r; }
        std::string body = std::string("{\"token\":\"") + cfg.token + "\"}";
        std::string resp; long sc = 0;
        if (!http_post("/api/auth/handshake", body, resp, sc)) {
            r.error = "network failure"; return r;
        }
        if (sc == 200) {
            r.valid      = str_field(resp, "valid") == "true";
            r.user_id    = str_field(resp, "id");
            r.plan       = str_field(resp, "plan");
            r.product_id = str_field(resp, "product_id");
            r.expires_at = num_field(resp, "expires_at");
            if (!r.valid) r.error = str_field(resp, "error");
        } else {
            r.error = "http " + std::to_string(sc);
        }
        return r;
    }

    // Background thread that POSTs /api/auth/heartbeat every 30s. If the
    // server ever responds with valid=false (or the network stays down
    // long enough) it calls `on_invalid` — usually you want ExitProcess.
    void start_heartbeat(std::function<void()> on_invalid) {
        if (running.exchange(true)) return;
        std::thread([this, on_invalid]{
            int fails = 0;
            while (running.load()) {
                std::this_thread::sleep_for(std::chrono::seconds(30));
                std::string body = std::string("{\"token\":\"") + cfg.token + "\"}";
                std::string resp; long sc = 0;
                bool ok = http_post("/api/auth/heartbeat", body, resp, sc);
                if (!ok || sc != 200) {
                    if (++fails >= 6) { if (on_invalid) on_invalid(); return; }
                    continue;
                }
                fails = 0;
                if (str_field(resp, "valid") == "false") {
                    if (on_invalid) on_invalid();
                    return;
                }
            }
        }).detach();
    }

    void stop_heartbeat() { running.store(false); }

private:
    Config              cfg;
    std::atomic<bool>   running{false};

    static std::wstring widen(const std::string& s) {
        int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, NULL, 0);
        std::wstring w(n > 0 ? n - 1 : 0, L'\0');
        if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, &w[0], n);
        return w;
    }

    bool http_post(const std::string& path, const std::string& body,
                   std::string& out, long& sc) const {
        HINTERNET s = WinHttpOpen(L"YullyProduct/1.0",
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME,
            WINHTTP_NO_PROXY_BYPASS, 0);
        if (!s) return false;
        HINTERNET c = WinHttpConnect(s, widen(cfg.host).c_str(),
            (INTERNET_PORT)cfg.port, 0);
        if (!c) { WinHttpCloseHandle(s); return false; }
        DWORD flags = cfg.https ? WINHTTP_FLAG_SECURE : 0;
        HINTERNET r = WinHttpOpenRequest(c, L"POST", widen(path).c_str(), NULL,
            WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
        if (!r) { WinHttpCloseHandle(c); WinHttpCloseHandle(s); return false; }
        const wchar_t* h = L"Content-Type: application/json\r\n";
        BOOL ok = WinHttpSendRequest(r, h, -1L, (LPVOID)body.data(),
                                     (DWORD)body.size(), (DWORD)body.size(), 0);
        if (ok) ok = WinHttpReceiveResponse(r, NULL);
        if (ok) {
            DWORD code = 0, sz = sizeof(code);
            WinHttpQueryHeaders(r,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                NULL, &code, &sz, WINHTTP_NO_HEADER_INDEX);
            sc = (long)code;
            DWORD avail = 0;
            do {
                if (!WinHttpQueryDataAvailable(r, &avail) || avail == 0) break;
                std::string buf(avail, '\0');
                DWORD read = 0;
                if (!WinHttpReadData(r, &buf[0], avail, &read) || read == 0) break;
                out.append(buf.data(), read);
            } while (avail > 0);
        }
        WinHttpCloseHandle(r);
        WinHttpCloseHandle(c);
        WinHttpCloseHandle(s);
        return ok == TRUE;
    }

    static std::string str_field(const std::string& obj, const std::string& key) {
        std::string needle = "\"" + key + "\"";
        size_t p = obj.find(needle);
        if (p == std::string::npos) return "";
        p = obj.find(':', p); if (p == std::string::npos) return "";
        ++p; while (p < obj.size() && (obj[p]==' '||obj[p]=='\t')) ++p;
        if (p >= obj.size()) return "";
        if (obj[p] == '"') {
            ++p;
            std::string v;
            while (p < obj.size() && obj[p] != '"') {
                if (obj[p] == '\\' && p + 1 < obj.size()) { v.push_back(obj[p+1]); p += 2; }
                else v.push_back(obj[p++]);
            }
            return v;
        }
        size_t start = p;
        while (p < obj.size() && obj[p] != ',' && obj[p] != '}' && obj[p] != ' ') ++p;
        return obj.substr(start, p - start);
    }
    static long long num_field(const std::string& obj, const std::string& key) {
        std::string v = str_field(obj, key);
        return v.empty() ? 0 : std::atoll(v.c_str());
    }
};

} // namespace yh
