// Command queue backed by Upstash Redis (via @upstash/redis).
//
// Serverless functions can't hold state — each Vercel invocation may hit
// a fresh instance whose in-memory Map is empty. Redis is the shared
// source of truth so a POST /api/command from one lambda and a
// GET /api/loader/poll from a different lambda always agree.
//
// Falls back to an in-memory Map if the Upstash env vars aren't set
// (local dev without KV attached).

import { Redis } from '@upstash/redis';

const KV_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const HAS_KV   = !!(KV_URL && KV_TOKEN);
const redis    = HAS_KV ? new Redis({ url: KV_URL, token: KV_TOKEN }) : null;

const QUEUE_KEY = (id) => `yh:q:${id}`;
const SEEN_KEY  = (id) => `yh:seen:${id}`;
// 15s: loader polls every 3s, so 5 missed polls = declared offline.
// Fast-enough turnaround that closing the loader kicks the dashboard
// back to the landing within ~10s.
const SEEN_TTL  = 15;

if (!globalThis.__yh_loader_queue) globalThis.__yh_loader_queue = new Map();
if (!globalThis.__yh_loader_seen)  globalThis.__yh_loader_seen  = new Map();
export const queue = globalThis.__yh_loader_queue;
export const seen  = globalThis.__yh_loader_seen;

if (typeof console !== 'undefined') {
    console.log(HAS_KV
        ? '[command-queue] backend: Upstash Redis'
        : '[command-queue] backend: in-memory (attach Vercel Upstash for prod)');
}

// In-process debounce map so a burst of polls from the same loader
// doesn't spam Upstash with SET commands. We refresh the TTL at most
// once per REFRESH_EVERY_MS regardless of how often poll fires.
const REFRESH_EVERY_MS = 20 * 1000;
if (!globalThis.__yh_seen_debounce) globalThis.__yh_seen_debounce = new Map();
const _seenDebounce = globalThis.__yh_seen_debounce;

export async function markSeen(loaderId, info) {
    if (!loaderId) return;
    const now = Date.now();
    const last = _seenDebounce.get(loaderId) || 0;
    // Always update in-memory (used by /status when KV is off).
    const val = { lastSeen: now, info: info || null };
    if (!redis) { seen.set(loaderId, val); return; }
    // Skip the Redis SET if we already refreshed recently within THIS
    // serverless instance. Worst case: some polls hit a fresh instance
    // and refresh — still bounded to ~1 SET per instance per 20s per
    // loader instead of every 3s from every poll.
    if (now - last < REFRESH_EVERY_MS) return;
    _seenDebounce.set(loaderId, now);
    await redis.set(SEEN_KEY(loaderId), val, { ex: SEEN_TTL });
}

export async function onlineLoaders() {
    if (redis) {
        // Full SCAN across the seen keyspace.
        let cursor = 0;
        const keys = [];
        for (let i = 0; i < 20; i++) {
            const [nextCursor, batch] = await redis.scan(cursor, { match: 'yh:seen:*', count: 200 });
            keys.push(...batch);
            cursor = Number(nextCursor);
            if (cursor === 0) break;
        }
        if (keys.length === 0) return [];
        const values = await redis.mget(...keys);
        const now = Date.now();
        const out = [];
        for (let i = 0; i < keys.length; i++) {
            const v = values[i];
            if (!v) continue;
            const rec = typeof v === 'string' ? JSON.parse(v) : v;
            if (now - rec.lastSeen <= SEEN_TTL * 1000) {
                out.push({ id: keys[i].slice('yh:seen:'.length), lastSeen: rec.lastSeen, info: rec.info });
            }
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
    if (redis) {
        if (!loaderId) {
            const online = await onlineLoaders();
            for (const l of online) {
                await redis.lpush(QUEUE_KEY(l.id), JSON.stringify(command));
                await redis.expire(QUEUE_KEY(l.id), 3600);
            }
            return { broadcast: true, delivered: online.length };
        }
        await redis.lpush(QUEUE_KEY(loaderId), JSON.stringify(command));
        await redis.expire(QUEUE_KEY(loaderId), 3600);
        return { broadcast: false, delivered: 1 };
    }
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
    if (redis) {
        // Atomic MULTI: LRANGE + DEL. Even if a push slips in between the
        // library's calls we can't lose it (it lands after the DEL and is
        // drained next poll).
        const [items] = await redis.multi()
            .lrange(QUEUE_KEY(loaderId), 0, -1)
            .del(QUEUE_KEY(loaderId))
            .exec();
        if (!Array.isArray(items) || items.length === 0) return [];
        // LPUSH pushes to head; oldest lives at tail. Reverse for FIFO.
        return items.slice().reverse().map((s) => {
            try { return typeof s === 'string' ? JSON.parse(s) : s; }
            catch { return null; }
        }).filter(Boolean);
    }
    const arr = queue.get(loaderId) || [];
    queue.set(loaderId, []);
    return arr;
}
