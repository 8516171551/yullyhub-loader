// Edge middleware — gates browser routes on the yh_session cookie.
//
// This runs at the edge, so it can't hit MySQL directly (mysql2 is a
// node-only module). It only checks whether the cookie EXISTS — the
// actual token → session row lookup happens in each route via lib/auth.js.
// That's enough to redirect unauth visitors off the dashboard fast and
// keep API 401s explicit.

import { NextResponse } from 'next/server';

export const config = {
    matcher: [
        '/api/products/:path*',
        '/api/command/:path*',
        '/api/blob/upload',
        '/api/loader/dispatch',
    ],
};

export function middleware(req) {
    const has = req.cookies.get('yh_session');
    if (has) return NextResponse.next();
    // For API routes return JSON 401; for page routes redirect to /login.
    if (req.nextUrl.pathname.startsWith('/api/')) {
        return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
}
