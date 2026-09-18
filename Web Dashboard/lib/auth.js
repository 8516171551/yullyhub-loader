// auth.js — session cookies + login helpers (unified schema).
//
// Cookie:  `yh_session` = 64-hex session token, matches web_sessions.session_token.
// web_sessions rows always carry origin='yullyhub' when created here — the
// other origin ('yullywtf') is written by the yully.wtf codebase against
// the same DB.
//
// Identity is a users.id (users table). No more identity_type/identity_ref.
// currentSession() joins users so callers can read role/email/username.

import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { cookies } from 'next/headers';
import { q, q1, hasDb } from './db.js';

export const SESSION_COOKIE = 'yh_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
export const SESSION_ORIGIN  = 'yullyhub';

const KEY_RE = /^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/i;
export { KEY_RE };

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

// Look up a user by email OR username (case-insensitive email).
export async function findUserByIdentifier(identifier) {
    if (!hasDb() || !identifier) return null;
    const id = String(identifier).trim();
    if (id.includes('@')) {
        return await q1(
            `SELECT id, email, username, password_hash, role, status, display_name
               FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`,
            [id]
        );
    }
    return await q1(
        `SELECT id, email, username, password_hash, role, status, display_name
           FROM users WHERE username = ? LIMIT 1`,
        [id]
    );
}

// Look up user by id.
export async function findUserById(userId) {
    if (!hasDb() || !userId) return null;
    return await q1(
        `SELECT id, email, username, password_hash, role, status, display_name
           FROM users WHERE id = ? LIMIT 1`,
        [userId]
    );
}

// Fetch a license row for auth checks.
export async function getLicense(key) {
    if (!hasDb() || !key) return null;
    return await q1(
        `SELECT "key", product_id, tier, duration_days, reseller_id,
                redeemed_by_user_id, activated_at, expires_at, hwid,
                ip_lock, max_devices, active, blacklisted_at
           FROM licenses WHERE "key" = ? LIMIT 1`,
        [key]
    );
}

// Create a synthetic customer user for a bare license key. Used when a
// customer logs in with a key that no user has ever redeemed. Idempotent:
// re-uses an existing synthetic user with the same email if one already
// exists.
export async function ensureSyntheticKeyUser(key) {
    if (!hasDb() || !key) throw new Error('bad state');
    const email = `license-${key.toUpperCase()}@fbo.foundation`;
    const existing = await q1(
        `SELECT id, email, username, role, status, display_name
           FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`,
        [email]
    );
    if (existing) return existing;
    const id = crypto.randomUUID();
    await q(
        `INSERT INTO users (id, email, password_hash, role, status, display_name)
         VALUES (?, ?, NULL, 'customer', 'active', ?)`,
        [id, email, `Key ${key.toUpperCase()}`]
    );
    return await q1(
        `SELECT id, email, username, role, status, display_name
           FROM users WHERE id = ? LIMIT 1`,
        [id]
    );
}

// Create a session row + set cookie. Returns the session token.
export async function createSession(user, req) {
    if (!hasDb()) throw new Error('no db');
    if (!user || !user.id) throw new Error('no user');
    const sessionId    = crypto.randomUUID();
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const ua           = String(req?.headers?.get?.('user-agent') || '').slice(0, 500);
    const ip           = ipOf(req);

    await q(
        `INSERT INTO web_sessions
            (id, session_token, user_id, origin, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [sessionId, sessionToken, user.id, SESSION_ORIGIN, ip, ua]
    );
    await q(`UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?`, [user.id]).catch(() => {});
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

// Read the current session from cookie. Returns a joined session+user row,
// or null when there is no live session.
export async function currentSession() {
    if (!hasDb()) return null;
    let tok = null;
    try {
        const jar = await cookies();
        tok = jar.get(SESSION_COOKIE)?.value || null;
    } catch { tok = null; }
    if (!tok) return null;
    const row = await q1(
        `SELECT s.id            AS session_id,
                s.session_token,
                s.user_id,
                s.origin,
                s.ip,
                s.user_agent,
                s.created_at,
                s.last_used_at,
                s.expires_at,
                s.revoked_at,
                u.email         AS user_email,
                u.username      AS user_username,
                u.role          AS user_role,
                u.status        AS user_status,
                u.display_name  AS user_display_name
           FROM web_sessions s
      LEFT JOIN users u ON u.id = s.user_id
          WHERE s.session_token = ? AND s.revoked_at IS NULL
          LIMIT 1`,
        [tok]
    );
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
    if (row.user_status && row.user_status !== 'active') return null;

    // touch last_used_at (best-effort)
    q(`UPDATE web_sessions SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.session_id]).catch(() => {});

    return {
        session_id:    row.session_id,
        session_token: row.session_token,
        user_id:       row.user_id,
        origin:        row.origin,
        user: {
            id:           row.user_id,
            email:        row.user_email,
            username:     row.user_username,
            role:         row.user_role,
            status:       row.user_status,
            display_name: row.user_display_name,
        },
    };
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
        await q(
            `UPDATE web_sessions
                SET revoked_at = CURRENT_TIMESTAMP
              WHERE session_token = ? AND revoked_at IS NULL`,
            [tok]
        );
    }
}

// For API routes that need "must be logged in" — throws with .code=401.
export async function requireSession() {
    const s = await currentSession();
    if (!s) {
        const err = new Error('unauthorized');
        err.code = 401;
        throw err;
    }
    return s;
}
