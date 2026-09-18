// Command queue backed by Neon Postgres (loader_commands + loader_sessions).
//
// One row per queued command. Poll drains rows for a loaderId
// (SELECT + DELETE). Online tracking lives on loader_sessions.last_seen_at
// (auto-touched by heartbeat + poll).

import crypto from 'crypto';
import { q, q1, hasDb } from './db.js';

const ONLINE_TTL_MS = 15 * 1000;

if (!globalThis.__yh_seen_debounce) globalThis.__yh_seen_debounce = new Map();
const _seenDebounce = globalThis.__yh_seen_debounce;
const REFRESH_EVERY_MS = 10 * 1000;

// Compat globals (some old code paths poke these Maps).
if (!globalThis.__yh_loader_queue) globalThis.__yh_loader_queue = new Map();
if (!globalThis.__yh_loader_seen)  globalThis.__yh_loader_seen  = new Map();
export const queue = globalThis.__yh_loader_queue;
export const seen  = globalThis.__yh_loader_seen;

function assertDb() {
    if (!hasDb()) throw new Error('DATABASE_URL not configured');
}

export async function markSeen(loaderId, info) {
    if (!loaderId || !hasDb()) return;
    const now = Date.now();
    const last = _seenDebounce.get(loaderId) || 0;
    if (now - last < REFRESH_EVERY_MS) return;
    _seenDebounce.set(loaderId, now);
    // Upsert against an anonymous heartbeat row if none exists yet.
    try {
        // touched: 1 if we updated an existing row
        const touched = await q1(
            `UPDATE loader_sessions
                SET last_seen_at = NOW(),
                    user_agent   = COALESCE(?, user_agent)
              WHERE loader_id = ? AND revoked_at IS NULL
              RETURNING id`,
            [info?.ua || null, loaderId]
        );
        if (!touched) {
            const id = crypto.randomUUID();
            const tok = crypto.randomBytes(32).toString('hex');
            await q(
                `INSERT INTO loader_sessions
                    (id, license_key, loader_id, session_token, user_agent)
                 VALUES (?, NULL, ?, ?, ?)
                 ON CONFLICT (session_token) DO UPDATE SET last_seen_at = NOW()`,
                [id, loaderId, tok, info?.ua || null]
            );
        }
    } catch {}
}

export async function onlineLoaders() {
    if (!hasDb()) return [];
    const cutoff = new Date(Date.now() - ONLINE_TTL_MS);
    const rows = await q(
        `SELECT loader_id,
                EXTRACT(EPOCH FROM MAX(last_seen_at))::bigint AS last_seen
           FROM loader_sessions
          WHERE revoked_at IS NULL AND last_seen_at >= ?
          GROUP BY loader_id
          ORDER BY last_seen DESC`,
        [cutoff]
    );
    return rows.map(r => ({ id: r.loader_id, lastSeen: Number(r.last_seen) * 1000, info: null }));
}

export async function push(loaderId, command) {
    assertDb();
    const json = JSON.stringify(command);
    if (!loaderId) {
        const online = await onlineLoaders();
        for (const l of online) {
            await q(
                `INSERT INTO loader_commands (loader_id, payload) VALUES (?, ?::jsonb)`,
                [l.id, json]
            );
        }
        return { broadcast: true, delivered: online.length };
    }
    await q(
        `INSERT INTO loader_commands (loader_id, payload) VALUES (?, ?::jsonb)`,
        [loaderId, json]
    );
    return { broadcast: false, delivered: 1 };
}

export async function drain(loaderId) {
    if (!hasDb()) return [];
    // Atomic drain via RETURNING — grabs + deletes in one round-trip.
    const rows = await q(
        `DELETE FROM loader_commands
          WHERE id IN (
              SELECT id FROM loader_commands
               WHERE loader_id = ? AND picked_at IS NULL
               ORDER BY id ASC
          )
        RETURNING id, payload`,
        [loaderId]
    );
    return rows.map(r => {
        try { return typeof r.payload === 'object' ? r.payload : JSON.parse(r.payload); }
        catch { return null; }
    }).filter(Boolean);
}
