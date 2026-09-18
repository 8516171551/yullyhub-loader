// protect.h — layered anti-analysis. Not silver-bullet security; each
// individual check is well-known and beatable, but together they raise
// the effort bar meaningfully for casual attackers.
//
// Checks currently in the stack (in start_protection_thread's poll):
//   1. IsDebuggerPresent (PEB flag) + CheckRemoteDebuggerPresent
//   2. NtQueryInformationProcess(ProcessDebugPort) — kernel-level
//   3. NtSetInformationThread(ThreadHideFromDebugger) — hide our own
//      threads from any attached ring-3 debugger
//   4. rdtsc timing gap — huge deltas mean something's single-stepping
//   5. Loaded-module scan for known injectors / analysis tools
//   6. .text section FNV-1a self-hash, re-checked periodically
//
// On any positive detection: `ExitProcess(0xDEAD)` — the loader
// disappears, and so does anything in its Job Object (the product).
//
// One-shot init:
//   protect::wipe_headers() — zero the DOS + NT headers of our own
//     PE mapping so a naive process dump lands garbage.
//   protect::start_protection_thread() — background poller.
#pragma once

namespace protect {
    // Blast the DOS + NT header pages of our own image with zeros so
    // process-hollower dumps miss the PE structure. Loader keeps
    // running (headers are only needed at load time).
    void wipe_headers();

    // One-shot true/false checks (usable ad-hoc).
    bool is_debugger_present();
    bool has_kernel_debugger();
    bool has_injector_loaded();
    bool rdtsc_timing_tripped();

    // Hides our runtime threads from any attached ring-3 debugger by
    // calling NtSetInformationThread(ThreadHideFromDebugger) on every
    // subsequently-created thread we know about. Idempotent.
    void hide_current_thread();

    // Fires the background poller. Runs the checks every ~4s and
    // ExitProcess()es on any hit.
    void start_protection_thread();
}
