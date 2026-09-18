import { NextResponse } from 'next/server';
import { getProduct, safeId } from '../../../../../lib/product-store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Returns the product's .exe bytes. Vercel Blob is CDN-fronted, so
// rather than pipe bytes through this lambda we hand the loader a 302
// straight to the blob URL.
export async function GET(_request, { params }) {
    const id = safeId(params.id);
    if (!id) return new Response('bad id', { status: 400 });
    const meta = await getProduct(id);
    if (!meta || !meta.exeUrl) return new Response('not found', { status: 404 });
    return NextResponse.redirect(meta.exeUrl, 302);
}
