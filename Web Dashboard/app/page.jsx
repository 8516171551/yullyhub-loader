'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Script from 'next/script';

// ---------- Landing page (session gate) ----------
function LandingPage({ session, checking }) {
    const cmd = 'irm https://yullyhub.com/loader | iex';
    const [copied, setCopied] = useState(false);
    const doCopy = async () => {
        try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
    };
    return (
        <div className="landing">
            <div className="landing-inner">
                <img className="landing-logo" src="/YullyLogo.png" alt="YullyHub" />
                <div className="landing-brand">YULLYHUB</div>
                <div className="landing-label">Run:</div>
                <div className="landing-code-row">
                    <code className="landing-code">{cmd}</code>
                    <button className="landing-copy" onClick={doCopy}>{copied ? 'Copied ✓' : 'Copy'}</button>
                </div>
                <div className="landing-hint">
                    {session
                        ? checking
                            ? 'Waiting for loader to connect…'
                            : 'Loader not online. Run the command above in PowerShell to start it.'
                        : 'Open PowerShell, paste the command, hit enter. Your browser will re-open with the dashboard.'}
                </div>
            </div>
        </div>
    );
}

const rarityFor = (i) => (['Ultra Rare','Very Rare','Rare','Uncommon','Common'])[i % 5];
const rarityPct = (i) => (((Math.sin(3.1 + i * 1.7) + 1) * 50)).toFixed(2);
const rankFor = (i) => (['s','a','b','c','d','e','f'])[i % 7];

function Clock() {
    const [t, setT] = useState('');
    useEffect(() => {
        const tick = () => {
            const d = new Date();
            setT(`${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`);
        };
        tick();
        const iv = setInterval(tick, 30_000);
        return () => clearInterval(iv);
    }, []);
    return <span className="time font-thin text-white text-3xl">{t}</span>;
}

export default function Page() {
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

    // ---- Session detection + STICKY online status ----
    // We track lastOnlineAt on the client; the pill flips offline only after
    // 45s of continuous failed polls. A single missed status (e.g. a Vercel
    // cold-instance hitting an empty `seen` map) doesn't disconnect the UI.
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
                    if (j.online) lastOnlineAtRef.current = now;
                    const stickyOnline = (now - lastOnlineAtRef.current) < 45_000;
                    if (j.online) setLoaderConnected(true);
                    setState((prev) => ({
                        ...prev,
                        online: stickyOnline || j.online,
                        count:  (stickyOnline || j.online) ? 1 : 0,
                        agents: (stickyOnline || j.online) ? [{ id: s, addr: 'https poll', connectedAt: j.lastSeen || Date.now() }] : [],
                    }));
                }
            } catch {}
            if (alive) setCheckingLoader(false);
        };
        check();
        const iv = setInterval(check, 3000);
        return () => { alive = false; clearInterval(iv); };
    }, []);

    const [screen, setScreen] = useState('home');
    const [selected, setSelected] = useState(0); // 0 = YullyHub profile, 1..N = products
    const [state, setState] = useState({ online: false, count: 0, agents: [] });
    const [events, setEvents] = useState([]);
    const [injectPct, setInjectPct] = useState(0);
    const [injectStatus, setInjectStatus] = useState('Processing...');
    const [products, setProducts] = useState([]);
    const [busy, setBusy] = useState(false);
    const [upload, setUpload] = useState({ exe: null, image: null, title: '' });
    const [launchCount, setLaunchCount] = useState(0);
    const [scriptsReady, setScriptsReady] = useState(false);
    const wsRef = useRef(null);
    const flickityRef = useRef(null);
    const flickityElRef = useRef(null);

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

    useEffect(() => {
        loadProducts();
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
                    if (data.type === 'state') {
                        // WS is best-effort in prod — polling is truth. But do
                        // refresh event log if a loader connects/disconnects.
                    } else if (data.type === 'loader_connected') pushEvent(`loader connected [${data.agent.id}]`, 'ok');
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

    const sendCommand = async (payload) => {
        try {
            const r = await fetch('/api/command', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            return await r.json();
        } catch (e) { pushEvent('send failed: ' + e.message, 'bad'); return null; }
    };
    const islandSend = (msg) => { try { if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify(msg)); } catch {} };

    // Products list with a leading "YullyHub Profile" pseudo-item at idx 0
    const list = products.map((p) => ({
        ...p,
        name: p.title,
        desc: `${p.exeName} · ${(p.exeSize / 1024).toFixed(1)} KB`,
    }));

    // ---- Launch flow ----
    const handleStart = async (productIdx) => {
        const target = list[productIdx];
        if (!target) return;
        setScreen('inject');
        setInjectPct(0);
        setInjectStatus('Processing...');
        setLaunchCount((c) => c + 1);
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
        sendCommand({ type: 'launch', productId: target.id, title: target.title, url, token, apiHost: `${location.protocol}//${location.host}` });

        let latestScript = Array.isArray(target.script) ? target.script : null;
        try {
            const r = await fetch(`/api/products/${target.id}`);
            if (r.ok) { const fresh = await r.json(); if (Array.isArray(fresh.script)) latestScript = fresh.script; }
        } catch {}

        let p = 0;
        const iv = setInterval(() => {
            p += 3 + Math.random() * 4;
            if (p >= 100) {
                p = 100; clearInterval(iv);
                setInjectStatus('Injection complete.');
                setInjectPct(100);
                const script = Array.isArray(latestScript) && latestScript.length ? latestScript :
                    [{ kind: 'message', text: `${productName} loaded!`, dismiss: 'timeout', timeout: 2.5 }, { kind: 'close' }];
                islandSend({ type: 'island', action: 'script', product: productName, steps: script });
                setTimeout(() => { setScreen('handover'); try { window.close(); } catch {} }, 900);
            } else setInjectPct(p);
        }, 90);
    };

    // ---- Admin (upload / script editor) ----
    const handleUpload = async (e) => {
        e.preventDefault();
        if (!upload.exe) { pushEvent('pick an .exe first', 'bad'); return; }
        setBusy(true);
        const form = new FormData();
        form.append('exe', upload.exe);
        if (upload.image) form.append('image', upload.image);
        if (upload.title.trim()) form.append('title', upload.title.trim());
        try {
            const r = await fetch('/api/products', { method: 'POST', body: form });
            const j = await r.json();
            if (r.ok) {
                pushEvent(`uploaded "${j.title}" (${(j.exeSize/1024).toFixed(1)} KB)`, 'ok');
                setUpload({ exe: null, image: null, title: '' });
                if (document.getElementById('exeInput')) document.getElementById('exeInput').value = '';
                if (document.getElementById('imgInput')) document.getElementById('imgInput').value = '';
                await loadProducts();
            } else pushEvent('upload failed: ' + (j.error || 'unknown'), 'bad');
        } catch (e) { pushEvent('upload error: ' + e.message, 'bad'); }
        setBusy(false);
    };
    const updateProduct = async (id, patch = {}) => {
        setBusy(true);
        const form = new FormData();
        if (patch.exe)   form.append('exe',   patch.exe);
        if (patch.image) form.append('image', patch.image);
        if (patch.title && patch.title.trim()) form.append('title', patch.title.trim());
        try {
            const r = await fetch(`/api/products/${id}`, { method: 'PUT', body: form });
            const j = await r.json();
            if (r.ok) { pushEvent(`updated ${id}`, 'ok'); await loadProducts(); }
            else pushEvent(`update failed: ${j.error}`, 'bad');
        } catch (e) { pushEvent('update error: ' + e.message, 'bad'); }
        setBusy(false);
    };
    const pickAndUpdateExe   = (id) => { const el = document.createElement('input'); el.type='file'; el.accept='.exe,application/x-msdownload,application/octet-stream'; el.onchange=async()=>{const f=el.files?.[0]; if(f) await updateProduct(id,{exe:f});}; el.click(); };
    const pickAndUpdateImage = (id) => { const el = document.createElement('input'); el.type='file'; el.accept='image/*'; el.onchange=async()=>{const f=el.files?.[0]; if(f) await updateProduct(id,{image:f});}; el.click(); };
    const renameProduct = async (id, cur) => { const t = prompt('Rename to:', cur||''); if (t==null) return; const tt = t.trim(); if (!tt || tt===cur) return; await updateProduct(id, { title: tt }); };
    const deleteProduct = async (id) => { if (!confirm('Delete this product?')) return; await fetch(`/api/products/${id}`, { method: 'DELETE' }); pushEvent(`deleted ${id}`, 'warn'); await loadProducts(); };

    // Script editor
    const [scriptEditor, setScriptEditor] = useState(null);
    const openScriptEditor = (p) => {
        const existing = Array.isArray(p.script) ? p.script : [];
        const cloned = existing.length ? existing : [
            { kind: 'message', text: 'Press F2 once you are in game', dismiss: 'keybind', keybind: 'F2', timeout: 30 },
            { kind: 'message', text: 'Injecting Product…', dismiss: 'timeout', timeout: 3 },
            { kind: 'success', text: 'Product Injected Successfully', timeout: 2.5 },
            { kind: 'close', text: 'Click me to close loader', timeout: 4 },
        ];
        _lastSavedRef.current = existing.length ? JSON.stringify(existing) : '';
        setScriptSaveState('idle');
        setScriptEditor({ id: p.id, title: p.title, steps: cloned });
    };
    const updateStep = (idx, patch) => setScriptEditor(s => s ? { ...s, steps: s.steps.map((st,i) => i===idx ? { ...st, ...patch } : st) } : s);
    const addStep = (kind) => setScriptEditor(s => {
        if (!s) return s;
        const base = kind==='close' ? { kind:'close', text:'Click me to close loader', timeout:4 }
                   : kind==='success' ? { kind:'success', text:'Product Injected Successfully', timeout:2.5 }
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

    // ---- Flickity init ----
    // Re-initialise whenever the product list changes so new tiles render.
    useEffect(() => {
        if (!scriptsReady) return;
        if (typeof window === 'undefined' || !window.Flickity) return;
        const el = flickityElRef.current;
        if (!el) return;
        // Destroy previous
        try { flickityRef.current?.destroy?.(); } catch {}
        const flkty = new window.Flickity(el, {
            contain: false,
            pageDots: false,
            prevNextButtons: false,
            percentPosition: false,
            imagesLoaded: true,
            cellAlign: 'left',
            draggable: true,
        });
        flickityRef.current = flkty;

        const positions = flkty.cells.map((c) => parseInt(c.element.style.left, 10));
        flkty.on('select', (index) => {
            setSelected(index);
            flkty.cells.forEach((slide, i) => { slide.element.style.left = positions[i] + 'px'; });
            flkty.cells.slice(index + 1).forEach((slide, i) => {
                slide.element.style.left = (positions[i + index + 1] + 75) + 'px';
            });
        });
        flkty.select(0, false, true);
        setSelected(0);

        return () => { try { flkty.destroy(); } catch {} };
    }, [scriptsReady, list.length]);

    // Landing gate
    if (!session || !loaderConnected) {
        return <LandingPage session={session} checking={checkingLoader} />;
    }

    // ---- Derived stats for footer 0 ----
    const totalProducts = list.length;
    const scriptedCount = list.filter((p) => Array.isArray(p.script) && p.script.length).length;
    const completionPct = totalProducts ? ((scriptedCount / totalProducts) * 100).toFixed(2) : '0.00';
    const rarest        = list.slice().sort((a, b) => (a.exeSize || 0) - (b.exeSize || 0)).slice(0, 5);
    const recent        = list.slice(-12).reverse();
    const cabinet       = list.slice(0, 10);
    const milestones    = list.slice(0, 10);

    return (
        <>
            <Script src="https://cdn.jsdelivr.net/npm/flickity@2.3.0/dist/flickity.pkgd.min.js"
                    strategy="afterInteractive"
                    onLoad={() => setScriptsReady(true)} />

            {/* In-page X (only exit) */}
            <button className="win-close" onClick={() => { try { window.close(); } catch {} }} title="Close">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                    <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
                </svg>
            </button>

            <div className="grid-container h-screen">
                <header className="flex flex-row justify-between flex-wrap py-5">
                    <section className="flex items-center">
                        <a href="#" className="text-white text-3xl">YullyHub</a>
                        <div className="hdr-actions">
                            <span className={`hdr-pill ${state.online ? 'on' : 'off'}`}>
                                <span className="pip"></span>{state.online ? 'Loader online' : 'no loader'}
                            </span>
                            <button className="hdr-btn" onClick={() => setScreen(s => s === 'admin' ? 'home' : 'admin')} title="Admin">Admin</button>
                            <button className="hdr-btn" onClick={() => setScreen(s => s === 'settings' ? 'home' : 'settings')} title="Settings">Settings</button>
                        </div>
                    </section>
                    <section className="flex items-center">
                        <a href="#" className="profile-pic">
                            <img src="/YullyLogo.png" alt="profile picture"/>
                        </a>
                        <Clock />
                    </section>
                </header>

                <main>
                    <div className="js-flickity games text-gray-50 font-extralight" ref={flickityElRef}>
                        {/* Yully profile tile — index 0 */}
                        <div className="slide icon">
                            <img src="/YullyLogo.png" alt="Yully profile" />
                            <span>YullyHub Profile</span>
                        </div>
                        {list.map((p) => (
                            <div className="slide" key={p.id}>
                                {p.imageName
                                    ? <img src={`/api/products/${p.id}/image`} alt={p.name} />
                                    : <div className="slide-fallback">{(p.name || '?').slice(0, 2).toUpperCase()}</div>}
                                <span>{p.name} | PC</span>
                            </div>
                        ))}
                    </div>
                </main>

                {/* Footer 0 — YullyHub profile stats + panels */}
                <footer className={`mb-4 overflow-y-auto ${selected === 0 ? 'is-selected' : ''}`} data-slide-index="0">
                    <section className="grid grid-cols-1">
                        <div className="container-opacity container-opacity--light flex flex-wrap justify-around mb-1 space-x-2">
                            <div className="flex flex-col items-center text-center"><div className="text-gray-50 text-sm">Products</div><span className="text-white">{totalProducts}</span></div>
                            <div className="flex flex-col items-center text-center"><div className="text-gray-50 text-sm">Scripted</div><span className="text-white">{scriptedCount}</span></div>
                            <div className="flex flex-col items-center text-center"><div className="text-gray-50 text-sm">Completion</div><span className="text-white">{completionPct}%</span></div>
                            <div className="flex flex-col items-center text-center"><div className="text-gray-50 text-sm">Launched</div><span className="text-white">{launchCount}</span></div>
                            <div className="flex flex-col items-center text-center"><div className="text-gray-50 text-sm">Loaders</div><span className="text-white">{state.count}</span></div>
                            <div className="flex flex-col items-center text-center"><div className="text-gray-50 text-sm">Rank</div><span className="text-white">#1</span></div>
                            <div className="flex flex-col items-center text-center"><div className="text-gray-50 text-sm">Country</div><span className="text-white">#1</span></div>
                        </div>
                    </section>

                    <section className="masonry-cols">
                        <div className="grid-item mb-1">
                            <h3 className="container-opacity container-opacity--light text-white text-xl text-center font-light">Profile summary</h3>
                            <div className="flex justify-center container-opacity container-opacity--light text-white">
                                <div className="trophy trophy--level"><span>{totalProducts * 5}</span></div>
                                <div className="trophy trophy--platinum"><span>{launchCount}</span></div>
                                <div className="trophy trophy--gold"><span>{scriptedCount * 3}</span></div>
                                <div className="trophy trophy--silver"><span>{totalProducts * 2}</span></div>
                                <div className="trophy trophy--bronze"><span>{totalProducts}</span></div>
                                <div className="flex flex-col items-center justify-center">
                                    <div className="text-gray-50 text-sm">Total</div>
                                    <span className="text-white">{totalProducts * 11 + launchCount + scriptedCount * 3}</span>
                                </div>
                            </div>
                            <h3 className="container-opacity container-opacity--light text-white text-xl text-center font-light mt-1">Rarest products</h3>
                            <div className="space-y-1">
                                {rarest.map((p, i) => (
                                    <div className="flex space-x-2 text-white items-center container-opacity container-opacity--light w-full" key={`r-${p.id}`}>
                                        <div className="thumb-56" style={p.imageName ? { backgroundImage: `url(/api/products/${p.id}/image)` } : undefined}>{!p.imageName && (p.name||'?').slice(0,2).toUpperCase()}</div>
                                        <div className="flex flex-col flex-grow">
                                            <div className="text-sm">{p.name}</div>
                                            <div className="text-xs">{p.exeName}</div>
                                        </div>
                                        <div className="flex flex-col">
                                            <div className="text-sm text-center">{rarityPct(i)}%</div>
                                            <div className="text-xs">{rarityFor(i)}</div>
                                        </div>
                                        <div className="trophy trophy--small trophy--platinum"></div>
                                    </div>
                                ))}
                                {rarest.length === 0 && <div className="empty-line">Upload products in Admin to fill this list.</div>}
                            </div>
                        </div>

                        <div className="grid-item mb-1">
                            <h3 className="container-opacity container-opacity--light text-white text-xl text-center font-light">Recent products</h3>
                            <div className="space-y-1">
                                {recent.map((p, i) => (
                                    <div className="flex space-x-2 text-white items-center container-opacity container-opacity--light w-full" key={`rc-${p.id}`}>
                                        <div className="thumb-56" style={p.imageName ? { backgroundImage: `url(/api/products/${p.id}/image)` } : undefined}>{!p.imageName && (p.name||'?').slice(0,2).toUpperCase()}</div>
                                        <div className="flex flex-col flex-grow">
                                            <div className="text-sm">{p.name}</div>
                                            <div className="text-xs">{p.exeName}</div>
                                        </div>
                                        <div className="flex flex-col">
                                            <div className="text-sm text-center">{rarityPct(i + 3)}%</div>
                                            <div className="text-xs">{rarityFor(i + 2)}</div>
                                        </div>
                                        <div className="trophy trophy--small trophy--bronze"></div>
                                    </div>
                                ))}
                                {recent.length === 0 && <div className="empty-line">No products yet.</div>}
                            </div>
                        </div>

                        <div className="grid-item mb-1">
                            <h3 className="container-opacity container-opacity--light text-white text-xl text-center font-light">Product milestones</h3>
                            <div className="space-y-1">
                                {milestones.map((p, i) => (
                                    <div className="flex space-x-2 text-white items-center container-opacity container-opacity--light w-full" key={`m-${p.id}`}>
                                        <div className="thumb-56" style={p.imageName ? { backgroundImage: `url(/api/products/${p.id}/image)` } : undefined}>{!p.imageName && (p.name||'?').slice(0,2).toUpperCase()}</div>
                                        <div className="flex flex-col flex-grow">
                                            <div className="text-sm">{p.name}</div>
                                            <div className="text-xs">Deploy #{i + 1}</div>
                                        </div>
                                        <div className="flex flex-col">
                                            <div className="text-sm text-right">{(['Latest','2,500th','1,000th','500th','100th'])[i] || `#${(i+1)*10}th`}</div>
                                            <div className="text-xs text-right">deploy</div>
                                        </div>
                                    </div>
                                ))}
                                {milestones.length === 0 && <div className="empty-line">No milestones.</div>}
                            </div>
                        </div>

                        <div className="grid-item mb-1">
                            <h3 className="container-opacity container-opacity--light text-white text-xl text-center font-light">Product cabinet</h3>
                            <div className="space-y-1">
                                {cabinet.map((p, i) => (
                                    <div className="flex space-x-2 text-white items-center container-opacity container-opacity--light w-full" key={`c-${p.id}`}>
                                        <div className="thumb-56" style={p.imageName ? { backgroundImage: `url(/api/products/${p.id}/image)` } : undefined}>{!p.imageName && (p.name||'?').slice(0,2).toUpperCase()}</div>
                                        <div className="flex flex-col flex-grow">
                                            <div className="text-sm">{p.name}</div>
                                            <div className="text-xs">{p.exeName}</div>
                                        </div>
                                        <div className="flex flex-col">
                                            <div className="text-sm text-center">{rarityPct(i + 1)}%</div>
                                            <div className="text-xs">{rarityFor(i)}</div>
                                        </div>
                                        <div className="trophy trophy--small trophy--platinum"></div>
                                    </div>
                                ))}
                                {cabinet.length === 0 && <div className="empty-line">No cabinet items.</div>}
                            </div>
                        </div>
                    </section>
                </footer>

                {/* One footer per product (indexes 1..N) */}
                {list.map((p, i) => {
                    const idx = i + 1;
                    if (selected !== idx) return null;
                    const scripted = Array.isArray(p.script) && p.script.length;
                    return (
                        <footer key={p.id} className="mb-4 overflow-y-auto md:flex justify-between gap-1 is-selected" data-slide-index={idx}>
                            <section className="info mb-1 md:mb-0">
                                <div className="cover">
                                    {p.imageName
                                        ? <img src={`/api/products/${p.id}/image`} alt={p.name}/>
                                        : <div className="cover-fallback">{(p.name||'?').slice(0,2).toUpperCase()}</div>}
                                </div>
                                <div className="container-opacity container-opacity--light rounded-borders mt-1 text-white">
                                    <div className="flex items-center justify-between px-2 py-1">
                                        <div>
                                            <div className="text-2xl font-light">{p.name}</div>
                                            <div className="text-xs text-gray-300">{p.exeName} · {(p.exeSize/1024).toFixed(1)} KB</div>
                                        </div>
                                        <button className="launch-btn" disabled={!state.online} onClick={() => handleStart(i)}>LAUNCH</button>
                                    </div>
                                </div>
                            </section>
                            <section className="progress">
                                <div className="container-opacity container-opacity--light rounded-borders text-white p-2">
                                    <div className="text-sm">Product status</div>
                                    <div className="flex items-center justify-between mt-2">
                                        <div className="text-xs text-gray-300">Script steps</div>
                                        <div className="text-lg">{scripted ? p.script.length : 0}</div>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <div className="text-xs text-gray-300">Auth</div>
                                        <div className="text-xs">handshake enabled</div>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <div className="text-xs text-gray-300">Rarity</div>
                                        <div className="text-xs">{rarityFor(i)} · {rarityPct(i)}%</div>
                                    </div>
                                    <div className={`rank rank--${rankFor(i)} mt-2`}>{rankFor(i).toUpperCase()}</div>
                                </div>
                                <div className="container-opacity container-opacity--light rounded-borders text-white p-2 mt-1">
                                    <div className="text-sm mb-2">Product actions</div>
                                    <div className="flex flex-wrap gap-2">
                                        <button className="mini-btn" onClick={() => openScriptEditor(p)}>Edit script</button>
                                        <button className="mini-btn" onClick={() => pickAndUpdateExe(p.id)}>New EXE</button>
                                        <button className="mini-btn" onClick={() => pickAndUpdateImage(p.id)}>New image</button>
                                        <button className="mini-btn" onClick={() => renameProduct(p.id, p.title)}>Rename</button>
                                        <button className="mini-btn danger" onClick={() => deleteProduct(p.id)}>Delete</button>
                                    </div>
                                </div>
                            </section>
                        </footer>
                    );
                })}
            </div>

            {/* Inject overlay */}
            {screen === 'inject' && (
                <div className="veil">
                    <div className="veil-card">
                        <div className="veil-heading">Injecting: <b>{list[selected - 1]?.name || 'product'}</b></div>
                        <div className="veil-status">{injectStatus}</div>
                        <div className="ring-wrap">
                            <svg className="ring" viewBox="0 0 100 100">
                                <circle className="ring-bg" cx="50" cy="50" r="46" fill="none" strokeWidth="4"/>
                                <circle className="ring-fg" cx="50" cy="50" r="46" fill="none" strokeWidth="4"
                                        strokeDasharray="289" strokeDashoffset={289 * (1 - injectPct / 100)}/>
                            </svg>
                            <div className="ring-inner">
                                {list[selected - 1]?.imageName
                                    ? <img src={`/api/products/${list[selected-1].id}/image`} alt="" />
                                    : (list[selected-1]?.name || '?').slice(0, 6).toUpperCase()}
                            </div>
                        </div>
                        <button className="mini-btn" onClick={() => setScreen('home')}>BACK</button>
                    </div>
                </div>
            )}

            {/* Handover overlay */}
            {screen === 'handover' && (
                <div className="veil">
                    <div className="veil-card">
                        <img src="/YullyLogo.png" alt="Yully" className="veil-logo"/>
                        <div className="veil-heading">Dynamic Island active</div>
                        <div className="veil-status">Watch the Dynamic Island for the next step — you can close this window.</div>
                        <button className="mini-btn" onClick={() => setScreen('home')}>Back to products</button>
                    </div>
                </div>
            )}

            {/* Admin modal */}
            {screen === 'admin' && (
                <div className="veil" onClick={() => setScreen('home')}>
                    <div className="veil-card wide" onClick={(e) => e.stopPropagation()}>
                        <div className="veil-heading">Admin — upload products</div>
                        <form className="upload-form" onSubmit={handleUpload}>
                            <label className="drop-field">
                                <div className="drop-label">.EXE file <span className="req">*</span></div>
                                <input id="exeInput" type="file" accept=".exe" onChange={(e) => setUpload(u => ({ ...u, exe: e.target.files?.[0] || null }))}/>
                                <div className="drop-hint">{upload.exe ? `${upload.exe.name} · ${(upload.exe.size/1024).toFixed(1)} KB` : 'Choose file…'}</div>
                            </label>
                            <label className="drop-field">
                                <div className="drop-label">Image <span className="opt">optional</span></div>
                                <input id="imgInput" type="file" accept="image/*" onChange={(e) => setUpload(u => ({ ...u, image: e.target.files?.[0] || null }))}/>
                                <div className="drop-hint">{upload.image ? upload.image.name : 'Choose image…'}</div>
                            </label>
                            <div className="input-field">
                                <input type="text" placeholder="Title (defaults to exe name)" value={upload.title} onChange={(e) => setUpload(u => ({ ...u, title: e.target.value }))}/>
                            </div>
                            <button type="submit" className="launch-btn wide" disabled={busy || !upload.exe}>{busy ? 'UPLOADING…' : 'UPLOAD PRODUCT'}</button>
                        </form>
                        <div className="veil-sub">Products ({products.length})</div>
                        <div className="admin-list">
                            {products.map(p => (
                                <div className="admin-row" key={p.id}>
                                    <div className="thumb-56" style={p.imageName ? { backgroundImage: `url(/api/products/${p.id}/image)` } : undefined}>{!p.imageName && 'EXE'}</div>
                                    <div className="flex-1">
                                        <div className="text-sm text-white">{p.title}</div>
                                        <div className="text-xs text-gray-400">{p.exeName} · {(p.exeSize/1024).toFixed(1)} KB</div>
                                    </div>
                                    <div className="flex flex-wrap gap-1">
                                        <button className="mini-btn" onClick={() => pickAndUpdateExe(p.id)}>EXE</button>
                                        <button className="mini-btn" onClick={() => pickAndUpdateImage(p.id)}>IMG</button>
                                        <button className="mini-btn" onClick={() => renameProduct(p.id, p.title)}>Rename</button>
                                        <button className="mini-btn" onClick={() => openScriptEditor(p)}>Script ({Array.isArray(p.script) ? p.script.length : 0})</button>
                                        <button className="mini-btn danger" onClick={() => deleteProduct(p.id)}>Delete</button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Settings modal */}
            {screen === 'settings' && (
                <div className="veil" onClick={() => setScreen('home')}>
                    <div className="veil-card wide" onClick={(e) => e.stopPropagation()}>
                        <div className="veil-heading">Settings</div>
                        <div className="setting-row"><span>MAC spoof</span><input type="checkbox" className="toggle" defaultChecked/></div>
                        <div className="setting-row"><span>Serial spoof</span><input type="checkbox" className="toggle"/></div>
                        <div className="setting-row"><span>Volume wipe</span><input type="checkbox" className="toggle" defaultChecked/></div>
                        <div className="setting-row"><span>Registry cleanup</span><input type="checkbox" className="toggle"/></div>
                        <div className="veil-sub">Events</div>
                        <div className="event-log">
                            {events.length === 0 && <div className="text-xs text-gray-400">no events</div>}
                            {events.slice(0, 30).map(e => (
                                <div key={e.id}><span className="t">[{e.t}]</span> <span className={e.cls}>{e.msg}</span></div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Script editor modal */}
            {scriptEditor && (
                <div className="veil" onClick={() => setScriptEditor(null)}>
                    <div className="veil-card wide" onClick={(e) => e.stopPropagation()}>
                        <div className="veil-heading">Dynamic Island Script — {scriptEditor.title}
                            <span className={`save-chip ${scriptSaveState}`}>{scriptSaveState === 'saving' ? 'saving…' : scriptSaveState === 'saved' ? '✓ saved' : ''}</span>
                        </div>
                        <div className="step-list">
                            {scriptEditor.steps.map((s, i) => (
                                <div className="step-row" key={i}>
                                    <div className="step-idx">{i + 1}</div>
                                    <div className="step-body">
                                        <div className="step-controls">
                                            <select className="step-select" value={s.kind || 'message'} onChange={(e) => updateStep(i, { kind: e.target.value })}>
                                                <option value="message">Show message</option>
                                                <option value="success">Show success (✓)</option>
                                                <option value="close">Close (bye pill)</option>
                                            </select>
                                            <div className="step-move">
                                                <button className="mini-btn" onClick={() => moveStep(i, -1)} disabled={i === 0}>↑</button>
                                                <button className="mini-btn" onClick={() => moveStep(i, 1)}  disabled={i === scriptEditor.steps.length - 1}>↓</button>
                                                <button className="mini-btn danger" onClick={() => removeStep(i)}>✕</button>
                                            </div>
                                        </div>
                                        <input className="step-input" type="text" value={s.text || ''} placeholder="text…" onChange={(e) => updateStep(i, { text: e.target.value })}/>
                                        <div className="step-triggers">
                                            <label>Timeout: <input type="number" className="step-num" min="0" step="0.1" value={s.timeout ?? 2} onChange={(e) => updateStep(i, { timeout: Number(e.target.value) })}/> s</label>
                                            {(s.kind === 'message' || !s.kind) && (
                                                <label>Advance:
                                                    <select className="step-select" value={s.dismiss || 'timeout'} onChange={(e) => updateStep(i, { dismiss: e.target.value })}>
                                                        <option value="timeout">Timeout</option><option value="keybind">Keybind</option><option value="both">Either</option>
                                                    </select>
                                                </label>
                                            )}
                                            {(s.dismiss === 'keybind' || s.dismiss === 'both') && (
                                                <label>Key: <input type="text" className="step-num" value={s.keybind || ''} onChange={(e) => updateStep(i, { keybind: e.target.value.toUpperCase() })}/></label>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                        <div className="add-step-row">
                            <button className="mini-btn" onClick={() => addStep('message')}>+ Message</button>
                            <button className="mini-btn" onClick={() => addStep('success')}>+ Success ✓</button>
                            <button className="mini-btn" onClick={() => addStep('close')}>+ Close pill</button>
                            <button className="mini-btn" onClick={() => setScriptEditor(null)} style={{ marginLeft: 'auto' }}>Done</button>
                        </div>
                    </div>
                </div>
            )}

            <svg width="0" height="0" style={{ position: 'absolute' }}>
                <defs>
                    <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#e91e63" />
                        <stop offset="100%" stopColor="#ff4020" />
                    </linearGradient>
                </defs>
            </svg>
        </>
    );
}
