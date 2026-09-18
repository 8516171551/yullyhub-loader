// GET /api/imgsearch?q=<query>
//
// Aggregated game image search. Uses Steam's public SearchApps endpoint
// (no auth) plus deterministic Steam CDN URLs for each app id — this
// covers the vast majority of PC games with 4 image variants each:
//   - header (16:9 banner)
//   - portrait (600x900 library card)
//   - hero (wide banner used behind the store page)
//   - capsule (small marketing card)
//
// Returns:
//   { results: [{ appid, name, source: 'steam',
//                 icon: <thumb url>,
//                 images: { header, portrait, hero, capsule } }, ...] }

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';

function steamImages(appid) {
    return {
        header:   `${STEAM_CDN}/${appid}/header.jpg`,
        portrait: `${STEAM_CDN}/${appid}/library_600x900_2x.jpg`,
        hero:     `${STEAM_CDN}/${appid}/library_hero.jpg`,
        capsule:  `${STEAM_CDN}/${appid}/capsule_616x353.jpg`,
    };
}

async function searchSteam(query) {
    // The public autocomplete search that steam's own storefront uses.
    // Returns HTML-in-JSON with logo urls; we lift out appids from each item.
    const url = `https://steamcommunity.com/actions/SearchApps/${encodeURIComponent(query)}`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'YullyHub/1.0' } });
    if (!r.ok) return [];
    const j = await r.json().catch(() => null);
    if (!Array.isArray(j)) return [];
    return j.slice(0, 24).map((it) => ({
        appid: String(it.appid),
        name:  it.name,
        source: 'steam',
        icon:   it.logo,        // small square from SearchApps
        images: steamImages(it.appid),
    }));
}

export async function GET(request) {
    const url = new URL(request.url);
    const q   = (url.searchParams.get('q') || '').trim();
    if (!q || q.length < 2) {
        return NextResponse.json({ results: [] }, { headers: { 'Cache-Control': 'no-store' } });
    }
    try {
        const results = await searchSteam(q);
        return NextResponse.json({ results }, {
            headers: { 'Cache-Control': 'public, max-age=300' },
        });
    } catch (e) {
        return NextResponse.json({ results: [], error: e.message || 'search failed' }, { status: 500 });
    }
}
