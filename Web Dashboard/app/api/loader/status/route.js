// GET /api/loader/status?id=<loaderId>
//
// Read-only check — does NOT bump the `seen` timestamp, so a browser
// asking "is my loader online?" every 2s doesn't stop the loader from
// being considered offline.

import { NextResponse } from 'next/server';
import { seen } from '../../../../lib/command-queue.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ONLINE_TTL_MS = 60 * 1000;

const KV_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const HAS_KV   = !!(KV_URL && KV_TOKEN);

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

export async function GET(request) {
    const url = new URL(request.url);
    const id  = url.searchParams.get('id');
    if (!id) return NextResponse.json({ online: false, error: 'no id' }, { status: 400 });

    let rec = null;
    if (HAS_KV) {
        const raw = await kv(['GET', `yh:seen:${id}`]);
        if (raw) { try { rec = JSON.parse(raw); } catch {} }
    } else {
        rec = seen.get(id) || null;
    }
    const online = !!rec && (Date.now() - rec.lastSeen) <= ONLINE_TTL_MS;
    return NextResponse.json({
        online,
        lastSeen: rec ? rec.lastSeen : null,
    }, { headers: { 'Cache-Control': 'no-store' } });
}
