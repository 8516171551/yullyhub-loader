// GET /api/loader/status?id=<loaderId>
//
// Read-only check — does NOT bump the `seen` timestamp, so a browser
// asking "is my loader online?" every 2s doesn't stop the loader from
// being considered offline.

import { NextResponse } from 'next/server';
import { seen } from '../../../../lib/command-queue.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Match the queue's TTL — 60s. See lib/command-queue.js for why.
const ONLINE_TTL_MS = 60 * 1000;

export async function GET(request) {
    const url = new URL(request.url);
    const id  = url.searchParams.get('id');
    if (!id) return NextResponse.json({ online: false, error: 'no id' }, { status: 400 });
    const rec = seen.get(id);
    const online = !!rec && (Date.now() - rec.lastSeen) <= ONLINE_TTL_MS;
    return NextResponse.json({
        online,
        lastSeen: rec ? rec.lastSeen : null,
    }, { headers: { 'Cache-Control': 'no-store' } });
}
