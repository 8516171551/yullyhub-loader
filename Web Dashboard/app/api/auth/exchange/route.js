// POST /api/auth/exchange
//
// The DASHBOARD (or a logged-in customer session, once auth is wired up)
// calls this to mint a short-lived exchange token that the loader will
// hand to a launched product. The product then calls /api/auth/handshake
// with the token to confirm the user is real and their subscription is
// active.
//
// Request body (all optional):
//   { productId?: string, userId?: string, plan?: string }
//
// Response:
//   {
//     token:       "abc123...",   // pass this to the product
//     expires_at:  1700000000,    // unix seconds when the token dies
//     user:        { id, plan },  // echoed so the caller can log context
//   }

import { NextResponse } from 'next/server';
import { issueToken, TOKEN_TTL_MS, sweep } from '../../../../lib/token-store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
    sweep();

    let body = {};
    try { body = await request.json(); } catch {}

    const userId    = body.userId    || 'demo-user';
    const productId = body.productId || null;
    const plan      = body.plan      || 'lifetime';

    const rec = issueToken({
        userId,
        productId,
        subscription: {
            plan,
            active: true,
            // null = lifetime, or a unix-second stamp for time-limited
            expires_at: plan === 'lifetime' ? null : Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000),
        },
    });

    return NextResponse.json({
        token: rec.token,
        expires_at: Math.floor(rec.expiresAt / 1000),
        issued_at:  Math.floor(rec.createdAt / 1000),
        ttl_seconds: TOKEN_TTL_MS / 1000,
        user: { id: rec.userId, plan },
        product_id: productId,
    });
}
