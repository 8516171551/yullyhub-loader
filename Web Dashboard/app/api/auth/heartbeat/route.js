// POST /api/auth/heartbeat
//
// The C++ loader calls this every 30s while a product is running. If we
// respond { valid: false, reason } the loader hard-kills the product AND
// itself. Ideal place to enforce subscription expiry, per-product
// entitlements, kill-switches for banned accounts, etc.
//
// Request body: { token, loaderId, productId }
// Response:     { valid: boolean, reason?: string, ttl_seconds: number }
//
// MVP behaviour: we look the exchange token up in the shared token store.
// If found + subscription.active + not past subscription.expires_at →
// valid. If subscription is explicitly inactive or expired → invalid.
// Missing token → fail-open (valid) so a serverless cold-instance whose
// in-memory token map is empty doesn't wrongly kill an active session.
// Swap in a durable subscription DB once real billing is wired.

import { NextResponse } from 'next/server';
import { tokens } from '../../../../lib/token-store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
    let body = {};
    try { body = await request.json(); } catch {}
    const { token = '', loaderId = '', productId = '' } = body || {};

    const rec = token ? tokens.get(token) : null;
    if (!rec) {
        // Fail-open — see note above. Do NOT tell the loader to die just
        // because we lost sight of the token.
        return NextResponse.json({
            valid: true, ttl_seconds: 30,
            note: 'token-not-found (fail-open)',
        }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const sub = rec.subscription || {};
    const nowSec = Math.floor(Date.now() / 1000);
    if (sub.active === false) {
        return NextResponse.json({ valid: false, reason: 'subscription_inactive' },
            { headers: { 'Cache-Control': 'no-store' } });
    }
    if (sub.expires_at && sub.expires_at < nowSec) {
        return NextResponse.json({ valid: false, reason: 'subscription_expired' },
            { headers: { 'Cache-Control': 'no-store' } });
    }
    if (rec.productId && productId && rec.productId !== productId) {
        return NextResponse.json({ valid: false, reason: 'product_mismatch' },
            { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json({
        valid:       true,
        ttl_seconds: 30,
        user_id:     rec.userId,
        product_id:  rec.productId,
        plan:        sub.plan || null,
    }, { headers: { 'Cache-Control': 'no-store' } });
}
