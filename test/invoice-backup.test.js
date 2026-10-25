'use strict';
// Invoice copies in Google Drive against a throwaway database and a small stand-in for the Drive API: new and
// edited invoices go up as PDF files, deleted ones move to their own folder, the register lists them all, Google's
// errors stop the run with a reason the admin can act on, and a real print through Chrome makes one A4 page.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-drive-test-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: TMP,
  DB_FILE: path.join(TMP, 'test.db'),
  UPLOAD_DIR: path.join(TMP, 'uploads'),
  ADMIN_EMAIL: 'admin@test.local',
  ADMIN_PASSWORD: 'admin-pass-123',
  ADMIN_WHATSAPP: '+201093525956',
  GOOGLE_CLIENT_ID: '',
  SEED_DEMO: 'false',
  TRUST_PROXY: '0',
  RATE_LIMIT: 'off',
  GMAIL_CLIENT_ID: '1234567890-test.apps.googleusercontent.com',
  GMAIL_CLIENT_SECRET: 'test-client-secret',
  GMAIL_REFRESH_TOKEN: '',
  DRIVE_REFRESH_TOKEN: 'test-drive-token',
  DRIVE_BACKUP: 'on',
  SMTP_HOST: '',
  SMTP_USER: '',
  SMTP_PASS: '',
  MAIL_FROM: '',
  MAIL_TRANSPORT: '',
});

const config = require('../src/config');
const { migrate, get, run } = require('../src/db');
const { seed } = require('../src/seed');
const settings = require('../src/lib/settings');
const money = require('../src/lib/money');
const invoices = require('../src/lib/invoices');
const drive = require('../src/lib/google-drive');
const pdf = require('../src/lib/pdf');
const backup = require('../src/lib/invoice-backup');
const { createApp } = require('../src/app');

/* ---------------------------------------------------------------------
   A stand-in for the Drive API: the calls the store makes, kept in memory
   --------------------------------------------------------------------- */
// fail answers every request with that error; failUpload only the next upload; dropNextCreate makes the next file
// but loses the answer.
const fake = { files: new Map(), fail: null, failUpload: null, dropNextCreate: false, requests: 0 };
const FOLDER = 'application/vnd.google-apps.folder';

const driveError = (status, reason, message, extra = {}) => ({ status, body: { error: { code: status, message, errors: [{ reason }], ...extra } } });
const notFound = (id) => driveError(404, 'notFound', `File not found: ${id}.`);

function meta(f) {
  const { data, revisions, ...m } = f;
  return m;
}

// The file and every folder above it in the bin: Drive reports both as trashed.
function inBin(f) {
  for (let cur = f; cur; cur = fake.files.get((cur.parents || [])[0])) if (cur.explicitlyTrashed) return true;
  return false;
}

function matches(f, q) {
  for (const [, key, value] of q.matchAll(/appProperties has \{ key='([^']*)' and value='([^']*)' \}/g)) if ((f.appProperties || {})[key] !== value) return false;
  if (/trashed = false/.test(q) && inBin(f)) return false;
  const type = /mimeType = '([^']*)'/.exec(q);
  return !type || f.mimeType === type[1];
}

function multipart(body, type) {
  const boundary = `--${/boundary=([^;]+)/.exec(type)[1]}`;
  const start = body.indexOf('\r\n\r\n') + 4;
  const second = body.indexOf(boundary, start);
  const metaJson = JSON.parse(body.subarray(start, second - 2).toString('utf8'));
  const dataStart = body.indexOf('\r\n\r\n', second) + 4;
  const end = body.lastIndexOf(`\r\n${boundary}--`);
  return { meta: metaJson, data: body.subarray(dataStart, end) };
}

function handle(req, body) {
  if (req.headers.authorization !== 'Bearer test-token') return driveError(401, 'authError', 'Invalid Credentials');
  const url = new URL(req.url, 'http://drive.test');
  const id = (/^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/.exec(url.pathname) || [])[1];
  const fileOf = (fid) => fake.files.get(decodeURIComponent(fid));
  if (req.method === 'GET' && url.pathname === '/drive/v3/about') return { status: 200, body: { user: { emailAddress: 'owner@gmail.test', displayName: 'Owner' } } };
  if (req.method === 'GET' && url.pathname === '/drive/v3/files') return { status: 200, body: { files: [...fake.files.values()].filter((f) => matches(f, url.searchParams.get('q') || '')).map(meta) } };
  if (req.method === 'GET' && id) {
    const f = fileOf(id);
    return f ? { status: 200, body: { ...meta(f), trashed: inBin(f) } } : notFound(id);
  }
  if (req.method === 'POST' && url.pathname === '/drive/v3/files') {
    const m = JSON.parse(body.toString('utf8'));
    const f = { id: crypto.randomBytes(8).toString('hex'), name: m.name, mimeType: m.mimeType, parents: m.parents || ['root'], appProperties: m.appProperties || {} };
    fake.files.set(f.id, f);
    return { status: 200, body: meta(f) };
  }
  if (req.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
    const { meta: m, data } = multipart(body, req.headers['content-type']);
    const f = { id: crypto.randomBytes(8).toString('hex'), name: m.name, mimeType: m.mimeType, parents: m.parents || ['root'], appProperties: m.appProperties || {}, data, revisions: [{ keepForever: false }] };
    fake.files.set(f.id, f);
    // The file is made, but the answer never reaches the store.
    if (fake.dropNextCreate) {
      fake.dropNextCreate = false;
      return driveError(503, 'backendError', 'The service is currently unavailable.');
    }
    return { status: 200, body: meta(f) };
  }
  if (req.method === 'PATCH' && id) {
    const f = fileOf(id);
    if (!f) return notFound(id);
    if (url.pathname.startsWith('/upload/')) {
      const { meta: m, data } = multipart(body, req.headers['content-type']);
      Object.assign(f, { name: m.name || f.name, data });
      f.revisions.push({ keepForever: url.searchParams.get('keepRevisionForever') === 'true' });
    } else {
      const m = JSON.parse(body.toString('utf8') || '{}');
      if (m.name) f.name = m.name;
    }
    const remove = (url.searchParams.get('removeParents') || '').split(',').filter(Boolean);
    const add = url.searchParams.get('addParents');
    if (remove.length || add) f.parents = [...f.parents.filter((p) => !remove.includes(p)), ...(add ? [add] : [])];
    return { status: 200, body: meta(f) };
  }
  return driveError(400, 'badRequest', `${req.method} ${url.pathname} is not part of this stand-in`);
}

const driveServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    fake.requests++;
    let out = fake.fail;
    if (!out && fake.failUpload && req.url.startsWith('/upload/')) [out, fake.failUpload] = [fake.failUpload, null];
    out = out || handle(req, Buffer.concat(chunks));
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
});

const byLabel = (key, value) => [...fake.files.values()].filter((f) => (f.appProperties || {})[key] === value);
const folderNamed = (name) => [...fake.files.values()].find((f) => f.mimeType === FOLDER && f.name === name && !inBin(f));

/* ---------------------------------------------------------------------
   The store
   --------------------------------------------------------------------- */
let server;
let base;
const rendered = [];

class Client {
  constructor() {
    this.jar = new Map();
  }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  headers(extra = {}) {
    return { cookie: Array.from(this.jar, ([k, v]) => `${k}=${v}`).join('; '), ...extra };
  }
  async get(url) {
    const res = await fetch(base + url, { redirect: 'manual', headers: this.headers() });
    this.store(res);
    return res;
  }
  async send(method, url, body) {
    const res = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: this.headers({ 'content-type': 'application/json', accept: 'application/json', origin: base, 'x-requested-with': 'fetch' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.store(res);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  async form(url, fields) {
    const res = await fetch(base + url, {
      method: 'POST',
      redirect: 'manual',
      headers: this.headers({ 'content-type': 'application/x-www-form-urlencoded', origin: base, 'x-requested-with': 'fetch' }),
      body: new URLSearchParams(fields).toString(),
    });
    this.store(res);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
}

const admin = new Client();
const API = '/seller/api/invoices';
const YEAR = invoices.today().slice(0, 4);
const valid = (extra = {}) => ({
  client_name: 'أحمد إبراهيم',
  client_contact: 'ahmad@example.com',
  client_country: 'PS',
  currency: 'USD',
  total: '1500',
  paid: '1500',
  method: 'InstaPay',
  paid_on: `${YEAR}-03-10`,
  service: 'design',
  purpose: 'تصميم هوية بصرية كاملة',
  issued_on: `${YEAR}-03-10`,
  lang: 'ar',
  ...extra,
});
const create = async (extra) => {
  const res = await admin.send('POST', API, valid(extra));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.invoice;
};
// The routes start a run a few seconds after each change; the tests run it at once instead.
const syncNow = async () => {
  backup.stop();
  const out = await backup.sync();
  backup.stop();
  return out;
};
const row = (id) => get('SELECT drive_file_id, drive_rev, drive_done, drive_error FROM invoices WHERE id = ?', id);
// Stands in for Chrome: a tiny PDF, and the page it was asked to print kept for the checks.
const fakePdf = async (html) => {
  rendered.push(html);
  return Buffer.from(`%PDF-1.7 test ${rendered.length}`);
};

before(async () => {
  await new Promise((r) => driveServer.listen(0, '127.0.0.1', r));
  config.drive.apiBase = `http://127.0.0.1:${driveServer.address().port}`;
  drive.useToken(async () => 'test-token');
  backup.useRenderer(fakePdf);
  backup.useManualRuns();
  migrate();
  settings.load();
  await seed();
  settings.load();
  money.load();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await admin.form('/login', { email: 'admin@test.local', password: 'admin-pass-123' });
  assert.equal(login.body.ok, true, JSON.stringify(login.body));
});

after(() => {
  backup.reset();
  server && server.close();
  driveServer.close();
  try {
    require('../src/db').db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('a new invoice goes to Drive as a PDF in its year folder, and the register lists it', async () => {
  const inv = await create();
  assert.equal(await syncNow(), 'ready', JSON.stringify(backup.health));

  const root = folderNamed('فواتير MTS Agency');
  assert.ok(root, 'the store made its folder');
  const year = folderNamed(YEAR);
  assert.deepEqual(year.parents, [root.id], 'one folder a year inside it');
  const [file] = byLabel('mtsInvoice', inv.number);
  assert.equal(file.name, `${inv.number} - أحمد إبراهيم.pdf`);
  assert.equal(file.mimeType, 'application/pdf');
  assert.deepEqual(file.parents, [year.id]);
  assert.equal(file.appProperties.mtsStore, settings.get('drive_instance'));
  assert.ok(file.data.toString('latin1').startsWith('%PDF'));
  assert.deepEqual({ ...row(inv.id) }, { drive_file_id: file.id, drive_rev: 1, drive_done: 1, drive_error: null });

  // The page printed is the print page itself, with nothing left to load.
  const html = rendered[rendered.length - 1];
  assert.ok(html.includes(inv.number) && html.includes('أحمد إبراهيم') && html.includes('data-inv-sheet'));
  assert.equal(html.match(/src: url\(data:font\/woff2;base64,/g).length, 6, 'the six IBM Plex Sans Arabic faces are inside');
  assert.ok(html.includes('src="data:image/png;base64,'), 'and the logo');
  assert.ok(!/(src|href)="\/static\//.test(html));

  const register = byLabel('mts', 'register');
  assert.equal(register.length, 1);
  assert.equal(register[0].name, 'سجل الفواتير.xlsx');
  assert.deepEqual(register[0].parents, [root.id]);
  assert.equal(register[0].data.subarray(0, 2).toString(), 'PK', 'an .xlsx file');
  const [list, summary] = backup.registerSheets();
  const line = list.rows.find((r) => r[0] === inv.number);
  assert.equal(line[2], 'أحمد إبراهيم');
  assert.equal(line[7], 1500);
  assert.equal(line[10], 'مدفوعة');
  assert.ok(line[18].f.includes(`https://drive.google.com/file/d/${file.id}/view`));
  assert.deepEqual(summary.rows[4], ['USD', { v: 1, s: 'int' }, 1500, 1500, 0]);

  const api = await admin.send('GET', `${API}/${inv.id}`);
  assert.deepEqual(api.body.invoice.drive, { saved: true, url: `https://drive.google.com/file/d/${file.id}/view` });
  const page = await (await admin.get(`/seller/invoices/${inv.id}`)).text();
  assert.ok(page.includes(`https://drive.google.com/file/d/${file.id}/view`), 'the editor links to the copy');
  assert.equal((await (await fetch(`${base}/healthz`)).json()).drive, 'ready');
});

test('an edit uploads a new version of the same file and Drive keeps the old one for good', async () => {
  const inv = await create({ client_name: 'مطعم البيت الدمشقي' });
  await syncNow();
  const [file] = byLabel('mtsInvoice', inv.number);
  const put = await admin.send('PUT', `${API}/${inv.id}`, valid({ client_name: 'مطعم البيت الدمشقي', total: '2000', paid: '500' }));
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.invoice.drive.saved, false, 'waiting for the new version');
  await syncNow();
  assert.equal(byLabel('mtsInvoice', inv.number).length, 1, 'still one file');
  assert.deepEqual(file.revisions, [{ keepForever: false }, { keepForever: true }]);
  assert.deepEqual({ ...row(inv.id) }, { drive_file_id: file.id, drive_rev: 2, drive_done: 2, drive_error: null });
  assert.equal(backup.registerSheets()[0].rows.find((r) => r[0] === inv.number)[10], 'مدفوعة جزئيا');
});

test('a deleted invoice keeps its file: it moves to the deleted folder and stays in the register', async () => {
  const inv = await create({ client_name: 'شركة النخبة' });
  await syncNow();
  const [file] = byLabel('mtsInvoice', inv.number);
  assert.equal((await admin.send('DELETE', `${API}/${inv.id}`)).status, 200);
  await syncNow();
  const removed = folderNamed('فواتير محذوفة');
  assert.ok(removed && fake.files.has(file.id) && !inBin(file));
  assert.deepEqual(file.parents, [removed.id]);
  assert.ok(get('SELECT moved_at FROM drive_removed WHERE number = ?', inv.number).moved_at);
  const gone = backup.registerSheets()[2].rows.find((r) => r[0] === inv.number);
  assert.deepEqual(gone.slice(0, 4), [inv.number, 'شركة النخبة', 'USD', 1500]);
});

test('a copy put in the bin is uploaded again, and an answer lost on the way never makes a second copy', async () => {
  const inv = await create({ client_name: 'مؤسسة الأفق' });
  await syncNow();
  const [first] = byLabel('mtsInvoice', inv.number);
  first.explicitlyTrashed = true;
  await admin.send('PUT', `${API}/${inv.id}`, valid({ client_name: 'مؤسسة الأفق', note: 'الدفعة الثانية عند التسليم' }));
  await syncNow();
  const copies = byLabel('mtsInvoice', inv.number).filter((f) => !inBin(f));
  assert.equal(copies.length, 1);
  assert.notEqual(copies[0].id, first.id);
  assert.equal(row(inv.id).drive_file_id, copies[0].id);

  // Drive makes the file but the answer is lost: the run stops, and the next one finds that file.
  const lost = await create({ client_name: 'متجر الريحان' });
  fake.dropNextCreate = true;
  await syncNow();
  assert.equal(backup.health.status, 'failed');
  assert.equal(backup.health.reason, 'network');
  assert.equal(row(lost.id).drive_done, 0);
  assert.equal(await syncNow(), 'ready');
  const made = byLabel('mtsInvoice', lost.number);
  assert.equal(made.length, 1, 'no second copy');
  assert.equal(row(lost.id).drive_file_id, made[0].id);
});

test('Google errors stop the run with the reason and the fix, and it carries on after the fix', async () => {
  const inv = await create({ client_name: 'استوديو المدار' });
  fake.fail = driveError(403, 'accessNotConfigured', 'Google Drive API has not been used in project 1234567890 before or it is disabled.', {
    status: 'PERMISSION_DENIED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', metadata: { consumer: 'projects/1234567890' } }],
  });
  try {
    assert.equal(await syncNow(), 'failed');
    assert.equal(backup.health.reason, 'api-disabled');
    assert.equal(backup.health.project, '1234567890');
    assert.equal(row(inv.id).drive_done, 0, 'still waiting');
    assert.equal((await (await fetch(`${base}/healthz`)).json()).drive, 'failed');
    const page = await (await admin.get('/seller/backups')).text();
    assert.ok(page.includes('واجهة Google Drive API متوقفة') && page.includes('drive.googleapis.com?project=1234567890'));
    assert.ok(!page.includes('test-drive-token') && !page.includes('test-client-secret'), 'never a secret on the page');
  } finally {
    fake.fail = null;
  }
  assert.equal(await syncNow(), 'ready');
  assert.equal(row(inv.id).drive_done, 1);

  // A full Drive.
  const full = await create({ client_name: 'مكتبة النور' });
  fake.failUpload = driveError(403, 'storageQuotaExceeded', "The user's Drive storage quota has been exceeded.");
  assert.equal(await syncNow(), 'failed');
  assert.equal(backup.health.reason, 'storage');
  assert.ok((await (await admin.get('/seller/backups')).text()).includes('مساحة Google Drive ممتلئة'));
  assert.equal(await syncNow(), 'ready');
  assert.equal(row(full.id).drive_done, 1);
});

test('the backups page shows what is in Drive, and the button uploads what waits', async () => {
  const inv = await create({ client_name: 'شركة السنبلة' });
  backup.stop();
  const page = await (await admin.get('/seller/backups')).text();
  const root = folderNamed('فواتير MTS Agency');
  assert.ok(page.includes(`https://drive.google.com/drive/folders/${root.id}`), 'a link to the folder');
  assert.ok(page.includes('owner@gmail.test') && page.includes('سجل الفواتير') && page.includes('والباقي في الطريق'));
  const res = await admin.form('/seller/backups/drive/sync', {});
  backup.stop();
  assert.equal(res.body.ok, true);
  assert.equal(res.body.message, 'كل الفواتير محفوظة في Google Drive');
  assert.equal(row(inv.id).drive_done, 1);
  assert.equal(backup.counts().pending, 0);
});

test('without DRIVE_REFRESH_TOKEN nothing goes to Drive and the page explains how to connect it', async () => {
  const token = config.drive.refreshToken;
  config.drive.refreshToken = '';
  const before = fake.requests;
  try {
    const inv = await create({ client_name: 'عميل بلا ربط' });
    assert.equal(backup.status(), 'off');
    assert.equal(await syncNow(), 'off');
    assert.equal(fake.requests, before, 'not a single call to Google');
    assert.equal(row(inv.id).drive_done, 0);
    const page = await (await admin.get('/seller/backups')).text();
    assert.ok(page.includes('npm run drive-auth') && page.includes('DRIVE_REFRESH_TOKEN'));
    assert.equal((await (await fetch(`${base}/healthz`)).json()).drive, 'off');
    assert.equal((await admin.form('/seller/backups/drive/sync', {})).body.ok, false);
  } finally {
    config.drive.refreshToken = token;
  }
  // Once connected, what waited goes up.
  assert.equal(await syncNow(), 'ready');
  assert.equal(backup.counts().pending, 0);
});

test('a copy of the store on another computer does not upload, even with the token in its .env', async () => {
  config.drive.enabled = false;
  const before = fake.requests;
  try {
    const inv = await create({ client_name: 'فاتورة تجربة' });
    assert.equal(backup.status(), 'paused');
    assert.equal(await syncNow(), 'paused');
    assert.equal(fake.requests, before, 'not a single call to Google');
    assert.equal(row(inv.id).drive_done, 0);
    const page = await (await admin.get('/seller/backups')).text();
    assert.ok(page.includes('الرفع يجري على السيرفر وحده') && page.includes('DRIVE_BACKUP=on'));
    assert.equal((await (await fetch(`${base}/healthz`)).json()).drive, 'paused');
  } finally {
    config.drive.enabled = true;
  }
  assert.equal(await syncNow(), 'ready');
  assert.equal(backup.counts().pending, 0);
});

test('uploads run on the live server by default and DRIVE_BACKUP switches them', () => {
  const { execFileSync } = require('child_process');
  const probe = (env) =>
    execFileSync(process.execPath, ['-e', "process.stdout.write(String(require('./src/config').drive.enabled))"], {
      cwd: path.join(__dirname, '..'),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DRIVE_BACKUP: '', NODE_ENV: '', ...env },
    }).toString();
  assert.equal(probe({ NODE_ENV: 'production' }), 'true');
  assert.equal(probe({ RAILWAY_ENVIRONMENT_NAME: 'production' }), 'true');
  assert.equal(probe({ NODE_ENV: 'development' }), 'false');
  assert.equal(probe({ NODE_ENV: 'development', DRIVE_BACKUP: 'on' }), 'true');
  assert.equal(probe({ NODE_ENV: 'production', DRIVE_BACKUP: 'off' }), 'false');
});

test('reasons: no Chrome, a full Drive and the usual Google problems', () => {
  assert.equal(backup.reasonOf(Object.assign(new Error('x'), { code: 'NO_CHROME' })), 'no-chrome');
  assert.equal(backup.reasonOf(new Error("Drive API 403 storageQuotaExceeded: The user's Drive storage quota has been exceeded.")), 'storage');
  assert.equal(backup.reasonOf(new Error('Drive API 403 SERVICE_DISABLED accessNotConfigured: Google Drive API has not been used')), 'api-disabled');
  assert.equal(backup.reasonOf(new Error('Drive API 403 insufficientPermissions: Request had insufficient authentication scopes.')), 'scope');
  assert.equal(backup.reasonOf(new Error('invalid_grant')), 'revoked');
  assert.equal(backup.reasonOf(new Error('Drive API 429 userRateLimitExceeded: User rate limit exceeded.')), 'quota');
  assert.equal(backup.reasonOf(new Error('Drive API 503 backendError: The service is currently unavailable.')), 'network');
  for (const r of ['api-disabled', 'scope', 'revoked', 'client', 'storage', 'no-chrome', 'chrome']) assert.ok(backup.NEEDS_FIX.has(r));
});

test('when Chrome cannot print, the run stops with that reason and the invoice waits', async () => {
  const inv = await create({ client_name: 'شركة الطباعة' });
  backup.useRenderer(async () => {
    throw new Error('Command failed: chromium --headless=new: error while loading shared libraries: libnss3.so');
  });
  try {
    assert.equal(await syncNow(), 'failed');
    assert.equal(backup.health.reason, 'chrome');
    assert.equal(row(inv.id).drive_done, 0);
    assert.equal(row(inv.id).drive_error, null, 'not blamed on the invoice');
    assert.ok((await (await admin.get('/seller/backups')).text()).includes('Chromium لم يستطع تحويل الفاتورة إلى PDF'));
  } finally {
    backup.useRenderer(fakePdf);
  }
  assert.equal(await syncNow(), 'ready');
  assert.equal(row(inv.id).drive_done, 1);
});

test('an invoice deleted while it uploads still ends up in the deleted folder', async () => {
  const inv = await create({ client_name: 'حذف أثناء الرفع' });
  backup.useRenderer(async (html) => {
    // The admin deletes it while Chrome is printing it.
    if (html.includes('حذف أثناء الرفع')) invoices.remove(inv.id);
    return fakePdf(html);
  });
  try {
    assert.equal(await syncNow(), 'ready');
  } finally {
    backup.useRenderer(fakePdf);
  }
  const [file] = byLabel('mtsInvoice', inv.number);
  assert.deepEqual(file.parents, [folderNamed('فواتير محذوفة').id]);
  const moved = get('SELECT file_id, moved_at FROM drive_removed WHERE number = ?', inv.number);
  assert.equal(moved.file_id, file.id);
  assert.ok(moved.moved_at, 'moved in the same run');
});

test('the copy printed by Chrome is one A4 page with the invoice fonts inside', { skip: pdf.available() ? false : 'Chrome is not installed here' }, async () => {
  const inv = invoices.byId((await create({ client_name: 'شركة النخبة للتجارة والاستثمار', purpose: 'تصميم هوية بصرية كاملة تشمل الشعار والألوان والخطوط ودليل الاستخدام. '.repeat(12) })).id);
  const bytes = (await pdf.fromHtml(backup.printable(inv))).toString('latin1');
  assert.ok(bytes.startsWith('%PDF-'));
  assert.equal((bytes.match(/\/Type\s*\/Page(?!s)/g) || []).length, 1, 'one page');
  const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(bytes);
  assert.ok(Math.abs(Number(box[1]) - 595.3) < 3 && Math.abs(Number(box[2]) - 841.9) < 3, `A4 portrait, got ${box[1]} x ${box[2]}`);
  assert.match(bytes, /IBMPlexSansArabic/, 'the Arabic font is embedded, not a fallback');
  if (process.env.INVOICE_PDF_DIR) fs.writeFileSync(path.join(process.env.INVOICE_PDF_DIR, 'drive-copy.pdf'), Buffer.from(bytes, 'latin1'));
});
