// minimal_example.cpp — the absolute bare minimum.
// One handshake, print result, exit.
//
//   g++ -std=c++17 -O2 -static -I ../include ../src/minimal_example.cpp \
//        -o minimal.exe -lwinhttp
//
#include "yullyhub.h"
#include <iostream>

int main() {
    yh::Client cli;

    // Pull env once — useful debug output.
    std::cout << "[product] token=" << (cli.config().token.empty() ? "(none)" : cli.config().token.substr(0, 8) + "...") << "\n";
    std::cout << "[product] host="  << cli.config().host << ":" << cli.config().port
              << (cli.config().https ? " (https)" : " (http)") << "\n";

    auto r = cli.handshake();
    if (!r.valid) {
        std::cerr << "[product] handshake failed: " << r.error << "\n";
        return 1;
    }
    std::cout << "[product] handshake OK\n"
              << "  user_id    = " << r.user_id << "\n"
              << "  plan       = " << r.plan << "\n"
              << "  product_id = " << r.product_id << "\n"
              << "  expires_at = " << r.expires_at << "\n";
    return 0;
}
