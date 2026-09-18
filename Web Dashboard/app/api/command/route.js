// POST /api/command
//
// Dashboard-facing command dispatch. Under `next start` / Vercel, this
// pushes into the polling queue read by the C++ loader. During local
// `node server.js` dev the custom server intercepts before this handler
// runs and broadcasts the command over the WebSocket for lower latency.

import { NextResponse } from 'next/server';
import { push, onlineLoaders } from '../../../lib/command-queue.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
    let body = {};
    try { body = await request.json(); } catch {}
    if (!body || !body.type) {
        return NextResponse.json({ error: 'missing type' }, { status: 400 });
    }
    const res = await push(body.loaderId || null, body);
    const online = await onlineLoaders();
    return NextResponse.json({
        ok: true,
        broadcast: res.broadcast,
        delivered: res.delivered,
        online: online.length,
    });
}

export async function GET() {
    return NextResponse.json({ online: await onlineLoaders() });
}
