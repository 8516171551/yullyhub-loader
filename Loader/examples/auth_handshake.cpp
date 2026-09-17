// ============================================================
//  YullyHub — Product Integration Example
// ============================================================
//
//  How a cheat / product verifies the user against the YullyHub API
//  after the loader hands it an exchange token. Drop this file into
//  your product's build, adapt the imports to your codebase, and call
//  yh_handshake() before running any privileged logic.
//
//  Flow:
//    1. Loader mints a token from the dashboard    →  POST /api/auth/exchange
//    2. Loader launches the product with the token as YULLY_TOKEN env var
//    3. Product reads the token from env / argv    →  handshakes
//    4. Server returns { valid, user, subscription } — product decides
//       whether to keep running.
//
//  This example uses WinHTTP so there are no external dependencies —
//  it will build with plain MSVC or MinGW on Windows.
//
//  Build (MSVC):
//    cl /nologo /EHsc /std:c++17 auth_handshake.cpp /link winhttp.lib
//  Build (MinGW g++):
//    g++ -std=c++17 -O2 auth_handshake.cpp -o auth_handshake.exe -lwinhttp
//
//  Run (against local dev):
//    set YULLY_TOKEN=abc123...
//    auth_handshake.exe
//
//  Run (against production once you have a domain):
//    auth_handshake.exe https://yullyhub.example.com
//
//  When you flip to a real HTTPS host the code auto-detects the scheme
//  from the argv[1] URL, no code change needed.
// ============================================================

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <winhttp.h>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <iostream>

#pragma comment(lib, "winhttp.lib")

// ---- Minimal string helpers ----------------------------------------------
static std::wstring toW(const std::string& s) {
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}

// Very small JSON-ish key extractor. Real integrations should use nlohmann/json
// or picojson — this is deliberately dependency-free.
static std::string json_str(const std::string& body, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    size_t p = body.find(needle);
    if (p == std::string::npos) return "";
    p = body.find(':', p);
    if (p == std::string::npos) return "";
    // skip whitespace
    while (p < body.size() && (body[p] == ':' || body[p] == ' ' || body[p] == '\t')) ++p;
    if (p >= body.size()) return "";
    if (body[p] == '"') {
        size_t q = body.find('"', p + 1);
        if (q == std::string::npos) return "";
        return body.substr(p + 1, q - p - 1);
    }
    // number / bool
    size_t q = p;
    while (q < body.size() && body[q] != ',' && body[q] != '}' && body[q] != ']') ++q;
    return body.substr(p, q - p);
}

// ---- HTTP client via WinHTTP --------------------------------------------
struct YHResponse {
    long status;
    std::string body;
};

static bool http_get(const std::wstring& host, INTERNET_PORT port,
                     bool https, const std::wstring& path,
                     YHResponse& out) {
    HINTERNET hSession = WinHttpOpen(L"YullyProduct/1.0",
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) return false;

    HINTERNET hConnect = WinHttpConnect(hSession, host.c_str(), port, 0);
    if (!hConnect) { WinHttpCloseHandle(hSession); return false; }

    HINTERNET hReq = WinHttpOpenRequest(hConnect, L"GET", path.c_str(),
        nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
        https ? WINHTTP_FLAG_SECURE : 0);
    if (!hReq) { WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return false; }

    bool ok = WinHttpSendRequest(hReq, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
              WINHTTP_NO_REQUEST_DATA, 0, 0, 0)
           && WinHttpReceiveResponse(hReq, nullptr);

    if (ok) {
        DWORD statusCode = 0, sz = sizeof(statusCode);
        WinHttpQueryHeaders(hReq, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &sz, WINHTTP_NO_HEADER_INDEX);
        out.status = (long)statusCode;

        for (;;) {
            DWORD available = 0;
            if (!WinHttpQueryDataAvailable(hReq, &available) || available == 0) break;
            std::string chunk(available, '\0');
            DWORD read = 0;
            if (!WinHttpReadData(hReq, &chunk[0], available, &read) || read == 0) break;
            chunk.resize(read);
            out.body += chunk;
        }
    }

    WinHttpCloseHandle(hReq);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);
    return ok;
}

// ---- URL parser (basic, no auth / no fragments) ------------------------
struct ParsedUrl {
    bool https;
    std::string host;
    INTERNET_PORT port;
};
static ParsedUrl parse_url(const std::string& urlIn) {
    ParsedUrl u{ false, "127.0.0.1", 3000 };
    std::string s = urlIn;
    if (s.rfind("https://", 0) == 0) { u.https = true; s = s.substr(8); u.port = 443; }
    else if (s.rfind("http://", 0) == 0) { u.https = false; s = s.substr(7); u.port = 3000; }
    // strip any trailing path
    size_t slash = s.find('/');
    if (slash != std::string::npos) s = s.substr(0, slash);
    size_t colon = s.find(':');
    if (colon != std::string::npos) {
        u.host = s.substr(0, colon);
        try { u.port = (INTERNET_PORT)std::stoi(s.substr(colon + 1)); } catch (...) {}
    } else {
        u.host = s;
    }
    return u;
}

// ============================================================
//  yh_handshake — the ONE call product code needs.
//    token: the exchange token the loader passed via env / argv
//    baseUrl: e.g. "http://127.0.0.1:3000" for dev, or your real domain
//
//  On success writes user / plan into `outUserId` + `outPlan` and returns
//  true. On failure the product should refuse to run.
// ============================================================
bool yh_handshake(const std::string& token,
                  const std::string& baseUrl,
                  std::string& outUserId,
                  std::string& outPlan,
                  std::string* rawBody = nullptr) {
    ParsedUrl u = parse_url(baseUrl);
    std::wstring path = L"/api/auth/handshake?token=" + toW(token);

    YHResponse rsp{};
    if (!http_get(toW(u.host), u.port, u.https, path, rsp)) {
        std::cerr << "[yh] transport failure — cannot reach " << u.host << std::endl;
        return false;
    }
    if (rawBody) *rawBody = rsp.body;

    if (rsp.status != 200) {
        std::cerr << "[yh] server rejected token (HTTP " << rsp.status << "): "
                  << rsp.body << std::endl;
        return false;
    }
    // Very simple JSON pluck — swap for a real parser in production.
    if (json_str(rsp.body, "valid") != "true") {
        std::cerr << "[yh] handshake body says invalid: " << rsp.body << std::endl;
        return false;
    }
    outUserId = json_str(rsp.body, "id");
    outPlan   = json_str(rsp.body, "plan");
    return true;
}

// ============================================================
//  Example driver — real products would call yh_handshake() inside
//  their own startup and gate the rest of their logic behind it.
// ============================================================
int main(int argc, char** argv) {
    // 1) Token — argv[1] first, then env var YULLY_TOKEN.
    std::string token;
    if (argc >= 2) token = argv[1];
    if (token.empty()) {
        char buf[512];
        DWORD n = GetEnvironmentVariableA("YULLY_TOKEN", buf, (DWORD)sizeof(buf));
        if (n > 0 && n < sizeof(buf)) token.assign(buf, n);
    }
    if (token.empty()) {
        std::cerr << "[yh] no token — set YULLY_TOKEN or pass as argv[1]" << std::endl;
        return 1;
    }

    // 2) Base URL — argv[2] or env YULLY_HOST, else localhost dev.
    std::string baseUrl;
    if (argc >= 3) baseUrl = argv[2];
    if (baseUrl.empty()) {
        char buf[512];
        DWORD n = GetEnvironmentVariableA("YULLY_HOST", buf, (DWORD)sizeof(buf));
        if (n > 0 && n < sizeof(buf)) baseUrl.assign(buf, n);
    }
    if (baseUrl.empty()) baseUrl = "http://127.0.0.1:3000";

    std::cout << "[yh] handshaking " << baseUrl
              << " with token " << token.substr(0, 6) << "…" << std::endl;

    std::string userId, plan, raw;
    if (!yh_handshake(token, baseUrl, userId, plan, &raw)) {
        std::cerr << "[yh] REFUSING TO RUN" << std::endl;
        return 2;
    }
    std::cout << "[yh] session OK — user=" << userId << " plan=" << plan << std::endl;
    std::cout << "[yh] raw body: " << raw << std::endl;

    // ============================================================
    // Real cheat / product logic goes here. The rest of the file only
    // executes because the handshake succeeded.
    // ============================================================
    std::cout << "[yh] product would now do its work..." << std::endl;
    return 0;
}
