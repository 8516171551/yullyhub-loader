-- =============================================================
-- Unified Postgres schema for yully.wtf + yullyhub.com + Windows Loader.
-- Runs on Neon (project falling-shadow-21712192, branch production).
-- Idempotent: uses DROP/CREATE so it can be re-applied cleanly.
-- =============================================================

-- 1) Nuke every prior table.
DROP TABLE IF EXISTS
    loader_launches, loader_commands, loader_sessions, web_sessions,
    transactions, ticket_messages, tickets, uploads,
    licenses, product_tiers, products,
    reseller_profiles, users,
    _readme, db_meta CASCADE;

-- 2) ENUMs (Postgres is stricter than MySQL — declare types up front).
DO $$ BEGIN
    CREATE TYPE user_role   AS ENUM ('admin','reseller','customer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE user_status AS ENUM ('active','banned','suspended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE session_origin AS ENUM ('yullyhub','yullywtf');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE payment_gateway AS ENUM ('stripe','paypal','manual','balance');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE payment_status AS ENUM ('pending','paid','failed','refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE ticket_status AS ENUM ('open','pending','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3) Meta
CREATE TABLE _readme (
    id          INT PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE db_meta (
    k TEXT PRIMARY KEY,
    v TEXT
);

-- 4) Users
CREATE TABLE users (
    id             UUID PRIMARY KEY,
    email          TEXT NOT NULL,
    username       TEXT,
    password_hash  TEXT,
    role           user_role   NOT NULL DEFAULT 'customer',
    status         user_status NOT NULL DEFAULT 'active',
    display_name   TEXT,
    avatar_url     TEXT,
    discord_id     TEXT,
    discord_access_token  TEXT,
    discord_refresh_token TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_users_email    ON users (LOWER(email));
CREATE UNIQUE INDEX uq_users_username ON users (username) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX uq_users_discord  ON users (discord_id) WHERE discord_id IS NOT NULL;
CREATE INDEX ix_users_role   ON users (role);
CREATE INDEX ix_users_status ON users (status);

CREATE TABLE reseller_profiles (
    user_id                UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    brand_name             TEXT NOT NULL,
    brand_tagline          TEXT NOT NULL DEFAULT '',
    brand_accent           TEXT NOT NULL DEFAULT '#e63946',
    brand_logo_url         TEXT NOT NULL DEFAULT '',
    key_prefix             TEXT NOT NULL DEFAULT '',
    balance_cents          INT  NOT NULL DEFAULT 0,
    plan                   TEXT NOT NULL DEFAULT 'basic',
    retail_week_cents      INT  NOT NULL DEFAULT 0,
    retail_month_cents     INT  NOT NULL DEFAULT 0,
    retail_quarter_cents   INT  NOT NULL DEFAULT 0,
    retail_year_cents      INT  NOT NULL DEFAULT 0,
    stripe_customer_id     TEXT,
    stripe_subscription_id TEXT,
    sub_expires_at         TIMESTAMPTZ,
    api_token              TEXT
);

-- 5) Products
CREATE TABLE products (
    id             UUID PRIMARY KEY,
    slug           TEXT NOT NULL,
    name           TEXT NOT NULL,
    description    TEXT,
    image_url      TEXT,
    exe_pathname   TEXT,
    exe_url        TEXT,
    exe_size_bytes BIGINT NOT NULL DEFAULT 0,
    hide_window    BOOLEAN NOT NULL DEFAULT FALSE,
    active         BOOLEAN NOT NULL DEFAULT TRUE,
    price_cents    INT NOT NULL DEFAULT 0,
    launch_script  JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_products_slug ON products (slug);
CREATE INDEX ix_products_active ON products (active);

CREATE TABLE product_tiers (
    id            SERIAL PRIMARY KEY,
    product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    duration_days INT,
    price_cents   INT NOT NULL
);
CREATE INDEX ix_product_tiers_product ON product_tiers (product_id);

-- 6) Licenses
CREATE TABLE licenses (
    "key"              TEXT PRIMARY KEY,
    product_id         UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    tier               TEXT NOT NULL DEFAULT 'standard',
    duration_days      INT,
    reseller_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    redeemed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    activated_at       TIMESTAMPTZ,
    expires_at         TIMESTAMPTZ,
    hwid               TEXT,
    ip_lock            TEXT,
    max_devices        INT NOT NULL DEFAULT 1,
    active             BOOLEAN NOT NULL DEFAULT TRUE,
    blacklisted_at     TIMESTAMPTZ,
    note               TEXT NOT NULL DEFAULT '',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_licenses_product   ON licenses (product_id);
CREATE INDEX ix_licenses_reseller  ON licenses (reseller_id);
CREATE INDEX ix_licenses_redeemer  ON licenses (redeemed_by_user_id);
CREATE INDEX ix_licenses_expiry    ON licenses (expires_at);
CREATE INDEX ix_licenses_blacklist ON licenses (blacklisted_at);

-- 7) Sessions
CREATE TABLE web_sessions (
    id            UUID PRIMARY KEY,
    session_token TEXT NOT NULL,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    origin        session_origin NOT NULL,
    ip            TEXT,
    user_agent    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_web_sessions_token ON web_sessions (session_token);
CREATE INDEX ix_web_sessions_user ON web_sessions (user_id);

CREATE TABLE loader_sessions (
    id             UUID PRIMARY KEY,
    session_token  TEXT NOT NULL,
    loader_id      TEXT NOT NULL,
    license_key    TEXT,
    user_id        UUID,
    active_product UUID,
    ip             TEXT,
    user_agent     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_loader_sessions_token ON loader_sessions (session_token);
CREATE INDEX ix_loader_sessions_loader  ON loader_sessions (loader_id);
CREATE INDEX ix_loader_sessions_license ON loader_sessions (license_key);
CREATE INDEX ix_loader_sessions_user    ON loader_sessions (user_id);

CREATE TABLE loader_commands (
    id         BIGSERIAL PRIMARY KEY,
    loader_id  TEXT NOT NULL,
    payload    JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    picked_at  TIMESTAMPTZ
);
CREATE INDEX ix_loader_commands ON loader_commands (loader_id, picked_at);

CREATE TABLE loader_launches (
    id           BIGSERIAL PRIMARY KEY,
    loader_id    TEXT NOT NULL,
    license_key  TEXT,
    user_id      UUID,
    product_id   UUID NOT NULL,
    ip           TEXT,
    launched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_loader_launches_key  ON loader_launches (license_key);
CREATE INDEX ix_loader_launches_user ON loader_launches (user_id);
CREATE INDEX ix_loader_launches_time ON loader_launches (launched_at);

-- 8) Payments
CREATE TABLE transactions (
    id             UUID PRIMARY KEY,
    user_id        UUID,
    reseller_id    UUID,
    product_id     UUID,
    license_key    TEXT,
    amount_cents   INT NOT NULL,
    currency       TEXT NOT NULL DEFAULT 'usd',
    gateway        payment_gateway NOT NULL,
    gateway_ref    TEXT,
    status         payment_status NOT NULL DEFAULT 'pending',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_transactions_user     ON transactions (user_id);
CREATE INDEX ix_transactions_reseller ON transactions (reseller_id);
CREATE INDEX ix_transactions_gateway  ON transactions (gateway, gateway_ref);

-- 9) Support
CREATE TABLE tickets (
    id         UUID PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject    TEXT NOT NULL,
    status     ticket_status NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_tickets_user   ON tickets (user_id);
CREATE INDEX ix_tickets_status ON tickets (status);

CREATE TABLE ticket_messages (
    id         BIGSERIAL PRIMARY KEY,
    ticket_id  UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_ticket_messages_ticket ON ticket_messages (ticket_id);

-- 10) Uploads
CREATE TABLE uploads (
    id             UUID PRIMARY KEY,
    user_id        UUID,
    kind           TEXT NOT NULL,
    filename       TEXT NOT NULL,
    content_type   TEXT,
    size_bytes     BIGINT NOT NULL,
    blob_pathname  TEXT NOT NULL,
    public_url     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_uploads_user ON uploads (user_id);
CREATE INDEX ix_uploads_kind ON uploads (kind);

-- 11) Meta rows
INSERT INTO db_meta (k, v) VALUES
    ('schema_version', '2026-09-18-pg'),
    ('applied_at',     NOW()::text),
    ('backend',        'Neon Postgres'),
    ('owner_yullyhub', 'products, licenses, loader_sessions, loader_commands, loader_launches'),
    ('owner_yullywtf', 'users, reseller_profiles, product_tiers, transactions, tickets, ticket_messages, uploads')
ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;

INSERT INTO _readme (id, title, body) VALUES (1,
    'yully.wtf ↔ yullyhub.com ↔ Windows Loader — shared Neon DB',
    E'ONE Neon Postgres database shared by three surfaces:\n\n  yully.wtf     — marketing site + admin dashboard + reseller portal.\n  yullyhub.com  — the loader landing/dashboard (users log in with a Yully account or a license key).\n  Windows loader — polls /api/loader/poll, downloads product exe with Bearer token.\n\nOWNERSHIP:\n  yullyhub.com owns: products, licenses, loader_sessions, loader_commands, loader_launches.\n  yully.wtf   owns: users, reseller_profiles, product_tiers, transactions, tickets, ticket_messages, uploads.\n  BOTH read/write: licenses (yully.wtf writes, both validate); web_sessions (per-origin).\n\nRULES:\n  1. Never drop tables without coordinating both sites.\n  2. Adding columns is safe; renaming/removing is a breaking change.\n  3. Windows loader NEVER talks to Postgres. Only /api/loader/*.\n  4. Blobs (exe, images) live in Vercel Blob; DB only holds pathnames.\n')
ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, updated_at = NOW();
