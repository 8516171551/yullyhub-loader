import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads');

async function ensureRoot() {
    await fs.mkdir(UPLOAD_ROOT, { recursive: true });
}

export async function GET() {
    await ensureRoot();
    const dirs = await fs.readdir(UPLOAD_ROOT);
    const products = [];
    for (const d of dirs) {
        try {
            const meta = JSON.parse(
                await fs.readFile(path.join(UPLOAD_ROOT, d, 'meta.json'), 'utf8')
            );
            products.push(meta);
        } catch {}
    }
    products.sort((a, b) => b.createdAt - a.createdAt);
    return NextResponse.json({ products });
}

export async function POST(request) {
    await ensureRoot();
    const form = await request.formData();
    const exe = form.get('exe');
    const title = (form.get('title') || '').toString().trim();
    const image = form.get('image');

    if (!exe || typeof exe === 'string') {
        return NextResponse.json({ error: 'exe file required' }, { status: 400 });
    }

    const id = crypto.randomBytes(6).toString('hex');
    const dir = path.join(UPLOAD_ROOT, id);
    await fs.mkdir(dir, { recursive: true });

    const exeName = exe.name || 'app.exe';
    const exeBuf = Buffer.from(await exe.arrayBuffer());
    await fs.writeFile(path.join(dir, 'app.exe'), exeBuf);

    let imageName = null;
    let imageMime = null;
    if (image && typeof image !== 'string' && image.size > 0) {
        imageName = image.name || 'image';
        imageMime = image.type || 'image/png';
        const imgBuf = Buffer.from(await image.arrayBuffer());
        const ext = imageName.includes('.') ? imageName.slice(imageName.lastIndexOf('.')) : '.png';
        await fs.writeFile(path.join(dir, 'image' + ext), imgBuf);
        imageName = 'image' + ext;
    }

    const meta = {
        id,
        title: title || exeName.replace(/\.exe$/i, ''),
        exeName,
        exeSize: exeBuf.length,
        imageName,
        imageMime,
        createdAt: Date.now(),
    };
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

    return NextResponse.json(meta);
}
