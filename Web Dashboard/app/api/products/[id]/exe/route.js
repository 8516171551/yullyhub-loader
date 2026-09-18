import { NextResponse } from 'next/server';
import { issueSignedToken, presignUrl } from '@vercel/blob';
import { getProduct, safeId } from '../../../../../lib/product-store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Store is private → each read gets a fresh 5-minute presigned GET URL.
export async function GET(_request, { params }) {
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
