// Shared MySQL pool.
//
// yullyhub.com and yully.wtf share ONE MySQL database (yully). yullyhub
// owns everything prefixed `yh_` plus the `_yullyhub_readme` hint table.
// yully.wtf owns everything else (admins, applications, beta_applications,
// device_challenges, device_keys, licenses, reseller_audit, resellers,
// session_tokens, stripe_checkouts, stripe_events, ticket_messages,
// tickets). Both sides read `licenses` for auth; only yully.wtf writes it.
//
// The DATABASE_URL points at the shared VPS (mysql://yullyhub:...@ip:3306/yully).
// yully.wtf uses mysql://yully:yully@localhost:3306/yully.

import mysql from 'mysql2/promise';

const DB_URL = process.env.DATABASE_URL || '';

let pool = null;
let poolPromise = null;

function makePool() {
    if (!DB_URL) throw new Error('DATABASE_URL not set');
    // Parse mysql://user:pass@host:port/db
    const u = new URL(DB_URL);
    return mysql.createPool({
        host: u.hostname,
        port: Number(u.port || 3306),
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database: u.pathname.replace(/^\//, ''),
        connectionLimit: 5,
        connectTimeout: 8000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        multipleStatements: false,
        charset: 'utf8mb4',
    });
}

export function getPool() {
    if (pool) return pool;
    if (!DB_URL) return null; // caller can decide to fall back to Upstash
    if (!poolPromise) {
        try { pool = makePool(); poolPromise = Promise.resolve(pool); }
        catch (e) { poolPromise = Promise.reject(e); }
    }
    return pool;
}

export async function q(sql, params = []) {
    const p = getPool();
    if (!p) throw new Error('No DB pool (DATABASE_URL missing)');
    const [rows] = await p.execute(sql, params);
    return rows;
}

export async function q1(sql, params = []) {
    const rows = await q(sql, params);
    return rows[0] || null;
}

export function hasDb() {
    return !!DB_URL;
}
