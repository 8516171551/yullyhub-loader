// GET  /api/loader/overlay — PS overlay polls this for script steps
// POST /api/loader/overlay — dashboard pushes steps here on launch

import { NextResponse } from 'next/server';
import { getOverlay, setOverlay, clearOverlay } from '../../../../lib/overlay-store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function clientIp(req) {
    return (
        req.headers.get('x-real-ip') ||
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        '127.0.0.1'
    );
}

export async function GET(req) {
    const ip = clientIp(req);
    const url = new URL(req.url);
    const since = Number(url.searchParams.get('v') || 0);
    const entry = getOverlay(ip);

    if (!entry || entry.version <= since) {
        return new Response('v=0\n', {
            status: 200,
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        });
    }

    // Pipe-delimited text format the C# overlay can parse without a JSON lib:
    //   v=<version>
    //   kind|text|dismiss|keybind|timeoutMs
    const lines = [`v=${entry.version}`];
    for (const s of entry.steps) {
        const kind    = String(s.kind    || 'message');
        const text    = String(s.text    || '').replace(/\|/g, ' ').replace(/\n/g, ' ');
        const dismiss = String(s.dismiss || 'timeout');
        const keybind = String(s.keybind || '');
        const timeout = Math.round(Number(s.timeout || 3) * 1000);
        lines.push(`${kind}|${text}|${dismiss}|${keybind}|${timeout}`);
    }

    return new Response(lines.join('\n') + '\n', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
}

export async function POST(req) {
    const ip = clientIp(req);
    try {
        const body = await req.json();
        if (body.clear) {
            clearOverlay(ip);
            return NextResponse.json({ ok: true });
        }
        const steps = Array.isArray(body.steps) ? body.steps : [];
        setOverlay(ip, steps);
        return NextResponse.json({ ok: true, steps: steps.length });
    } catch (e) {
        return NextResponse.json({ error: e?.message || 'bad request' }, { status: 400 });
    }
}
