import { NextResponse } from 'next/server';
import { listProducts, createProduct, createProductFromUrls } from '../../../lib/product-store.js';
import { currentSession } from '../../../lib/auth.js';
import { q } from '../../../lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const s = await currentSession();
        const all = await listProducts();

        // Anonymous / no session — return empty. The dashboard requires
        // sign-in to see anything anyway.
        if (!s || !s.user) return NextResponse.json({ products: [] });

        // Admins see everything (they use the same UI to manage the
        // catalog). Everyone else sees only products they hold at least
        // one active, non-expired license for.
        if (s.user.role === 'admin') {
            return NextResponse.json({ products: all });
        }

        const owned = await q(
            `SELECT DISTINCT product_id
               FROM licenses
              WHERE redeemed_by_user_id = ?
                AND (active IS NULL OR active = TRUE)
                AND blacklisted_at IS NULL
                AND (expires_at IS NULL OR expires_at > NOW())`,
            [s.user.id],
        );
        const ownedIds = new Set(owned.map((r) => String(r.product_id)));
        const products = all.filter((p) => ownedIds.has(String(p.id)));
        return NextResponse.json({ products });
    } catch (e) {
        return NextResponse.json({ products: [], error: e.message }, { status: 500 });
    }
}

// Two modes:
//   * application/json  → payload has {exeUrl, exeName, exeSize, imageUrl?, imageMime?, imageName?, title?}
//                         The client already streamed the bytes straight to
//                         Vercel Blob via @vercel/blob/client.upload(). We
//                         just register the meta record. Preferred for exes
//                         > 4.5 MB (Vercel's serverless body cap).
//   * multipart/form-data → small files sent directly through this lambda.
//                         Kept for backwards-compat / <4.5MB uploads.
export async function POST(request) {
    try {
        const ct = (request.headers.get('content-type') || '').toLowerCase();
        if (ct.startsWith('application/json')) {
            const body = await request.json();
            const meta = await createProductFromUrls(body);
            return NextResponse.json(meta);
        }
        const form = await request.formData();
        const meta = await createProduct({
            exe:   form.get('exe'),
            image: form.get('image'),
            title: (form.get('title') || '').toString(),
        });
        return NextResponse.json(meta);
    } catch (e) {
        return NextResponse.json({ error: e.message || 'upload failed' }, { status: 400 });
    }
}
