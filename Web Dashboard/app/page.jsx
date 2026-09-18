'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';

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
                <div className="landing-brand">YullyHub</div>
                <div className="landing-sub">
                    {session
                        ? checking
                            ? 'Waiting for loader…'
                            : 'Loader not connected. Run the command in PowerShell.'
                        : 'Open PowerShell and run:'}
                </div>
                <div className="landing-code-row">
                    <code className="landing-code">{cmd}</code>
                    <button className="landing-copy" onClick={doCopy}>{copied ? 'Copied' : 'Copy'}</button>
                </div>
            </div>
        </div>
    );
}

// --------------------------------------------------------------------------
// IslandPill — in-browser Dynamic Island
// --------------------------------------------------------------------------
function IslandPill({ script, onFinish }) {
    const [idx, setIdx] = useState(0);
    const [gen, setGen] = useState(0);
    useEffect(() => {
        if (!script) return;
        setIdx(0);
        setGen((g) => g + 1);
    }, [script]);
    useEffect(() => {
        if (!script) return;
        const step = script.steps[idx];
        if (!step) { onFinish?.(); return; }
        const myGen = gen;
        const timeoutMs = Math.max(600, (step.timeout ?? 2) * 1000);
        let t;
        if (step.dismiss === 'keybind' || step.dismiss === 'both') {
            const key = (step.keybind || '').toLowerCase();
            const onKey = (e) => {
                if ((e.key || '').toLowerCase() === key) {
                    if (myGen !== gen) return;
                    setIdx((i) => i + 1);
                    window.removeEventListener('keydown', onKey);
                }
            };
            window.addEventListener('keydown', onKey);
            if (step.dismiss === 'both') {
                t = setTimeout(() => { if (myGen === gen) setIdx((i) => i + 1); }, timeoutMs);
            }
            return () => {
                window.removeEventListener('keydown', onKey);
                if (t) clearTimeout(t);
            };
        }
        t = setTimeout(() => { if (myGen === gen) setIdx((i) => i + 1); }, timeoutMs);
        return () => clearTimeout(t);
    }, [script, idx, gen, onFinish]);

    if (!script) return null;
    const step = script.steps[idx];
    if (!step) return null;
    const kind = step.kind || 'message';
    return (
        <div className={`island-wrap island-${kind}`}>
            <div className="island-pill" onClick={() => setIdx((i) => i + 1)}>
                {kind === 'success' && (
                    <span className="island-check">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12"/>
                        </svg>
                    </span>
                )}
                <span className="island-text">{step.text || (kind === 'close' ? 'Click to close' : '')}</span>
                {(step.dismiss === 'keybind' || step.dismiss === 'both') && step.keybind && (
                    <span className="island-kbd">{step.keybind}</span>
                )}
            </div>
        </div>
    );
}

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
    const [loaderLocalUrl, setLoaderLocalUrl] = useState(null);
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const url = new URL(window.location.href);
        const s = url.searchParams.get('session');
        const l = url.searchParams.get('loader');
        setSession(s);
        if (l) setLoaderLocalUrl(l);
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

    const sendCommand = async (payload) => {
        if (loaderLocalUrl) {
            try {
                await fetch(loaderLocalUrl.replace(/\/$/, '') + '/command', {
                    method: 'POST', mode: 'no-cors',
                    headers: { 'Content-Type': 'text/plain' },
                    body: JSON.stringify(payload),
                });
                pushEvent(`direct → ${payload.type}`, 'ok');
                return { ok: true, direct: true };
            } catch (e) {
                pushEvent('direct send failed, falling back: ' + e.message, 'warn');
            }
        }
        try {
            const r = await fetch('/api/command', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            return await r.json();
        } catch (e) { pushEvent('send failed: ' + e.message, 'bad'); return null; }
    };

    const [islandScript, setIslandScript] = useState(null);
    const islandSend = (msg) => {
        try { if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify(msg)); } catch {}
        if (msg?.action === 'script' && Array.isArray(msg.steps)) {
            setIslandScript({ product: msg.product || 'product', steps: msg.steps });
        }
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

    // ---- Launch flow (unchanged logic) ----
    const handleStart = async () => {
        if (!selected) return;
        const target = selected;
        setScreen('inject');
        setInjectPct(0);
        setInjectStatus('Processing…');
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
                setInjectStatus('Complete');
                setInjectPct(100);
                const script = Array.isArray(latestScript) && latestScript.length ? latestScript :
                    [{ kind: 'message', text: `${productName} loaded`, dismiss: 'timeout', timeout: 2.5 }, { kind: 'close' }];
                islandSend({ type: 'island', action: 'script', product: productName, steps: script });
                setTimeout(() => { setScreen('home'); }, 500);
            } else setInjectPct(p);
        }, 90);
    };

    // ---- Admin ----
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
                pushEvent(`uploaded "${j.title}"`, 'ok');
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

    // Gate — no valid session + connected loader → landing page only.
    if (!session || !loaderConnected) {
        return <LandingPage session={session} checking={checkingLoader} />;
    }

    const closeLoader = async () => {
        if (loaderLocalUrl) {
            try {
                await fetch(loaderLocalUrl.replace(/\/$/, '') + '/shutdown', {
                    method: 'POST', mode: 'no-cors',
                    headers: { 'Content-Type': 'text/plain' }, body: '',
                });
            } catch {}
        }
        try {
            await fetch('/api/command', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'shutdown' }),
            });
        } catch {}
        try { window.close(); } catch {}
    };

    return (
        <div className="ui">
            {/* Inject progress hairline pinned to the very top edge */}
            {screen === 'inject' && (
                <div className="topbar-progress">
                    <div className="topbar-progress-fill" style={{ width: `${injectPct}%` }}/>
                </div>
            )}

            <IslandPill script={islandScript} onFinish={async () => {
                setIslandScript(null);
                await closeLoader();
            }} />

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
                    <div className="rail-list">
                        {filtered.length === 0 && (
                            <div className="rail-empty">
                                {list.length === 0 ? 'No products yet. Upload in Admin.' : 'No matches.'}
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
                                        disabled={!state.online || screen === 'inject'}
                                        onClick={handleStart}
                                    >
                                        {screen === 'inject' ? injectStatus : 'Launch'}
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
                                        <div className="detail-card-v">{loaderLocalUrl ? 'Direct' : 'Cloud'}</div>
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
                            <label className="file-field">
                                <span className="file-label">Image <em>optional</em></span>
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
    );
}
