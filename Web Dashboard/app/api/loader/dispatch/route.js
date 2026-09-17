// POST /api/loader/dispatch
//
// Dashboard drops a command here — it will be picked up by whichever loader
// polls next. Body:
//   {
//     loaderId?: string,   // omit to broadcast to every online loader
//     command:  { type: "launch" | "ping", ...payload }
//   }

import { NextResponse } from 'next/server';
import { push, onlineLoaders } from '../../../../lib/command-queue.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
    let body = {};
    try { body = await request.json(); } catch {}
    if (!body || !body.command || !body.command.type) {
        return NextResponse.json({ error: 'missing command' }, { status: 400 });
    }
    const res = push(body.loaderId || null, body.command);
    return NextResponse.json({
        ok: true,
        broadcast: res.broadcast,
        delivered: res.delivered,
        online: onlineLoaders().length,
    });
}
