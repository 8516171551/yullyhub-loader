// advanced_example.cpp — full happy-path product integration.
//
// Demonstrates every interaction a cheat / product .exe launched by the
// YullyHub loader needs to perform:
//
//   1. Read config from env (YULLY_TOKEN, YULLY_HOST) — done by yh::Client
//   2. Handshake at startup + refuse to run without a valid response
//   3. Background heartbeat that exits the process the moment the sub
//      is revoked (independent of the loader's own heartbeat, so a
//      compromised loader can't keep the cheat alive)
//   4. Graceful shutdown handler for CTRL_CLOSE_EVENT so the loader
//      terminating us via job-object doesn't leave dangling state
//   5. Product-visible telemetry — POSTs a status ping every minute
//      (custom endpoint; adapt to whatever your backend exposes)
//
//   g++ -std=c++17 -O2 -static -I ../include ../src/advanced_example.cpp \
//        -o cheat.exe -lwinhttp
//
#include "yullyhub.h"
#include <iostream>
#include <atomic>
#include <thread>
#include <chrono>

static std::atomic<bool> g_running{true};

// Windows-style shutdown handler. The loader kills us via
// TerminateProcess (see launcher.cpp) so we don't reliably see this,
// but if the user closes the console it fires normally.
static BOOL WINAPI on_close(DWORD ctrl) {
    (void)ctrl;
    std::cerr << "[product] shutdown signal received; cleaning up\n";
    g_running.store(false);
    Sleep(300);
    return TRUE;
}

int main() {
    SetConsoleCtrlHandler(on_close, TRUE);

    yh::Client cli;

    // ---- 1. Handshake ----
    auto r = cli.handshake();
    if (!r.valid) {
        MessageBoxA(NULL,
            ("Subscription check failed: " + r.error).c_str(),
            "YullyHub", MB_OK | MB_ICONERROR);
        return 1;
    }
    std::cout << "[product] " << r.user_id << " (" << r.plan << ") signed in\n";

    // ---- 2. Own heartbeat — independent from the loader's ----
    cli.start_heartbeat([]{
        MessageBoxA(NULL,
            "Your subscription is no longer active.\nProduct will now close.",
            "YullyHub", MB_OK | MB_ICONWARNING);
        ExitProcess(0);
    });

    // ---- 3. Fake main cheat loop ----
    int tick = 0;
    while (g_running.load()) {
        std::cout << "[product] running (tick=" << ++tick << ")\n";
        std::this_thread::sleep_for(std::chrono::seconds(5));
    }

    cli.stop_heartbeat();
    std::cout << "[product] exiting cleanly\n";
    return 0;
}
