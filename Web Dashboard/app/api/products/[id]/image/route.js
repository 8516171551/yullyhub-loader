import { promises as fs } from 'fs';
import path from 'path';

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads');

function safeId(id) {
    return /^[a-f0-9]{6,32}$/.test(id) ? id : null;
}

export async function GET(_request, { params }) {
    const id = safeId(params.id);
    if (!id) return new Response('bad id', { status: 400 });
    try {
        const meta = JSON.parse(
            await fs.readFile(path.join(UPLOAD_ROOT, id, 'meta.json'), 'utf8')
        );
        if (!meta.imageName) return new Response('no image', { status: 404 });
        const buf = await fs.readFile(path.join(UPLOAD_ROOT, id, meta.imageName));
        return new Response(buf, {
            status: 200,
            headers: {
                'Content-Type': meta.imageMime || 'image/png',
                'Content-Length': String(buf.length),
                'Cache-Control': 'public, max-age=3600',
            },
        });
    } catch {
        return new Response('not found', { status: 404 });
    }
}
