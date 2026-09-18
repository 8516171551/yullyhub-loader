// http.h — thin WinHTTP wrapper.
// Two verbs, string in / string out. Handles TLS negotiation, redirects,
// gzip, and returns a raw response body + HTTP status.
#pragma once
#include <string>
#include <vector>
#include <cstdint>

namespace http {
    // GET, returns body via `out`. `sc` receives the HTTP status.
    bool get_string(const std::string& host, int port, bool https,
                    const std::string& path,
                    std::string& out, long* sc);

    // POST application/json, sends `body`, receives response into `out`.
    bool post_json(const std::string& host, int port, bool https,
                   const std::string& path,
                   const std::string& body,
                   std::string& out, long* sc);

    // GET, returns bytes via `out`. Used for product-exe download.
    bool download_bytes(const std::string& url, std::vector<uint8_t>& out);
}
