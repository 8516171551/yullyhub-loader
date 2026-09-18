#include "pch.h"
#include "crypto.h"

namespace crypto {

void xor_buf(void* buf, size_t len, const uint8_t* key, size_t keyLen) {
    if (!buf || !key || keyLen == 0) return;
    uint8_t* p = static_cast<uint8_t*>(buf);
    for (size_t i = 0; i < len; ++i) p[i] ^= key[i % keyLen];
}

std::string xor_str(const std::string& in, const std::string& key) {
    std::string out = in;
    if (!key.empty()) xor_buf(out.data(), out.size(),
                              reinterpret_cast<const uint8_t*>(key.data()), key.size());
    return out;
}

std::vector<uint8_t> xor_bytes(const std::vector<uint8_t>& in, const std::string& key) {
    std::vector<uint8_t> out = in;
    if (!key.empty()) xor_buf(out.data(), out.size(),
                              reinterpret_cast<const uint8_t*>(key.data()), key.size());
    return out;
}

uint32_t fnv1a(const void* data, size_t len) {
    const uint8_t* p = static_cast<const uint8_t*>(data);
    uint32_t h = 0x811C9DC5u;
    for (size_t i = 0; i < len; ++i) {
        h ^= p[i];
        h *= 0x01000193u;
    }
    return h;
}

} // namespace crypto
