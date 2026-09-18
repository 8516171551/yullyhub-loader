// session.h — cross-run tracking of the loader host PID and every
// product PID it spawned, so a fresh loader can nuke leftovers from a
// prior run before it hides its own console.
//
// State file lives at %APPDATA%\YullyHub\session.pids and is a plain
// newline-separated list of decimal PIDs. Line 0 is the loader host
// (PowerShell) PID; lines 1..N are product PIDs. Empty file / missing
// file / bogus content are all treated as "no previous session".
#pragma once
#include <string>

namespace session {
    // Read the state file, TerminateProcess every PID that's still
    // alive, then delete the file. Safe to call before we've done any
    // real work — this is the FIRST thing main() runs.
    void kill_previous();

    // Overwrite the state file with just our current PS host PID.
    void register_self();

    // Append a spawned product PID to the state file.
    void register_product(unsigned long pid);

    // Wipe the state file. Called from the shutdown paths.
    void clear();
}
