import { NextResponse } from 'next/server';
import {
    getProduct, updateProduct, deleteProduct, safeId,
} from '../../../../lib/product-store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request, { params }) {
    const id = safeId(params.id);
    if (!id) return NextResponse.json({ error: 'bad id' }, { status: 400 });
    const meta = await getProduct(id);
    if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(meta);
}

export async function DELETE(_request, { params }) {
    const id = safeId(params.id);
    if (!id) return NextResponse.json({ error: 'bad id' }, { status: 400 });
    await deleteProduct(id);
    return NextResponse.json({ ok: true });
}

export async function PUT(request, { params }) {
    const id = safeId(params.id);
    if (!id) return NextResponse.json({ error: 'bad id' }, { status: 400 });
    const form = await request.formData();

    let script;
    const scriptRaw = form.get('script');
    if (scriptRaw != null) {
        try {
            const parsed = typeof scriptRaw === 'string' ? JSON.parse(scriptRaw) : scriptRaw;
            if (Array.isArray(parsed)) script = parsed;
        } catch (e) {
            return NextResponse.json({ error: 'bad script JSON: ' + e.message }, { status: 400 });
        }
    }

    let hideWindow;
    const hideRaw = form.get('hideWindow');
    if (hideRaw != null) {
        hideWindow = (String(hideRaw) === 'true' || String(hideRaw) === '1');
    }

    try {
        const meta = await updateProduct(id, {
            exe:   form.get('exe'),
            image: form.get('image'),
            title: (form.get('title') || '').toString(),
            script,
            hideWindow,
        });
        return NextResponse.json(meta);
    } catch (e) {
        const notFound = /not found/i.test(e.message || '');
        return NextResponse.json({ error: e.message || 'update failed' }, { status: notFound ? 404 : 400 });
    }
}
