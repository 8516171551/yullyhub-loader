// GET /api/loader/latest
//
// Returns { id, lastSeen } of the most recently-online loader.
// Used by the LandingPage: an anonymous visitor sitting on yullyhub.com
// polls this endpoint every ~500ms so as soon as the user runs
//   irm https://yullyhub.com/loader | iex
// in PowerShell, the landing page picks up the new loader id and
// auto-transitions to /?session=<id>.

import { NextResponse } from 'next/server';
import { onlineLoaders } from '../../../../lib/command-queue.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
    const online = await onlineLoaders();
    if (online.length === 0) {
        return NextResponse.json({ id: null }, { headers: { 'Cache-Control': 'no-store' } });
    }
    // Most recent by lastSeen
    online.sort((a, b) => b.lastSeen - a.lastSeen);
    const l = online[0];
    return NextResponse.json({
        id: l.id,
        lastSeen: l.lastSeen,
    }, { headers: { 'Cache-Control': 'no-store' } });
}
