// POST /api/auth/redeem
//
// Bind a license key to the currently signed-in user. Used from the
// dashboard when a customer already has a session (email/password login,
// or a previous key redemption) and wants to add another key to their
// account — a gift, a top-up, whatever.
//
// Body: { key: "XXXX-XXXX-XXXX-XXXX" }
// Success: { ok: true, product: { id, name } | null, license_key }
//
// Rules:
//   - key must exist and be active + not blacklisted + not expired
//   - if the license is already bound to a DIFFERENT user → 409
//   - if the license is already bound to THIS user → idempotent success
//   - otherwise: set redeemed_by_user_id = current user

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
    if (lic.expires_at && new Date(lic.expires_at) < new Date()) return fail('key_expired', 403);

    if (lic.redeemed_by_user_id && lic.redeemed_by_user_id !== s.user.id) {
        return fail('key_already_redeemed', 409);
    }

    if (!lic.redeemed_by_user_id) {
        await q(
            `UPDATE licenses
                SET redeemed_by_user_id = ?
              WHERE "key" = ? AND redeemed_by_user_id IS NULL`,
            [s.user.id, key],
        );
    }

    const product = await q1(
        `SELECT id, name, slug FROM products WHERE id = ? LIMIT 1`,
        [lic.product_id],
    );

    return NextResponse.json({
        ok: true,
        license_key: key,
        product: product ? { id: product.id, name: product.name, slug: product.slug } : null,
    }, { headers: { 'Cache-Control': 'no-store' } });
}
