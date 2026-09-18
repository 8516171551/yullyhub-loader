// POST /api/auth/login
//
// Body: { identifier, password?, hwid? }
//   - identifier is one of:
//       * license key "XXXX-XXXX-XXXX-XXXX"
//       * email address
//       * username
//   - password required unless identifier is a license key.
//
// Success sets the `yh_session` cookie (via web_sessions row with
// origin='yullyhub') and returns { ok:true, user }.

import { NextResponse } from 'next/server';
import {
    KEY_RE,
    findUserByIdentifier,
    findUserById,
    verifyPassword,
    getLicense,
    ensureSyntheticKeyUser,
    createSession,
} from '../../../../lib/auth.js';
import { q, hasDb } from '../../../../lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(reason, code = 401) {
    return NextResponse.json(
        { ok: false, reason },
        { status: code, headers: { 'Cache-Control': 'no-store' } }
    );
}

function toWireUser(u) {
    return {
        id:           u.id,
        email:        u.email,
        username:     u.username || null,
        role:         u.role,
        display_name: u.display_name || null,
    };
}

export async function POST(request) {
    if (!hasDb()) return fail('db_not_configured', 503);

    let body = {};
    try { body = await request.json(); } catch {}
    const identifier = String(body?.identifier || '').trim();
    const password   = String(body?.password || '');
    const hwid       = String(body?.hwid || '').slice(0, 255) || null;

    if (!identifier) return fail('missing_identifier', 400);

    // === License-key flow ===
    if (KEY_RE.test(identifier)) {
        const key = identifier.toUpperCase();
        const lic = await getLicense(key);
        if (!lic)                                                    return fail('key_not_found', 404);
        if (!lic.active)                                             return fail('key_inactive', 403);
        if (lic.blacklisted_at)                                      return fail('key_blacklisted', 403);
        if (lic.expires_at && new Date(lic.expires_at) < new Date()) return fail('key_expired', 403);
        if (lic.hwid && hwid && lic.hwid !== hwid)                   return fail('hwid_locked', 403);

        let user;
        if (lic.redeemed_by_user_id) {
            user = await findUserById(lic.redeemed_by_user_id);
            if (!user) return fail('user_missing', 500);
        } else {
            user = await ensureSyntheticKeyUser(key);
            await q(
                `UPDATE licenses
                    SET redeemed_by_user_id = ?
                  WHERE \`key\` = ? AND redeemed_by_user_id IS NULL`,
                [user.id, key]
            );
        }
        if (user.status && user.status !== 'active') return fail('user_' + user.status, 403);

        await createSession(user, request);
        return NextResponse.json(
            { ok: true, user: toWireUser(user), license_key: key },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    // === Email / username + password flow ===
    if (!password) return fail('missing_password', 400);

    const user = await findUserByIdentifier(identifier);
    if (!user)                                     return fail('invalid_credentials', 401);
    if (!user.password_hash)                       return fail('invalid_credentials', 401);
    if (user.status && user.status !== 'active')   return fail('user_' + user.status, 403);
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok)                                       return fail('invalid_credentials', 401);

    await createSession(user, request);
    return NextResponse.json(
        { ok: true, user: toWireUser(user) },
        { headers: { 'Cache-Control': 'no-store' } }
    );
}
