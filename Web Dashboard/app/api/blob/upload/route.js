// POST /api/blob/upload
//
// Client-token minting endpoint for Vercel Blob direct uploads. Called
// by `uploadPresigned()` from @vercel/blob/client in the browser BEFORE
// the actual file transfer, and again with a completion notification
// AFTER.
//
// We use handleUploadPresigned + issueSignedToken instead of the older
// handleUpload path because our Blob store is OIDC-only (no static
// BLOB_READ_WRITE_TOKEN). issueSignedToken picks up the OIDC creds
// Vercel injects at runtime and mints a scoped delegation token.
//
// Direct uploads let us push files > 4.5 MB (Vercel's serverless
// request-body cap) straight from the browser to blob storage.

import { issueSignedToken } from '@vercel/blob';
import { handleUploadPresigned } from '@vercel/blob/client';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
    const body = await request.json();
    try {
        const jsonResponse = await handleUploadPresigned({
            body,
            request,
            webhookPublicKey: process.env.BLOB_WEBHOOK_PUBLIC_KEY,
            getSignedToken: async (pathname, _clientPayload, _multipart) => {
                const token = await issueSignedToken({
                    pathname,
                    operations: ['put'],
                    maximumSizeInBytes: 512 * 1024 * 1024,
                });
                return { token };
            },
            onUploadCompleted: async ({ blob }) => {
                console.log('[blob] upload complete:', blob.pathname);
            },
        });
        return NextResponse.json(jsonResponse);
    } catch (e) {
        console.error('[blob/upload] error:', e);
        return NextResponse.json({ error: e.message }, { status: 400 });
    }
}
