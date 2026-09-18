// crypto.h — tiny runtime crypto helpers (XOR + rolling XOR).
//
// These aren't real security — they're friction against dumb string
// grepping. Any determined attacker with a debugger will trivially undo
// them. The point is to keep casual snooping out of the loader's byte
// stream.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace crypto {
    // In-place XOR with a repeating key. Used for over-the-wire buffers
    // between the loader and a product that opts into wrapping.
    void xor_buf(void* buf, size_t len, const uint8_t* key, size_t keyLen);

    // Convenience wrapper for std::string / vector<uint8_t> targets.
    std::string xor_str(const std::string& in, const std::string& key);
    std::vector<uint8_t> xor_bytes(const std::vector<uint8_t>& in, const std::string& key);

    // 4-byte FNV-1a hash of a buffer. Useful as a self-integrity check
    // (protect module hashes .text on init and re-hashes periodically).
    uint32_t fnv1a(const void* data, size_t len);
}
