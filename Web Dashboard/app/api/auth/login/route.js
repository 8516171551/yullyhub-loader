// POST /api/auth/login
//
// Body: { identifier, password?, hwid? }
//   - identifier is either "XXXX-XXXX-XXXX-XXXX" (license key) or a
//     yully.wtf admin/reseller username.
//   - password required for admin/reseller. Ignored for key login.
//
// Success sets the `yh_session` cookie and returns { ok:true, identity }.

import { NextResponse } from 'next/server';
import { authenticate, createSession } from '../../../../lib/auth.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
    let body = {};
    try { body = await request.json(); } catch {}
    const { identifier = '', password = '', hwid = '' } = body || {};

    const res = await authenticate({ identifier, password, hwid });
    if (!res || res.error) {
        return NextResponse.json(
            { ok: false, reason: res?.error || 'invalid_credentials' },
            { status: 401, headers: { 'Cache-Control': 'no-store' } }
        );
    }
    await createSession(res, request);
    return NextResponse.json(
        { ok: true, identity: { type: res.type, ref: res.ref, license_key: res.license_key } },
        { headers: { 'Cache-Control': 'no-store' } }
    );
}
