// POST /api/loader/wrapper-signal-exit
//
// When the customer clicks X on the dashboard we call this endpoint
// with fetch(). The server records "IP <X> requested an exit at NOW()"
// in the wrapper_exit_signals table (upsert by IP, so repeat clicks
// just refresh the timestamp).
//
// The PowerShell wrapper polls /api/loader/wrapper-should-exit with
// its startup epoch — if the signal for its IP is newer than the
// wrapper's own start time, it breaks its auto-restart loop and the
// PS window closes cleanly.
//
// Shared / NAT'd IPs will kick every wrapper behind that IP; acceptable
// for the single-customer case this addresses.

import { NextResponse } from 'next/server';
import { q, hasDb } from '../../../../lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function extractIp(request) {
    const xff = request.headers.get('x-forwarded-for') || '';
    const primary = xff.split(',')[0].trim();
    if (primary) return primary;
    return request.headers.get('x-real-ip') || 'unknown';
}

export async function POST(request) {
    if (!hasDb()) {
        return NextResponse.json({ ok: false, reason: 'db-not-configured' }, { status: 503 });
    }
    const ip = extractIp(request);
    try {
        await q(
            `INSERT INTO wrapper_exit_signals (ip, sent_at)
             VALUES (?, NOW())
             ON CONFLICT (ip) DO UPDATE SET sent_at = EXCLUDED.sent_at`,
            [ip],
        );
    } catch (e) {
        return NextResponse.json({ ok: false, error: String(e.message || e) }, { status: 500 });
    }
    return NextResponse.json({ ok: true, ip },
        { headers: { 'Cache-Control': 'no-store' } });
}
