// strings.h — compile-time XOR string obfuscation.
//
// Any literal wrapped in XS("...") is XOR-encoded in the compiled binary
// with the fixed key below, and decoded to a fresh std::string only when
// the expression is evaluated at runtime. Grepping the .exe for the raw
// string no longer works; the plaintext exists in memory only briefly.
//
// Usage:
//   auto url = XS("https://yullyhub.com/api/loader/poll");
//   // url is a std::string; behaves exactly like std::string("...")
//
// The key is compile-time-only — a real production build should
// randomise it per compile (script pass), but a fixed key already
// removes the low-effort "strings loader.exe" attack.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace xs {
    constexpr uint8_t KEY = 0x5B;

    template <size_t N>
    struct EncBuf {
        char data[N];
        constexpr EncBuf(const char (&s)[N]) : data{} {
            for (size_t i = 0; i < N; ++i) data[i] = static_cast<char>(s[i] ^ KEY);
        }
    };
} // namespace xs

// Emit an obfuscated literal. Expands to an immediately-invoked lambda so
// the encrypted buffer lives in the calling scope's static storage but
// decoding happens at each use. Downstream code just sees a std::string.
#define XS(literal)                                                           \
    ([]() -> std::string {                                                     \
        static constexpr ::xs::EncBuf<sizeof(literal)> _enc(literal);          \
        std::string out;                                                       \
        constexpr size_t n = sizeof(literal);                                  \
        out.reserve(n);                                                        \
        for (size_t i = 0; i + 1 < n; ++i)                                     \
            out.push_back(static_cast<char>(_enc.data[i] ^ ::xs::KEY));        \
        return out;                                                            \
    }())
