// GET /api/auth/me
//
// Returns the currently logged-in user (via yh_session cookie -> web_sessions).
// Shape: { ok:true, user: { id, email, username, role, display_name } }.

import { NextResponse } from 'next/server';
import { currentSession } from '../../../../lib/auth.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
    const s = await currentSession();
    if (!s || !s.user) {
        return NextResponse.json({ ok: false }, {
            status: 401,
            headers: { 'Cache-Control': 'no-store' },
        });
    }
    return NextResponse.json({
        ok:   true,
        user: {
            id:           s.user.id,
            email:        s.user.email,
            username:     s.user.username || null,
            role:         s.user.role,
            display_name: s.user.display_name || null,
        },
    }, { headers: { 'Cache-Control': 'no-store' } });
}
