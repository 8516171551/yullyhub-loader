// GET /api/loader/status?id=<loaderId>[&keepalive=1]
//
// Read-only status check backed by loader_sessions.last_seen_at.
// When the dashboard passes `?keepalive=1` we ALSO bump last_seen_at
// — that's what keeps the loader from flipping offline while the
// customer has the dashboard open. Rule from the customer: "loader
// stays alive as long as the dashboard is running or a product is
// loading." The C++ loader's own 30s heartbeat runs independently,
// so if it dies the keepalive alone can't hold the row alive past
// ONLINE_TTL_MS anyway.

import { NextResponse } from 'next/server';
import { q, q1, hasDb } from '../../../../lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Widened to 3 minutes so a single dropped heartbeat can't ever trip
// the "offline" flip. The dashboard's keepalive polls every 5s, so
// while a browser tab is open this window stays fresh with plenty of
// headroom — the flip only fires when both the C++ loader AND the
// dashboard have genuinely gone away.
const ONLINE_TTL_MS = 180 * 1000;

export async function GET(request) {
    const url = new URL(request.url);
    const id  = url.searchParams.get('id');
    const keepalive = url.searchParams.get('keepalive') === '1';
    if (!id) return NextResponse.json({ online: false, error: 'no id' }, { status: 400 });

    if (!hasDb()) {
        return NextResponse.json({ online: false, note: 'db-not-configured' },
            { headers: { 'Cache-Control': 'no-store' } });
    }

    if (keepalive) {
        // Best-effort bump — never fail the status check if this
        // errors (e.g. the row was already revoked).
        try {
            await q(
                `UPDATE loader_sessions
                    SET last_seen_at = CURRENT_TIMESTAMP
                  WHERE loader_id = ? AND revoked_at IS NULL`,
                [id],
            );
        } catch { /* ignore */ }
    }

    const row = await q1(
        `SELECT EXTRACT(EPOCH FROM MAX(last_seen_at))::bigint AS last_seen
           FROM loader_sessions
          WHERE loader_id = ? AND revoked_at IS NULL`,
        [id]
    );
    const lastSeen = row?.last_seen ? Number(row.last_seen) * 1000 : null;
    const online = !!lastSeen && (Date.now() - lastSeen) <= ONLINE_TTL_MS;
    return NextResponse.json({ online, lastSeen },
        { headers: { 'Cache-Control': 'no-store' } });
}
