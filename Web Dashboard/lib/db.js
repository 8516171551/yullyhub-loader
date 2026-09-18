// Neon Postgres client — serverless HTTP driver, no pool required.
//
// Shared with yully.wtf. Schema owned in migrations/schema.pg.sql;
// see the `_readme` row (id=1) for ownership rules.
//
// Query helpers:
//   q(sql, params)  → rows array
//   q1(sql, params) → first row or null
//
// Placeholder shim: existing code base was written for mysql2 with `?`
// placeholders. To avoid touching every route, `?` in SQL is auto-rewritten
// to `$1, $2, ...` before it hits Postgres. New code can use `$N` directly.

import { neon } from '@neondatabase/serverless';

const DB_URL = process.env.DATABASE_URL || '';
export function hasDb() { return !!DB_URL; }

let _sql = null;
function client() {
    if (!_sql) {
        if (!DB_URL) throw new Error('DATABASE_URL not set');
        _sql = neon(DB_URL);
    }
    return _sql;
}

function convertPlaceholders(sql) {
    // Replace unquoted `?` with $1, $2, ... Any `?` inside a single-quoted
    // string literal is preserved. This is the same rewrite pattern
    // pg-promise uses when adapting mysql-style code.
    let i = 0, out = '', inStr = false, prev = '';
    for (const ch of sql) {
        if (ch === "'" && prev !== '\\') inStr = !inStr;
        if (ch === '?' && !inStr) { i += 1; out += '$' + i; }
        else out += ch;
        prev = ch;
    }
    return out;
}

export async function q(sql, params = []) {
    const c = client();
    const rewritten = convertPlaceholders(sql);
    // neon() returns rows directly.
    const rows = await c.query(rewritten, params);
    return rows.rows ?? rows;
}

export async function q1(sql, params = []) {
    const rows = await q(sql, params);
    return rows[0] || null;
}

// Kept for legacy imports that expected a pool-shaped object. No-op.
export function getPool() { return client(); }
