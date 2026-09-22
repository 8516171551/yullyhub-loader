// In-memory overlay message store, keyed by IP.
// Dashboard pushes script steps here on launch; the PS overlay bar polls them.

const store = new Map();
const TTL = 10 * 60 * 1000; // 10 min

export function setOverlay(ip, steps) {
    store.set(ip, { steps, version: Date.now(), ts: Date.now() });
}

export function getOverlay(ip) {
    const entry = store.get(ip);
    if (!entry) return null;
    if (Date.now() - entry.ts > TTL) { store.delete(ip); return null; }
    return entry;
}

export function clearOverlay(ip) {
    store.delete(ip);
}

// Periodic cleanup
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of store) {
        if (now - v.ts > TTL) store.delete(k);
    }
}, 60_000);
