import { NextResponse } from 'next/server';
import { issueSignedToken, presignUrl } from '@vercel/blob';
import { getProduct, safeId } from '../../../../../lib/product-store.js';
import { currentSession } from '../../../../../lib/auth.js';
import { q1, hasDb } from '../../../../../lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Gate: either a valid browser session cookie OR a valid loader-session
// Bearer token in Authorization. Anonymous callers get 401.
async function gate(request) {
    // Loader flow: Authorization: Bearer <loader_sessions.session_token>
    const auth = request.headers.get('authorization') || '';
    const m = auth.match(/^Bearer\s+([a-f0-9]{16,96})$/i);
    if (m && hasDb()) {
        const row = await q1(
            `SELECT s.session_token, s.revoked_at, s.license_key,
                    l.active, l.blacklisted_at, l.expires_at
               FROM loader_sessions s
          LEFT JOIN licenses l ON l."key" = s.license_key
              WHERE s.session_token = ?`,
            [m[1]]
        );
        if (row && !row.revoked_at
            && (!row.license_key || (row.active && !row.blacklisted_at
                && !(row.expires_at && new Date(row.expires_at) < new Date())))) {
            return true;
        }
    }
    // Browser flow: yh_session cookie
    const sess = await currentSession();
    return !!sess;
}

// Store is private → each read gets a fresh 5-minute presigned GET URL.
export async function GET(request, { params }) {
    if (!(await gate(request))) return new Response('unauthorized', { status: 401 });
    const id = safeId(params.id);
    if (!id) return new Response('bad id', { status: 400 });
    const meta = await getProduct(id);
    if (!meta || !meta.exePathname) return new Response('not found', { status: 404 });
    try {
        const validUntil = Date.now() + 5 * 60 * 1000;
        const token = await issueSignedToken({
            pathname:   meta.exePathname,
            operations: ['get'],
            validUntil,
        });
        // Files were uploaded with access:'public' via the client
        // presigned flow → CDN URL is served from the public path
        // even though the STORE default is private.
        const { presignedUrl } = await presignUrl(token, {
            operation: 'get',
            pathname:  meta.exePathname,
            access:    'public',
        });
        return NextResponse.redirect(presignedUrl, 302);
    } catch (e) {
        return new Response('presign failed: ' + e.message, { status: 500 });
    }
}
