import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads');

function safeId(id) {
    return /^[a-f0-9]{6,32}$/.test(id) ? id : null;
}

async function readMeta(dir) {
    return JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
}

export async function GET(_request, { params }) {
    const id = safeId(params.id);
    if (!id) return NextResponse.json({ error: 'bad id' }, { status: 400 });
    try {
        const meta = await readMeta(path.join(UPLOAD_ROOT, id));
        return NextResponse.json(meta);
    } catch {
        return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
}

export async function DELETE(_request, { params }) {
    const id = safeId(params.id);
    if (!id) return NextResponse.json({ error: 'bad id' }, { status: 400 });
    const dir = path.join(UPLOAD_ROOT, id);
    await fs.rm(dir, { recursive: true, force: true });
    return NextResponse.json({ ok: true });
}

// PUT — update an existing product. Any of {exe, image, title} can be sent;
// omitted fields keep their current value. This mutates in place so the
// product ID and its /api/products/<id>/exe URL stay the same, meaning any
// loader that already knows the URL gets the new bytes on the next launch
// (no cache — the exe route already sends `Cache-Control: no-store`).
export async function PUT(request, { params }) {
    const id = safeId(params.id);
    if (!id) return NextResponse.json({ error: 'bad id' }, { status: 400 });

    const dir = path.join(UPLOAD_ROOT, id);
    let meta;
    try {
        meta = await readMeta(dir);
    } catch {
        return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    const form = await request.formData();
    const exe   = form.get('exe');
    const image = form.get('image');
    const title = (form.get('title') || '').toString().trim();

    // Replace exe bytes
    if (exe && typeof exe !== 'string' && exe.size > 0) {
        const buf = Buffer.from(await exe.arrayBuffer());
        await fs.writeFile(path.join(dir, 'app.exe'), buf);
        meta.exeName = exe.name || meta.exeName || 'app.exe';
        meta.exeSize = buf.length;
    }

    // Replace image
    if (image && typeof image !== 'string' && image.size > 0) {
        // Clear any old image (any extension)
        const files = await fs.readdir(dir);
        for (const f of files) {
            if (f.startsWith('image.')) {
                await fs.unlink(path.join(dir, f)).catch(() => {});
            }
        }
        const iname = image.name || 'image';
        const ext = iname.includes('.') ? iname.slice(iname.lastIndexOf('.')) : '.png';
        const buf = Buffer.from(await image.arrayBuffer());
        await fs.writeFile(path.join(dir, 'image' + ext), buf);
        meta.imageName = 'image' + ext;
        meta.imageMime = image.type || meta.imageMime || 'image/png';
    }

    // Rename
    if (title) meta.title = title;

    meta.updatedAt = Date.now();
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

    return NextResponse.json(meta);
}
