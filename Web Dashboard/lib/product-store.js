// product-store.js — persistence for products.
//
// Backend: shared MySQL `products` table on the yully.wtf/yullyhub VPS.
// Requires DATABASE_URL. See lib/db.js and the _readme row (id=1) in the
// DB for ownership rules — `products` is shared, admin-managed on
// yully.wtf, read here.
//
// Binary blobs (exe, image) live in Vercel Blob at:
//   products/<id>/app.exe
//   products/<id>/image<.ext>
// Blob is private; /api/products/<id>/{exe,image} presigns a fresh GET
// URL on each request.

import { put as blobPut, del as blobDel } from '@vercel/blob';
import crypto from 'crypto';
import { q, q1, hasDb } from './db.js';

const BLOB_ROOT = (id) => `products/${id}`;

export function newId() {
    return crypto.randomUUID();
}
export function safeId(id) {
    if (!id) return null;
    // Accept UUIDs (new) and 12-hex legacy ids.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id.toLowerCase();
    if (/^[a-f0-9]{6,32}$/i.test(id)) return id.toLowerCase();
    return null;
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
    return { url: res.url, pathname: res.pathname, size: buf.length, name: file.name || 'app.exe' };
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
    return { url: res.url, pathname: res.pathname, name: `image${ext}`, mime: file.type || 'image/png' };
}

// ---- Row <-> meta shape mapping ----
//
// The new `products` table columns:
//   id, slug, name, description, image_url, exe_pathname, exe_url,
//   exe_size_bytes, hide_window, active, price_cents, launch_script (JSON),
//   created_at, updated_at
//
// The legacy JS meta shape used by /app/page.jsx:
//   { id, title, exeName, exeSize, exeUrl, exePathname,
//     imageName, imageMime, imageUrl, imagePathname,
//     hideWindow, script, createdAt, updatedAt }

function basenameFromPathname(p) {
    if (!p) return null;
    const clean = String(p).split('?')[0];
    const parts = clean.split('/');
    return parts[parts.length - 1] || null;
}

function guessMimeFromName(n) {
    if (!n) return null;
    const lower = n.toLowerCase();
    if (lower.endsWith('.png'))  return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.gif'))  return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.svg'))  return 'image/svg+xml';
    return null;
}

function rowToMeta(row) {
    if (!row) return null;
    let script = [];
    if (row.launch_script != null) {
        if (typeof row.launch_script === 'object') script = row.launch_script;
        else { try { script = JSON.parse(row.launch_script); } catch { script = []; } }
    }
    if (!Array.isArray(script)) script = [];

    // image_url may be either a direct blob URL or a pathname. If we don't
    // have a separate pathname column, we derive one from the URL path.
    let imagePathname = null;
    if (row.image_url) {
        try {
            const u = new URL(row.image_url);
            imagePathname = u.pathname.replace(/^\//, '') || null;
        } catch {
            imagePathname = row.image_url;
        }
    }
    const imageName = basenameFromPathname(imagePathname);
    const exeName   = basenameFromPathname(row.exe_pathname) || 'app.exe';

    return {
        id:            row.id,
        title:         row.name || '',
        description:   row.description || '',
        exeName,
        exeSize:       Number(row.exe_size_bytes || 0),
        exeUrl:        row.exe_url || null,
        exePathname:   row.exe_pathname || null,
        imageName,
        imageMime:     guessMimeFromName(imageName),
        imageUrl:      row.image_url || null,
        imagePathname,
        hideWindow:    !!row.hide_window,
        script,
        active:        row.active == null ? true : !!row.active,
        priceCents:    Number(row.price_cents || 0),
        slug:          row.slug || null,
        createdAt:     row.created_at ? new Date(row.created_at).getTime() : null,
        updatedAt:     row.updated_at ? new Date(row.updated_at).getTime() : null,
    };
}

function slugify(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120) || 'product';
}

// ---- DB CRUD ----

function assertDb() {
    if (!hasDb()) throw new Error('DATABASE_URL not configured');
}

export async function listProducts() {
    assertDb();
    const rows = await q(
        `SELECT id, slug, name, description, image_url, exe_pathname, exe_url,
                exe_size_bytes, hide_window, active, price_cents, launch_script,
                created_at, updated_at
           FROM products
          ORDER BY created_at DESC`
    );
    return rows.map(rowToMeta).filter(Boolean);
}

export async function getProduct(id) {
    assertDb();
    const row = await q1(
        `SELECT id, slug, name, description, image_url, exe_pathname, exe_url,
                exe_size_bytes, hide_window, active, price_cents, launch_script,
                created_at, updated_at
           FROM products WHERE id = ?`,
        [id]
    );
    return rowToMeta(row);
}

async function uniqueSlug(base, excludeId) {
    let s = slugify(base);
    let n = 0;
    while (true) {
        const candidate = n === 0 ? s : `${s}-${n}`;
        const row = excludeId
            ? await q1(
                `SELECT id FROM products WHERE slug = ? AND id <> ? LIMIT 1`,
                [candidate, excludeId]
              )
            : await q1(
                `SELECT id FROM products WHERE slug = ? LIMIT 1`,
                [candidate]
              );
        if (!row) return candidate;
        n += 1;
        if (n > 500) return `${s}-${crypto.randomBytes(3).toString('hex')}`;
    }
}

// meta = legacy shape. Persists to the new `products` table.
export async function saveProduct(meta) {
    assertDb();
    const slug = meta.slug || await uniqueSlug(meta.title || meta.exeName || 'product', meta.id);
    const script = Array.isArray(meta.script) ? meta.script : [];
    await q(
        `INSERT INTO products
            (id, slug, name, description, image_url, exe_pathname, exe_url,
             exe_size_bytes, hide_window, active, price_cents, launch_script)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
         ON CONFLICT (id) DO UPDATE SET
            slug           = EXCLUDED.slug,
            name           = EXCLUDED.name,
            description    = EXCLUDED.description,
            image_url      = EXCLUDED.image_url,
            exe_pathname   = EXCLUDED.exe_pathname,
            exe_url        = EXCLUDED.exe_url,
            exe_size_bytes = EXCLUDED.exe_size_bytes,
            hide_window    = EXCLUDED.hide_window,
            launch_script  = EXCLUDED.launch_script,
            updated_at     = NOW()`,
        [
            meta.id,
            slug,
            meta.title || meta.exeName || 'product',
            meta.description || null,
            meta.imageUrl || null,
            meta.exePathname || null,
            meta.exeUrl || null,
            Number(meta.exeSize || 0),
            !!meta.hideWindow,
            meta.active !== false,
            Number(meta.priceCents || 0),
            JSON.stringify(script),
        ]
    );
    return getProduct(meta.id);
}

export async function deleteProduct(id) {
    const meta = await getProduct(id);
    const kills = [];
    if (meta?.exeUrl)   kills.push(blobDel(meta.exeUrl).catch(() => {}));
    if (meta?.imageUrl) kills.push(blobDel(meta.imageUrl).catch(() => {}));
    await Promise.all(kills);
    await q(`DELETE FROM products WHERE id = ?`, [id]);
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
        title:         (title || '').trim() || e.name.replace(/\.exe$/i, ''),
        exeName:       e.name,
        exeSize:       e.size,
        exeUrl:        e.url,
        exePathname:   e.pathname,
        imageName:     img?.name || null,
        imageMime:     img?.mime || null,
        imageUrl:      img?.url  || null,
        imagePathname: img?.pathname || null,
        hideWindow:    false,
        script:        [],
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
    return saveProduct(meta);
}

export async function updateProduct(id, { exe, image, title, script, hideWindow }) {
    const meta = await getProduct(id);
    if (!meta) throw new Error('not found');

    if (exe && typeof exe !== 'string' && exe.size > 0) {
        if (meta.exeUrl) await blobDel(meta.exeUrl).catch(() => {});
        const e = await uploadExe(id, exe);
        meta.exeName     = e.name;
        meta.exeSize     = e.size;
        meta.exeUrl      = e.url;
        meta.exePathname = e.pathname;
    }
    if (image && typeof image !== 'string' && image.size > 0) {
        if (meta.imageUrl) await blobDel(meta.imageUrl).catch(() => {});
        const img = await uploadImage(id, image);
        meta.imageName     = img.name;
        meta.imageMime     = img.mime;
        meta.imageUrl      = img.url;
        meta.imagePathname = img.pathname;
    }
    if (typeof title === 'string' && title.trim()) meta.title = title.trim();
    if (Array.isArray(script))                     meta.script = script;
    if (typeof hideWindow === 'boolean')           meta.hideWindow = hideWindow;

    return saveProduct(meta);
}
