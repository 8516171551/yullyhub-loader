// POST /api/blob/upload
//
// Client-token minting endpoint for Vercel Blob direct uploads. Called
// by `upload()` from @vercel/blob/client in the browser BEFORE the
// actual file transfer, and again with a completion notification AFTER.
//
// Direct uploads let us push files > 4.5 MB (Vercel's default request
// body limit for serverless functions) straight from the browser to the
// blob storage bucket — bypassing this lambda entirely for the bytes.
// We only ever handle the metadata + short signed token.

import { handleUpload } from '@vercel/blob/client';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
    const body = await request.json();
    try {
        const jsonResponse = await handleUpload({
            body,
            request,
            onBeforeGenerateToken: async (pathname /*, clientPayload */) => ({
                // Product exes, images, or Poppins-style asset files.
                allowedContentTypes: [
                    'application/vnd.microsoft.portable-executable',
                    'application/octet-stream',
                    'application/x-msdownload',
                    'image/*',
                ],
                // 512 MB cap per single upload — plenty for a product exe.
                maximumSizeInBytes: 512 * 1024 * 1024,
                tokenPayload: JSON.stringify({ pathname }),
            }),
            onUploadCompleted: async ({ blob /*, tokenPayload */ }) => {
                // Nothing to do server-side yet — the client immediately
                // POSTs the resulting blob URL to /api/products so we can
                // persist the full product meta record.
                console.log('[blob] upload complete:', blob.url);
            },
        });
        return NextResponse.json(jsonResponse);
    } catch (e) {
        return NextResponse.json({ error: e.message }, { status: 400 });
    }
}
