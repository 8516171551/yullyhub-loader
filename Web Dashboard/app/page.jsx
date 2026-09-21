'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { uploadPresigned as blobUpload } from '@vercel/blob/client';

// ---------- Login page ----------
// Yully credentials (admin or reseller username + password) OR a license
// key (XXXX-XXXX-XXXX-XXXX). One flow, one form.
function LoginPage({ onLoggedIn }) {
    const [id, setId] = useState('');
    const [pw, setPw] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');

    const isKey = /^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/i.test(id.trim());

    const submit = async (e) => {
        e.preventDefault();
        if (!id.trim()) return;
        setBusy(true); setErr('');
        try {
            const r = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifier: id.trim(), password: pw }),
            });
            const j = await r.json();
            if (r.ok && j.ok) onLoggedIn(j.identity);
            else setErr(j.reason || 'invalid_credentials');
        } catch (e2) {
            setErr('network');
        }
        setBusy(false);
    };

    return (
        <div className="landing">
            <div className="landing-inner" style={{ maxWidth: 380 }}>
                <img className="landing-logo" src="/YullyLogo.png" alt="YullyHub" />
                <div className="landing-brand">YullyHub</div>
                <div className="landing-sub">Sign in with your Yully account or a license key.</div>
                <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', marginTop: 18 }}>
                    <input
                        autoFocus
                        placeholder="Username or license key"
                        value={id}
                        onChange={e => setId(e.target.value)}
                        className="landing-input"
                        autoComplete="username"
                    />
                    {!isKey && (
                        <input
                            type="password"
                            placeholder="Password"
                            value={pw}
                            onChange={e => setPw(e.target.value)}
                            className="landing-input"
                            autoComplete="current-password"
                        />
                    )}
                    <button className="landing-copy" type="submit" disabled={busy || !id.trim() || (!isKey && !pw)}>
                        {busy ? 'Signing in…' : (isKey ? 'Redeem key' : 'Sign in')}
                    </button>
                    {err && <div style={{ color: '#ff6b6b', fontSize: 13, textAlign: 'center' }}>{err.replace(/_/g,' ')}</div>}
                </form>
            </div>
        </div>
    );
}

// ---------- Landing page (session gate) ----------
// Three states:
//   1. No session in URL, no online loader yet
//        → show the `irm ... | iex` command + Copy button, poll every
//          500ms for a loader to come online.
//   2. Online loader detected (or session in URL)
//        → show "Connecting to loader…" with a spinner, keep polling
//          status until it flips online.
//   3. Loader connected → parent transitions us out to the dashboard.
function LandingPage({ session, checking }) {
    const cmd = 'irm https://yullyhub.com/loader | iex';
    const [copied, setCopied] = useState(false);
    const doCopy = async () => {
        try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
    };

    // Continuously watch /api/loader/latest for the freshest online
    // loader — whether or not we already have a session in the URL.
    // Reason: a stale session id in the URL (previous run's loader
    // died, user reran `irm | iex` in a new PS) would otherwise leave
    // the visitor stuck on "Connecting…" forever. If /latest returns
    // a DIFFERENT online loader from the one in our URL, we transition
    // to it. Also handles the fresh-visit case (no session param yet).
    useEffect(() => {
        if (typeof window === 'undefined') return;
        let alive = true;
        const poll = async () => {
            try {
                const r = await fetch('/api/loader/latest', { cache: 'no-store' });
                if (!alive) return;
                if (r.ok) {
                    const j = await r.json();
                    // Only jump when there's a NEWER online loader than
                    // whatever session is already in the URL.
                    if (j.id && j.id !== session) {
                        const u = new URL(window.location.href);
                        u.searchParams.set('session', j.id);
                        window.location.replace(u.toString());
                    }
                }
            } catch {}
        };
        poll();
        const iv = setInterval(poll, 1200);
        return () => { alive = false; clearInterval(iv); };
    }, [session]);

    const connecting = !!session;
    return (
        <div className="landing">
            <div className="landing-inner">
                <img className="landing-logo" src="/YullyLogo.png" alt="YullyHub" />
                <div className="landing-brand">YullyHub</div>
                <div className="landing-sub">Run this in PowerShell:</div>
                <div className="landing-code-row">
                    <code className="landing-code">{cmd}</code>
                    <button className="landing-copy" onClick={doCopy}>{copied ? 'Copied' : 'Copy'}</button>
                </div>
                {connecting ? (
                    <div className="landing-connecting">
                        <span className="spinner big"/>
                        <span className="landing-connecting-text">
                            {checking ? 'Connecting to loader…' : 'Loader offline. Run the command again.'}
                        </span>
                    </div>
                ) : (
                    <div className="landing-sub muted landing-waiting">
                        <span className="pulse-dot"/> Waiting for loader…
                    </div>
                )}
            </div>
        </div>
    );
}

// The dynamic-island pill lives in its own /island page now — the loader
// spawns a tiny standalone Chrome window for it after a launch. The
// dashboard never renders the pill directly, so it can't get hidden
// behind the dashboard's own layout.

function Clock() {
    const [t, setT] = useState('');
    useEffect(() => {
        const tick = () => {
            const d = new Date();
            setT(`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`);
        };
        tick();
        const iv = setInterval(tick, 30_000);
        return () => clearInterval(iv);
    }, []);
    return <span className="clock">{t}</span>;
}

export default function Page() {
    // ---- Auth gate (Yully credentials OR license key) ----
    // Unified schema: /api/auth/me returns { ok, user: {id, email, username, role, display_name} }
    const [identity, setIdentity] = useState(null);
    const [authLoading, setAuthLoading] = useState(true);
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const r = await fetch('/api/auth/me', { cache: 'no-store' });
                if (!alive) return;
                if (r.ok) {
                    const j = await r.json();
                    if (j.ok && j.user) setIdentity({
                        id:       j.user.id,
                        email:    j.user.email,
                        username: j.user.username,
                        role:     j.user.role,
                        display:  j.user.display_name || j.user.username || j.user.email,
                    });
                }
            } catch {}
            if (alive) setAuthLoading(false);
        })();
        return () => { alive = false; };
    }, []);

    // ---- Session gate ----
    const [session, setSession] = useState(null);
    const [loaderConnected, setLoaderConnected] = useState(false);
    const [checkingLoader, setCheckingLoader] = useState(true);

    // Kiosk keyboard blocking
    useEffect(() => {
        const blockKey = (e) => {
            const k = (e.key || '').toLowerCase();
            const ctrl  = e.ctrlKey  || e.metaKey;
            const shift = e.shiftKey;
            const alt   = e.altKey;
            const isBad =
                k === 'f5' || k === 'f11' || k === 'f12' || k === 'escape' ||
                (ctrl && ['r','w','t','n','u','s','p','j','h'].includes(k)) ||
                (ctrl && shift && ['i','j','c','r'].includes(k)) ||
                (alt  && (k === 'arrowleft' || k === 'arrowright'));
            if (isBad) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); return false; }
        };
        const blockCtx = (e) => { e.preventDefault(); e.stopPropagation(); return false; };
        document.addEventListener('keydown', blockKey, true);
        document.addEventListener('contextmenu', blockCtx, true);
        try { window.history.pushState(null, '', window.location.href); } catch {}
        const popBlock = () => { try { window.history.pushState(null, '', window.location.href); } catch {} };
        window.addEventListener('popstate', popBlock);
        return () => {
            document.removeEventListener('keydown', blockKey, true);
            document.removeEventListener('contextmenu', blockCtx, true);
            window.removeEventListener('popstate', popBlock);
        };
    }, []);

    // Sticky online tracking (see command-queue.js for the server-side story)
    const lastOnlineAtRef = useRef(0);
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const url = new URL(window.location.href);
        const s = url.searchParams.get('session');
        setSession(s);
        if (!s) { setCheckingLoader(false); return; }

        let alive = true;
        const check = async () => {
            try {
                const r = await fetch(`/api/loader/status?id=${encodeURIComponent(s)}`, { cache: 'no-store' });
                if (!alive) return;
                if (r.ok) {
                    const j = await r.json();
                    const now = Date.now();
                    if (j.online) {
                        lastOnlineAtRef.current = now;
                        setLoaderConnected(true);
                    }
                    setState((prev) => ({
                        ...prev,
                        online: !!j.online,
                        count:  j.online ? 1 : 0,
                        agents: j.online ? [{ id: s, addr: 'https poll', connectedAt: j.lastSeen || Date.now() }] : [],
                    }));
                    // Old behavior kicked the user back to landing after
                    // 10s of "offline" — which fired whenever the C++
                    // loader missed a single heartbeat cycle. Users lost
                    // their dashboard mid-session. Now we just surface
                    // "reconnecting…" in the header banner and keep
                    // polling forever; the customer decides when to
                    // give up (close the tab / manually restart).
                }
            } catch {}
            if (alive) setCheckingLoader(false);
        };
        check();
        const iv = setInterval(check, 2500);
        return () => { alive = false; clearInterval(iv); };
    }, [loaderConnected]);

    const [screen, setScreen] = useState('home');
    const [modal, setModal]   = useState(null); // 'admin' | 'settings' | 'script' | null
    const [selectedId, setSelectedId] = useState(null);
    const [state, setState] = useState({ online: false, count: 0, agents: [] });
    const [events, setEvents] = useState([]);
    const [injectPct, setInjectPct] = useState(0);
    const [injectStatus, setInjectStatus] = useState('Processing…');
    const [products, setProducts] = useState([]);
    const [busy, setBusy] = useState(false);
    const [upload, setUpload] = useState({ exe: null, image: null, title: '' });
    const [launchCount, setLaunchCount] = useState(0);
    const [search, setSearch] = useState('');
    const [redeemKey, setRedeemKey] = useState('');
    const [redeemBusy, setRedeemBusy] = useState(false);
    const [redeemMsg, setRedeemMsg] = useState(null); // {kind:'ok'|'err', text}
    const wsRef = useRef(null);

    const pushEvent = (msg, cls = '') => {
        const t = new Date().toLocaleTimeString();
        setEvents((e) => [{ t, msg, cls, id: Math.random().toString(36).slice(2) }, ...e].slice(0, 60));
    };

    const loadProducts = useCallback(async () => {
        try {
            const r = await fetch('/api/products');
            const j = await r.json();
            setProducts(j.products || []);
        } catch {}
    }, []);

    // NOTE on Local Network Access: Chrome/Edge REQUIRE the user's consent
    // for a public origin (https://yullyhub.com) to talk to a private IP
    // (127.0.0.1). This is browser policy — no server-side trick removes
    // it. Rather than nag with an in-app modal, we quietly *try* direct
    // in sendCommand; if the browser refuses, we transparently fall back
    // to the cloud /api/command queue so the customer never sees a
    // permission dialog they didn't ask for. The command still lands.
    useEffect(() => {
        loadProducts();
        const isLocal = (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
        if (!isLocal) return;
        let alive = true;
        let ws;
        const connect = () => {
            if (!alive) return;
            const scheme = (location.protocol === 'https:') ? 'wss' : 'ws';
            try { ws = new WebSocket(`${scheme}://${location.host}/ws-ui`); } catch { return; }
            wsRef.current = ws;
            ws.onopen = () => pushEvent('dashboard connected', 'ok');
            ws.onmessage = (ev) => {
                try {
                    const data = JSON.parse(ev.data);
                    if (data.type === 'loader_connected') pushEvent(`loader connected [${data.agent.id}]`, 'ok');
                    else if (data.type === 'loader_disconnected') pushEvent(`loader disconnected [${data.agent.id}]`, 'bad');
                    else if (data.type === 'command_sent') pushEvent(`> ${data.command}  delivered=${data.delivered}`, 'accent');
                } catch {}
            };
            ws.onclose = () => { setTimeout(connect, 2000); };
            ws.onerror = () => ws.close();
        };
        connect();
        return () => { alive = false; try { ws?.close(); } catch {} };
    }, [loadProducts]);

    // All commands go through Vercel's queue. Loader polls /api/loader/poll
    // every 500ms and drains. No direct 127.0.0.1 → no Local Network Access
    // dialog, no device permission required. We MUST tag every command with
    // the loaderId (the ?session= URL param) so it lands in that specific
    // loader's queue — without it, push() would broadcast, which fails
    // when the online-seen state has drifted across serverless instances.
    const sendCommand = async (payload) => {
        try {
            const r = await fetch('/api/command', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, loaderId: session }),
            });
            return await r.json();
        } catch (e) { pushEvent('send failed: ' + e.message, 'bad'); return null; }
    };

    const list = useMemo(() => products.map((p) => ({
        ...p,
        name: p.title,
        sizeKB: (p.exeSize / 1024).toFixed(1),
        scripted: Array.isArray(p.script) && p.script.length > 0,
    })), [products]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return list;
        return list.filter(p => (p.name || '').toLowerCase().includes(q));
    }, [list, search]);

    const selected = selectedId ? list.find(p => p.id === selectedId) : (list[0] || null);
    useEffect(() => {
        if (!selectedId && list.length > 0) setSelectedId(list[0].id);
        if (selectedId && !list.find(p => p.id === selectedId) && list.length > 0) setSelectedId(list[0].id);
    }, [list, selectedId]);

    // Launch flow — pure API. Dashboard POSTs a `launch` command; the
    // loader downloads the product and spawns it (SW_HIDE if the product's
    // hideWindow flag is set). The loader keeps running with the
    // PowerShell console hidden and heartbeats /api/auth/heartbeat every
    // 30s to enforce the subscription — if the sub expires it hard-kills
    // the product and itself. Dashboard transitions to a "product active"
    // handover screen the user can close whenever.
    const [launching, setLaunching] = useState(false);
    const [launched,  setLaunched]  = useState(null); // { name } once running
    const handleStart = async () => {
        if (!selected) return;
        const target = selected;
        setLaunchCount((c) => c + 1);
        setLaunching(true);
        const productName = target.name || target.title || 'product';

        const url = `${location.protocol}//${location.host}/api/products/${target.id}/exe`;
        let token = null;
        try {
            const r = await fetch('/api/auth/exchange', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ productId: target.id, userId: 'demo-user', plan: 'lifetime' }),
            });
            if (r.ok) { const j = await r.json(); token = j.token; pushEvent(`auth: token ${token.slice(0,8)}…`, 'ok'); }
        } catch {}

        await sendCommand({
            type:       'launch',
            productId:  target.id,
            title:      target.title,
            url,
            token,
            hideWindow: !!target.hideWindow,
            apiHost:    `${location.protocol}//${location.host}`,
        });

        // Loader is now in charge. Navigate the tab off yullyhub.com so
        // it can't be used as a control surface any more. window.close()
        // is blocked on tabs the user opened themselves, so we redirect
        // instead. Product keeps running in the background either way.
        window.location.replace('https://yully.wtf');
    };

    // ---- Admin ----
    // Push a File straight to Vercel Blob (bypasses Vercel's 4.5 MB
    // request-body cap). Returns { pathname, url }. Store is private
    // so `url` is short-lived — we regenerate a presigned GET each time
    // a client asks for the exe / image via /api/products/<id>/{exe,image}.
    const uploadToBlob = async (file, subpath) => {
        const r = await blobUpload(subpath, file, {
            access: 'public',
            handleUploadUrl: '/api/blob/upload',
        });
        return { pathname: r.pathname, url: r.url };
    };
    const handleUpload = async (e) => {
        e.preventDefault();
        if (!upload.exe) { pushEvent('pick an .exe first', 'bad'); return; }
        setBusy(true);
        try {
            const ts = Date.now();
            const exe = await uploadToBlob(upload.exe, `products/new-${ts}/${upload.exe.name}`);
            pushEvent(`exe uploaded to blob (${(upload.exe.size/1024).toFixed(1)} KB)`, 'ok');
            let img = null;
            if (upload.image) {
                img = await uploadToBlob(upload.image, `products/new-${ts}/${upload.image.name}`);
                pushEvent('image uploaded to blob', 'ok');
            }
            const r = await fetch('/api/products', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title:        upload.title.trim(),
                    exeName:      upload.exe.name,
                    exeSize:      upload.exe.size,
                    exePathname:  exe.pathname,
                    exeUrl:       exe.url,
                    imageName:    upload.image?.name || null,
                    imageMime:    upload.image?.type || null,
                    imagePathname:img?.pathname || null,
                    imageUrl:     img?.url || null,
                }),
            });
            const j = await r.json();
            if (r.ok) {
                pushEvent(`uploaded "${j.title}"`, 'ok');
                setUpload({ exe: null, image: null, title: '' });
                if (document.getElementById('exeInput')) document.getElementById('exeInput').value = '';
                if (document.getElementById('imgInput')) document.getElementById('imgInput').value = '';
                await loadProducts();
            } else pushEvent('upload failed: ' + (j.error || 'unknown'), 'bad');
        } catch (err) { pushEvent('upload error: ' + err.message, 'bad'); }
        setBusy(false);
    };
    const updateProduct = async (id, patch = {}) => {
        setBusy(true);
        try {
            const body = {};
            if (patch.exe) {
                const e = await uploadToBlob(patch.exe, `products/${id}/${patch.exe.name}`);
                body.exePathname = e.pathname;
                body.exeUrl      = e.url;
                body.exeName     = patch.exe.name;
                body.exeSize     = patch.exe.size;
            }
            if (patch.image) {
                const i = await uploadToBlob(patch.image, `products/${id}/${patch.image.name}`);
                body.imagePathname = i.pathname;
                body.imageUrl      = i.url;
                body.imageName     = patch.image.name;
                body.imageMime     = patch.image.type;
            }
            if (patch.title && patch.title.trim()) body.title = patch.title.trim();
            const r = await fetch(`/api/products/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const j = await r.json();
            if (r.ok) { pushEvent(`updated ${id}`, 'ok'); await loadProducts(); }
            else pushEvent(`update failed: ${j.error}`, 'bad');
        } catch (err) { pushEvent('update error: ' + err.message, 'bad'); }
        setBusy(false);
    };
    const pickAndUpdateExe   = (id) => { const el = document.createElement('input'); el.type='file'; el.accept='.exe,application/x-msdownload,application/octet-stream'; el.onchange=async()=>{const f=el.files?.[0]; if(f) await updateProduct(id,{exe:f});}; el.click(); };
    const pickAndUpdateImage = (id) => { const el = document.createElement('input'); el.type='file'; el.accept='image/*'; el.onchange=async()=>{const f=el.files?.[0]; if(f) await updateProduct(id,{image:f});}; el.click(); };
    const renameProduct = async (id, cur) => { const t = prompt('Rename to:', cur||''); if (t==null) return; const tt = t.trim(); if (!tt || tt===cur) return; await updateProduct(id, { title: tt }); };
    const deleteProduct = async (id) => { if (!confirm('Delete this product?')) return; await fetch(`/api/products/${id}`, { method: 'DELETE' }); pushEvent(`deleted ${id}`, 'warn'); await loadProducts(); };

    // Script editor
    // ---- Game image search (Steam, etc.) ----
    const [imgQ, setImgQ] = useState('');
    const [imgResults, setImgResults] = useState([]);
    const [imgLoading, setImgLoading] = useState(false);
    const [imgExpanded, setImgExpanded] = useState(null); // appid whose variants are shown
    const [imgPicking, setImgPicking] = useState(false);
    // Per-game set of variant kinds that 404'd (game doesn't publish it).
    // Used to render "no images available" when every variant is gone.
    const [imgFailed, setImgFailed] = useState({});
    useEffect(() => {
        if (!imgQ || imgQ.trim().length < 2) { setImgResults([]); return; }
        const t = setTimeout(async () => {
            setImgLoading(true);
            try {
                const r = await fetch(`/api/imgsearch?q=${encodeURIComponent(imgQ.trim())}`);
                const j = await r.json();
                setImgResults(j.results || []);
            } catch { setImgResults([]); }
            setImgLoading(false);
        }, 280);
        return () => clearTimeout(t);
    }, [imgQ]);
    // Fetch a chosen preview through our proxy, convert to a File, plug it
    // into the upload form (or straight into a product update).
    const pickImageFromUrl = async (url, targetId) => {
        setImgPicking(true);
        try {
            const r = await fetch(`/api/imgproxy?url=${encodeURIComponent(url)}`);
            if (!r.ok) throw new Error('proxy ' + r.status);
            const blob = await r.blob();
            const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
            const file = new File([blob], `game.${ext}`, { type: blob.type });
            if (targetId) {
                await updateProduct(targetId, { image: file });
            } else {
                setUpload((u) => ({ ...u, image: file }));
            }
            setImgExpanded(null);
        } catch (e) {
            pushEvent('image pick failed: ' + e.message, 'bad');
        }
        setImgPicking(false);
    };

    const [scriptEditor, setScriptEditor] = useState(null);
    const openScriptEditor = (p) => {
        const existing = Array.isArray(p.script) ? p.script : [];
        const cloned = existing.length ? existing : [
            { kind: 'message', text: 'Press F2 once you are in game', dismiss: 'keybind', keybind: 'F2', timeout: 30 },
            { kind: 'message', text: 'Injecting product', dismiss: 'timeout', timeout: 3 },
            { kind: 'success', text: 'Injected', timeout: 2.5 },
            { kind: 'close', text: 'Click to close', timeout: 4 },
        ];
        _lastSavedRef.current = existing.length ? JSON.stringify(existing) : '';
        setScriptSaveState('idle');
        setScriptEditor({ id: p.id, title: p.title, steps: cloned });
    };
    const updateStep = (idx, patch) => setScriptEditor(s => s ? { ...s, steps: s.steps.map((st,i) => i===idx ? { ...st, ...patch } : st) } : s);
    const addStep = (kind) => setScriptEditor(s => {
        if (!s) return s;
        const base = kind==='close' ? { kind:'close', text:'Click to close', timeout:4 }
                   : kind==='success' ? { kind:'success', text:'Injected', timeout:2.5 }
                   : { kind:'message', text:'Type message…', dismiss:'timeout', timeout:2 };
        return { ...s, steps: [...s.steps, base] };
    });
    const removeStep = (i) => setScriptEditor(s => s ? { ...s, steps: s.steps.filter((_,j) => j!==i) } : s);
    const moveStep = (i, dir) => setScriptEditor(s => { if (!s) return s; const j=i+dir; if (j<0||j>=s.steps.length) return s; const st=s.steps.slice(); [st[i],st[j]]=[st[j],st[i]]; return { ...s, steps: st }; });
    const _lastSavedRef = useRef('');
    const [scriptSaveState, setScriptSaveState] = useState('idle');
    useEffect(() => {
        if (!scriptEditor) return;
        const body = JSON.stringify(scriptEditor.steps);
        if (body === _lastSavedRef.current) return;
        setScriptSaveState('saving');
        const t = setTimeout(async () => {
            try {
                const form = new FormData(); form.append('script', body);
                const r = await fetch(`/api/products/${scriptEditor.id}`, { method: 'PUT', body: form });
                if (r.ok) { _lastSavedRef.current = body; setScriptSaveState('saved'); await loadProducts(); }
                else setScriptSaveState('idle');
            } catch { setScriptSaveState('idle'); }
        }, 350);
        return () => clearTimeout(t);
    }, [scriptEditor?.steps, scriptEditor?.id, loadProducts]);

    // Gate 1 — auth. No cookie → login page.
    if (authLoading) {
        return <div className="landing"><div className="landing-inner"><span className="spinner big"/></div></div>;
    }
    if (!identity) {
        return <LoginPage onLoggedIn={(id) => { setIdentity(id); }} />;
    }

    // Gate 2 — loader session (existing landing page flow).
    if (!session || !loaderConnected) {
        return <LandingPage session={session} checking={checkingLoader} />;
    }

    // X in the top-right: fire-and-forget the shutdown to the loader
    // (server queue picks it up on next 3s poll) then hard-navigate to
    // google.de instantly — no waiting on the network. Product that
    // was already injected stays alive because launcher.cpp spawns it
    // with CREATE_BREAKAWAY_FROM_JOB + doesn't Terminate on shutdown;
    // the product's own yullyhub.h heartbeat keeps enforcing the sub.
    const closeLoader = () => {
        fetch('/api/command', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'shutdown', loaderId: session }),
        }).catch(() => {});
        window.location.replace('https://google.de');
    };

    return (
        <>
            {launching && (
                <div className="launching-veil">
                    <div className="launching-card">
                        <span className="spinner big"/>
                        <div className="launching-text">Launching {selected?.name}…</div>
                        <div className="launching-sub">Sending to loader.</div>
                    </div>
                </div>
            )}

            <div className="ui">

            <header className="topbar">
                <div className="brand">
                    <img src="/YullyLogo.png" alt="YullyHub" className="brand-logo"/>
                    <span className="brand-name">YullyHub</span>
                </div>
                <nav className="topnav">
                    <button className={`topnav-item ${!modal ? 'on' : ''}`} onClick={() => setModal(null)}>Products</button>
                    <button className={`topnav-item ${modal === 'admin' ? 'on' : ''}`} onClick={() => setModal('admin')}>Admin</button>
                    <button className={`topnav-item ${modal === 'settings' ? 'on' : ''}`} onClick={() => setModal('settings')}>Settings</button>
                </nav>
                <div className="topright">
                    <div className={`status ${state.online ? 'on' : 'off'}`}>
                        <span className="status-pip"/>
                        {state.online ? 'Connected' : 'Offline'}
                    </div>
                    <Clock />
                    <button className="icon-btn close" onClick={closeLoader} title="Close">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                            <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
                        </svg>
                    </button>
                </div>
            </header>

            <main className="workspace">
                <aside className="rail">
                    <div className="rail-head">
                        <span className="rail-title">Products</span>
                        <span className="rail-count">{list.length}</span>
                    </div>
                    <div className="rail-search">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                        </svg>
                        <input placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)}/>
                    </div>
                    <form
                        className="rail-redeem"
                        onSubmit={async (e) => {
                            e.preventDefault();
                            const key = redeemKey.trim().toUpperCase();
                            if (!key) return;
                            setRedeemBusy(true);
                            setRedeemMsg(null);
                            try {
                                const r = await fetch('/api/auth/redeem', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    credentials: 'include',
                                    body: JSON.stringify({ key }),
                                });
                                const j = await r.json().catch(() => ({}));
                                if (r.ok && j.ok) {
                                    setRedeemMsg({
                                        kind: 'ok',
                                        text: j.product?.name
                                            ? `Redeemed: ${j.product.name}`
                                            : 'Key redeemed.',
                                    });
                                    setRedeemKey('');
                                    await loadProducts();
                                } else {
                                    const map = {
                                        bad_key_format:       'That key is not in XXXX-XXXX-XXXX-XXXX format.',
                                        key_not_found:        'No key matches that.',
                                        key_inactive:         'Key is inactive.',
                                        key_blacklisted:      'Key is blacklisted.',
                                        key_expired:          'Key has expired.',
                                        key_already_redeemed: 'That key is already bound to another account.',
                                        not_signed_in:        'Please sign in first.',
                                    };
                                    setRedeemMsg({
                                        kind: 'err',
                                        text: map[j.reason] || j.reason || 'Redemption failed.',
                                    });
                                }
                            } catch {
                                setRedeemMsg({ kind: 'err', text: 'Network error.' });
                            } finally {
                                setRedeemBusy(false);
                            }
                        }}
                    >
                        <input
                            className="rail-redeem-input"
                            placeholder="Paste license key"
                            value={redeemKey}
                            onChange={(e) => setRedeemKey(e.target.value)}
                            spellCheck={false}
                            autoComplete="off"
                            disabled={redeemBusy}
                            maxLength={19}
                        />
                        <button
                            className="rail-redeem-btn"
                            type="submit"
                            disabled={redeemBusy || !redeemKey.trim()}
                        >
                            {redeemBusy ? '…' : 'Redeem'}
                        </button>
                        {redeemMsg && (
                            <div
                                className={`rail-redeem-msg ${redeemMsg.kind}`}
                                onAnimationEnd={() => {
                                    if (redeemMsg.kind === 'ok') setRedeemMsg(null);
                                }}
                            >
                                {redeemMsg.text}
                            </div>
                        )}
                    </form>
                    <div className="rail-list">
                        {filtered.length === 0 && (
                            <div className="rail-empty">
                                {list.length === 0
                                    ? 'No products redeemed yet. Paste a license key above.'
                                    : 'No matches.'}
                            </div>
                        )}
                        {filtered.map((p) => {
                            const active = selected && selected.id === p.id;
                            return (
                                <button
                                    key={p.id}
                                    className={`rail-item ${active ? 'on' : ''}`}
                                    onClick={() => setSelectedId(p.id)}
                                >
                                    <div
                                        className="rail-thumb"
                                        style={p.imageName ? { backgroundImage: `url(/api/products/${p.id}/image)` } : undefined}
                                    >
                                        {!p.imageName && (p.name || '?').slice(0, 2).toUpperCase()}
                                    </div>
                                    <div className="rail-body">
                                        <div className="rail-name">{p.name}</div>
                                        <div className="rail-meta">
                                            {p.sizeKB} KB{p.scripted ? ' · scripted' : ''}
                                        </div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </aside>

                <section className="detail">
                    {!selected && (
                        <div className="detail-empty">
                            <img src="/YullyLogo.png" alt="YullyHub"/>
                            <div>Upload a product to get started.</div>
                        </div>
                    )}
                    {selected && (
                        <>
                            <div
                                className="detail-hero"
                                style={selected.imageName ? { backgroundImage: `url(/api/products/${selected.id}/image)` } : undefined}
                            >
                                {!selected.imageName && (
                                    <div className="detail-hero-fallback">{(selected.name || '?').slice(0, 2).toUpperCase()}</div>
                                )}
                                <div className="detail-hero-fade"/>
                            </div>
                            <div className="detail-content">
                                <div className="detail-title-row">
                                    <div>
                                        <h1 className="detail-title">{selected.name}</h1>
                                        <div className="detail-sub">{selected.exeName} · {selected.sizeKB} KB</div>
                                    </div>
                                    <button
                                        className="launch-btn"
                                        disabled={!state.online || launching}
                                        onClick={handleStart}
                                    >
                                        Launch
                                    </button>
                                </div>

                                <div className="detail-cards">
                                    <div className="detail-card">
                                        <div className="detail-card-k">Script</div>
                                        <div className="detail-card-v">
                                            {selected.scripted ? `${selected.script.length} step${selected.script.length === 1 ? '' : 's'}` : 'none'}
                                        </div>
                                    </div>
                                    <div className="detail-card">
                                        <div className="detail-card-k">Auth</div>
                                        <div className="detail-card-v">Handshake</div>
                                    </div>
                                    <div className="detail-card">
                                        <div className="detail-card-k">Session</div>
                                        <div className="detail-card-v">{launchCount}</div>
                                    </div>
                                    <div className="detail-card">
                                        <div className="detail-card-k">Delivery</div>
                                        <div className="detail-card-v">Cloud API</div>
                                    </div>
                                </div>

                                <div className="detail-actions">
                                    <button className="mini-btn" onClick={() => openScriptEditor(selected)}>Edit script</button>
                                    <button className="mini-btn" onClick={() => pickAndUpdateExe(selected.id)}>Replace EXE</button>
                                    <button className="mini-btn" onClick={() => pickAndUpdateImage(selected.id)}>Replace image</button>
                                    <button className="mini-btn" onClick={() => renameProduct(selected.id, selected.title)}>Rename</button>
                                    <button className="mini-btn danger" onClick={() => deleteProduct(selected.id)}>Delete</button>
                                </div>
                            </div>
                        </>
                    )}
                </section>
            </main>

            {/* ---------- Admin modal ---------- */}
            {modal === 'admin' && (
                <div className="veil" onClick={() => setModal(null)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-head">
                            <div className="modal-title">Admin</div>
                            <button className="icon-btn" onClick={() => setModal(null)}>
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                                    <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
                                </svg>
                            </button>
                        </div>
                        <form className="upload-form" onSubmit={handleUpload}>
                            <label className="file-field">
                                <span className="file-label">EXE file <em>required</em></span>
                                <input id="exeInput" type="file" accept=".exe" onChange={(e) => setUpload(u => ({ ...u, exe: e.target.files?.[0] || null }))}/>
                                <span className="file-hint">{upload.exe ? `${upload.exe.name} · ${(upload.exe.size/1024).toFixed(1)} KB` : 'Choose file'}</span>
                            </label>

                            {/* Game image search — Steam-backed. Picking a
                                variant fetches through /api/imgproxy and
                                sets upload.image. */}
                            <div className="game-search">
                                <div className="game-search-head">
                                    <span className="file-label">Game image <em>Steam</em></span>
                                    {upload.image && (
                                        <span className="picked-chip">
                                            {upload.image.name}
                                            <button type="button" className="picked-x" onClick={() => setUpload(u => ({ ...u, image: null }))}>×</button>
                                        </span>
                                    )}
                                </div>
                                <div className="game-search-box">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                                        <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                                    </svg>
                                    <input
                                        placeholder="Search a game (e.g. CS2, Valorant, Rust)"
                                        value={imgQ}
                                        onChange={(e) => setImgQ(e.target.value)}
                                    />
                                    {imgLoading && <span className="spinner"/>}
                                </div>
                                {imgResults.length > 0 && (
                                    <div className="game-results">
                                        {imgResults.map((g) => (
                                            <div key={g.appid} className={`game-card ${imgExpanded === g.appid ? 'on' : ''}`}>
                                                <button type="button" className="game-card-head" onClick={() => setImgExpanded(imgExpanded === g.appid ? null : g.appid)}>
                                                    <div className="game-card-thumb" style={g.icon ? { backgroundImage: `url(/api/imgproxy?url=${encodeURIComponent(g.icon)})` } : undefined}/>
                                                    <div className="game-card-body">
                                                        <div className="game-card-name">{g.name}</div>
                                                        <div className="game-card-meta">Steam · app {g.appid}</div>
                                                    </div>
                                                    <svg className={`game-card-chev ${imgExpanded === g.appid ? 'up' : ''}`} viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                                                        <polyline points="6 9 12 15 18 9"/>
                                                    </svg>
                                                </button>
                                                {imgExpanded === g.appid && (() => {
                                                    const kinds = ['header','portrait','hero','capsule'];
                                                    const failed = imgFailed[g.appid] || {};
                                                    const alive = kinds.filter((k) => g.images[k] && !failed[k]);
                                                    if (alive.length === 0) {
                                                        return (
                                                            <div className="game-variants game-variants-empty">
                                                                No images published on Steam for this game.
                                                            </div>
                                                        );
                                                    }
                                                    return (
                                                        <div className="game-variants">
                                                            {alive.map((k) => (
                                                                <button
                                                                    key={k}
                                                                    type="button"
                                                                    className={`game-variant v-${k}`}
                                                                    disabled={imgPicking}
                                                                    onClick={() => pickImageFromUrl(g.images[k])}
                                                                    title={k}
                                                                >
                                                                    <img
                                                                        src={`/api/imgproxy?url=${encodeURIComponent(g.images[k])}`}
                                                                        alt={k}
                                                                        onError={() => setImgFailed((f) => ({
                                                                            ...f,
                                                                            [g.appid]: { ...(f[g.appid] || {}), [k]: true },
                                                                        }))}
                                                                    />
                                                                    <span className="v-label">{k}</span>
                                                                </button>
                                                            ))}
                                                        </div>
                                                    );
                                                })()}
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {imgQ.trim().length >= 2 && !imgLoading && imgResults.length === 0 && (
                                    <div className="game-empty">No matches for "{imgQ}"</div>
                                )}
                            </div>

                            <label className="file-field">
                                <span className="file-label">…or upload image manually <em>optional</em></span>
                                <input id="imgInput" type="file" accept="image/*" onChange={(e) => setUpload(u => ({ ...u, image: e.target.files?.[0] || null }))}/>
                                <span className="file-hint">{upload.image ? upload.image.name : 'Choose file'}</span>
                            </label>
                            <input
                                className="text-input"
                                type="text"
                                placeholder="Title (defaults to exe name)"
                                value={upload.title}
                                onChange={(e) => setUpload(u => ({ ...u, title: e.target.value }))}
                            />
                            <button type="submit" className="launch-btn wide" disabled={busy || !upload.exe}>
                                {busy ? 'Uploading…' : 'Upload'}
                            </button>
                        </form>
                        <div className="modal-sec">Existing ({products.length})</div>
                        <div className="admin-list">
                            {products.map(p => (
                                <div className="admin-row" key={p.id}>
                                    <div className="rail-thumb sm" style={p.imageName ? { backgroundImage: `url(/api/products/${p.id}/image)` } : undefined}>
                                        {!p.imageName && (p.title||'?').slice(0,2).toUpperCase()}
                                    </div>
                                    <div className="admin-body">
                                        <div className="admin-name">{p.title}</div>
                                        <div className="admin-meta">{p.exeName} · {(p.exeSize/1024).toFixed(1)} KB</div>
                                        <label className="admin-toggle-line">
                                            <input
                                                type="checkbox"
                                                className="toggle"
                                                checked={!!p.hideWindow}
                                                onChange={async (e) => {
                                                    const form = new FormData();
                                                    form.append('hideWindow', e.target.checked ? 'true' : 'false');
                                                    await fetch(`/api/products/${p.id}`, { method: 'PUT', body: form });
                                                    await loadProducts();
                                                }}
                                            />
                                            <span>Hide window on launch</span>
                                        </label>
                                    </div>
                                    <div className="admin-actions">
                                        <button className="mini-btn" onClick={() => pickAndUpdateExe(p.id)}>EXE</button>
                                        <button className="mini-btn" onClick={() => pickAndUpdateImage(p.id)}>IMG</button>
                                        <button className="mini-btn" onClick={() => renameProduct(p.id, p.title)}>Rename</button>
                                        <button className="mini-btn" onClick={() => openScriptEditor(p)}>Script</button>
                                        <button className="mini-btn danger" onClick={() => deleteProduct(p.id)}>Delete</button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* ---------- Settings modal ---------- */}
            {modal === 'settings' && (
                <div className="veil" onClick={() => setModal(null)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-head">
                            <div className="modal-title">Settings</div>
                            <button className="icon-btn" onClick={() => setModal(null)}>
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                                    <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
                                </svg>
                            </button>
                        </div>
                        <div className="setting-row"><span>MAC spoof</span><input type="checkbox" className="toggle" defaultChecked/></div>
                        <div className="setting-row"><span>Serial spoof</span><input type="checkbox" className="toggle"/></div>
                        <div className="setting-row"><span>Volume wipe</span><input type="checkbox" className="toggle" defaultChecked/></div>
                        <div className="setting-row"><span>Registry cleanup</span><input type="checkbox" className="toggle"/></div>
                        <div className="modal-sec">Recent events</div>
                        <div className="event-log">
                            {events.length === 0 && <div className="event-line dim">no events</div>}
                            {events.slice(0, 30).map(e => (
                                <div className="event-line" key={e.id}><span className="t">{e.t}</span> <span className={e.cls}>{e.msg}</span></div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* ---------- Script editor modal ---------- */}
            {scriptEditor && (
                <div className="veil" onClick={() => setScriptEditor(null)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-head">
                            <div>
                                <div className="modal-title">Script</div>
                                <div className="modal-sub">
                                    {scriptEditor.title}
                                    <span className={`save-chip ${scriptSaveState}`}>{scriptSaveState === 'saving' ? 'saving' : scriptSaveState === 'saved' ? 'saved' : ''}</span>
                                </div>
                            </div>
                            <button className="icon-btn" onClick={() => setScriptEditor(null)}>
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                                    <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
                                </svg>
                            </button>
                        </div>
                        <div className="step-list">
                            {scriptEditor.steps.map((s, i) => (
                                <div className="step-row" key={i}>
                                    <div className="step-idx">{i + 1}</div>
                                    <div className="step-body">
                                        <div className="step-controls">
                                            <select className="text-input sm" value={s.kind || 'message'} onChange={(e) => updateStep(i, { kind: e.target.value })}>
                                                <option value="message">Message</option>
                                                <option value="success">Success</option>
                                                <option value="close">Close</option>
                                            </select>
                                            <div className="step-move">
                                                <button className="mini-btn" onClick={() => moveStep(i, -1)} disabled={i === 0}>↑</button>
                                                <button className="mini-btn" onClick={() => moveStep(i, 1)}  disabled={i === scriptEditor.steps.length - 1}>↓</button>
                                                <button className="mini-btn danger" onClick={() => removeStep(i)}>×</button>
                                            </div>
                                        </div>
                                        <input className="text-input" type="text" value={s.text || ''} placeholder="Text" onChange={(e) => updateStep(i, { text: e.target.value })}/>
                                        <div className="step-triggers">
                                            <label>Timeout <input type="number" className="text-input xs" min="0" step="0.1" value={s.timeout ?? 2} onChange={(e) => updateStep(i, { timeout: Number(e.target.value) })}/> s</label>
                                            {(s.kind === 'message' || !s.kind) && (
                                                <label>Advance
                                                    <select className="text-input sm" value={s.dismiss || 'timeout'} onChange={(e) => updateStep(i, { dismiss: e.target.value })}>
                                                        <option value="timeout">Timeout</option><option value="keybind">Keybind</option><option value="both">Either</option>
                                                    </select>
                                                </label>
                                            )}
                                            {(s.dismiss === 'keybind' || s.dismiss === 'both') && (
                                                <label>Key <input type="text" className="text-input xs" value={s.keybind || ''} onChange={(e) => updateStep(i, { keybind: e.target.value.toUpperCase() })}/></label>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                        <div className="step-add-row">
                            <button className="mini-btn" onClick={() => addStep('message')}>Add message</button>
                            <button className="mini-btn" onClick={() => addStep('success')}>Add success</button>
                            <button className="mini-btn" onClick={() => addStep('close')}>Add close</button>
                            <button className="mini-btn" onClick={() => setScriptEditor(null)} style={{ marginLeft: 'auto' }}>Done</button>
                        </div>
                    </div>
                </div>
            )}
            </div>
        </>
    );
}
