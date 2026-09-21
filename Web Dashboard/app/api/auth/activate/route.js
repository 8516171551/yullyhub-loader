// POST /api/auth/activate
//
// Start the subscription timer on a license the caller already owns.
//
// The yully.wtf checkout writes the license row with activated_at NULL
// and expires_at NULL — the clock hasn't started yet. When the customer
// clicks "Activate Subscription" on the yullyhub.com dashboard, this
// endpoint stamps activated_at = NOW() and derives expires_at from
// duration_days. Idempotent: activating an already-running license just
// returns its current activation.
//
// Body: { key }
// Success: { ok:true, license_key, activated_at, expires_at }

import { NextResponse } from 'next/server';
import { currentSession, KEY_RE, getLicense } from '../../../../lib/auth.js';
import { q, q1 } from '../../../../lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const fail = (reason, code = 400) =>
    NextResponse.json({ ok: false, reason }, {
        status: code,
        headers: { 'Cache-Control': 'no-store' },
    });

export async function POST(request) {
    const s = await currentSession();
    if (!s || !s.user) return fail('not_signed_in', 401);

    let body = {};
    try { body = await request.json(); } catch {}
    const key = String(body?.key || '').trim().toUpperCase();
    if (!KEY_RE.test(key)) return fail('bad_key_format', 400);

    const lic = await getLicense(key);
    if (!lic)                                                    return fail('key_not_found', 404);
    if (!lic.active)                                             return fail('key_inactive', 403);
    if (lic.blacklisted_at)                                      return fail('key_blacklisted', 403);
    if (lic.redeemed_by_user_id && lic.redeemed_by_user_id !== s.user.id) {
        return fail('not_yours', 403);
    }
    if (lic.expires_at && new Date(lic.expires_at) < new Date()) return fail('key_expired', 403);

    // Idempotent — already running.
    if (lic.activated_at) {
        return NextResponse.json({
            ok: true,
            license_key: key,
            activated_at: lic.activated_at,
            expires_at:   lic.expires_at,
            already:      true,
        }, { headers: { 'Cache-Control': 'no-store' } });
    }

    // Bind to this user if not yet bound (a fresh key), then start the
    // clock. duration_days may be null for lifetime keys — leave
    // expires_at NULL in that case.
    if (!lic.redeemed_by_user_id) {
        await q(
            `UPDATE licenses
                SET redeemed_by_user_id = ?
              WHERE "key" = ? AND redeemed_by_user_id IS NULL`,
            [s.user.id, key],
        );
    }

    const days = Number(lic.duration_days || 0);
    if (days > 0) {
        await q(
            `UPDATE licenses
                SET activated_at = NOW(),
                    expires_at   = NOW() + (? || ' days')::interval
              WHERE "key" = ?`,
            [String(days), key],
        );
    } else {
        await q(
            `UPDATE licenses
                SET activated_at = NOW()
              WHERE "key" = ?`,
            [key],
        );
    }

    const fresh = await q1(
        `SELECT activated_at, expires_at FROM licenses WHERE "key" = ? LIMIT 1`,
        [key],
    );

    return NextResponse.json({
        ok: true,
        license_key: key,
        activated_at: fresh?.activated_at || null,
        expires_at:   fresh?.expires_at || null,
    }, { headers: { 'Cache-Control': 'no-store' } });
}
