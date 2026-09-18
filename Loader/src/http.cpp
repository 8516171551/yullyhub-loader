#include "pch.h"
#include "http.h"

namespace http {

namespace {

std::wstring widen(const std::string& s) {
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, NULL, 0);
    std::wstring w(n > 0 ? n - 1 : 0, L'\0');
    if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, &w[0], n);
    return w;
}

// One-shot WinHTTP session + connection + request. Returns the response
// body plus status code, both optional.
bool request(const std::string& host, int port, bool https,
             const std::string& path, const wchar_t* verb,
             const std::string* body, const wchar_t* extraHeaders,
             std::string* outBody, std::vector<uint8_t>* outBytes,
             long* sc) {
    HINTERNET session = WinHttpOpen(L"YullyLoader/2.0",
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) return false;

    HINTERNET conn = WinHttpConnect(session, widen(host).c_str(),
        (INTERNET_PORT)port, 0);
    if (!conn) { WinHttpCloseHandle(session); return false; }

    DWORD flags = https ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET req = WinHttpOpenRequest(conn, verb, widen(path).c_str(),
        NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (!req) { WinHttpCloseHandle(conn); WinHttpCloseHandle(session); return false; }

    // Accept self-signed certs on dev hosts.
    DWORD ign = SECURITY_FLAG_IGNORE_UNKNOWN_CA
              | SECURITY_FLAG_IGNORE_CERT_DATE_INVALID
              | SECURITY_FLAG_IGNORE_CERT_CN_INVALID
              | SECURITY_FLAG_IGNORE_CERT_WRONG_USAGE;
    WinHttpSetOption(req, WINHTTP_OPTION_SECURITY_FLAGS, &ign, sizeof(ign));

    DWORD bodyLen = body ? (DWORD)body->size() : 0;
    LPVOID bodyPtr = body && !body->empty() ? (LPVOID)body->data() : WINHTTP_NO_REQUEST_DATA;

    // Assemble headers: caller's extras first, then Authorization if a
    // bearer token is loaded. Kept in a widened std::wstring so its
    // storage outlives the WinHttpSendRequest call.
    std::wstring hdrs;
    if (extraHeaders) hdrs.assign(extraHeaders);
    if (!g_bearer_token.empty()) {
        if (!hdrs.empty() && hdrs.size() >= 2 &&
            hdrs.compare(hdrs.size() - 2, 2, L"\r\n") != 0) hdrs += L"\r\n";
        hdrs += L"Authorization: Bearer " + widen(g_bearer_token) + L"\r\n";
    }
    const wchar_t* hdrPtr = hdrs.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS
                                         : hdrs.c_str();
    DWORD hdrLen = hdrs.empty() ? 0 : (DWORD)-1L;

    BOOL ok = WinHttpSendRequest(req, hdrPtr, hdrLen,
        bodyPtr, bodyLen, bodyLen, 0);
    if (!ok) { WinHttpCloseHandle(req); WinHttpCloseHandle(conn); WinHttpCloseHandle(session); return false; }

    ok = WinHttpReceiveResponse(req, NULL);
    if (!ok) { WinHttpCloseHandle(req); WinHttpCloseHandle(conn); WinHttpCloseHandle(session); return false; }

    if (sc) {
        DWORD code = 0, sz = sizeof(code);
        WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            NULL, &code, &sz, WINHTTP_NO_HEADER_INDEX);
        *sc = (long)code;
    }

    if (outBody) outBody->clear();
    if (outBytes) outBytes->clear();

    DWORD avail = 0;
    do {
        if (!WinHttpQueryDataAvailable(req, &avail)) break;
        if (avail == 0) break;
        std::vector<uint8_t> buf(avail);
        DWORD read = 0;
        if (!WinHttpReadData(req, buf.data(), avail, &read)) break;
        if (read == 0) break;
        if (outBody)  outBody->append(reinterpret_cast<const char*>(buf.data()), read);
        if (outBytes) outBytes->insert(outBytes->end(), buf.begin(), buf.begin() + read);
    } while (avail > 0);

    WinHttpCloseHandle(req);
    WinHttpCloseHandle(conn);
    WinHttpCloseHandle(session);
    return true;
}

} // namespace

bool get_string(const std::string& host, int port, bool https,
                const std::string& path, std::string& out, long* sc) {
    return request(host, port, https, path, L"GET", nullptr, nullptr,
                   &out, nullptr, sc);
}

bool post_json(const std::string& host, int port, bool https,
               const std::string& path, const std::string& body,
               std::string& out, long* sc) {
    return request(host, port, https, path, L"POST", &body,
                   L"Content-Type: application/json\r\n",
                   &out, nullptr, sc);
}

bool download_bytes(const std::string& url, std::vector<uint8_t>& out) {
    // Parse "https://host[:port]/path"
    bool https = false;
    std::string rest = url;
    if (rest.rfind("https://", 0) == 0) { https = true; rest = rest.substr(8); }
    else if (rest.rfind("http://", 0) == 0) { rest = rest.substr(7); }
    else return false;
    size_t slash = rest.find('/');
    std::string host = (slash == std::string::npos) ? rest : rest.substr(0, slash);
    std::string path = (slash == std::string::npos) ? "/"  : rest.substr(slash);
    int port = https ? 443 : 80;
    size_t colon = host.find(':');
    if (colon != std::string::npos) {
        port = atoi(host.c_str() + colon + 1);
        host = host.substr(0, colon);
    }
    long sc = 0;
    return request(host, port, https, path, L"GET", nullptr, nullptr,
                   nullptr, &out, &sc) && sc == 200;
}

} // namespace http
