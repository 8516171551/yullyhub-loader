// auth.js — session cookies + login helpers.
//
// One cookie: `yh_session` = 64-hex session token, matches yh_web_sessions.session_token.
// Sessions can be linked to:
//   - a yully.wtf admin (identity_type='admin')
//   - a yully.wtf reseller (identity_type='reseller')
//   - a license-key holder (identity_type='key' + license_key set)
//
// The license_key column on yh_web_sessions is also filled when an
// admin/reseller has claimed a specific key, so downstream code can
// always find the key via `session.license_key`.

import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { cookies } from 'next/headers';
import { q, q1, hasDb } from './db.js';

export const SESSION_COOKIE = 'yh_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const KEY_RE = /^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/i;

function ipOf(req) {
    const xff = req?.headers?.get?.('x-forwarded-for') || '';
    return xff.split(',')[0].trim() || req?.headers?.get?.('x-real-ip') || '';
}

// Verify plaintext password against a bcrypt $2a$/$2b$ hash from the DB.
export async function verifyPassword(plain, hash) {
    if (!plain || !hash) return false;
    try { return await bcrypt.compare(String(plain), String(hash)); }
    catch { return false; }
}

// Resolve an identifier to { type, ref, license_key }. Order:
//   1) license key format → identity_type='key'
//   2) admin username     → identity_type='admin'
//   3) reseller username  → identity_type='reseller'
// Returns null if nothing matches OR password check fails.
export async function authenticate({ identifier, password, hwid }) {
    if (!hasDb() || !identifier) return null;
    const id = String(identifier).trim();

    if (KEY_RE.test(id)) {
        const key = id.toUpperCase();
        const lic = await q1(
            `SELECT \`key\`, active, blacklisted_at, expires_at, hwid
               FROM licenses WHERE \`key\` = ?`,
            [key]
        );
        if (!lic) return { error: 'key_not_found' };
        if (!lic.active) return { error: 'key_inactive' };
        if (lic.blacklisted_at) return { error: 'key_blacklisted' };
        if (lic.expires_at && new Date(lic.expires_at) < new Date()) return { error: 'key_expired' };
        if (lic.hwid && hwid && lic.hwid !== hwid) return { error: 'hwid_locked' };
        return { type: 'key', ref: key, license_key: key };
    }

    // Try admins
    const admin = await q1('SELECT username, pass_hash FROM admins WHERE username = ?', [id]);
    if (admin && await verifyPassword(password, admin.pass_hash)) {
        return { type: 'admin', ref: admin.username, license_key: null };
    }

    // Try resellers
    const reseller = await q1(
        'SELECT id, username, pass_hash FROM resellers WHERE username = ? AND active = 1 AND blacklisted = 0',
        [id]
    );
    if (reseller && await verifyPassword(password, reseller.pass_hash)) {
        return { type: 'reseller', ref: reseller.username, license_key: null };
    }

    return { error: 'invalid_credentials' };
}

// Create a session row + set cookie. Returns the session token.
export async function createSession(identity, req) {
    if (!hasDb()) throw new Error('no db');
    const sessionId    = crypto.randomUUID();
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const ua           = String(req?.headers?.get?.('user-agent') || '').slice(0, 500);
    const ip           = ipOf(req);

    await q(
        `INSERT INTO yh_web_sessions
            (id, session_token, identity_type, identity_ref, license_key, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, sessionToken, identity.type, identity.ref, identity.license_key, ip, ua]
    );
    // NB: cookies() is a Next 15 async import in some contexts; keep both paths.
    const jar = await cookies();
    jar.set(SESSION_COOKIE, sessionToken, {
        httpOnly: true,
        secure:   true,
        sameSite: 'lax',
        path:     '/',
        maxAge:   SESSION_MAX_AGE,
    });
    return sessionToken;
}

// Read the current session from cookie. Returns null if none/invalid/revoked.
export async function currentSession() {
    if (!hasDb()) return null;
    let tok = null;
    try {
        const jar = await cookies();
        tok = jar.get(SESSION_COOKIE)?.value || null;
    } catch { tok = null; }
    if (!tok) return null;
    const row = await q1(
        `SELECT s.*, l.active AS lic_active, l.blacklisted_at, l.expires_at AS lic_expires_at
           FROM yh_web_sessions s
      LEFT JOIN licenses l ON l.\`key\` = s.license_key
          WHERE s.session_token = ? AND s.revoked_at IS NULL
          LIMIT 1`,
        [tok]
    );
    if (!row) return null;
    // Extra hard-gate: if the session is a key session, the underlying
    // license must still be alive. Admins/resellers stay alive as long as
    // the session row is unrevoked.
    if (row.identity_type === 'key') {
        if (!row.lic_active || row.blacklisted_at) return null;
        if (row.lic_expires_at && new Date(row.lic_expires_at) < new Date()) return null;
    }
    // touch last_used_at (best-effort)
    q(`UPDATE yh_web_sessions SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id]).catch(() => {});
    return row;
}

export async function revokeCurrentSession() {
    if (!hasDb()) return;
    let tok = null;
    try {
        const jar = await cookies();
        tok = jar.get(SESSION_COOKIE)?.value || null;
        jar.delete(SESSION_COOKIE);
    } catch {}
    if (tok) {
        await q(`UPDATE yh_web_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE session_token = ?`, [tok]);
    }
}

// For API routes that need "must be logged in" — throws NextResponse-safe error info.
export async function requireSession() {
    const s = await currentSession();
    if (!s) {
        const err = new Error('unauthorized');
        err.code = 401;
        throw err;
    }
    return s;
}
