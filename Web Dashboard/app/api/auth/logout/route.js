import { NextResponse } from 'next/server';
import { revokeCurrentSession } from '../../../../lib/auth.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
    await revokeCurrentSession();
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
