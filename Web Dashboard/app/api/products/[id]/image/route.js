import { NextResponse } from 'next/server';
import { issueSignedToken, presignUrl } from '@vercel/blob';
import { getProduct, safeId } from '../../../../../lib/product-store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request, { params }) {
    const id = safeId(params.id);
    if (!id) return new Response('bad id', { status: 400 });
    const meta = await getProduct(id);
    if (!meta || !meta.imagePathname) return new Response('not found', { status: 404 });
    try {
        const validUntil = Date.now() + 60 * 60 * 1000;
        const token = await issueSignedToken({
            pathname:   meta.imagePathname,
            operations: ['get'],
            validUntil,
        });
        const { presignedUrl } = await presignUrl(token, {
            operation: 'get',
            pathname:  meta.imagePathname,
            access:    'public',
        });
        return NextResponse.redirect(presignedUrl, 302);
    } catch (e) {
        return new Response('presign failed: ' + e.message, { status: 500 });
    }
}
