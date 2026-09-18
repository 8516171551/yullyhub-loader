// GET /api/imgproxy?url=<encoded url>
//
// Server-side image passthrough. Needed because:
//   1) The browser can't fetch cross-origin Steam CDN images as a Blob
//      without CORS headers upstream — so we relay them with our own
//      Access-Control-Allow-Origin: *.
//   2) Prevents an open proxy — only an explicit allowlist of hostnames
//      is passed through.
//
// Cached at the edge (Cache-Control: public, max-age=86400) so a preview
// is only fetched once per URL per Vercel edge node.

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Any host under Valve's / Steam's CDN infrastructure. Regex-based so
// we cover the sprawling assortment they use (cdn.akamai.steamstatic.com,
// shared.cloudflare.steamstatic.com, steamcdn-a.akamaihd.net,
// steamuserimages-a.akamaihd.net, community.*.steamstatic.com, etc.)
const HOST_ALLOWLIST = [
    /(^|\.)steamstatic\.com$/i,
    /(^|\.)steampowered\.com$/i,
    /(^|\.)steamcontent\.com$/i,
    /(^|\.)akamaihd\.net$/i,          // steamcdn-a.akamaihd.net, steamuserimages-a.akamaihd.net
];

export async function GET(request) {
    const u = new URL(request.url);
    const target = u.searchParams.get('url');
    if (!target) return NextResponse.json({ error: 'missing url' }, { status: 400 });
    let src;
    try { src = new URL(target); } catch { return NextResponse.json({ error: 'bad url' }, { status: 400 }); }
    if (src.protocol !== 'https:') return NextResponse.json({ error: 'https only' }, { status: 400 });
    if (!HOST_ALLOWLIST.some((rx) => rx.test(src.hostname))) {
        return NextResponse.json({ error: 'host not allowed: ' + src.hostname }, { status: 400 });
    }
    try {
        const r = await fetch(src.toString(), { headers: { 'User-Agent': 'YullyHub/1.0' } });
        if (r.status === 404) {
            // Missing asset — many games don't publish every variant.
            // Return a tiny transparent PNG instead of a 502 so the
            // browser doesn't render a broken-image icon.
            const transparent = Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
                'base64');
            return new NextResponse(transparent, {
                headers: {
                    'Content-Type': 'image/png',
                    'Cache-Control': 'public, max-age=86400',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }
        if (!r.ok) return NextResponse.json({ error: 'upstream ' + r.status }, { status: 502 });
        const ct = r.headers.get('content-type') || 'application/octet-stream';
        const buf = await r.arrayBuffer();
        return new NextResponse(buf, {
            headers: {
                'Content-Type': ct,
                'Cache-Control': 'public, max-age=86400',
                'Access-Control-Allow-Origin': '*',
            },
        });
    } catch (e) {
        return NextResponse.json({ error: e.message || 'proxy failed' }, { status: 500 });
    }
}
