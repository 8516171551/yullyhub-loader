#include "pch.h"
#include "protect.h"
#include "crypto.h"

// ---------------- Undocumented NT prototypes ----------------
using NtQueryInformationProcess_t = NTSTATUS (WINAPI *)(
    HANDLE, ULONG /*ProcessInformationClass*/, PVOID, ULONG, PULONG);
using NtSetInformationThread_t = NTSTATUS (WINAPI *)(
    HANDLE, ULONG /*ThreadInformationClass*/, PVOID, ULONG);

// PROCESSINFOCLASS / THREADINFOCLASS values — winternl.h names collide on
// MinGW so we use our own constants under a `k` prefix.
static constexpr ULONG kProcessDebugPort         = 7;
static constexpr ULONG kProcessDebugFlags        = 31;
static constexpr ULONG kProcessDebugObjectHandle = 30;
static constexpr ULONG kThreadHideFromDebugger   = 17;

namespace {

NtQueryInformationProcess_t nt_qip() {
    static auto p = (NtQueryInformationProcess_t)GetProcAddress(
        GetModuleHandleA("ntdll.dll"), "NtQueryInformationProcess");
    return p;
}
NtSetInformationThread_t nt_sit() {
    static auto p = (NtSetInformationThread_t)GetProcAddress(
        GetModuleHandleA("ntdll.dll"), "NtSetInformationThread");
    return p;
}

// Baseline hash of the .text section, captured on init.
uint32_t g_text_hash_baseline = 0;
size_t   g_text_size          = 0;
uint8_t* g_text_base          = nullptr;

void capture_text_baseline() {
    HMODULE base = GetModuleHandleA(NULL);
    if (!base) return;
    auto dos = reinterpret_cast<IMAGE_DOS_HEADER*>(base);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return;
    auto nt = reinterpret_cast<IMAGE_NT_HEADERS*>(
        reinterpret_cast<uint8_t*>(base) + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return;
    auto sec = IMAGE_FIRST_SECTION(nt);
    for (WORD i = 0; i < nt->FileHeader.NumberOfSections; ++i, ++sec) {
        if (memcmp(sec->Name, ".text", 5) == 0) {
            g_text_base = reinterpret_cast<uint8_t*>(base) + sec->VirtualAddress;
            g_text_size = sec->Misc.VirtualSize;
            g_text_hash_baseline = crypto::fnv1a(g_text_base, g_text_size);
            return;
        }
    }
}

} // namespace

namespace protect {

void wipe_headers() {
    HMODULE base = GetModuleHandleA(NULL);
    if (!base) return;
    // Capture .text baseline BEFORE zeroing headers — after wipe we
    // can't parse them.
    capture_text_baseline();

    DWORD old = 0;
    if (VirtualProtect(base, 4096, PAGE_READWRITE, &old)) {
        // Preserve first 2 bytes ("MZ") — some Windows internals still
        // read them lazily; the rest of the DOS + NT headers is fair
        // game for wiping.
        memset(reinterpret_cast<uint8_t*>(base) + 2, 0, 4096 - 2);
        DWORD tmp;
        VirtualProtect(base, 4096, old, &tmp);
    }
}

bool is_debugger_present() {
    if (IsDebuggerPresent()) return true;
    BOOL rd = FALSE;
    CheckRemoteDebuggerPresent(GetCurrentProcess(), &rd);
    return rd == TRUE;
}

bool has_kernel_debugger() {
    auto fn = nt_qip();
    if (!fn) return false;
    // ProcessDebugPort: non-zero → user-mode debugger attached.
    ULONG_PTR port = 0;
    if (fn(GetCurrentProcess(), kProcessDebugPort, &port, sizeof(port), NULL) == 0
        && port != 0) return true;
    HANDLE dbg = NULL;
    if (fn(GetCurrentProcess(), kProcessDebugObjectHandle, &dbg, sizeof(dbg), NULL) == 0
        && dbg != NULL) return true;
    ULONG flags = 0;
    if (fn(GetCurrentProcess(), kProcessDebugFlags, &flags, sizeof(flags), NULL) == 0
        && flags == 0) return true;
    return false;
}

bool has_injector_loaded() {
    // Casual attacker giveaways. Anything in this list means the
    // process cohabits with a known tool.
    static const char* bad[] = {
        "cheatengine",     "extreminject",     "xenos64",
        "xenos",           "hxd",              "extreme",
        "ollydbg",         "windbg",           "idaq",
        "processhacker",   "ida64",            "scylla",
        "process explorer",
        NULL
    };
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32,
                                           GetCurrentProcessId());
    if (snap == INVALID_HANDLE_VALUE) return false;
    MODULEENTRY32 me{}; me.dwSize = sizeof(me);
    bool hit = false;
    if (Module32First(snap, &me)) {
        do {
            std::string name = me.szModule;
            std::transform(name.begin(), name.end(), name.begin(),
                           [](unsigned char c) { return (char)tolower(c); });
            for (int i = 0; bad[i]; i++) {
                if (name.find(bad[i]) != std::string::npos) { hit = true; break; }
            }
        } while (!hit && Module32Next(snap, &me));
    }
    CloseHandle(snap);
    if (hit) return true;

    // Also scan the running process list — a debugger doesn't need to
    // inject a module to be attached.
    HANDLE psnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (psnap == INVALID_HANDLE_VALUE) return false;
    PROCESSENTRY32 pe{}; pe.dwSize = sizeof(pe);
    if (Process32First(psnap, &pe)) {
        do {
            std::string name = pe.szExeFile;
            std::transform(name.begin(), name.end(), name.begin(),
                           [](unsigned char c) { return (char)tolower(c); });
            for (int i = 0; bad[i]; i++) {
                if (name.find(bad[i]) != std::string::npos) { hit = true; break; }
            }
        } while (!hit && Process32Next(psnap, &pe));
    }
    CloseHandle(psnap);
    return hit;
}

bool rdtsc_timing_tripped() {
    // Single-stepped code shows massive rdtsc deltas across trivial ops.
    unsigned long long a = __rdtsc();
    // A handful of ops that shouldn't take more than a few hundred cycles.
    volatile int x = 0;
    for (int i = 0; i < 20; i++) x += i;
    unsigned long long b = __rdtsc();
    (void)x;
    // 500k cycles for a 20-add loop is a strong single-step signal.
    return (b - a) > 500000ULL;
}

void hide_current_thread() {
    auto fn = nt_sit();
    if (!fn) return;
    fn(GetCurrentThread(), kThreadHideFromDebugger, NULL, 0);
}

void start_protection_thread() {
    hide_current_thread();
    std::thread([]() {
        hide_current_thread();
        while (true) {
            std::this_thread::sleep_for(std::chrono::seconds(4));
            if (is_debugger_present() ||
                has_kernel_debugger() ||
                has_injector_loaded() ||
                rdtsc_timing_tripped()) {
                ExitProcess(0xDEAD);
            }
            // .text integrity check
            if (g_text_base && g_text_size) {
                uint32_t cur = crypto::fnv1a(g_text_base, g_text_size);
                if (cur != g_text_hash_baseline) ExitProcess(0xDEAD);
            }
        }
    }).detach();
}

} // namespace protect
