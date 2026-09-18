// control.h — command-plane transport for the loader.
//
// Two channels feed the same handle_command dispatch:
//   1. Remote polling (cloud): every 500 ms GET /api/loader/poll
//   2. Local HTTP (127.0.0.1:<random port>): dashboard/pill can POST
//      /command directly at us with zero server hop
//
// A shared job object owns the loader + every non-elevated child, so
// closing it kills everything in one shot.
#pragma once
#include <string>

namespace control {
    // Install the process-wide Job Object with KILL_ON_JOB_CLOSE +
    // BREAKAWAY_OK. Loader gets assigned; children inherit unless they
    // explicitly break away.
    void install_kill_switch();

    // Register a Ctrl+C / X handler that closes the job → kills all children.
    void install_console_ctrl_handler();

    // Bind 127.0.0.1:<random port>. Sets g_local_port. Handles /ping,
    // /command, /shutdown + OPTIONS preflight with LNA CORS headers.
    void start_local_server();

    // The cloud polling loop. Blocks. Runs forever unless something
    // hard-kills the process (heartbeat / protect thread / user).
    void run_poll_loop();

    // Local HTTP server bound port, or 0 if not running.
    extern int local_port;
}
