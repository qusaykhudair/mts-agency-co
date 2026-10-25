'use strict';
// Backups against a throwaway database: the full .tar.gz download (database snapshot, uploads, manifest),
// the daily snapshots and their clean-up, admin-only access, and the daily copy by e-mail.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-backups-test-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: TMP,
  DB_FILE: path.join(TMP, 'test.db'),
  UPLOAD_DIR: path.join(TMP, 'uploads'),
  ADMIN_EMAIL: 'admin@test.local',
  ADMIN_PASSWORD: 'admin-pass-123',
  ADMIN_WHATSAPP: '+201093525956',
  GOOGLE_CLIENT_ID: '',
  SEED_DEMO: 'true',
  TRUST_PROXY: '0',
  RATE_LIMIT: 'off',
  GMAIL_CLIENT_ID: '',
  GMAIL_CLIENT_SECRET: '',
  GMAIL_REFRESH_TOKEN: '',
  SMTP_HOST: '',
  SMTP_USER: '',
  SMTP_PASS: '',
  MAIL_FROM: '',
  MAIL_TRANSPORT: '',
});

const { migrate, get } = require('../src/db');
const { seed } = require('../src/seed');
const settings = require('../src/lib/settings');
const money = require('../src/lib/money');
const backups = require('../src/lib/backups');
const mail = require('../src/lib/mail');
const { createApp } = require('../src/app');

let server;
let base;
let adminCookie = '';

const login = async (email, password) => {
  const res = await fetch(base + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, 'x-requested-with': 'fetch' },
    body: new URLSearchParams({ email, password }).toString(),
  });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
};
const asAdmin = (url, init = {}) => fetch(base + url, { redirect: 'manual', ...init, headers: { cookie: adminCookie, origin: base, 'x-requested-with': 'fetch', ...(init.headers || {}) } });

// Reads a tar archive into { name: Buffer }.
function untar(buf) {
  const files = {};
  let at = 0;
  while (at + 512 <= buf.length) {
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const field = (start, len) => h.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    const size = parseInt(field(124, 12), 8);
    files[name] = buf.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

before(async () => {
  migrate();
  settings.load();
  await seed();
  settings.load();
  money.load();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminCookie = await login('admin@test.local', 'admin-pass-123');
});

after(() => {
  server && server.close();
  try {
    require('../src/db').db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('the full backup is a tar.gz with a working database snapshot, every uploaded file and a manifest', async () => {
  const receipt = path.join(TMP, 'uploads', 'private', 'receipts', 'test-receipt.png');
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, Buffer.from('fake image bytes'));

  const temps = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('mts-backup-') && f.endsWith('.db'));
  const tempsBefore = temps();
  const res = await asAdmin('/seller/backups/download');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/gzip/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="mts-backup-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz"/);
  assert.equal(res.headers.get('content-encoding'), null, 'sent as the archive itself, not compressed twice');
  const files = untar(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())));

  assert.deepEqual(files['uploads/private/receipts/test-receipt.png'], Buffer.from('fake image bytes'));
  const manifest = JSON.parse(files['manifest.json']);
  assert.equal(manifest.app, 'MTS Store');
  assert.equal(manifest.counts.users, get('SELECT COUNT(*) AS n FROM users').n);

  const copy = path.join(TMP, 'restored.db');
  fs.writeFileSync(copy, files['store.db']);
  const restored = new DatabaseSync(copy, { readOnly: true });
  try {
    assert.equal(restored.prepare("SELECT role FROM users WHERE email = 'admin@test.local'").get().role, 'admin');
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM products').get().n, get('SELECT COUNT(*) AS n FROM products').n);
    assert.equal(restored.prepare('PRAGMA user_version').get().user_version, manifest.schemaVersion);
  } finally {
    restored.close();
  }
  assert.deepEqual(temps(), tempsBefore, 'the temporary snapshot is removed');
});

test('only the admin reaches the backups', async () => {
  const anonymous = await fetch(base + '/seller/backups/download', { redirect: 'manual' });
  assert.equal(anonymous.status, 302);
  assert.match(anonymous.headers.get('location'), /^\/login/);
  const page = await asAdmin('/seller/backups');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('النسخ الاحتياطي') && html.includes('/seller/backups/download'));
});

test('a snapshot a day is kept on the server, the oldest beyond seven are dropped, and each can be downloaded', async () => {
  for (let i = 0; i < 9; i++) backups.daily(new Date(Date.UTC(2026, 9, 1 + i, 12)));
  assert.equal(backups.daily(new Date(Date.UTC(2026, 9, 9, 18))), null, 'once a day');
  const kept = backups.list();
  assert.equal(kept.length, 7);
  assert.equal(kept[0].day, '2026-10-09');
  assert.equal(kept[6].day, '2026-10-03');

  const one = await asAdmin(`/seller/backups/daily/${kept[0].name}`);
  assert.equal(one.status, 200);
  assert.equal(Buffer.from(await one.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await asAdmin('/seller/backups/daily/..%2Ftest.db')).status, 404);
  assert.equal((await asAdmin('/seller/backups/daily/store-2026-01-01.db')).status, 404);
});

test('turning on the daily copy by e-mail sends one right away, then at most one a day', async () => {
  const outbox = mail.useMemoryTransport();
  try {
    const on = await asAdmin('/seller/backups/email', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'on=1' });
    assert.equal(on.status, 200);
    assert.equal(settings.get('backup_email'), '1');
    const sent = outbox.find((m) => m.subject.startsWith('نسخة احتياطية'));
    assert.ok(sent, 'the first copy went out');
    assert.equal(sent.to, settings.get('support_email'));
    const attachment = sent.attachments[0];
    assert.match(attachment.filename, /^store-\d{4}-\d{2}-\d{2}\.db\.gz$/);
    assert.equal(zlib.gunzipSync(attachment.content).subarray(0, 15).toString(), 'SQLite format 3');
    assert.ok(!/[ً-ْ—]/.test(sent.text), 'plain Arabic, no diacritics or em dashes');

    assert.equal(await backups.emailDaily({ to: 'admin@test.local' }), null, 'not twice on the same day');
    const tomorrow = new Date(Date.now() + 86400000);
    assert.equal((await backups.emailDaily({ to: 'admin@test.local', now: tomorrow })).ok, true, 'the next day sends again');

    await asAdmin('/seller/backups/email', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'on=0' });
    assert.equal(settings.get('backup_email'), '0');
    assert.equal(await backups.emailDaily({ to: 'admin@test.local', now: new Date(Date.now() + 2 * 86400000) }), null, 'off means no e-mail');
  } finally {
    mail.useRealTransport();
  }
});
