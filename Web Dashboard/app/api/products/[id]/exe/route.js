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
        const buf = await fs.readFile(path.join(UPLOAD_ROOT, id, 'app.exe'));
        return new Response(buf, {
            status: 200,
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(buf.length),
                'Content-Disposition': `attachment; filename="${meta.exeName || 'app.exe'}"`,
                'Cache-Control': 'no-store',
            },
        });
    } catch {
        return new Response('not found', { status: 404 });
    }
}
