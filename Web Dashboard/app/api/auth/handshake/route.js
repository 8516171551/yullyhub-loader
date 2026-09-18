// POST /api/auth/handshake
//
// The landing page POSTs the license key the user typed in. We validate
// against the shared `licenses` table (yully.wtf owns writes, yullyhub
// activates on first use). On success we mint a session row in
// loader_sessions and return a token the loader passes to
// /api/auth/heartbeat every ~30s.
//
// Request:  { key: "XXXX-XXXX-XXXX-XXXX", hwid?: "...", loaderId?: "..." }
// Response: { ok: true, token, loaderId, tier, expires_at }
//        or { ok: false, reason }

import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { q, q1, hasDb } from '../../../../lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEY_RE = /^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/i;

function fail(reason, code = 400) {
    return NextResponse.json({ ok: false, reason }, {
        status: code,
        headers: { 'Cache-Control': 'no-store' },
    });
}

function clientIp(req) {
    const xff = req.headers.get('x-forwarded-for') || '';
    return xff.split(',')[0].trim() || req.headers.get('x-real-ip') || '';
}

export async function POST(request) {
    if (!hasDb()) return fail('db_not_configured', 503);

    let body = {};
    try { body = await request.json(); } catch {}
    const key      = String(body.key || '').trim().toUpperCase();
    const hwid     = String(body.hwid || '').slice(0, 255) || null;
    const loaderId = String(body.loaderId || '').slice(0, 80) ||
                     crypto.randomBytes(8).toString('hex');

    if (!KEY_RE.test(key)) return fail('invalid_key_format');

    const lic = await q1(
        `SELECT \`key\`, active, blacklisted_at, expires_at, activated_at,
                duration_days, tier, hwid, ip_lock, max_devices,
                redeemed_by_user_id
         FROM licenses WHERE \`key\` = ?`,
        [key]
    );
    if (!lic) return fail('key_not_found', 404);

    const now = new Date();

    if (!lic.active)                                          return fail('key_inactive', 403);
    if (lic.blacklisted_at)                                   return fail('key_blacklisted', 403);
    if (lic.expires_at && new Date(lic.expires_at) < now)     return fail('key_expired', 403);
    if (lic.hwid && hwid && lic.hwid !== hwid)                return fail('hwid_locked', 403);

    // First-use activation: stamp activated_at + expires_at + hwid on the
    // license row.
    if (!lic.activated_at) {
        const expiresAt = lic.duration_days
            ? new Date(now.getTime() + lic.duration_days * 86400 * 1000)
            : null;
        await q(
            `UPDATE licenses
                SET activated_at = ?, expires_at = COALESCE(expires_at, ?), hwid = COALESCE(hwid, ?)
              WHERE \`key\` = ? AND activated_at IS NULL`,
            [now, expiresAt, hwid, key]
        );
        lic.activated_at = now;
        if (!lic.expires_at) lic.expires_at = expiresAt;
    }

    // Mint session token.
    const sessionId    = crypto.randomUUID();
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const ip           = clientIp(request);
    const ua           = String(request.headers.get('user-agent') || '').slice(0, 500);

    // Revoke prior live sessions for this key — one active session per key.
    await q(
        `UPDATE loader_sessions SET revoked_at = ?
           WHERE license_key = ? AND revoked_at IS NULL`,
        [now, key]
    );
    await q(
        `INSERT INTO loader_sessions
            (id, license_key, loader_id, session_token, user_id, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, key, loaderId, sessionToken, lic.redeemed_by_user_id || null, ip, ua]
    );

    return NextResponse.json({
        ok:         true,
        token:      sessionToken,
        loaderId,
        tier:       lic.tier,
        expires_at: lic.expires_at ? Math.floor(new Date(lic.expires_at).getTime() / 1000) : null,
    }, { headers: { 'Cache-Control': 'no-store' } });
}
