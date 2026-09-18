// Command queue with Vercel KV (Upstash Redis REST) backing when the
// KV_REST_API_URL + KV_REST_API_TOKEN env vars are set. Falls back to an
// in-memory Map for local dev / when KV isn't attached.
//
// Vercel serverless functions run in short-lived isolated instances, so a
// pure in-memory queue only works when the /api/command POST and the
// /api/loader/poll GET happen to hit the same instance. That's why the
// old "5 minute delay" bug existed. With KV, every instance reads/writes
// the same Redis state → commands land instantly regardless of routing.
//
// To enable in prod: Vercel dashboard → Storage → Create Database → KV
// → attach to the yullyhub project. That auto-populates the env vars.

const KV_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const HAS_KV   = !!(KV_URL && KV_TOKEN);

const QUEUE_KEY = (id) => `yh:q:${id}`;
const SEEN_KEY  = (id) => `yh:seen:${id}`;
const SEEN_TTL  = 60; // seconds

if (!globalThis.__yh_loader_queue) globalThis.__yh_loader_queue = new Map();
if (!globalThis.__yh_loader_seen)  globalThis.__yh_loader_seen  = new Map();
export const queue = globalThis.__yh_loader_queue;
export const seen  = globalThis.__yh_loader_seen;

if (typeof console !== 'undefined') {
    console.log(HAS_KV
        ? '[command-queue] backend: Vercel KV / Upstash Redis'
        : '[command-queue] backend: in-memory (attach Vercel KV for prod)');
}

async function kv(cmd) {
    if (!HAS_KV) return null;
    try {
        const r = await fetch(KV_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(cmd),
        });
        if (!r.ok) return null;
        const j = await r.json();
        return j.result;
    } catch { return null; }
}
async function kvPipeline(cmds) {
    if (!HAS_KV) return null;
    try {
        const r = await fetch(`${KV_URL}/pipeline`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(cmds),
        });
        if (!r.ok) return null;
        return await r.json();
    } catch { return null; }
}

// -------- Public API --------

export async function markSeen(loaderId, info) {
    if (!loaderId) return;
    const val = JSON.stringify({ lastSeen: Date.now(), info: info || null });
    if (HAS_KV) {
        await kv(['SET', SEEN_KEY(loaderId), val, 'EX', String(SEEN_TTL)]);
        return;
    }
    seen.set(loaderId, { lastSeen: Date.now(), info: info || null });
}

export async function onlineLoaders() {
    if (HAS_KV) {
        const scan = await kv(['SCAN', '0', 'MATCH', 'yh:seen:*', 'COUNT', '200']);
        // Upstash SCAN returns [cursor, [keys...]]
        const keys = Array.isArray(scan) ? scan[1] : [];
        if (!keys || keys.length === 0) return [];
        const values = await kv(['MGET', ...keys]);
        const now = Date.now();
        const out = [];
        for (let i = 0; i < keys.length; i++) {
            const v = values?.[i];
            if (!v) continue;
            try {
                const rec = JSON.parse(v);
                if (now - rec.lastSeen <= SEEN_TTL * 1000) {
                    out.push({ id: keys[i].slice('yh:seen:'.length), lastSeen: rec.lastSeen, info: rec.info });
                }
            } catch {}
        }
        return out;
    }
    const now = Date.now();
    const out = [];
    for (const [id, r] of seen) {
        if (now - r.lastSeen <= SEEN_TTL * 1000) out.push({ id, lastSeen: r.lastSeen, info: r.info });
    }
    return out;
}

export async function push(loaderId, command) {
    if (HAS_KV) {
        if (!loaderId) {
            // Broadcast: push to every online loader's queue.
            const online = await onlineLoaders();
            if (online.length === 0) return { broadcast: true, delivered: 0 };
            const pipe = [];
            for (const l of online) {
                pipe.push(['LPUSH', QUEUE_KEY(l.id), JSON.stringify(command)]);
                pipe.push(['EXPIRE', QUEUE_KEY(l.id), '3600']);
            }
            await kvPipeline(pipe);
            return { broadcast: true, delivered: online.length };
        }
        await kvPipeline([
            ['LPUSH',  QUEUE_KEY(loaderId), JSON.stringify(command)],
            ['EXPIRE', QUEUE_KEY(loaderId), '3600'],
        ]);
        return { broadcast: false, delivered: 1 };
    }
    // In-memory fallback
    if (!loaderId) {
        const online = await onlineLoaders();
        for (const l of online) {
            const arr = queue.get(l.id) || [];
            arr.push(command);
            queue.set(l.id, arr);
        }
        return { broadcast: true, delivered: online.length };
    }
    const arr = queue.get(loaderId) || [];
    arr.push(command);
    queue.set(loaderId, arr);
    return { broadcast: false, delivered: 1 };
}

export async function drain(loaderId) {
    if (HAS_KV) {
        // Atomic LRANGE + DEL via pipeline. LPUSH + RPOP would be FIFO but
        // LRANGE + DEL gets the whole batch in one round-trip.
        const results = await kvPipeline([
            ['LRANGE', QUEUE_KEY(loaderId), '0', '-1'],
            ['DEL',    QUEUE_KEY(loaderId)],
        ]);
        if (!Array.isArray(results)) return [];
        // Upstash pipeline returns [{result: ...}, {result: ...}]
        const raw = results[0]?.result || [];
        // LPUSHed head-first, so reverse to get FIFO order.
        return raw.slice().reverse().map((s) => {
            try { return JSON.parse(s); } catch { return null; }
        }).filter(Boolean);
    }
    const arr = queue.get(loaderId) || [];
    queue.set(loaderId, []);
    return arr;
}
