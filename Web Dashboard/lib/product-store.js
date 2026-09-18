// product-store.js — persistence for products.
//
// Meta lives in Upstash Redis:
//   yh:products         (SET of product ids)
//   yh:product:<id>     (JSON of the product's meta)
//
// Binary blobs (exe, image) live in Vercel Blob at:
//   products/<id>/app.exe
//   products/<id>/image<.ext>
//
// Everything a Vercel serverless function needs — no local filesystem
// writes (fs is read-only on the platform, which was breaking uploads).

import { Redis } from '@upstash/redis';
import { put as blobPut, del as blobDel } from '@vercel/blob';
import crypto from 'crypto';

const KV_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis    = (KV_URL && KV_TOKEN) ? new Redis({ url: KV_URL, token: KV_TOKEN }) : null;

const IDS_KEY   = 'yh:products';
const META_KEY  = (id) => `yh:product:${id}`;
const BLOB_ROOT = (id) => `products/${id}`;

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

// ---- Meta helpers ----

export async function listProducts() {
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
    if (!redis) return null;
    const v = await redis.get(META_KEY(id));
    if (!v) return null;
    return typeof v === 'string' ? JSON.parse(v) : v;
}

export async function saveProduct(meta) {
    if (!redis) throw new Error('product store not configured');
    await redis.set(META_KEY(meta.id), JSON.stringify(meta));
    await redis.sadd(IDS_KEY, meta.id);
    return meta;
}

export async function deleteProduct(id) {
    if (!redis) return;
    const meta = await getProduct(id);
    // Kill blobs (both if present).
    const kills = [];
    if (meta?.exeUrl)   kills.push(blobDel(meta.exeUrl).catch(() => {}));
    if (meta?.imageUrl) kills.push(blobDel(meta.imageUrl).catch(() => {}));
    await Promise.all(kills);
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

export async function updateProduct(id, { exe, image, title, script, hideWindow }) {
    const meta = await getProduct(id);
    if (!meta) throw new Error('not found');

    if (exe && typeof exe !== 'string' && exe.size > 0) {
        // Replace existing blob (deleteProduct's URL then re-put).
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
