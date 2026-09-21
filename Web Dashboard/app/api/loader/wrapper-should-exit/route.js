// GET /api/loader/wrapper-should-exit?since=<unix-epoch-seconds>
//
// PS wrapper polls this after every RPE::Run returns. If an exit
// signal for the caller's IP is newer than the wrapper's own
// `?since=` start timestamp, we return { exit: true } and PS breaks
// its auto-restart loop.
//
// See ./wrapper-signal-exit for the writer side.

import { NextResponse } from 'next/server';
import { q1, hasDb } from '../../../../lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function extractIp(request) {
    const xff = request.headers.get('x-forwarded-for') || '';
    const primary = xff.split(',')[0].trim();
    if (primary) return primary;
    return request.headers.get('x-real-ip') || 'unknown';
}

export async function GET(request) {
    if (!hasDb()) {
        // Fail-safe: without a DB we can't say "should exit" — return
        // false so PS keeps its normal behavior (auto-restart).
        return NextResponse.json({ exit: false, note: 'db-not-configured' },
            { headers: { 'Cache-Control': 'no-store' } });
    }
    const url = new URL(request.url);
    const sinceStr = url.searchParams.get('since') || '0';
    const sinceEpoch = Number(sinceStr) || 0;
    const ip = extractIp(request);

    let row;
    try {
        row = await q1(
            `SELECT EXTRACT(EPOCH FROM sent_at)::bigint AS sent_epoch
               FROM wrapper_exit_signals
              WHERE ip = ?`,
            [ip],
        );
    } catch {
        return NextResponse.json({ exit: false, note: 'db-error' },
            { headers: { 'Cache-Control': 'no-store' } });
    }
    const sentEpoch = row?.sent_epoch ? Number(row.sent_epoch) : 0;
    const exit = sentEpoch > 0 && sentEpoch >= sinceEpoch;
    return NextResponse.json({ exit, sentEpoch, sinceEpoch, ip },
        { headers: { 'Cache-Control': 'no-store' } });
}
