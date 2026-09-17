// In-memory exchange-token store.
//
// Shared across API routes via `globalThis` so Next.js's per-route module
// isolation doesn't split the store into two disconnected Maps. Not
// production-grade — swap this out for a real KV / Postgres row when you
// hook it up to a proper backend. The shape and lifecycle stay the same.
//
// Record shape:
//   {
//     token:       string          — the opaque token the product receives
//     userId:      string          — who this belongs to
//     productId:   string | null   — which product this token authorises
//     subscription:{
//       plan: 'lifetime' | 'monthly' | ...
//       active: boolean
//       expires_at: number | null   — unix seconds, null for lifetime
//     }
//     createdAt:   number (ms)
//     expiresAt:   number (ms)      — token TTL, NOT the subscription
//     usedAt?:     number (ms)      — set on first successful handshake
//   }

import { randomBytes } from 'crypto';

// TTL for the exchange token itself (short — it's meant to be one-shot).
export const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

if (!globalThis.__yh_tokens) globalThis.__yh_tokens = new Map();
/** @type {Map<string, any>} */
export const tokens = globalThis.__yh_tokens;

export function newToken() {
    return randomBytes(24).toString('hex');
}

export function issueToken({ userId = 'demo-user', productId = null,
                             subscription = { plan: 'lifetime', active: true, expires_at: null } } = {}) {
    const token = newToken();
    const now = Date.now();
    tokens.set(token, {
        token,
        userId,
        productId,
        subscription,
        createdAt: now,
        expiresAt: now + TOKEN_TTL_MS,
    });
    return tokens.get(token);
}

export function redeemToken(token, { markUsed = true } = {}) {
    if (!token) return { ok: false, reason: 'missing' };
    const rec = tokens.get(token);
    if (!rec) return { ok: false, reason: 'unknown' };
    if (Date.now() > rec.expiresAt) {
        tokens.delete(token);
        return { ok: false, reason: 'expired' };
    }
    if (markUsed && !rec.usedAt) rec.usedAt = Date.now();
    return { ok: true, record: rec };
}

// Housekeeping — sweep expired entries when we get a chance.
export function sweep() {
    const now = Date.now();
    for (const [k, v] of tokens) if (now > v.expiresAt) tokens.delete(k);
}
