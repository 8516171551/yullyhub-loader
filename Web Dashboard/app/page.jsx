'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

const DEMO_GAMES = [
    { id: 'demo-gta',  name: 'GTA V',    cls: 'g-gta',  desc: 'Demo card — upload your own product in Admin.', demo: true },
    { id: 'demo-dota', name: 'Dota 2',   cls: 'g-dota', desc: 'Demo card — upload your own product in Admin.', demo: true },
    { id: 'demo-cs',   name: 'CS2',      cls: 'g-cs',   desc: 'Demo card — upload your own product in Admin.', demo: true },
    { id: 'demo-val',  name: 'Valorant', cls: 'g-val',  desc: 'Demo card — upload your own product in Admin.', demo: true },
];

const DEMO_CLASSES = ['g-gta', 'g-dota', 'g-cs', 'g-val'];

export default function Page() {
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
            ws = new WebSocket(`ws://${location.host}/ws-ui`);
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

    const handleStart = async () => {
        const target = getVisibleList()[selected];
        if (!target) return;
        setScreen('inject');
        setInjectPct(0);
        setInjectStatus('Processing...');

        const productName = target.name || target.title || 'product';
        islandSend({ type: 'island', action: 'start', product: productName });

        if (target.demo) {
            sendCommand({ type: 'ping' });
        } else {
            const url = `http://${location.host}/api/products/${target.id}/exe`;
            sendCommand({ type: 'launch', productId: target.id, title: target.title, url });
        }
        let p = 0;
        const iv = setInterval(() => {
            p += 3 + Math.random() * 4;
            if (p >= 100) {
                p = 100;
                clearInterval(iv);
                setInjectStatus('Injection complete.');
                setInjectPct(100);
                islandSend({ type: 'island', action: 'progress', pct: 100 });
                islandSend({ type: 'island', action: 'done' });
            } else {
                setInjectPct(p);
                islandSend({ type: 'island', action: 'progress', pct: p });
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
                <nav className="nav">
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                        <div className="logo"><span className="kw">YULLY</span><span className="sp">HUB</span></div>
                        <div className="nav-tabs">
                            <button className={`tab ${screen === 'home' ? 'active' : ''}`} onClick={() => setScreen('home')}>home</button>
                            <button className={`tab ${screen === 'admin' ? 'active' : ''}`} onClick={() => setScreen('admin')}>admin</button>
                            <button className={`tab ${screen === 'settings' ? 'active' : ''}`} onClick={() => setScreen('settings')}>settings</button>
                            <button className={`tab ${screen === 'login' ? 'active' : ''}`} onClick={() => setScreen('login')}>login</button>
                            <button className="tab">help</button>
                        </div>
                    </div>
                    <div className="nav-right">
                        <div className="status-pill">
                            <span className={`pulse-dot ${state.online ? 'on' : ''}`}></span>
                            {state.online ? `${state.count} loader${state.count === 1 ? '' : 's'} online` : 'no loader connected'}
                        </div>
                        <button className="donate">DONATE</button>
                        <div className="user">
                            <div className="avatar">M</div>
                            <span>moonnight</span>
                        </div>
                    </div>
                </nav>

                <div className="main">
                    {screen === 'home' && (
                        <section className="screen home-inner" key="home">
                            <div
                                className={`carousel-stage ${dragging ? 'is-dragging' : ''}`}
                                onMouseDown={onCarouselDown}
                                onTouchStart={onCarouselDown}
                            >
                                <div
                                    className={`carousel-inner ${dragging ? 'is-dragging' : ''}`}
                                    style={{ transform: `translateX(${dragDelta}px)` }}
                                >
                                    {list.map((game, idx) => {
                                        const slot = slotFor(idx);
                                        if (slot === 'hidden') return null;
                                        const bg = game.imageName && !game.demo
                                            ? { backgroundImage: `url(/api/products/${game.id}/image)` }
                                            : undefined;
                                        return (
                                            <div
                                                key={game.id}
                                                className={`game-card ${game.cls || 'g-dota'}`}
                                                data-slot={slot}
                                                style={bg}
                                                onClick={(e) => {
                                                    if (dragging) return;
                                                    if (Math.abs(dragDelta) > 4) return;
                                                    if (slot === '-1' || slot === '-2') commitSwitch(-1);
                                                    else if (slot === '1' || slot === '2') commitSwitch(1);
                                                }}
                                            >
                                                <div className="card-body">
                                                    <div className="card-title">{game.name}</div>
                                                    <div className="card-caption">{game.desc}</div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* status row (Updating / Ready / Waiting) sits directly under the active card */}
                            <div className="status-row">
                                <span className={`pulse ${state.online ? 'online' : ''}`}></span>
                                <span>{state.online ? (g.updatedAt ? 'Updating' : 'Ready') : 'Offline'}</span>
                            </div>

                            <div className="deck-nav">
                                <button
                                    className="deck-nav-btn"
                                    onClick={() => commitSwitch(-1)}
                                    disabled={transitioning || list.length === 0}
                                    aria-label="Previous"
                                >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="15 18 9 12 15 6"></polyline>
                                    </svg>
                                </button>
                                <button
                                    className="deck-nav-btn"
                                    onClick={() => commitSwitch(1)}
                                    disabled={transitioning || list.length === 0}
                                    aria-label="Next"
                                >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="9 18 15 12 9 6"></polyline>
                                    </svg>
                                </button>
                            </div>

                            {list.length > 1 && (
                                <div className="carousel-dots">
                                    {list.map((_, i) => (
                                        <div
                                            key={i}
                                            className={`carousel-dot ${i === safeSelected ? 'active' : ''}`}
                                            onClick={() => setSelected(i)}
                                        />
                                    ))}
                                </div>
                            )}

                            <div className="feature-title">{g.name}</div>
                            <div className="feature-desc">{g.desc}</div>
                            <button className="primary-btn" onClick={handleStart} disabled={!state.online}>
                                {g.demo ? 'PING' : 'LOAD PRODUCT'}
                            </button>
                            {!state.online && (
                                <div style={{marginTop: 14, fontSize: 11, color: 'var(--muted)'}}>
                                    Waiting for loader.exe to connect…
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
            </div>
        </>
    );
}
