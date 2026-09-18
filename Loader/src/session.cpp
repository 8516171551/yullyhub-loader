#include "pch.h"
#include "session.h"

namespace session {

namespace {

std::string state_path() {
    char buf[MAX_PATH] = {0};
    DWORD n = GetEnvironmentVariableA("APPDATA", buf, sizeof(buf));
    std::string base = (n > 0 && n < sizeof(buf))
        ? std::string(buf, n)
        : std::string("C:\\Users\\Public");
    std::string dir = base + "\\YullyHub";
    CreateDirectoryA(dir.c_str(), NULL);
    return dir + "\\session.pids";
}

bool try_kill(DWORD pid) {
    if (pid == 0 || pid == GetCurrentProcessId()) return false;
    HANDLE h = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid);
    if (!h) return false;
    BOOL ok = TerminateProcess(h, 0);
    // Wait briefly so anything holding a lock we care about (files
    // under %TEMP%, our own state file) actually releases before we
    // try to overwrite.
    WaitForSingleObject(h, 500);
    CloseHandle(h);
    return ok == TRUE;
}

std::vector<DWORD> read_pids() {
    std::vector<DWORD> out;
    FILE* f = fopen(state_path().c_str(), "rb");
    if (!f) return out;
    char line[64];
    while (fgets(line, sizeof(line), f)) {
        DWORD pid = (DWORD)strtoul(line, nullptr, 10);
        if (pid) out.push_back(pid);
    }
    fclose(f);
    return out;
}

void write_pids(const std::vector<DWORD>& pids) {
    FILE* f = fopen(state_path().c_str(), "wb");
    if (!f) return;
    for (DWORD p : pids) fprintf(f, "%lu\n", (unsigned long)p);
    fclose(f);
}

} // namespace

void kill_previous() {
    auto pids = read_pids();
    if (pids.empty()) return;

    // First entry = loader host (PowerShell) PID from last run.
    // Rest    = product PIDs that loader spawned.
    // Kill products FIRST (so they don't detach when loader dies),
    // then the loader host itself.
    for (size_t i = 1; i < pids.size(); i++) try_kill(pids[i]);
    try_kill(pids[0]);

    // Whatever's left is stale — nuke the file.
    DeleteFileA(state_path().c_str());
}

void register_self() {
    write_pids({ GetCurrentProcessId() });
}

void register_product(unsigned long pid) {
    if (pid == 0) return;
    auto pids = read_pids();
    // Preserve loader host PID (line 0) if present; append product PID.
    if (pids.empty()) pids.push_back(GetCurrentProcessId());
    // Dedup — don't append the same PID twice.
    for (DWORD p : pids) if (p == pid) return;
    pids.push_back((DWORD)pid);
    write_pids(pids);
}

void clear() {
    DeleteFileA(state_path().c_str());
}

} // namespace session
