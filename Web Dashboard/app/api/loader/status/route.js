// GET /api/loader/status?id=<loaderId>
//
// Read-only check backed by loader_sessions.last_seen_at — does NOT
// bump the timestamp so a chatty dashboard doesn't keep a dead loader
// looking alive.

import { NextResponse } from 'next/server';
import { q1, hasDb } from '../../../../lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ONLINE_TTL_MS = 15 * 1000;

export async function GET(request) {
    const url = new URL(request.url);
    const id  = url.searchParams.get('id');
    if (!id) return NextResponse.json({ online: false, error: 'no id' }, { status: 400 });

    if (!hasDb()) {
        return NextResponse.json({ online: false, note: 'db-not-configured' },
            { headers: { 'Cache-Control': 'no-store' } });
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
