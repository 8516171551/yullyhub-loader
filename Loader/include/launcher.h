// launcher.h — command dispatch + product launch + subscription heartbeat
// + browser open.
//
// Every raw JSON command that arrives (from local /command or a poll
// batch) is fed into handle_command. Recognised types:
//   { "type": "ping"                                            }
//   { "type": "launch",   productId, title, url, token,
//                         apiHost, hideWindow                    }
//   { "type": "shutdown"                                        }
//   { "type": "island"    }  // deprecated no-op (kept for old clients)
#pragma once
#include <string>

namespace launcher {
    void handle_command(const std::string& payload);

    // Called from main() on startup. Detects an existing YullyHub
    // browser window (title match); if none found, opens
    //   chrome.exe --incognito --new-window https://<api-host>
    void open_dashboard_browser_if_needed();

    // Idempotent — spawns the heartbeat thread on first launch.
    void start_heartbeat_thread();
}
