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

        // Every user — admins included — only sees products they hold a
        // live license for on the customer-facing rail. The full catalog
        // is available under the Admin tab (a separate view).
        // For each licensed product we surface the "best" license bound
        // to the user: prefer an already-activated one (subscription is
        // running), otherwise the newest pending one so the UI can show
        // an Activate Subscription button.
        const rows = await q(
            `SELECT DISTINCT ON (product_id)
                    product_id,
                    "key"         AS license_key,
                    tier,
                    duration_days,
                    activated_at,
                    expires_at
               FROM licenses
              WHERE redeemed_by_user_id = ?
                AND (active IS NULL OR active = TRUE)
                AND blacklisted_at IS NULL
                AND (expires_at IS NULL OR expires_at > NOW())
              ORDER BY product_id,
                       (activated_at IS NULL) ASC,  -- activated first
                       created_at DESC`,
            [s.user.id],
        );
        const byProduct = new Map();
        for (const r of rows) byProduct.set(String(r.product_id), r);

        const products = all
            .filter((p) => byProduct.has(String(p.id)))
            .map((p) => {
                const lic = byProduct.get(String(p.id));
                return {
                    ...p,
                    license: {
                        key:            lic.license_key,
                        tier:           lic.tier,
                        duration_days:  lic.duration_days,
                        activated_at:   lic.activated_at,
                        expires_at:     lic.expires_at,
                        status: lic.activated_at
                            ? 'active'
                            : 'pending',
                    },
                };
            });
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
