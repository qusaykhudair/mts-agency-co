'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

const db = new DatabaseSync(config.dbFile);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
`);

// Each entry upgrades the schema by one version (tracked in PRAGMA user_version).
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT,
    google_sub    TEXT UNIQUE,
    avatar_url    TEXT,
    wa_country    TEXT,
    wa_dial       TEXT,
    wa_number     TEXT,
    wa_e164       TEXT,
    role          TEXT NOT NULL DEFAULT 'buyer' CHECK (role IN ('buyer', 'seller', 'admin')),
    store_name    TEXT,
    is_blocked    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );

  CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    ip         TEXT,
    user_agent TEXT
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE currencies (
    code       TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    symbol     TEXT NOT NULL,
    rate       REAL NOT NULL CHECK (rate > 0),
    decimals   INTEGER NOT NULL DEFAULT 2,
    is_base    INTEGER NOT NULL DEFAULT 0,
    is_active  INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    icon        TEXT NOT NULL DEFAULT 'fa-solid fa-layer-group',
    description TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE platforms (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    logo_url    TEXT,
    color1      TEXT NOT NULL DEFAULT '#3E7BFF',
    color2      TEXT NOT NULL DEFAULT '#1B3FBF',
    description TEXT,
    is_featured INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE products (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id               INTEGER NOT NULL REFERENCES users(id),
    category_id             INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    platform_id             INTEGER REFERENCES platforms(id) ON DELETE SET NULL,
    title                   TEXT NOT NULL,
    slug                    TEXT NOT NULL UNIQUE,
    short_description       TEXT,
    description             TEXT,
    features                TEXT NOT NULL DEFAULT '[]',
    activation_steps        TEXT NOT NULL DEFAULT '[]',
    cover_url               TEXT,
    badge                   TEXT,
    delivery_method         TEXT NOT NULL DEFAULT 'account',
    delivery_time           TEXT,
    warranty                TEXT,
    region_note             TEXT,
    buyer_input_label       TEXT,
    buyer_input_placeholder TEXT,
    offer_ends_at           TEXT,
    is_active               INTEGER NOT NULL DEFAULT 1,
    is_featured             INTEGER NOT NULL DEFAULT 0,
    sales_count             INTEGER NOT NULL DEFAULT 0,
    views                   INTEGER NOT NULL DEFAULT 0,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_products_category ON products(category_id);
  CREATE INDEX idx_products_platform ON products(platform_id);
  CREATE INDEX idx_products_seller ON products(seller_id);

  CREATE TABLE product_plans (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    duration_days INTEGER,
    price         INTEGER NOT NULL CHECK (price >= 0),
    old_price     INTEGER,
    stock         INTEGER,
    is_active     INTEGER NOT NULL DEFAULT 1,
    sort_order    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_plans_product ON product_plans(product_id);

  CREATE TABLE payment_methods (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT NOT NULL,
    subtitle             TEXT,
    type                 TEXT NOT NULL DEFAULT 'bank' CHECK (type IN ('bank', 'wallet')),
    icon                 TEXT NOT NULL DEFAULT 'fa-solid fa-building-columns',
    color                TEXT NOT NULL DEFAULT '#2457E8',
    logo_url             TEXT,
    currency_code        TEXT NOT NULL REFERENCES currencies(code),
    details              TEXT NOT NULL DEFAULT '[]',
    instructions         TEXT,
    sender_account_label TEXT NOT NULL DEFAULT 'رقم الحساب المحول منه',
    is_active            INTEGER NOT NULL DEFAULT 1,
    sort_order           INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE orders (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    code                TEXT UNIQUE,
    user_id             INTEGER NOT NULL REFERENCES users(id),
    seller_id           INTEGER REFERENCES users(id),
    product_id          INTEGER REFERENCES products(id) ON DELETE SET NULL,
    plan_id             INTEGER REFERENCES product_plans(id) ON DELETE SET NULL,
    product_title       TEXT NOT NULL,
    plan_name           TEXT NOT NULL,
    platform_name       TEXT,
    duration_days       INTEGER,
    quantity            INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_price          INTEGER NOT NULL,
    total               INTEGER NOT NULL,
    base_currency       TEXT NOT NULL,
    pay_currency        TEXT NOT NULL,
    pay_rate            REAL NOT NULL,
    pay_amount          INTEGER NOT NULL,
    payment_method_id   INTEGER REFERENCES payment_methods(id) ON DELETE SET NULL,
    payment_method_name TEXT NOT NULL,
    sender_name         TEXT NOT NULL,
    sender_account      TEXT NOT NULL,
    receipt_file        TEXT,
    receipt_mime        TEXT,
    buyer_input_label   TEXT,
    buyer_input         TEXT,
    buyer_note          TEXT,
    status              TEXT NOT NULL DEFAULT 'under_review'
                        CHECK (status IN ('under_review', 'payment_rejected', 'processing', 'delivered', 'completed', 'cancelled')),
    reject_reason       TEXT,
    delivery            TEXT,
    paid_at             TEXT,
    delivered_at        TEXT,
    expires_at          TEXT,
    completed_at        TEXT,
    cancelled_at        TEXT,
    reviewed_by         INTEGER REFERENCES users(id),
    staff_note          TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_orders_user ON orders(user_id, created_at);
  CREATE INDEX idx_orders_seller ON orders(seller_id, status);
  CREATE INDEX idx_orders_status ON orders(status, created_at);

  CREATE TABLE order_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    type       TEXT NOT NULL,
    message    TEXT,
    is_public  INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_order_events_order ON order_events(order_id);

  CREATE TABLE reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    order_id    INTEGER UNIQUE REFERENCES orders(id) ON DELETE SET NULL,
    author_name TEXT NOT NULL,
    rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment     TEXT,
    is_visible  INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_reviews_product ON reviews(product_id, is_visible);

  CREATE TABLE notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    body       TEXT,
    link       TEXT,
    icon       TEXT,
    tone       TEXT,
    is_read    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_notifications_user ON notifications(user_id, is_read, id);

  CREATE TABLE seller_applications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    store_name  TEXT NOT NULL,
    about       TEXT,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    admin_note  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT
  );
  CREATE INDEX idx_seller_apps_user ON seller_applications(user_id);
  `,
  // v2: remember how much limited stock each order holds, so releases restore exactly that.
  `
  ALTER TABLE orders ADD COLUMN stock_reserved INTEGER NOT NULL DEFAULT 0;
  `,
  // v3: MTS Agency service requests, and the "provider" role that fulfils them. SQLite cannot widen a CHECK
  // constraint in place, so "users" is rebuilt (foreign keys off, so nothing referencing it cascades).
  {
    foreignKeysOff: true,
    sql: `
  CREATE TABLE users_v3 (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT,
    google_sub    TEXT UNIQUE,
    avatar_url    TEXT,
    wa_country    TEXT,
    wa_dial       TEXT,
    wa_number     TEXT,
    wa_e164       TEXT,
    role          TEXT NOT NULL DEFAULT 'buyer' CHECK (role IN ('buyer', 'seller', 'admin', 'provider')),
    store_name    TEXT,
    is_blocked    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );
  INSERT INTO users_v3 (id, name, email, password_hash, google_sub, avatar_url, wa_country, wa_dial, wa_number, wa_e164,
                        role, store_name, is_blocked, created_at, last_login_at)
    SELECT id, name, email, password_hash, google_sub, avatar_url, wa_country, wa_dial, wa_number, wa_e164,
           role, store_name, is_blocked, created_at, last_login_at FROM users;
  DROP TABLE users;
  ALTER TABLE users_v3 RENAME TO users;

  CREATE TABLE services (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    icon       TEXT NOT NULL DEFAULT 'fa-solid fa-briefcase',
    summary    TEXT,
    brief_hint TEXT,
    is_active  INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE service_requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT UNIQUE,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    service_id    INTEGER REFERENCES services(id) ON DELETE SET NULL,
    service_name  TEXT NOT NULL,
    title         TEXT NOT NULL,
    details       TEXT NOT NULL,
    budget        TEXT,
    deadline      TEXT,
    links         TEXT NOT NULL DEFAULT '[]',
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'in_progress', 'delivered', 'revision', 'completed', 'cancelled')),
    assigned_to   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_at   TEXT,
    delivered_at  TEXT,
    completed_at  TEXT,
    cancelled_at  TEXT,
    cancel_reason TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_service_requests_user ON service_requests(user_id, id);
  CREATE INDEX idx_service_requests_assignee ON service_requests(assigned_to, status);
  CREATE INDEX idx_service_requests_status ON service_requests(status, id);

  CREATE TABLE service_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id  INTEGER NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    type        TEXT NOT NULL,
    body        TEXT,
    links       TEXT NOT NULL DEFAULT '[]',
    is_internal INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_service_events_request ON service_events(request_id, id);

  CREATE TABLE service_files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id    INTEGER NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
    event_id      INTEGER REFERENCES service_events(id) ON DELETE CASCADE,
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    file_name     TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime          TEXT NOT NULL,
    size          INTEGER NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_service_files_request ON service_files(request_id, event_id);
  `,
  },
  // v4: the shop's default wording rewritten in plain human Arabic; see src/lib/copy-v4.js.
  { run: (database) => require('./lib/copy-v4').apply(database) },
];

function migrate() {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  const fkProblems = () => db.prepare('PRAGMA foreign_key_check').all().length;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const step = typeof MIGRATIONS[v] === 'string' ? { sql: MIGRATIONS[v] } : MIGRATIONS[v];
    // PRAGMA foreign_keys is ignored inside a transaction, so it is switched around BEGIN/COMMIT.
    if (step.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      const before = step.foreignKeysOff ? fkProblems() : 0;
      if (step.run) step.run(db);
      else db.exec(step.sql);
      if (step.foreignKeysOff && fkProblems() > before) throw new Error(`Migration ${v + 1} would break foreign keys`);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      if (step.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

// node:sqlite only binds null/number/bigint/string/buffer — normalise everything else.
function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return toSql(v);
  return v;
}
function normParams(params) {
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Buffer.isBuffer(params[0]) && !(params[0] instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(params[0])) out[k] = norm(v);
    return [out];
  }
  return params.map(norm);
}

const cache = new Map();
function prep(sql) {
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

const get = (sql, ...params) => prep(sql).get(...normParams(params));
const all = (sql, ...params) => prep(sql).all(...normParams(params));
const run = (sql, ...params) => prep(sql).run(...normParams(params));

function tx(fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

// SQLite's datetime('now') format (UTC): "YYYY-MM-DD HH:MM:SS".
function toSql(date = new Date()) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}
function fromSql(value) {
  if (!value) return null;
  let s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00Z';
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = { db, MIGRATIONS, migrate, get, all, run, tx, toSql, fromSql };
