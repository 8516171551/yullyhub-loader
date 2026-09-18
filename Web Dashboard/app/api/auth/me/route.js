import { NextResponse } from 'next/server';
import { currentSession } from '../../../../lib/auth.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
    const s = await currentSession();
    if (!s) return NextResponse.json({ ok: false }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json({
        ok:           true,
        identity_type: s.identity_type,
        identity_ref:  s.identity_ref,
        license_key:   s.license_key,
    }, { headers: { 'Cache-Control': 'no-store' } });
}
