// In-memory command queue for loaders that can't hold a WebSocket
// (Vercel serverless). Dashboard POSTs to /api/loader/dispatch → the
// command lands here → loader.exe polls /api/loader/poll and drains it.
//
// Loaders identify themselves with a UUID they generate on first launch;
// dashboards target that ID. `all: true` broadcasts to every online
// loader. Records live in `globalThis` so both routes see the same Map.

if (!globalThis.__yh_loader_queue) globalThis.__yh_loader_queue = new Map(); // loaderId -> Command[]
if (!globalThis.__yh_loader_seen)  globalThis.__yh_loader_seen  = new Map(); // loaderId -> { lastSeen, info }

/** @type {Map<string, Array<any>>} */
export const queue = globalThis.__yh_loader_queue;
/** @type {Map<string, { lastSeen: number, info: any }>} */
export const seen  = globalThis.__yh_loader_seen;

const ONLINE_TTL_MS = 15 * 1000; // if a loader hasn't polled in 15s, treat as offline

export function markSeen(loaderId, info) {
    if (!loaderId) return;
    seen.set(loaderId, { lastSeen: Date.now(), info: info || null });
}

export function onlineLoaders() {
    const now = Date.now();
    const out = [];
    for (const [id, r] of seen) {
        if (now - r.lastSeen <= ONLINE_TTL_MS) out.push({ id, lastSeen: r.lastSeen, info: r.info });
    }
    return out;
}

export function push(loaderId, command) {
    if (!loaderId) {
        // broadcast to every currently-online loader
        for (const l of onlineLoaders()) {
            const arr = queue.get(l.id) || [];
            arr.push(command);
            queue.set(l.id, arr);
        }
        return { broadcast: true, delivered: onlineLoaders().length };
    }
    const arr = queue.get(loaderId) || [];
    arr.push(command);
    queue.set(loaderId, arr);
    return { broadcast: false, delivered: 1 };
}

export function drain(loaderId) {
    const arr = queue.get(loaderId) || [];
    queue.set(loaderId, []);
    return arr;
}
