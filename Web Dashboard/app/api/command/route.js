// POST /api/command
//
// Dashboard-facing command dispatch. Under `next start` / Vercel, this
// pushes into the polling queue read by the C++ loader. During local
// `node server.js` dev the custom server intercepts before this handler
// runs and broadcasts the command over the WebSocket for lower latency.

import { NextResponse } from 'next/server';
import { push, onlineLoaders } from '../../../lib/command-queue.js';
import { q } from '../../../lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
    let body = {};
    try { body = await request.json(); } catch {}
    if (!body || !body.type) {
        return NextResponse.json({ error: 'missing type' }, { status: 400 });
    }
    const res = await push(body.loaderId || null, body);

    // On shutdown, also mark the loader_sessions row as revoked. That's
    // what tells the PowerShell auto-restart wrapper "don't come back":
    // the wrapper polls /api/loader/status after loader.exe exits, sees
    // revoked=true, and breaks out of the while-loop instead of
    // re-mapping the PE. The C++ loader itself already dies on its
    // next heartbeat when it sees session_revoked.
    if (body.type === 'shutdown' && body.loaderId) {
        try {
            await q(
                `UPDATE loader_sessions
                    SET revoked_at = CURRENT_TIMESTAMP
                  WHERE loader_id = ? AND revoked_at IS NULL`,
                [body.loaderId],
            );
        } catch { /* ignore */ }
    }

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
