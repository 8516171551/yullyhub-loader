// Command queue backed by the shared MySQL DB (yh_commands + yh_loader_sessions).
//
// One row per queued command in yh_commands. Poll drains rows for a
// loaderId in one transaction (SELECT ... FOR UPDATE + DELETE). Online
// tracking lives on yh_loader_sessions.last_seen_at (auto-touched by
// heartbeat + poll).
//
// See _yullyhub_readme row id=1 in the DB for ownership rules.

import { q, hasDb } from './db.js';

// Consider a loader "online" if we've seen a heartbeat/poll within this window.
const ONLINE_TTL_MS = 15 * 1000;

// In-instance debounce so a burst of polls from the same loader doesn't
// spam UPDATE queries on the sessions table.
if (!globalThis.__yh_seen_debounce) globalThis.__yh_seen_debounce = new Map();
const _seenDebounce = globalThis.__yh_seen_debounce;
const REFRESH_EVERY_MS = 10 * 1000;

// Compat: some old code paths poke these Maps. Keep them so nothing crashes,
// but they're no longer the source of truth.
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
    // Touch every non-revoked session for this loaderId. There should be
    // one live session per loaderId at a time.
    try {
        await q(
            `UPDATE yh_loader_sessions
                SET last_seen_at = CURRENT_TIMESTAMP
              WHERE loader_id = ? AND revoked_at IS NULL`,
            [loaderId]
        );
    } catch {}
}

export async function onlineLoaders() {
    if (!hasDb()) return [];
    const cutoff = new Date(Date.now() - ONLINE_TTL_MS);
    const rows = await q(
        `SELECT loader_id, MAX(UNIX_TIMESTAMP(last_seen_at)) AS last_seen
           FROM yh_loader_sessions
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
                `INSERT INTO yh_commands (loader_id, payload) VALUES (?, CAST(? AS JSON))`,
                [l.id, json]
            );
        }
        return { broadcast: true, delivered: online.length };
    }
    await q(
        `INSERT INTO yh_commands (loader_id, payload) VALUES (?, CAST(? AS JSON))`,
        [loaderId, json]
    );
    return { broadcast: false, delivered: 1 };
}

export async function drain(loaderId) {
    if (!hasDb()) return [];
    // Atomic drain: grab the id list, then delete those rows by id.
    const rows = await q(
        `SELECT id, payload FROM yh_commands
          WHERE loader_id = ? AND picked_at IS NULL
          ORDER BY id ASC`,
        [loaderId]
    );
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    await q(`DELETE FROM yh_commands WHERE id IN (${placeholders})`, ids);
    return rows.map(r => {
        try { return typeof r.payload === 'object' ? r.payload : JSON.parse(r.payload); }
        catch { return null; }
    }).filter(Boolean);
}
