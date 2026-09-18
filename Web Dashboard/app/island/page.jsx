'use client';

// Standalone Dynamic Island page. The loader spawns a tiny 560x120 Chrome
// window pointing at this URL after a successful launch:
//
//     https://yullyhub.com/island?script=<url-encoded JSON>&product=<name>
//
// The page reads the script from the query string, plays it through, and
// calls window.close() on the last step. Because it's opened as its own
// --app window, closing it destroys the Chrome process — which the loader
// is WaitForSingleObject()-ing on, so it tears down the whole session.

import { useEffect, useMemo, useState } from 'react';

function withLoadingStep(script) {
    if (!script || !Array.isArray(script.steps) || !script.steps.length) return script;
    const first = script.steps[0];
    if (first.kind === 'loading') return script;
    return {
        ...script,
        steps: [{ kind: 'loading', text: `Injecting ${script.product || 'product'}`, timeout: 2.4 }, ...script.steps],
    };
}

function IslandPill({ script, onFinish }) {
    const s = useMemo(() => withLoadingStep(script), [script]);
    const [idx, setIdx] = useState(0);
    const [gen, setGen] = useState(0);
    useEffect(() => {
        if (!s) return;
        setIdx(0);
        setGen((g) => g + 1);
    }, [s]);
    useEffect(() => {
        if (!s) return;
        const step = s.steps[idx];
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
    }, [s, idx, gen, onFinish]);
    if (!s) return null;
    const step = s.steps[idx];
    if (!step) return null;
    const kind = step.kind || 'message';
    const clickable = kind !== 'loading';
    return (
        <div className={`island-wrap island-${kind}`}>
            <div key={idx} className="island-pill" onClick={() => { if (clickable) setIdx((i) => i + 1); }}>
                {kind === 'loading' && (
                    <span className="island-loader" aria-hidden="true">
                        <span className="dot"/><span className="dot"/><span className="dot"/>
                    </span>
                )}
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

export default function IslandPage() {
    const [script, setScript] = useState(null);

    useEffect(() => {
        // Block reload/DevTools keys — same as the main dashboard.
        const blockKey = (e) => {
            const k = (e.key || '').toLowerCase();
            const ctrl = e.ctrlKey || e.metaKey;
            const shift = e.shiftKey;
            const bad = k === 'f5' || k === 'f11' || k === 'f12' ||
                        (ctrl && ['r','w','t','n','u','s','p','j','h'].includes(k)) ||
                        (ctrl && shift && ['i','j','c','r'].includes(k));
            if (bad) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
        };
        document.addEventListener('keydown', blockKey, true);
        document.addEventListener('contextmenu', (e) => e.preventDefault(), true);
        return () => {
            document.removeEventListener('keydown', blockKey, true);
        };
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const u = new URL(window.location.href);
        const raw = u.searchParams.get('script');
        const product = u.searchParams.get('product') || 'product';
        if (!raw) {
            setScript({ product, steps: [{ kind: 'message', text: 'No script provided', timeout: 3 }, { kind: 'close' }] });
            return;
        }
        try {
            const parsed = JSON.parse(decodeURIComponent(raw));
            const steps = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.steps) ? parsed.steps : []);
            setScript({ product, steps });
        } catch {
            setScript({ product, steps: [{ kind: 'message', text: 'Bad script payload', timeout: 3 }, { kind: 'close' }] });
        }
    }, []);

    const handleFinish = async () => {
        // Fire shutdown at the cloud queue — the loader picks it up on its
        // next 500ms poll and terminates the process, which nukes this
        // browser window too (job object).
        try {
            await fetch('/api/command', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'shutdown' }),
            });
        } catch {}
        // Also try to close ourselves directly — works in Chrome --app windows.
        try { window.close(); } catch {}
    };

    return (
        <div className="island-page">
            <IslandPill script={script} onFinish={handleFinish}/>
        </div>
    );
}
