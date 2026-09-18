import { NextResponse } from 'next/server';
import { listProducts, createProduct } from '../../../lib/product-store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const products = await listProducts();
        return NextResponse.json({ products });
    } catch (e) {
        return NextResponse.json({ products: [], error: e.message }, { status: 500 });
    }
}

export async function POST(request) {
    try {
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
