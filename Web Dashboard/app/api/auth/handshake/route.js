// GET  /api/auth/handshake?token=<token>
// POST /api/auth/handshake       (JSON body: { token })
//
// The PRODUCT calls this after the loader launches it. Response tells the
// product whether to keep running or bail out.
//
// Success (200):
//   {
//     valid: true,
//     user:         { id, plan },
//     subscription: { plan, active, expires_at },
//     product_id:   string | null,
//     issued_at:    unix-seconds,
//     expires_at:   unix-seconds,      // token TTL
//   }
//
// Failure (401 / 400):
//   { valid: false, error: "missing" | "unknown" | "expired" }

import { NextResponse } from 'next/server';
import { redeemToken, sweep } from '../../../../lib/token-store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function respond(token) {
    sweep();
    const res = redeemToken(token, { markUsed: true });
    if (!res.ok) {
        const status = res.reason === 'missing' ? 400 : 401;
        return NextResponse.json({ valid: false, error: res.reason }, { status });
    }
    const rec = res.record;
    return NextResponse.json({
        valid: true,
        user:  { id: rec.userId, plan: rec.subscription?.plan || 'unknown' },
        subscription: rec.subscription,
        product_id:   rec.productId,
        issued_at:    Math.floor(rec.createdAt / 1000),
        expires_at:   Math.floor(rec.expiresAt / 1000),
    });
}

export async function GET(request) {
    const url = new URL(request.url);
    return respond(url.searchParams.get('token'));
}

export async function POST(request) {
    let body = {};
    try { body = await request.json(); } catch {}
    return respond(body.token);
}
