// product-store.js — persistence for products.
//
// Primary backend: shared MySQL (`yh_products`) on the yully.wtf/yullyhub
// VPS. Requires DATABASE_URL. See lib/db.js and _yullyhub_readme row in
// the DB for the ownership boundary — yh_products is OURS, do not
// touch tables owned by yully.wtf.
//
// Fallback: Upstash Redis, when DATABASE_URL isn't set (local dev). Same
// API surface, so callers don't need to know which backend is live.
//
// Binary blobs (exe, image) always live in Vercel Blob at:
//   products/<id>/app.exe
//   products/<id>/image<.ext>
// Blob is private; /api/products/<id>/{exe,image} presigns a fresh GET
// URL on each request.

import { Redis } from '@upstash/redis';
import { put as blobPut, del as blobDel } from '@vercel/blob';
import crypto from 'crypto';
import { getPool, hasDb, q, q1 } from './db.js';

const KV_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis    = (KV_URL && KV_TOKEN) ? new Redis({ url: KV_URL, token: KV_TOKEN }) : null;

const IDS_KEY   = 'yh:products';
const META_KEY  = (id) => `yh:product:${id}`;
const BLOB_ROOT = (id) => `products/${id}`;

const USE_DB = hasDb();

export function newId() {
    return crypto.randomBytes(6).toString('hex');
}
export function safeId(id) {
    return /^[a-f0-9]{6,32}$/.test(id) ? id : null;
}

// ---- Blob helpers ----

async function uploadExe(id, file) {
    const buf = Buffer.from(await file.arrayBuffer());
    const res = await blobPut(`${BLOB_ROOT(id)}/app.exe`, buf, {
        access:            'public',
        contentType:       'application/vnd.microsoft.portable-executable',
        addRandomSuffix:   false,
        allowOverwrite:    true,
        cacheControlMaxAge: 0,
    });
    return { url: res.url, size: buf.length, name: file.name || 'app.exe' };
}

async function uploadImage(id, file) {
    const name = file.name || 'image';
    const ext  = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '.png';
    const buf  = Buffer.from(await file.arrayBuffer());
    const res  = await blobPut(`${BLOB_ROOT(id)}/image${ext}`, buf, {
        access:            'public',
        contentType:       file.type || 'image/png',
        addRandomSuffix:   false,
        allowOverwrite:    true,
        cacheControlMaxAge: 86400,
    });
    return { url: res.url, name: `image${ext}`, mime: file.type || 'image/png' };
}

// ---- Meta helpers (backend-aware) ----

function rowToMeta(row) {
    if (!row) return null;
    const meta = row.meta && typeof row.meta === 'object' ? row.meta
               : row.meta ? (() => { try { return JSON.parse(row.meta); } catch { return {}; } })()
               : {};
    // Ensure id + timestamps are always present even for older rows.
    meta.id = row.id;
    if (!meta.createdAt && row.created_at) meta.createdAt = new Date(row.created_at).getTime();
    if (!meta.updatedAt && row.updated_at) meta.updatedAt = new Date(row.updated_at).getTime();
    if (typeof meta.hideWindow !== 'boolean') meta.hideWindow = !!row.hide_window;
    return meta;
}

export async function listProducts() {
    if (USE_DB) {
        const rows = await q("SELECT id, meta, hide_window, created_at, updated_at FROM yh_products ORDER BY created_at DESC");
        return rows.map(rowToMeta).filter(Boolean);
    }
    if (!redis) return [];
    const ids = await redis.smembers(IDS_KEY);
    if (!ids || ids.length === 0) return [];
    const values = await redis.mget(...ids.map(META_KEY));
    const out = [];
    for (let i = 0; i < ids.length; i++) {
        const v = values[i];
        if (!v) continue;
        try { out.push(typeof v === 'string' ? JSON.parse(v) : v); } catch {}
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
}

export async function getProduct(id) {
    if (USE_DB) {
        const row = await q1("SELECT id, meta, hide_window, created_at, updated_at FROM yh_products WHERE id = ?", [id]);
        return rowToMeta(row);
    }
    if (!redis) return null;
    const v = await redis.get(META_KEY(id));
    if (!v) return null;
    return typeof v === 'string' ? JSON.parse(v) : v;
}

export async function saveProduct(meta) {
    if (USE_DB) {
        // meta.id must be set. name/slug/exe_url mirror common fields for
        // ad-hoc reporting; the source of truth is meta JSON.
        const payload = { ...meta };
        // Strip transient fields from JSON if any — keep it clean.
        const jsonStr = JSON.stringify(payload);
        await q(
            `INSERT INTO yh_products (id, name, slug, exe_url, exe_pathname, image_urls, hide_window, meta)
             VALUES (?, ?, NULL, ?, ?, NULL, ?, CAST(? AS JSON))
             ON DUPLICATE KEY UPDATE
                name         = VALUES(name),
                exe_url      = VALUES(exe_url),
                exe_pathname = VALUES(exe_pathname),
                hide_window  = VALUES(hide_window),
                meta         = VALUES(meta)`,
            [
                meta.id,
                meta.title || null,
                meta.exeUrl || null,
                meta.exePathname || null,
                meta.hideWindow ? 1 : 0,
                jsonStr,
            ]
        );
        return meta;
    }
    if (!redis) throw new Error('product store not configured');
    await redis.set(META_KEY(meta.id), JSON.stringify(meta));
    await redis.sadd(IDS_KEY, meta.id);
    return meta;
}

export async function deleteProduct(id) {
    const meta = await getProduct(id);
    const kills = [];
    if (meta?.exeUrl)   kills.push(blobDel(meta.exeUrl).catch(() => {}));
    if (meta?.imageUrl) kills.push(blobDel(meta.imageUrl).catch(() => {}));
    await Promise.all(kills);
    if (USE_DB) {
        await q("DELETE FROM yh_products WHERE id = ?", [id]);
        return;
    }
    if (!redis) return;
    await redis.del(META_KEY(id));
    await redis.srem(IDS_KEY, id);
}

// ---- Public high-level API used by the routes ----

export async function createProduct({ exe, image, title }) {
    if (!exe || typeof exe === 'string') throw new Error('exe file required');
    const id = newId();
    const e = await uploadExe(id, exe);
    let img = null;
    if (image && typeof image !== 'string' && image.size > 0) {
        img = await uploadImage(id, image);
    }
    const meta = {
        id,
        title:      (title || '').trim() || e.name.replace(/\.exe$/i, ''),
        exeName:    e.name,
        exeSize:    e.size,
        exeUrl:     e.url,
        imageName:  img?.name || null,
        imageMime:  img?.mime || null,
        imageUrl:   img?.url  || null,
        hideWindow: false,
        script:     [],
        createdAt:  Date.now(),
    };
    return saveProduct(meta);
}

export async function createProductFromUrls({
    title, exeName, exeSize, exeUrl, exePathname,
    imageName, imageMime, imageUrl, imagePathname,
}) {
    if (!exePathname && !exeUrl) throw new Error('exePathname required');
    const id = newId();
    const meta = {
        id,
        title:         (title || '').trim() || (exeName || '').replace(/\.exe$/i, '') || 'product',
        exeName:       exeName || 'app.exe',
        exeSize:       Number(exeSize) || 0,
        exeUrl:        exeUrl || null,
        exePathname:   exePathname || null,
        imageName:     imageName || null,
        imageMime:     imageMime || null,
        imageUrl:      imageUrl || null,
        imagePathname: imagePathname || null,
        hideWindow:    false,
        script:        [],
        createdAt:     Date.now(),
    };
    return saveProduct(meta);
}

export async function updateProductFromUrls(id, {
    exeName, exeSize, exeUrl, exePathname,
    imageName, imageMime, imageUrl, imagePathname,
    title, script, hideWindow,
}) {
    const meta = await getProduct(id);
    if (!meta) throw new Error('not found');
    if (exePathname) {
        if (meta.exeUrl && meta.exeUrl !== exeUrl) await blobDel(meta.exeUrl).catch(() => {});
        meta.exeUrl      = exeUrl || meta.exeUrl;
        meta.exePathname = exePathname;
        if (exeName) meta.exeName = exeName;
        if (exeSize) meta.exeSize = Number(exeSize);
    }
    if (imagePathname) {
        if (meta.imageUrl && meta.imageUrl !== imageUrl) await blobDel(meta.imageUrl).catch(() => {});
        meta.imageUrl      = imageUrl || meta.imageUrl;
        meta.imagePathname = imagePathname;
        if (imageName) meta.imageName = imageName;
        if (imageMime) meta.imageMime = imageMime;
    }
    if (typeof title === 'string' && title.trim()) meta.title = title.trim();
    if (Array.isArray(script))                     meta.script = script;
    if (typeof hideWindow === 'boolean')           meta.hideWindow = hideWindow;
    meta.updatedAt = Date.now();
    return saveProduct(meta);
}

export async function updateProduct(id, { exe, image, title, script, hideWindow }) {
    const meta = await getProduct(id);
    if (!meta) throw new Error('not found');

    if (exe && typeof exe !== 'string' && exe.size > 0) {
        if (meta.exeUrl) await blobDel(meta.exeUrl).catch(() => {});
        const e = await uploadExe(id, exe);
        meta.exeName = e.name;
        meta.exeSize = e.size;
        meta.exeUrl  = e.url;
    }
    if (image && typeof image !== 'string' && image.size > 0) {
        if (meta.imageUrl) await blobDel(meta.imageUrl).catch(() => {});
        const img = await uploadImage(id, image);
        meta.imageName = img.name;
        meta.imageMime = img.mime;
        meta.imageUrl  = img.url;
    }
    if (typeof title === 'string' && title.trim()) meta.title = title.trim();
    if (Array.isArray(script))                     meta.script = script;
    if (typeof hideWindow === 'boolean')           meta.hideWindow = hideWindow;

    meta.updatedAt = Date.now();
    return saveProduct(meta);
}
