'use strict';
// Invoices against a throwaway database: amounts and status, validation, numbering (concurrent and
// across years), search, filters, the API, the pages, and a real A4 print through headless Chrome.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-invoices-test-'));
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
  GMAIL_CLIENT_ID: '',
  GMAIL_CLIENT_SECRET: '',
  GMAIL_REFRESH_TOKEN: '',
  SMTP_HOST: '',
  SMTP_USER: '',
  SMTP_PASS: '',
  MAIL_FROM: '',
  MAIL_TRANSPORT: '',
});

const { migrate, get, run } = require('../src/db');
const { seed } = require('../src/seed');
const settings = require('../src/lib/settings');
const money = require('../src/lib/money');
const invoices = require('../src/lib/invoices');
const sheet = require('../public/js/invoice-sheet');
const { createApp } = require('../src/app');

let server;
let base;

class Client {
  constructor() {
    this.jar = new Map();
  }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a)) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  headers(extra = {}) {
    return { cookie: Array.from(this.jar, ([k, v]) => `${k}=${v}`).join('; '), ...extra };
  }
  async get(url, { json = false } = {}) {
    const res = await fetch(base + url, { redirect: 'manual', headers: this.headers(json ? { accept: 'application/json' } : {}) });
    this.store(res);
    return json ? { status: res.status, body: await res.json() } : res;
  }
  async send(method, url, body, { origin = base } = {}) {
    const headers = this.headers({ 'content-type': 'application/json', accept: 'application/json', 'x-requested-with': 'fetch' });
    if (origin) headers.origin = origin;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    this.store(res);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  async form(url, fields) {
    const res = await fetch(base + url, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/x-www-form-urlencoded', origin: base, 'x-requested-with': 'fetch' }),
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
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

before(async () => {
  migrate();
  settings.load();
  await seed();
  settings.load();
  money.load();
  server = createApp().listen(0);
  server.keepAliveTimeout = 120000;
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await admin.form('/login', { email: 'admin@test.local', password: 'admin-pass-123' });
  assert.equal(login.body.ok, true, JSON.stringify(login.body));
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

/* ---------------------------------------------------------------------
   Pure functions
   --------------------------------------------------------------------- */
test('amounts print without zero decimals, fractions with two, Latin digits and thousands separators', () => {
  assert.equal(sheet.formatNumber(10000), '100');
  assert.equal(sheet.formatNumber(150000), '1,500');
  assert.equal(sheet.formatNumber(150050), '1,500.50');
  assert.equal(sheet.formatNumber(150005), '1,500.05');
  assert.equal(sheet.formatNumber(5), '0.05');
  assert.equal(sheet.formatNumber(123456789), '1,234,567.89');
  assert.equal(sheet.amountText(150000, { code: 'USD', symbol: '$' }, 'ar'), '1,500 $');
  assert.equal(sheet.amountText(150050, { code: 'EGP', symbol: 'ج.م' }, 'en'), '1,500.50 EGP');
});

test('status and remaining are computed, and a missing paid amount means paid in full', () => {
  assert.deepEqual(sheet.computeStatus(100000, 100000), { total: 100000, paid: 100000, remaining: 0, status: 'paid' });
  assert.deepEqual(sheet.computeStatus(100000, 40000), { total: 100000, paid: 40000, remaining: 60000, status: 'partial' });
  assert.deepEqual(sheet.computeStatus(100000, 0), { total: 100000, paid: 0, remaining: 100000, status: 'unpaid' });
  assert.deepEqual(sheet.computeStatus(100000, null), { total: 100000, paid: 100000, remaining: 0, status: 'paid' });
  assert.equal(sheet.computeStatus(100000, 1).status, 'partial');
  assert.equal(sheet.computeStatus(100000, 99999).remaining, 1);
});

test('day names come from the date, in Arabic and English', () => {
  assert.equal(sheet.dayLabel('2026-10-15', 'ar'), 'الخميس، 15 أكتوبر 2026');
  assert.equal(sheet.dayLabel('2026-10-15', 'en'), 'Thursday, 15 October 2026');
  assert.equal(sheet.dayLabel('2026-10-15', 'ar', { weekday: false }), '15 أكتوبر 2026');
  assert.equal(sheet.dayLabel('2026-02-30', 'ar'), '');
  assert.equal(sheet.countryName('PS', 'ar'), 'فلسطين');
  assert.equal(sheet.countryName('PS', 'en'), 'Palestine');
  assert.equal(sheet.countryName('EG', 'en'), 'Egypt');
});

test('search spelling: hamza forms, alef maqsura, ta marbuta and Hindi digits read the same', () => {
  assert.equal(invoices.normalize('أحمد إبراهيم آمنة'), 'احمد ابراهيم امنه');
  assert.equal(invoices.normalize('مصطفى'), 'مصطفي');
  assert.equal(invoices.normalize('فاطمة'), 'فاطمه');
  assert.equal(invoices.normalize('MTS-٢٠٢٦-٠٠١'), 'mts-2026-001');
  assert.equal(invoices.normalize('مُحَمَّد  ـ InstaPay'), 'محمد instapay');
});

test('validation ties every problem to its field', () => {
  const check = (extra) => invoices.validate(valid(extra)).errors;
  assert.deepEqual(invoices.validate(valid()).errors, {});
  assert.ok(check({ client_name: '  ' }).client_name);
  assert.ok(check({ client_name: 'x'.repeat(121) }).client_name);
  assert.ok(check({ client_contact: 'not a contact' }).client_contact);
  assert.ok(check({ client_contact: 'a@b' }).client_contact);
  assert.deepEqual(check({ client_contact: '+970 599 123 456' }), {});
  assert.ok(check({ client_country: 'XX' }).client_country);
  assert.ok(check({ client_country: 'ps1' }).client_country);
  assert.ok(check({ currency: 'BTC' }).currency);
  for (const total of ['', '0', '-5', '12.345', '1e3', 'abc', '١٢٫٣٤٥']) assert.ok(check({ total, paid: '0' }).total, `total ${total}`);
  assert.ok(check({ paid: '1500.01' }).paid);
  assert.ok(check({ paid: '10.123' }).paid);
  assert.ok(check({ method: '' }).method, 'a payment needs a method');
  assert.ok(check({ paid_on: '' }).paid_on, 'a payment needs a date');
  assert.ok(check({ paid_on: '2026-02-30' }).paid_on);
  assert.ok(check({ paid_on: '15/10/2026' }).paid_on);
  assert.ok(check({ due_on: '2026-13-01', paid: '100' }).due_on);
  assert.ok(check({ issued_on: '2026-00-10' }).issued_on);
  assert.ok(check({ service: 'cooking' }).service);
  assert.ok(check({ service: '' }).service);
  assert.ok(check({ purpose: 'x'.repeat(2001) }).purpose);
  assert.deepEqual(check({ purpose: 'x'.repeat(2000) }), {});
  assert.ok(check({ note: 'x'.repeat(501) }).note);
  assert.ok(check({ lang: 'fr' }).lang);
  assert.ok(check({ project_id: '999' }).project_id);

  // Nothing paid: method and date are optional and dropped.
  const unpaid = invoices.validate(valid({ paid: '0', method: '', paid_on: '' }));
  assert.deepEqual(unpaid.errors, {});
  assert.equal(unpaid.values.method, null);
  const dropped = invoices.validate(valid({ paid: '0', method: 'PayPal', paid_on: '2026-01-01' })).values;
  assert.equal(dropped.method, null);
  assert.equal(dropped.paid_on, null);
  // Arabic digits and separators, and a due date only while money is owed.
  const arabic = invoices.validate(valid({ total: '١٬٥٠٠٫٥٠', paid: '٥٠٠', due_on: '2026-04-01' })).values;
  assert.equal(arabic.total, 150050);
  assert.equal(arabic.paid, 50000);
  assert.equal(arabic.due_on, '2026-04-01');
  assert.equal(invoices.validate(valid({ due_on: '2026-04-01' })).values.due_on, null, 'paid in full: no due date');
});

/* ---------------------------------------------------------------------
   API
   --------------------------------------------------------------------- */
test('creating returns the number, status and remaining; editing keeps the number', async () => {
  const inv = await create({ total: '1000', paid: '400', due_on: `${YEAR}-04-01` });
  assert.equal(inv.number, `MTS-${YEAR}-0001`);
  assert.equal(inv.status, 'partial');
  assert.equal(inv.total, 1000);
  assert.equal(inv.paid, 400);
  assert.equal(inv.remaining, 600);
  assert.equal(inv.client.country, 'PS');
  assert.deepEqual(inv.client.country_name, { ar: 'فلسطين', en: 'Palestine' });
  assert.equal(inv.paid_on_label.ar, sheet.dayLabel(`${YEAR}-03-10`, 'ar'));

  const edited = await admin.send('PUT', `${API}/${inv.id}`, valid({ total: '1200', paid: '400', client_name: 'أحمد إبراهيم يوسف', issued_on: `${Number(YEAR) + 1}-01-05` }));
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.invoice.number, inv.number, 'the number never changes');
  assert.equal(edited.body.invoice.remaining, 800);
  assert.equal(edited.body.invoice.status, 'partial');

  const got = await admin.get(`${API}/${inv.id}`, { json: true });
  assert.equal(got.body.invoice.client.name, 'أحمد إبراهيم يوسف');
  assert.equal((await admin.get(`${API}/999999`, { json: true })).status, 404);
  assert.equal((await admin.get(`${API}/abc`, { json: true })).status, 404);

  const bad = await admin.send('POST', API, valid({ total: '0', service: '' }));
  assert.equal(bad.status, 422);
  assert.ok(bad.body.errors.total && bad.body.errors.service);
});

test('a deleted invoice number is never handed out again', async () => {
  const a = await create();
  const del = await admin.send('DELETE', `${API}/${a.id}`);
  assert.equal(del.body.ok, true);
  assert.equal((await admin.get(`${API}/${a.id}`, { json: true })).status, 404);
  const b = await create();
  assert.notEqual(b.number, a.number);
  assert.equal(Number(b.number.slice(-4)), Number(a.number.slice(-4)) + 1);
});

test('twenty invoices created at the same moment get twenty consecutive numbers', async () => {
  const before = get('SELECT seq FROM invoice_counters WHERE year = ?', Number(YEAR)).seq;
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => admin.send('POST', API, valid({ client_name: `عميل متزامن ${i}` }))));
  results.forEach((r) => assert.equal(r.status, 201, JSON.stringify(r.body)));
  const seqs = results.map((r) => Number(r.body.invoice.number.split('-')[2])).sort((x, y) => x - y);
  assert.equal(new Set(seqs).size, 20);
  assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => before + 1 + i));
});

test('numbering starts again with each year of issue', async () => {
  const next = `${Number(YEAR) + 3}`;
  const first = await create({ issued_on: `${next}-01-01`, paid_on: `${next}-01-01` });
  assert.equal(first.number, `MTS-${next}-0001`);
  const second = await create({ issued_on: `${next}-12-31`, paid_on: `${next}-12-31` });
  assert.equal(second.number, `MTS-${next}-0002`);
  const back = await create();
  assert.ok(back.number.startsWith(`MTS-${YEAR}-`));
  assert.ok(Number(back.number.slice(-4)) > 20, 'the current year keeps its own count');
});

test('search matches number, name, method, purpose and country in Arabic or English', async () => {
  const special = await create({ client_name: 'فاطمة مصطفى', method: 'فودافون كاش', purpose: 'مونتاج فيديو إعلاني لمطعم', client_country: 'EG', service: 'video' });
  const find = async (q) => (await admin.get(`${API}?q=${encodeURIComponent(q)}&per_page=200`, { json: true })).body.items.map((i) => i.id);
  assert.ok((await find('فاطمه مصطفي')).includes(special.id), 'ta marbuta and alef maqsura');
  assert.ok((await find('فودافون')).includes(special.id), 'method');
  assert.ok((await find('مطعم')).includes(special.id), 'purpose');
  assert.ok((await find('egypt')).includes(special.id), 'country in English');
  assert.ok((await find('مصر')).includes(special.id), 'country in Arabic');
  assert.ok((await find(special.number)).includes(special.id), 'number');
  const digits = special.number.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);
  assert.deepEqual(await find(digits), [special.id], 'Hindi digits in the number');
  assert.ok((await find('احمد ابراهيم')).length > 0, 'hamza forms');
  assert.deepEqual(await find('لا يوجد شيء كهذا'), []);
});

test('filters by status, service, currency, country and period (transfer date, else issue date)', async () => {
  const q = async (qs) => (await admin.get(`${API}?per_page=200&${qs}`, { json: true })).body;
  const unpaid = await create({ client_name: 'عميل الفلاتر', paid: '0', method: '', paid_on: '', currency: 'EGP', client_country: 'SA', service: 'training', issued_on: `${YEAR}-07-20` });
  const partial = await create({ client_name: 'عميل الفلاتر', paid: '100', currency: 'ILS', client_country: 'AE', service: 'marketing', issued_on: `${YEAR}-05-01`, paid_on: `${YEAR}-07-02` });

  assert.ok((await q('status=unpaid')).items.every((i) => i.status === 'unpaid'));
  assert.ok((await q('status=unpaid')).items.some((i) => i.id === unpaid.id));
  assert.ok((await q('status=partial')).items.every((i) => i.status === 'partial'));
  assert.ok((await q('status=paid')).items.every((i) => i.remaining === 0));
  assert.deepEqual((await q('service=training')).items.map((i) => i.id), [unpaid.id]);
  assert.ok((await q('currency=EGP')).items.every((i) => i.currency === 'EGP'));
  assert.deepEqual((await q('country=AE')).items.map((i) => i.id), [partial.id]);
  // July: the unpaid one by its issue date, the partial one by its transfer date (issued in May).
  const july = (await q(`from=${YEAR}-07-01&to=${YEAR}-07-31`)).items.map((i) => i.id);
  assert.ok(july.includes(unpaid.id) && july.includes(partial.id));
  const may = (await q(`from=${YEAR}-05-01&to=${YEAR}-05-31`)).items.map((i) => i.id);
  assert.ok(!may.includes(partial.id), 'counted by its transfer date, not its issue date');
  // A reversed range is read the right way round.
  assert.ok((await q(`from=${YEAR}-07-31&to=${YEAR}-07-01`)).items.some((i) => i.id === unpaid.id));
  // Combined filters and per-currency totals.
  const both = await q('status=partial&currency=ILS');
  assert.ok(both.items.length >= 1 && both.items.every((i) => i.currency === 'ILS' && i.status === 'partial'));
  const ils = both.totals.find((t) => t.currency === 'ILS');
  assert.equal(ils.remaining, ils.total - ils.paid);
  assert.equal(ils.count, both.items.length);
});

test('suggestions list the methods used before and the most frequent clients', async () => {
  const s = (await admin.get(`${API}/suggestions`, { json: true })).body;
  assert.equal(s.methods[0], 'InstaPay', 'the most used method comes first');
  for (const m of ['تحويل بنكي', 'PayPal', 'Payoneer', 'Wise', 'فودافون كاش']) assert.ok(s.methods.includes(m), m);
  assert.equal(new Set(s.methods.map((m) => invoices.normalize(m))).size, s.methods.length, 'no duplicates');
  assert.ok(s.clients.length > 0 && s.clients[0].count >= s.clients[s.clients.length - 1].count);
  assert.deepEqual(s.countries.slice(0, 5), ['PS', 'EG', 'SA', 'AE', 'JO']);
});

test('invoices saved before the paid amount existed count as paid in full', async () => {
  const id = Number(
    run(
      `INSERT INTO invoices (number, year, seq, client_name, currency, total, paid, service, issued_on, lang) VALUES ('OLD-2020-0001', 2020, 1, 'عميل قديم', 'USD', 25000, NULL, 'design', '2020-05-05', 'ar')`,
    ).lastInsertRowid,
  );
  const inv = (await admin.get(`${API}/${id}`, { json: true })).body.invoice;
  assert.equal(inv.status, 'paid');
  assert.equal(inv.paid, 250);
  assert.equal(inv.remaining, 0);
  assert.ok((await admin.get(`${API}?status=paid&per_page=200`, { json: true })).body.items.some((i) => i.id === id));
});

test('settings: prefilled from the site, international WhatsApp only, website without https', async () => {
  const first = (await admin.get(`${API}/settings`, { json: true })).body.settings;
  assert.equal(first.whatsapp, settings.get('whatsapp_number'));
  assert.equal(first.email, settings.get('support_email'));
  assert.equal(first.prefix, 'MTS');
  const body = { ...first, whatsapp: '01093525956', website: 'nope', prefix: 'M', email: 'bad' };
  const bad = await admin.send('PUT', `${API}/settings`, body);
  assert.equal(bad.status, 422);
  assert.match(bad.body.errors.whatsapp, /\+201093525956/);
  assert.ok(bad.body.errors.website && bad.body.errors.prefix && bad.body.errors.email);
  assert.ok((await admin.send('PUT', `${API}/settings`, { ...first, whatsapp: '00201093525956' })).body.errors.whatsapp, 'a leading 00 is refused too');
  const ok = await admin.send('PUT', `${API}/settings`, { ...first, whatsapp: '+20 109 352 5956', website: 'https://www.MTS-agency.com/', prefix: 'qk', footer_en: 'Thanks!' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.settings.whatsapp, '+201093525956');
  assert.equal(ok.body.settings.website, 'www.mts-agency.com');
  assert.equal(ok.body.settings.prefix, 'QK');
  const later = await create();
  assert.ok(later.number.startsWith(`QK-${YEAR}-`), 'a new prefix applies to new invoices');
  const older = (await admin.get(`${API}/1`, { json: true })).body.invoice;
  assert.ok(older.number.startsWith('MTS-'), 'existing numbers stay');
  await admin.send('PUT', `${API}/settings`, { ...first, prefix: 'MTS' });
});

test('the API needs an admin session and a same-site origin', async () => {
  const guest = new Client();
  assert.equal((await guest.get(API, { json: true })).status, 401);
  assert.equal((await guest.send('POST', API, valid())).status, 401);
  const buyer = new Client();
  const reg = await buyer.form('/register', { name: 'Buyer Test', email: 'buyer-inv@test.local', password: 'password123', password_confirm: 'password123', wa_country: 'EG', wa_number: '01011223344', agree: '1' });
  assert.equal(reg.body.ok, true, JSON.stringify(reg.body));
  assert.equal((await buyer.get(API, { json: true })).status, 403);
  assert.equal((await buyer.get('/seller/invoices')).status, 403);
  // Cross-site writes are refused even with the admin's cookie.
  assert.equal((await admin.send('POST', API, valid(), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await admin.send('DELETE', `${API}/1`, undefined, { origin: null })).status, 403);
});

test('dashboard pages render: list with totals, editor, duplicate and print', async () => {
  const inv = await create({ client_name: 'Lina Haddad', lang: 'en', total: '2500.5', paid: '0', method: '', paid_on: '' });
  const list = await admin.get('/seller/invoices');
  assert.equal(list.status, 200);
  const html = await list.text();
  assert.ok(html.includes(inv.number) && html.includes('Lina Haddad'));
  assert.ok(html.includes('inv-totals'), 'per-currency totals');
  assert.ok(html.includes('id="invSettings"'), 'settings window');
  for (const url of ['/seller/invoices?status=partial&currency=USD&period=year', '/seller/invoices?period=range&from=2020-01-01&to=2030-12-31&q=Lina', '/seller/invoices/new', `/seller/invoices/${inv.id}`, `/seller/invoices/new?from=${inv.id}`]) {
    assert.equal((await admin.get(url)).status, 200, url);
  }
  const dup = await (await admin.get(`/seller/invoices/new?from=${inv.id}`)).text();
  assert.ok(dup.includes('Lina Haddad') && dup.includes('نسخة من'));
  const print = await (await admin.get(`/seller/invoices/${inv.id}/print?noprint=1`)).text();
  assert.match(print, new RegExp(`<title>${inv.number} - Lina Haddad</title>`));
  assert.ok(print.includes('lang="en"') && print.includes('Unpaid'));
  assert.ok(!print.includes('Payment details'), 'no payment details on an unpaid invoice');
  assert.equal((await admin.get('/seller/invoices/999999')).status, 404);
});

/* ---------------------------------------------------------------------
   Real print: headless Chrome must produce exactly one A4 page
   --------------------------------------------------------------------- */
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const CHROME = findChrome();

// The saved print page points its stylesheet, scripts and logo at the files on disk: the server sends
// Cross-Origin-Resource-Policy: same-origin, so a page opened from a file may not load them over HTTP.
function localAssets(html) {
  const root = 'file:///' + path.join(__dirname, '..', 'public').replace(/\\/g, '/');
  return html.replace(/(["'(])\/static\/([^"'?)]+)(\?v=[^"')]*)?/g, (m, quote, file) => `${quote}${root}/${file}`);
}

test('printed invoices are exactly one A4 page in every state, in Arabic and English', { skip: CHROME ? false : 'Chrome is not installed here' }, async () => {
  const long = 'تصميم هوية بصرية كاملة تشمل الشعار والألوان والخطوط ودليل الاستخدام، مع تصميم ٣٠ منشورا لصفحات التواصل وغلافات للفيسبوك وإنستغرام، وتعديلات حتى الموافقة النهائية. ';
  const longEn = 'Full brand identity including logo, colours, typography and a usage guide, plus 30 social media posts, Facebook and Instagram covers, and revisions until final approval. ';
  await admin.send('PUT', `${API}/settings`, {
    ...(await admin.get(`${API}/settings`, { json: true })).body.settings,
    footer_ar: 'شكرا لثقتك بنا. يسعدنا العمل معك مرة أخرى، ولأي سؤال عن هذه الفاتورة أو عن الخدمة راسلنا على واتساب أو البريد وسنرد عليك في أقرب وقت ممكن خلال ساعات العمل.',
    footer_en: 'Thank you for your trust. We would be glad to work with you again. For any question about this invoice or the service, message us on WhatsApp or by email and we will reply as soon as we can during working hours.',
  });
  const cases = [];
  for (const lang of ['ar', 'en']) {
    const purpose = (lang === 'ar' ? long : longEn).repeat(lang === 'ar' ? 4 : 5).trim();
    const note = lang === 'ar' ? 'الدفعة الثانية تستحق عند تسليم الملفات النهائية بصيغ الطباعة والويب.' : 'The second payment is due on delivery of the final print and web files.';
    cases.push({ lang, state: 'paid', body: valid({ lang, client_name: lang === 'ar' ? 'شركة النخبة للتجارة والاستثمار' : 'Elite Trading & Investment Co.', purpose, note }) });
    cases.push({ lang, state: 'partial', body: valid({ lang, client_name: lang === 'ar' ? 'مؤسسة الأفق الجديد للخدمات التسويقية' : 'New Horizon Marketing Services', total: '12500.75', paid: '4000', due_on: `${YEAR}-11-30`, client_country: 'AE', purpose, note }) });
    cases.push({ lang, state: 'unpaid', body: valid({ lang, client_name: lang === 'ar' ? 'مطعم البيت الدمشقي' : 'Damascus House Restaurant', paid: '0', method: '', paid_on: '', due_on: `${YEAR}-12-15`, client_country: 'JO', purpose, note }) });
  }
  // The longest text the form accepts still fits (in the tightest type).
  cases.push({ lang: 'ar', state: 'max', body: valid({ total: '999999.99', paid: '1', due_on: `${YEAR}-12-31`, purpose: long.repeat(20).slice(0, 2000), note: 'ملاحظة '.repeat(80).slice(0, 500), client_name: 'ع'.repeat(120) }) });

  const out = path.join(TMP, 'print');
  fs.mkdirSync(out, { recursive: true });
  for (const c of cases) {
    const inv = (await admin.send('POST', API, c.body)).body.invoice;
    assert.equal(inv.status, c.state === 'max' ? 'partial' : c.state);
    const html = await (await admin.get(`/seller/invoices/${inv.id}/print?noprint=1`)).text();
    const file = path.join(out, `${c.lang}-${c.state}.html`);
    fs.writeFileSync(file, localAssets(html));
    const pdf = path.join(out, `${c.lang}-${c.state}.pdf`);
    // Asynchronous on purpose: Chrome loads the styles from this very test server.
    await promisify(execFile)(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${path.join(TMP, 'chrome-profile')}`,
        '--no-pdf-header-footer',
        '--virtual-time-budget=8000',
        `--print-to-pdf=${pdf}`,
        'file:///' + file.replace(/\\/g, '/'),
      ],
      { timeout: 120000, windowsHide: true },
    );
    const bytes = fs.readFileSync(pdf).toString('latin1');
    const pages = (bytes.match(/\/Type\s*\/Page(?!s)/g) || []).length;
    assert.equal(pages, 1, `${c.lang}-${c.state}: ${pages} pages`);
    const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(bytes);
    assert.ok(box, 'page size present');
    assert.ok(Math.abs(Number(box[1]) - 595.3) < 3 && Math.abs(Number(box[2]) - 841.9) < 3, `A4 portrait, got ${box[1]} x ${box[2]}`);
    if (process.env.INVOICE_PDF_DIR) fs.copyFileSync(pdf, path.join(process.env.INVOICE_PDF_DIR, path.basename(pdf)));
  }
});
