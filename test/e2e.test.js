'use strict';
// End-to-end flow against a throwaway database: node --test test/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-store-test-'));
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
  // Many accounts are registered from one IP here; the limiter itself is checked in its own test.
  RATE_LIMIT: 'off',
});

const { migrate, get, run } = require('../src/db');
const { seed } = require('../src/seed');
const settings = require('../src/lib/settings');
const money = require('../src/lib/money');
const { createApp } = require('../src/app');

// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let server;
let base;

class Client {
  constructor() {
    this.jar = new Map();
  }
  cookieHeader() {
    return Array.from(this.jar, ([k, v]) => `${k}=${v}`).join('; ');
  }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a)) || value === '';
      if (expired) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  async get(url, { follow = false } = {}) {
    const res = await fetch(base + url, { redirect: follow ? 'follow' : 'manual', headers: { cookie: this.cookieHeader() } });
    this.store(res);
    return res;
  }
  async post(url, body, { origin = base, json = true } = {}) {
    const headers = { cookie: this.cookieHeader(), origin, 'x-requested-with': 'fetch' };
    let payload = body;
    if (!(body instanceof FormData)) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(body).toString();
    }
    const res = await fetch(base + url, { method: 'POST', headers, body: payload, redirect: 'manual' });
    this.store(res);
    return json ? { status: res.status, body: await res.json() } : res;
  }
}

function receiptForm(fields, { file = PNG, name = 'receipt.png', type = 'image/png' } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  if (file) fd.append('receipt', new Blob([file], { type }), name);
  return fd;
}

const buyer = new Client();
const admin = new Client();
const stranger = new Client();
let plan;
let product;
let bankMethod;
let walletMethod;
let orderCode;

before(async () => {
  migrate();
  settings.load();
  await seed();
  settings.load();
  money.load();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  product = get("SELECT * FROM products WHERE slug = 'chatgpt-plus'");
  plan = get('SELECT * FROM product_plans WHERE product_id = ? ORDER BY sort_order LIMIT 1', product.id);
  bankMethod = get("SELECT * FROM payment_methods WHERE name = 'بنك فلسطين'");
  walletMethod = get("SELECT * FROM payment_methods WHERE currency_code = 'EGP'");
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

test('seed creates the four payment methods with the right accounts', () => {
  const methods = require('../src/db').all('SELECT * FROM payment_methods ORDER BY sort_order');
  assert.equal(methods.length, 4);
  const all = JSON.stringify(methods.map((m) => JSON.parse(m.details)));
  for (const needle of ['3056855', 'PS21PALS045230568550993100000', '01093525956', 'قصي خضير']) assert.ok(all.includes(needle), needle);
  assert.deepEqual(
    methods.map((m) => m.currency_code),
    ['ILS', 'ILS', 'ILS', 'EGP'],
  );
});

test('public store pages render', async () => {
  for (const url of ['/', '/store', '/store/products', '/store/platforms', '/store/product/chatgpt-plus', '/store/category/ai', '/store/platform/canva', '/store/help', '/store/terms', '/store/privacy', '/login', '/register']) {
    const res = await stranger.get(url);
    assert.equal(res.status, 200, url);
  }
  const home = await (await stranger.get('/store')).text();
  assert.ok(home.includes('ChatGPT') && home.includes('Canva') && home.includes('CapCut'));
  const notFound = await stranger.get('/store/product/does-not-exist');
  assert.equal(notFound.status, 404);
});

test('brand homepage shows live catalogue data and agency services', async () => {
  const html = await (await stranger.get('/')).text();
  assert.match(html, /<title>MTS Agency/);
  assert.ok(html.includes('action="/store/products"'), 'hero search posts to the catalogue');
  assert.ok(html.includes('data-tab-panel="popular"'), 'product tabs render');
  assert.ok(html.includes('id="services"') && html.includes('/static/img/clients/'), 'agency services and clients render');
  assert.ok(html.includes('/store/product/chatgpt-plus'), 'links to real products');
  // Every active payment method is listed with its currency.
  assert.ok(html.includes('فودافون كاش') && html.includes('بنك فلسطين'));

  const health = await stranger.get('/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, storage: 'persistent', version: 'dev' });

  const legacy = await stranger.get('/index.html');
  assert.equal(legacy.status, 301);
  assert.equal(legacy.headers.get('location'), '/');
});

test('checkout requires login', async () => {
  const res = await stranger.get(`/store/checkout?product=chatgpt-plus&plan=${plan.id}`);
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/login\?next=/);
});

test('registration validates the WhatsApp number', async () => {
  const bad = await buyer.post('/register', { name: 'Test Buyer', email: 'buyer@test.local', password: 'password123', password_confirm: 'password123', wa_country: 'PS', wa_number: '12', agree: '1' });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.errors.wa_number);

  const missingCountry = await buyer.post('/register', { name: 'Test Buyer', email: 'buyer@test.local', password: 'password123', password_confirm: 'password123', wa_country: 'XX', wa_number: '0599123456', agree: '1' });
  assert.equal(missingCountry.status, 422);

  const ok = await buyer.post('/register', { name: 'محمد التجربة', email: 'Buyer@Test.local', password: 'password123', password_confirm: 'password123', wa_country: 'PS', wa_number: '٠٥٩٩١٢٣٤٥٦', agree: '1' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.ok, true);
  const u = get("SELECT * FROM users WHERE email = 'buyer@test.local'");
  assert.equal(u.wa_e164, '+970599123456');
  assert.equal(u.role, 'buyer');

  const dup = await stranger.post('/register', { name: 'Someone', email: 'buyer@test.local', password: 'password123', password_confirm: 'password123', wa_country: 'EG', wa_number: '01012345678', agree: '1' });
  assert.equal(dup.status, 422);
  assert.ok(dup.body.errors.email);
});

test('multipart posts to non-upload routes do not crash', async () => {
  const fd = new FormData();
  fd.append('email', 'nobody@test.local');
  fd.append('password', 'whatever-123');
  const res = await stranger.post('/login', fd);
  assert.equal(res.status, 422);
  assert.ok(res.body.errors.email);
});

test('cross-site POSTs are rejected', async () => {
  const res = await buyer.post('/account/profile', { name: 'Hacked', wa_country: 'PS', wa_number: '0599123456' }, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(get("SELECT name FROM users WHERE email = 'buyer@test.local'").name, 'محمد التجربة');
});

test('checkout page shows all payment methods with converted amounts', async () => {
  const res = await buyer.get(`/store/checkout?product=chatgpt-plus&plan=${plan.id}&qty=1`);
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const needle of ['بنك فلسطين', 'جوال باي', 'بال باي', 'فودافون كاش', '3056855', 'PS21PALS045230568550993100000', '01093525956', 'iBURAQ']) {
    assert.ok(html.includes(needle), `checkout should include ${needle}`);
  }
  // $12 at 3.1 ILS -> 37.2 rounded up to 38; at 53 EGP -> 636.
  assert.equal(money.convert(plan.price, money.byCode('ILS')), 38);
  assert.equal(money.convert(plan.price, money.byCode('EGP')), 636);
});

test('checkout validates fields and requires a receipt', async () => {
  const noFile = await buyer.post('/store/checkout', receiptForm({ product_id: product.id, plan_id: plan.id, quantity: 1, payment_method_id: bankMethod.id, sender_name: 'محمد', sender_account: '123456', buyer_input: 'me@gmail.com', agree: 1 }, { file: null }));
  assert.equal(noFile.status, 422);
  assert.ok(noFile.body.errors.receipt);

  const fakeImage = await buyer.post('/store/checkout', receiptForm({ product_id: product.id, plan_id: plan.id, quantity: 1, payment_method_id: bankMethod.id, sender_name: 'محمد التجربة', sender_account: '123456', buyer_input: 'me@gmail.com', agree: 1 }, { file: Buffer.from('<html>not an image</html>'), name: 'x.png' }));
  assert.equal(fakeImage.status, 400);

  const missing = await buyer.post('/store/checkout', receiptForm({ product_id: product.id, plan_id: plan.id, quantity: 1, payment_method_id: bankMethod.id, sender_name: '', sender_account: '', agree: 1 }));
  assert.equal(missing.status, 422);
  assert.ok(missing.body.errors.sender_name && missing.body.errors.sender_account && missing.body.errors.buyer_input);
});

test('buyer places an order with a receipt', async () => {
  const res = await buyer.post('/store/checkout', receiptForm({ product_id: product.id, plan_id: plan.id, quantity: 1, payment_method_id: bankMethod.id, sender_name: 'محمد التجربة', sender_account: '٠٥٩٩١١١٢٢٢', buyer_input: 'me@gmail.com', buyer_note: 'شكراً', agree: 1 }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.redirect, /^\/account\/orders\/MTS-\d+\?placed=1$/);
  orderCode = res.body.redirect.split('/').pop().split('?')[0];
  const o = get('SELECT * FROM orders WHERE code = ?', orderCode);
  assert.equal(o.status, 'under_review');
  assert.equal(o.pay_currency, 'ILS');
  assert.equal(o.pay_amount, 3800);
  assert.equal(o.sender_account, '0599111222');
  assert.equal(o.buyer_input, 'me@gmail.com');
  assert.ok(fs.existsSync(path.join(TMP, 'uploads', 'private', 'receipts', o.receipt_file)));
  const adminUser = get("SELECT id FROM users WHERE email = 'admin@test.local'");
  assert.ok(get('SELECT id FROM notifications WHERE user_id = ? AND title LIKE ?', adminUser.id, `%${orderCode}%`), 'admin notified');

  const page = await buyer.get(`/account/orders/${orderCode}?placed=1`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('تم إرسال طلبك بنجاح'));
});

test('receipts are private', async () => {
  const o = get('SELECT receipt_file FROM orders WHERE code = ?', orderCode);
  const own = await buyer.get(`/files/receipts/${o.receipt_file}`);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'image/png');
  const anon = await stranger.get(`/files/receipts/${o.receipt_file}`);
  assert.equal(anon.status, 302);
  const other = new Client();
  await other.post('/register', { name: 'Other Person', email: 'other@test.local', password: 'password123', password_confirm: 'password123', wa_country: 'EG', wa_number: '01012345678', agree: '1' });
  const res = await other.get(`/files/receipts/${o.receipt_file}`);
  assert.equal(res.status, 404);
  const otherOrder = await other.get(`/account/orders/${orderCode}`);
  assert.equal(otherOrder.status, 404);
});

test('admin logs in and sees the order', async () => {
  const bad = await admin.post('/login', { email: 'admin@test.local', password: 'wrong-password' });
  assert.equal(bad.status, 422);
  const res = await admin.post('/login', { email: 'admin@test.local', password: 'admin-pass-123' });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.redirect, '/seller');
  const list = await admin.get('/seller/orders?status=under_review');
  assert.equal(list.status, 200);
  assert.ok((await list.text()).includes(orderCode));
  const detail = await admin.get(`/seller/orders/${orderCode}`);
  assert.equal(detail.status, 200);
  const html = await detail.text();
  assert.ok(html.includes('0599111222') && html.includes('me@gmail.com'));

  const buyerAsSeller = await buyer.get('/seller');
  assert.equal(buyerAsSeller.status, 403);
});

test('admin rejects, buyer re-uploads, admin approves and delivers', async () => {
  const short = await admin.post(`/seller/orders/${orderCode}/reject`, { reason: 'x' });
  assert.equal(short.status, 422);
  const rej = await admin.post(`/seller/orders/${orderCode}/reject`, { reason: 'صورة الإيصال غير واضحة' });
  assert.equal(rej.body.ok, true);
  assert.equal(get('SELECT status FROM orders WHERE code = ?', orderCode).status, 'payment_rejected');
  const buyerId = get("SELECT id FROM users WHERE email = 'buyer@test.local'").id;
  assert.ok(get("SELECT id FROM notifications WHERE user_id = ? AND tone = 'danger'", buyerId));

  const re = await buyer.post(`/account/orders/${orderCode}/receipt`, receiptForm({ sender_name: 'محمد التجربة', sender_account: '0599111222' }));
  assert.equal(re.body.ok, true, JSON.stringify(re.body));
  assert.equal(get('SELECT status FROM orders WHERE code = ?', orderCode).status, 'under_review');

  const salesBefore = get('SELECT sales_count FROM products WHERE id = ?', product.id).sales_count;
  const ok = await admin.post(`/seller/orders/${orderCode}/approve`, {});
  assert.equal(ok.body.ok, true);
  assert.equal(get('SELECT status FROM orders WHERE code = ?', orderCode).status, 'processing');
  assert.equal(get('SELECT sales_count FROM products WHERE id = ?', product.id).sales_count, salesBefore + 1);

  const empty = await admin.post(`/seller/orders/${orderCode}/deliver`, { 'fields[0][label]': '', 'fields[0][value]': '' });
  assert.equal(empty.status, 422);
  const del = await admin.post(`/seller/orders/${orderCode}/deliver`, {
    'fields[0][label]': 'البريد الإلكتروني',
    'fields[0][value]': 'sub-account@example.com',
    'fields[1][label]': 'كلمة المرور',
    'fields[1][value]': 'S3cret-Pass',
    'fields[1][secret]': '1',
    note: 'لا تغيّر كلمة المرور',
    expires_at: '2030-01-31',
  });
  assert.equal(del.body.ok, true, JSON.stringify(del.body));
  const o = get('SELECT * FROM orders WHERE code = ?', orderCode);
  assert.equal(o.status, 'delivered');
  const delivery = JSON.parse(o.delivery);
  assert.equal(delivery.fields.length, 2);
  assert.equal(delivery.fields[1].secret, true);
  assert.ok(o.expires_at.startsWith('2030-01-31'));
});

test('buyer sees the subscription, confirms and reviews', async () => {
  const page = await buyer.get(`/account/orders/${orderCode}`);
  const html = await page.text();
  assert.ok(html.includes('sub-account@example.com'));
  assert.ok(html.includes('S3cret-Pass'), 'secret is available to reveal/copy');
  const subs = await (await buyer.get('/account/subscriptions')).text();
  assert.ok(subs.includes(product.title));

  const conf = await buyer.post(`/account/orders/${orderCode}/confirm`, {});
  assert.equal(conf.body.ok, true);
  assert.equal(get('SELECT status FROM orders WHERE code = ?', orderCode).status, 'completed');

  const noStars = await buyer.post(`/account/orders/${orderCode}/review`, { rating: '0', comment: '' });
  assert.equal(noStars.status, 422);
  const rev = await buyer.post(`/account/orders/${orderCode}/review`, { rating: '5', comment: 'خدمة ممتازة وسريعة' });
  assert.equal(rev.body.ok, true);
  const twice = await buyer.post(`/account/orders/${orderCode}/review`, { rating: '4', comment: 'again' });
  assert.equal(twice.status, 422);
  const productPage = await (await stranger.get('/store/product/chatgpt-plus')).text();
  assert.ok(productPage.includes('خدمة ممتازة وسريعة'));
});

test('stock is reserved and released on cancel', async () => {
  run('UPDATE product_plans SET stock = 1 WHERE id = ?', plan.id);
  const first = await buyer.post('/store/checkout', receiptForm({ product_id: product.id, plan_id: plan.id, quantity: 1, payment_method_id: walletMethod.id, sender_name: 'محمد التجربة', sender_account: '01011112222', buyer_input: 'me@gmail.com', agree: 1 }));
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  const code = first.body.redirect.split('/').pop().split('?')[0];
  const o = get('SELECT * FROM orders WHERE code = ?', code);
  assert.equal(o.pay_currency, 'EGP');
  assert.equal(o.pay_amount, 63600);
  assert.equal(get('SELECT stock FROM product_plans WHERE id = ?', plan.id).stock, 0);

  const second = await buyer.post('/store/checkout', receiptForm({ product_id: product.id, plan_id: plan.id, quantity: 1, payment_method_id: walletMethod.id, sender_name: 'محمد التجربة', sender_account: '01011112222', buyer_input: 'me@gmail.com', agree: 1 }));
  assert.equal(second.body.ok, false);

  const cancel = await buyer.post(`/account/orders/${code}/cancel`, {});
  assert.equal(cancel.body.ok, true);
  assert.equal(get('SELECT stock FROM product_plans WHERE id = ?', plan.id).stock, 1);
  run('UPDATE product_plans SET stock = NULL WHERE id = ?', plan.id);
});

test('users without WhatsApp must complete their profile', async () => {
  const id = Number(run("INSERT INTO users (name, email, google_sub) VALUES ('Google User', 'g@test.local', 'sub-123')").lastInsertRowid);
  const c = new Client();
  // Simulate a Google sign-in session for that user.
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('base64url');
  run("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))", crypto.createHash('sha256').update(token).digest('hex'), id);
  c.jar.set('mts_sid', token);
  const res = await c.get('/store');
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/auth\/complete-profile/);
  const blocked = await c.post('/account/profile', { name: 'x' });
  assert.equal(blocked.status, 403);
  const done = await c.post('/auth/complete-profile', { name: 'Google User', wa_country: 'PS972', wa_number: '0569123456' });
  assert.equal(done.body.ok, true, JSON.stringify(done.body));
  assert.equal(get('SELECT wa_e164 FROM users WHERE id = ?', id).wa_e164, '+972569123456');
  assert.equal((await c.get('/store')).status, 200);
});

test('google sign-in is refused when not configured', async () => {
  const res = await stranger.post('/auth/google', { credential: 'fake' });
  assert.equal(res.body.ok, false);
});

test('seller creates and edits a product with plans', async () => {
  const cat = get("SELECT id FROM categories WHERE slug = 'design'");
  const pl = get("SELECT id FROM platforms WHERE slug = 'canva'");
  const fd = new FormData();
  Object.entries({
    title: 'Canva Teams — تجربة',
    category_id: cat.id,
    platform_id: pl.id,
    delivery_method: 'invite',
    delivery_time: 'خلال ساعة',
    is_active: '1',
    'plans[0][name]': 'شهر',
    'plans[0][duration_days]': '30',
    'plans[0][price]': '4.5',
    'plans[0][old_price]': '10',
    'plans[0][is_active]': '1',
    'plans[1][name]': 'سنة',
    'plans[1][duration_days]': '365',
    'plans[1][price]': '٣٠',
    'plans[1][is_active]': '1',
  }).forEach(([k, v]) => fd.append(k, String(v)));
  const res = await admin.post('/seller/products', fd);
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  const created = get("SELECT * FROM products WHERE title = 'Canva Teams — تجربة'");
  const plans = require('../src/db').all('SELECT * FROM product_plans WHERE product_id = ? ORDER BY sort_order', created.id);
  assert.deepEqual(
    plans.map((p) => [p.name, p.price, p.old_price]),
    [
      ['شهر', 450, 1000],
      ['سنة', 3000, null],
    ],
  );
  const page = await stranger.get('/store/product/' + created.slug);
  assert.equal(page.status, 200);

  const toggle = await admin.post(`/seller/products/${created.id}/toggle`, {});
  assert.equal(toggle.body.ok, true);
  assert.equal((await stranger.get('/store/product/' + created.slug)).status, 404);
});

test('admin edits payment details and exchange rates', async () => {
  const fd = new FormData();
  Object.entries({
    name: 'فودافون كاش',
    subtitle: 'تحويل إلى محفظة فودافون كاش',
    type: 'wallet',
    icon: 'fa-solid fa-money-bill-transfer',
    color: '#e60000',
    currency_code: 'EGP',
    'details[0][label]': 'رقم فودافون كاش',
    'details[0][value]': '01093525956',
    'details[0][copy]': '1',
    'details[1][label]': 'اسم صاحب المحفظة',
    'details[1][value]': 'شيماء',
    sender_account_label: 'رقم المحفظة',
    is_active: '1',
    sort_order: '4',
  }).forEach(([k, v]) => fd.append(k, String(v)));
  const res = await admin.post(`/seller/payment-methods/${walletMethod.id}`, fd);
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(JSON.parse(get('SELECT details FROM payment_methods WHERE id = ?', walletMethod.id).details)[1].value, 'شيماء');

  const rates = await admin.post('/seller/currencies', {
    'c[0][code]': 'USD',
    'c[0][name]': 'دولار أمريكي',
    'c[0][symbol]': '$',
    'c[0][decimals]': '2',
    'c[0][sort_order]': '1',
    'c[1][code]': 'ILS',
    'c[1][name]': 'شيكل',
    'c[1][symbol]': '₪',
    'c[1][rate]': '3.5',
    'c[1][decimals]': '0',
    'c[1][is_active]': '1',
    'c[1][sort_order]': '2',
    'c[2][code]': 'EGP',
    'c[2][name]': 'جنيه مصري',
    'c[2][symbol]': 'ج.م',
    'c[2][rate]': '50',
    'c[2][decimals]': '0',
    'c[2][is_active]': '1',
    'c[2][sort_order]': '3',
  });
  assert.equal(rates.body.ok, true, JSON.stringify(rates.body));
  assert.equal(money.convert(1200, money.byCode('ILS')), 42);
  // Completed order keeps its original amount.
  assert.equal(get('SELECT pay_amount FROM orders WHERE code = ?', orderCode).pay_amount, 3800);
});

test('changing the base currency re-prices the catalogue', async () => {
  const before = get('SELECT price FROM product_plans WHERE id = ?', plan.id).price;
  const res = await admin.post('/seller/currencies/ILS/make-base', {});
  assert.equal(res.body.ok, true);
  assert.equal(money.base().code, 'ILS');
  assert.equal(get('SELECT price FROM product_plans WHERE id = ?', plan.id).price, Math.round(before * 3.5));
  assert.equal(Number(money.byCode('USD').rate.toFixed(6)), Number((1 / 3.5).toFixed(6)));
  const overview = await admin.get('/seller');
  assert.equal(overview.status, 200);
  await admin.post('/seller/currencies/USD/make-base', {});
  assert.equal(money.base().code, 'USD');
  assert.equal(get('SELECT price FROM product_plans WHERE id = ?', plan.id).price, before);
});

test('every dashboard page renders for the admin', async () => {
  for (const url of ['/seller', '/seller/orders', '/seller/products', '/seller/products/new', `/seller/products/${product.id}/edit`, '/seller/platforms', '/seller/platforms/new', '/seller/categories', '/seller/payment-methods', '/seller/payment-methods/new', `/seller/payment-methods/${bankMethod.id}/edit`, '/seller/currencies', '/seller/users', '/seller/applications', '/seller/reviews', '/seller/settings', '/account', '/account/orders', '/account/subscriptions', '/account/notifications', '/account/profile']) {
    const res = await admin.get(url);
    assert.equal(res.status, 200, url);
  }
  for (const url of ['/account', '/account/orders', '/account/subscriptions', '/account/notifications', '/account/profile', '/account/become-seller']) {
    assert.equal((await buyer.get(url)).status, 200, url);
  }
});

test('buyer applies to become a seller and admin approves', async () => {
  const res = await buyer.post('/account/become-seller', { store_name: 'متجر التجربة', about: 'أبيع اشتراكات التصميم والذكاء الاصطناعي منذ سنتين.' });
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  const app = get("SELECT * FROM seller_applications WHERE store_name = 'متجر التجربة'");
  const ok = await admin.post(`/seller/applications/${app.id}/approve`, {});
  assert.equal(ok.body.ok, true);
  assert.equal(get("SELECT role FROM users WHERE email = 'buyer@test.local'").role, 'seller');
  // A seller only sees orders of their own products.
  const sellerView = await buyer.get('/seller/orders');
  assert.equal(sellerView.status, 200);
  assert.ok(!(await sellerView.text()).includes(orderCode));
  assert.equal((await buyer.get('/seller/settings')).status, 403);
});

/* ---------------------------------------------------------------------
   Regression tests for the security/logic review
   --------------------------------------------------------------------- */
async function newBuyer(email, country = 'EG', number = '01011223344') {
  const c = new Client();
  const res = await c.post('/register', { name: 'Test ' + email.split('@')[0], email, password: 'password123', password_confirm: 'password123', wa_country: country, wa_number: number, agree: '1' });
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  return c;
}
const codeOf = (res) => res.body.redirect.split('/').pop().split('?')[0];

test('safeNext only allows same-site paths', () => {
  const { safeNext } = require('../src/lib/util');
  assert.equal(safeNext('/store/checkout?product=x&plan=1'), '/store/checkout?product=x&plan=1');
  for (const bad of ['//evil.example', '/\t/evil.example', '/\n/evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', ['/a'], { a: 1 }]) {
    assert.equal(safeNext(bad, '/fallback'), '/fallback', JSON.stringify(bad));
  }
});

test('login with a tab-smuggled next does not redirect off-site', async () => {
  const c = await newBuyer('nexttab@test.local');
  await c.post('/logout', {}, { json: false });
  const res = await c.post('/login', { email: 'nexttab@test.local', password: 'password123', next: '/\t/evil.example/phish' });
  assert.equal(res.body.ok, true);
  assert.ok(res.body.redirect.startsWith('/') && !res.body.redirect.startsWith('//'), res.body.redirect);
  assert.ok(!res.body.redirect.includes('evil'), res.body.redirect);
});

test('google sign-in takes over a pre-registered e-mail safely', async () => {
  const { resolveGoogleUser } = require('../src/lib/auth');
  const attacker = await newBuyer('victim@test.local');
  assert.equal((await attacker.get('/account')).status, 200);

  const result = resolveGoogleUser({ sub: 'google-victim-1', email: 'Victim@test.local', name: 'Real Victim', email_verified: true });
  assert.ok(result.reset);
  const u = get("SELECT * FROM users WHERE email = 'victim@test.local'");
  assert.equal(u.google_sub, 'google-victim-1');
  assert.equal(u.password_hash, null);
  assert.equal(u.wa_e164, null);
  // The attacker's session and password no longer work.
  assert.equal((await attacker.get('/account')).status, 302);
  const relog = await attacker.post('/login', { email: 'victim@test.local', password: 'password123' });
  assert.equal(relog.body.ok, false);
  // Signing in again with Google simply finds the account.
  assert.equal(resolveGoogleUser({ sub: 'google-victim-1', email: 'victim@test.local' }).user.id, u.id);

  // Admin accounts are linked without being reset.
  const adminResult = resolveGoogleUser({ sub: 'google-admin-1', email: 'admin@test.local', name: 'Admin' });
  assert.ok(!adminResult.reset);
  assert.ok(get("SELECT password_hash FROM users WHERE email = 'admin@test.local'").password_hash);
});

test('restarting without ADMIN_EMAIL never promotes a registered account', async () => {
  const config = require('../src/config');
  await newBuyer('admin@mts.store');
  const previous = config.admin.email;
  config.admin.email = '';
  try {
    await seed();
  } finally {
    config.admin.email = previous;
  }
  assert.equal(get("SELECT role FROM users WHERE email = 'admin@mts.store'").role, 'buyer');
});

test('nested form fields on upload routes return 422 and leave no files', async () => {
  const receiptsDir = path.join(TMP, 'uploads', 'private', 'receipts');
  const before = fs.readdirSync(receiptsDir).length;
  const fd = receiptForm({});
  fd.append('sender_name[x]', 'a');
  fd.append('sender_account[y]', 'b');
  const res = await buyer.post(`/account/orders/${orderCode}/receipt`, fd);
  assert.equal(res.status, 422, JSON.stringify(res.body));

  const fd2 = receiptForm({ plan_id: plan.id, quantity: 1, payment_method_id: bankMethod.id, sender_name: 'x y z', sender_account: '123456', agree: 1 });
  fd2.append('product_id[x]', '1');
  const res2 = await buyer.post('/store/checkout', fd2);
  assert.equal(res2.status, 422, JSON.stringify(res2.body));
  // Error responses are sent before the async clean-up finishes; give it a moment.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.readdirSync(receiptsDir).length, before);
});

test('prototype keys in query strings and forms are ignored', async () => {
  for (const sort of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal((await stranger.get('/store/products?sort=' + sort)).status, 200, sort);
  }
  const fd = new FormData();
  Object.entries({ title: 'Proto Test Product', category_id: get("SELECT id FROM categories WHERE slug = 'ai'").id, 'delivery_method[]': 'account', is_active: '1', 'plans[0][name]': 'شهر', 'plans[0][price]': '5', 'plans[0][is_active]': '1' }).forEach(([k, v]) => fd.append(k, String(v)));
  const res = await admin.post('/seller/products', fd);
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(get("SELECT delivery_method FROM products WHERE title = 'Proto Test Product'").delivery_method, 'account');
});

test('HEIC receipts sent as octet-stream are accepted by signature', async () => {
  const c = await newBuyer('heic@test.local');
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(32)]);
  const res = await c.post('/store/checkout', receiptForm({ product_id: product.id, plan_id: plan.id, quantity: 1, payment_method_id: bankMethod.id, sender_name: 'Heic Sender', sender_account: '0599000111', buyer_input: 'me@gmail.com', agree: 1 }, { file: heic, name: 'IMG_0001.HEIC', type: 'application/octet-stream' }));
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  const o = get('SELECT receipt_mime, receipt_file FROM orders WHERE code = ?', codeOf(res));
  assert.equal(o.receipt_mime, 'image/heic');
  assert.match(o.receipt_file, /\.heic$/);
});

test('limited stock is released on rejection and only what was reserved comes back', async () => {
  const c = await newBuyer('stock@test.local');
  const checkout = () => c.post('/store/checkout', receiptForm({ product_id: product.id, plan_id: plan.id, quantity: 1, payment_method_id: bankMethod.id, sender_name: 'Stock Buyer', sender_account: '0599222333', buyer_input: 'me@gmail.com', agree: 1 }));
  const stock = () => get('SELECT stock FROM product_plans WHERE id = ?', plan.id).stock;

  // Ordered while stock was unlimited: a later cancel must not invent units.
  run('UPDATE product_plans SET stock = NULL WHERE id = ?', plan.id);
  const unlimited = codeOf(await checkout());
  run('UPDATE product_plans SET stock = 5 WHERE id = ?', plan.id);
  assert.equal((await admin.post(`/seller/orders/${unlimited}/cancel`, { reason: 'اختبار' })).body.ok, true);
  assert.equal(stock(), 5);

  const limited = codeOf(await checkout());
  assert.equal(stock(), 4);
  assert.equal((await admin.post(`/seller/orders/${limited}/reject`, { reason: 'صورة الإيصال غير واضحة' })).body.ok, true);
  assert.equal(stock(), 5, 'rejection releases the reservation');
  const re = await c.post(`/account/orders/${limited}/receipt`, receiptForm({ sender_name: 'Stock Buyer', sender_account: '0599222333' }));
  assert.equal(re.body.ok, true, JSON.stringify(re.body));
  assert.equal(stock(), 4, 'resubmission reserves again');
  assert.equal((await admin.post(`/seller/orders/${limited}/cancel`, { reason: 'اختبار' })).body.ok, true);
  assert.equal(stock(), 5);
  run('UPDATE product_plans SET stock = NULL WHERE id = ?', plan.id);
});

test('sellers cannot manage their own purchases and respect the approval setting', async () => {
  // `buyer` became a seller in an earlier test; give them a product.
  const fd = new FormData();
  Object.entries({ title: 'Seller Own Product', category_id: get("SELECT id FROM categories WHERE slug = 'ai'").id, delivery_method: 'code', is_active: '1', 'plans[0][name]': 'شهر', 'plans[0][price]': '3', 'plans[0][is_active]': '1' }).forEach(([k, v]) => fd.append(k, String(v)));
  const created = await buyer.post('/seller/products', fd);
  assert.equal(created.body.ok, true, JSON.stringify(created.body));
  const own = get("SELECT * FROM products WHERE title = 'Seller Own Product'");
  const ownPlan = get('SELECT * FROM product_plans WHERE product_id = ?', own.id);
  const buy = (client) => client.post('/store/checkout', receiptForm({ product_id: own.id, plan_id: ownPlan.id, quantity: 1, payment_method_id: bankMethod.id, sender_name: 'Some Sender', sender_account: '0599444555', agree: 1 }));

  const self = await buy(buyer);
  assert.equal(self.body.ok, true, JSON.stringify(self.body));
  const selfCode = codeOf(self);
  assert.equal((await buyer.post(`/seller/orders/${selfCode}/approve`, {})).status, 404);
  assert.equal((await buyer.post(`/seller/orders/${selfCode}/deliver`, { 'fields[0][label]': 'x', 'fields[0][value]': 'y' })).status, 404);
  assert.ok(!(await (await buyer.get('/seller/orders')).text()).includes(selfCode));

  // Another customer's order: allowed by default, blocked when the admin keeps approvals.
  const customer = await newBuyer('customer2@test.local');
  const otherCode = codeOf(await buy(customer));
  settings.set({ sellers_can_approve: '0' });
  try {
    const page = await buyer.get(`/seller/orders/${otherCode}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('بانتظار تأكيد الدفع من إدارة المتجر'));
    assert.ok(!html.includes(`/seller/orders/${otherCode}/approve`), 'no approve button for the seller');
    assert.equal((await buyer.post(`/seller/orders/${otherCode}/approve`, {})).status, 403);
    assert.equal((await buyer.post(`/seller/orders/${otherCode}/deliver`, { 'fields[0][label]': 'كود', 'fields[0][value]': 'ABC' })).status, 403);
    assert.equal((await admin.post(`/seller/orders/${otherCode}/approve`, {})).body.ok, true);
    const sellerId = get("SELECT id FROM users WHERE email = 'buyer@test.local'").id;
    assert.ok(get('SELECT id FROM notifications WHERE user_id = ? AND title LIKE ?', sellerId, `%${otherCode}%جاهز للتسليم%`), 'seller told the order is ready');
    const delivered = await buyer.post(`/seller/orders/${otherCode}/deliver`, { 'fields[0][label]': 'كود', 'fields[0][value]': 'ABC-123' });
    assert.equal(delivered.body.ok, true, JSON.stringify(delivered.body));
  } finally {
    settings.set({ sellers_can_approve: '1' });
  }
});

test('blocked sellers have their products hidden', async () => {
  const sellerId = get("SELECT id FROM users WHERE email = 'buyer@test.local'").id;
  const slug = get("SELECT slug FROM products WHERE title = 'Seller Own Product'").slug;
  assert.equal((await stranger.get('/store/product/' + slug)).status, 200);
  run('UPDATE users SET is_blocked = 1 WHERE id = ?', sellerId);
  try {
    assert.equal((await stranger.get('/store/product/' + slug)).status, 404);
  } finally {
    run('UPDATE users SET is_blocked = 0 WHERE id = ?', sellerId);
  }
});

test('a buyer can only keep a few unpaid orders open', async () => {
  const c = await newBuyer('busy@test.local');
  const body = () => receiptForm({ product_id: product.id, plan_id: plan.id, quantity: 1, payment_method_id: bankMethod.id, sender_name: 'Busy Buyer', sender_account: '0599666777', buyer_input: 'me@gmail.com', agree: 1 });
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/store/checkout', body())).body.ok, true);
  const sixth = await c.post('/store/checkout', body());
  assert.equal(sixth.body.ok, false);
});

test('login attempts are rate limited', async () => {
  const config = require('../src/config');
  config.rateLimitOff = false;
  try {
    const c = new Client();
    let last;
    for (let i = 0; i < 21; i++) last = await c.post('/login', { email: 'nobody@test.local', password: 'wrong-password' });
    assert.equal(last.status, 429);
  } finally {
    config.rateLimitOff = true;
  }
});

test('sales chart buckets payments by the store-timezone day', async () => {
  const res = await admin.get('/seller');
  assert.equal(res.status, 200);
  const { isoDay } = require('../src/lib/format');
  const today = isoDay(new Date());
  const label = `${Number(today.slice(8))}/${Number(today.slice(5, 7))}`;
  assert.ok((await res.text()).includes(label), 'today appears on the chart');
});

// Runs a snippet in a fresh Node process with a Railway-like environment (no .env values leak in).
function runOnRailway(code, extraEnv) {
  const { execFileSync } = require('child_process');
  const env = { ...process.env, NODE_ENV: '', APP_URL: '', RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_PUBLIC_DOMAIN: 'shop.up.railway.app', ...extraEnv };
  for (const k of ['DATA_DIR', 'DB_FILE', 'UPLOAD_DIR', 'TRUST_PROXY']) if (!(k in extraEnv)) delete env[k];
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', code], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

test('on Railway the database and uploads default to the attached volume', () => {
  const vol = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-volume-'));
  const show = "const c = require('./src/config'); console.log(JSON.stringify({ dataDir: c.dataDir, uploadDir: c.uploadDir, isProd: c.isProd, trustProxy: c.trustProxy, appUrl: c.appUrl, ephemeral: c.ephemeralStorage }))";
  const withVolume = runOnRailway(show, { RAILWAY_VOLUME_MOUNT_PATH: vol });
  assert.equal(withVolume.dataDir, path.resolve(vol));
  assert.equal(withVolume.uploadDir, path.join(path.resolve(vol), 'uploads'));
  assert.equal(withVolume.isProd, true);
  assert.equal(withVolume.trustProxy, 1);
  assert.equal(withVolume.appUrl, 'https://shop.up.railway.app');
  assert.equal(withVolume.ephemeral, false);

  const withoutVolume = runOnRailway(show, {});
  assert.equal(withoutVolume.ephemeral, true, 'admins are warned when nothing is persisted');
});

test('ADMIN_RESET_PASSWORD replaces the admin password at startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-reset-'));
  const boot = `(async () => {
    require('./src/db').migrate(); require('./src/lib/settings').load(); await require('./src/seed').seed();
    const { get } = require('./src/db'); const { verifyPassword } = require('./src/lib/auth');
    const u = get("SELECT password_hash FROM users WHERE email = 'owner@test.local'");
    console.log(JSON.stringify({ reset: await verifyPassword('new-owner-pass-456', u.password_hash), old: await verifyPassword('first-owner-pass-123', u.password_hash) }));
  })()`;
  const env = { DATA_DIR: dir, SEED_DEMO: 'false', ADMIN_EMAIL: 'owner@test.local', ADMIN_PASSWORD: 'first-owner-pass-123' };
  assert.deepEqual(runOnRailway(boot, env), { reset: false, old: true });
  assert.deepEqual(runOnRailway(boot, { ...env, ADMIN_RESET_PASSWORD: 'new-owner-pass-456' }), { reset: true, old: false });
});

test('ADMIN_PASSWORD is adopted by an admin account that has never signed in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-adopt-'));
  const env = { DATA_DIR: dir, SEED_DEMO: 'false', ADMIN_EMAIL: 'owner@test.local' };
  const boot = (extraSql = '') => `(async () => {
    const db = require('./src/db'); db.migrate(); require('./src/lib/settings').load(); await require('./src/seed').seed();
    ${extraSql}
    const { verifyPassword } = require('./src/lib/auth');
    const u = db.get("SELECT password_hash FROM users WHERE email = 'owner@test.local'");
    console.log(JSON.stringify({ later: await verifyPassword('later-pass-789', u.password_hash), other: await verifyPassword('other-pass-000', u.password_hash) }));
  })()`;
  // First start without a password: a random one is generated.
  assert.deepEqual(runOnRailway(boot(), { ...env, ADMIN_PASSWORD: '' }), { later: false, other: false });
  // The variable is added afterwards: the unused account takes it.
  assert.deepEqual(runOnRailway(boot("db.run(\"UPDATE users SET last_login_at = datetime('now') WHERE email = 'owner@test.local'\");"), { ...env, ADMIN_PASSWORD: 'later-pass-789' }), { later: true, other: false });
  // Once the admin has signed in, changing the variable no longer overrides the password.
  assert.deepEqual(runOnRailway(boot(), { ...env, ADMIN_PASSWORD: 'other-pass-000' }), { later: true, other: false });
});

test('ADMIN_RESET_PASSWORD turns the ADMIN_EMAIL account into an admin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-promote-'));
  const boot = (extraSql = '') => `(async () => {
    const db = require('./src/db'); db.migrate(); require('./src/lib/settings').load(); await require('./src/seed').seed();
    ${extraSql}
    const { verifyPassword } = require('./src/lib/auth');
    const u = db.get("SELECT role, password_hash FROM users WHERE email = 'me@test.local'");
    console.log(JSON.stringify(u ? { role: u.role, ok: !!u.password_hash && (await verifyPassword('me-new-pass-456', u.password_hash)) } : null));
  })()`;
  // The owner first signed up through Google as a regular customer.
  const signup = "db.run(\"INSERT INTO users (name, email, google_sub, last_login_at) VALUES ('Owner', 'me@test.local', 'g-1', datetime('now'))\");";
  assert.deepEqual(runOnRailway(boot(signup), { DATA_DIR: dir, SEED_DEMO: 'false', ADMIN_EMAIL: 'boss@test.local', ADMIN_PASSWORD: 'boss-pass-123' }), { role: 'buyer', ok: false });
  // Plain ADMIN_EMAIL never promotes an existing account…
  assert.deepEqual(runOnRailway(boot(), { DATA_DIR: dir, SEED_DEMO: 'false', ADMIN_EMAIL: 'me@test.local', ADMIN_PASSWORD: 'me-new-pass-456' }), { role: 'buyer', ok: false });
  // …but the explicit reset does.
  assert.deepEqual(runOnRailway(boot(), { DATA_DIR: dir, SEED_DEMO: 'false', ADMIN_EMAIL: 'me@test.local', ADMIN_RESET_PASSWORD: 'me-new-pass-456' }), { role: 'admin', ok: true });
});
