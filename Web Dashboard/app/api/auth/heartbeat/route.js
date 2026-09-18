// POST /api/auth/heartbeat
//
// The C++ loader calls this every 30s while a product is running. If we
// respond { valid: false, reason } the loader hard-kills the product AND
// itself.
//
// Request:  { token, loaderId, productId }
// Response: { valid: boolean, reason?: string, ttl_seconds: number }
//
// Validates BOTH the yh_loader_sessions row (not revoked) AND the parent
// licenses row (still active, not blacklisted, not expired). If either
// says no, the loader dies.
//
// Fail-open ONLY on transient DB errors (network blip) — never on
// "session not found", because that would let revoked tokens keep
// running products.

import { NextResponse } from 'next/server';
import { q, q1, hasDb } from '../../../../lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OK  = (extra = {}) => NextResponse.json(
    { valid: true, ttl_seconds: 30, ...extra },
    { headers: { 'Cache-Control': 'no-store' } }
);
const NO  = (reason) => NextResponse.json(
    { valid: false, reason },
    { headers: { 'Cache-Control': 'no-store' } }
);

export async function POST(request) {
    let body = {};
    try { body = await request.json(); } catch {}
    const { token = '', loaderId = '', productId = '' } = body || {};

    if (!hasDb()) {
        // Without a DB we have no source of truth — fail-open so we don't
        // wrongly kill users. Prod deploys should always have DATABASE_URL.
        return OK({ note: 'db-not-configured (fail-open)' });
    }
    if (!token) return NO('missing_token');

    let row;
    try {
        row = await q1(
            `SELECT s.license_key, s.revoked_at,
                    l.active     AS lic_active,
                    l.blacklisted_at,
                    l.expires_at
             FROM yh_loader_sessions s
             LEFT JOIN licenses l ON l.\`key\` = s.license_key
             WHERE s.session_token = ?`,
            [token]
        );
    } catch (e) {
        // Transient — fail-open. Loader will re-check in 30s.
        return OK({ note: 'db-error (fail-open)', error: String(e.message || e) });
    }

    if (!row)                                                    return NO('session_not_found');
    if (row.revoked_at)                                          return NO('session_revoked');
    if (!row.lic_active)                                         return NO('key_inactive');
    if (row.blacklisted_at)                                      return NO('key_blacklisted');
    if (row.expires_at && new Date(row.expires_at) < new Date()) return NO('key_expired');

    // Touch last_seen_at + record active product (best-effort).
    try {
        await q(
            `UPDATE yh_loader_sessions
                SET last_seen_at = CURRENT_TIMESTAMP,
                    active_product = COALESCE(?, active_product)
              WHERE session_token = ?`,
            [productId || null, token]
        );
    } catch {}

    return OK({ license_key: row.license_key });
}
