'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-dupl-cur-test-'));
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

const { migrate, get, all, run } = require('../src/db');
const { seed } = require('../src/seed');
const { hashPassword } = require('../src/lib/auth');
const settings = require('../src/lib/settings');
const money = require('../src/lib/money');
const { createApp } = require('../src/app');

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
  async get(p) {
    const res = await fetch(`${base}${p}`, {
      headers: { cookie: this.cookieHeader() },
      redirect: 'manual',
    });
    this.store(res);
    return res;
  }
  async post(p, body) {
    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    let headers = {
      cookie: this.cookieHeader(),
      origin: base,
      'x-requested-with': 'XMLHttpRequest',
      accept: 'application/json',
    };
    let payload = body;
    if (!isFormData && typeof body === 'object') {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) sp.append(k, v);
      payload = sp.toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(`${base}${p}`, {
      method: 'POST',
      headers,
      body: payload,
      redirect: 'manual',
    });
    this.store(res);
    let parsed = null;
    const text = await res.text();
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = text;
    }
    return { status: res.status, headers: res.headers, body: parsed, text: () => Promise.resolve(text) };
  }
}

const admin = new Client();
const seller1 = new Client();
const seller2 = new Client();

before(async () => {
  migrate();
  seed();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  // Log admin in.
  const adminLogin = await admin.post('/login', { email: 'admin@test.local', password: 'admin-pass-123' });
  assert.equal(adminLogin.body.ok, true);

  // Create seller 1 and seller 2 accounts with hashed passwords and login.
  const hash = await hashPassword('seller-pass-123');
  run("INSERT INTO users (name, email, password_hash, role, store_name, wa_e164, fee_paid_until) VALUES ('بائع 1', 'seller1@test.local', ?, 'seller', 'متجر بائع 1', '+201011111111', datetime('now', '+30 days'))", hash);
  run("INSERT INTO users (name, email, password_hash, role, store_name, wa_e164, fee_paid_until) VALUES ('بائع 2', 'seller2@test.local', ?, 'seller', 'متجر بائع 2', '+201022222222', datetime('now', '+30 days'))", hash);
  seller1.user = get("SELECT * FROM users WHERE email = 'seller1@test.local'");
  seller2.user = get("SELECT * FROM users WHERE email = 'seller2@test.local'");

  const s1Login = await seller1.post('/login', { email: 'seller1@test.local', password: 'seller-pass-123' });
  assert.equal(s1Login.body.ok, true);

  const s2Login = await seller2.post('/login', { email: 'seller2@test.local', password: 'seller-pass-123' });
  assert.equal(s2Login.body.ok, true);
});

after(() => {
  try { server.close(); } catch (e) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

test('admin dashboard settings displays currencies management card', async () => {
  const res = await admin.get('/seller/settings');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('العملات المتاحة على الموقع'));
  assert.ok(html.includes('USD'));
  assert.ok(html.includes('EGP'));
  assert.ok(html.includes('إضافة عملة جديدة إلى الموقع'));
});

test('toggle currency active status via POST /seller/currencies/:code/toggle', async () => {
  // Base currency cannot be disabled.
  const baseToggle = await admin.post('/seller/currencies/USD/toggle', {});
  assert.equal(baseToggle.body.ok, false);
  assert.ok(baseToggle.body.message.includes('لا يمكن تعطيل العملة الأساسية'));

  // Toggle non-base currency ILS.
  const beforeState = money.byCode('ILS').is_active;
  const toggleRes = await admin.post('/seller/currencies/ILS/toggle', {});
  assert.equal(toggleRes.body.ok, true);
  assert.equal(money.byCode('ILS').is_active, beforeState ? 0 : 1);

  // Toggle back.
  const toggleBack = await admin.post('/seller/currencies/ILS/toggle', {});
  assert.equal(toggleBack.body.ok, true);
  assert.equal(money.byCode('ILS').is_active, beforeState);
});

test('product duplicate via POST /seller/products/:id/duplicate', async () => {
  // Pick an existing product.
  const original = get('SELECT * FROM products LIMIT 1');
  assert.ok(original);

  const res = await admin.post(`/seller/products/${original.id}/duplicate`, {});
  assert.equal(res.body.ok, true);
  assert.ok(res.body.redirect.startsWith('/seller/products/'));

  const newId = Number(res.body.redirect.split('/')[3]);
  const cloned = get('SELECT * FROM products WHERE id = ?', newId);
  assert.ok(cloned);
  assert.equal(cloned.title, `${original.title} (نسخة)`);
  assert.notEqual(cloned.slug, original.slug);
  assert.equal(cloned.category_id, original.category_id);
  assert.equal(cloned.platform_id, original.platform_id);
  assert.equal(cloned.is_active, 0); // Draft/inactive so seller can review

  // Ensure plans were copied.
  const origPlans = all('SELECT * FROM product_plans WHERE product_id = ? ORDER BY sort_order', original.id);
  const clonedPlans = all('SELECT * FROM product_plans WHERE product_id = ? ORDER BY sort_order', cloned.id);
  assert.equal(clonedPlans.length, origPlans.length);
  assert.equal(clonedPlans[0].name, origPlans[0].name);
  assert.equal(clonedPlans[0].price, origPlans[0].price);
  assert.notEqual(clonedPlans[0].id, origPlans[0].id);
});

test('product duplicate via GET /seller/products/new?from=:id pre-fills form', async () => {
  const original = get('SELECT * FROM products LIMIT 1');
  const res = await admin.get(`/seller/products/new?from=${original.id}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(`${original.title} (نسخة)`));
  assert.ok(html.includes('تم نسخ بيانات'));
  assert.ok(html.includes('إضافة المنتج المنسوخ'));
});

test('seller permission scoping on product duplication', async () => {
  // Create a product owned by seller 1.
  const cat = get('SELECT id FROM categories LIMIT 1');
  const p1Id = Number(run("INSERT INTO products (seller_id, category_id, title, slug, is_active) VALUES (?, ?, 'منتج البائع 1', 'seller-1-prod', 1)", seller1.user.id, cat.id).lastInsertRowid);
  run("INSERT INTO product_plans (product_id, name, duration_days, price, cost_price, is_active, sort_order) VALUES (?, 'خطة 1', 30, 1000, 800, 1, 1)", p1Id);

  // Seller 1 can duplicate their own product.
  const s1Dupl = await seller1.post(`/seller/products/${p1Id}/duplicate`, {});
  assert.equal(s1Dupl.body.ok, true);

  // Seller 2 CANNOT duplicate seller 1's product.
  const s2Dupl = await seller2.post(`/seller/products/${p1Id}/duplicate`, {});
  assert.equal(s2Dupl.status, 404);

  // Seller 2 GET /seller/products/new?from=:id for seller 1's product falls back to empty form without error.
  const s2Get = await seller2.get(`/seller/products/new?from=${p1Id}`);
  assert.equal(s2Get.status, 200);
  const s2Html = await s2Get.text();
  assert.ok(!s2Html.includes('منتج البائع 1 (نسخة)'));

  // Admin CAN duplicate seller 1's product.
  const adminDupl = await admin.post(`/seller/products/${p1Id}/duplicate`, {});
  assert.equal(adminDupl.body.ok, true);
});

test('add and delete currency via admin settings', async () => {
  // Add SAR currency.
  const addRes = await admin.post('/seller/currencies/add', {
    code: 'SAR',
    name: 'ريال سعودي',
    symbol: 'ر.س',
    rate: '3.75',
    decimals: '2',
  });
  assert.equal(addRes.body.ok, true);
  assert.ok(money.byCode('SAR'));
  assert.equal(money.byCode('SAR').rate, 3.75);

  // Toggle SAR inactive and active.
  const toggleOff = await admin.post('/seller/currencies/SAR/toggle', {});
  assert.equal(toggleOff.body.ok, true);
  assert.equal(money.byCode('SAR').is_active, 0);

  // Delete SAR.
  const delRes = await admin.post('/seller/currencies/SAR/delete', {});
  assert.equal(delRes.body.ok, true);
  assert.equal(money.byCode('SAR'), null);
});

test('submitting a cloned product via POST /seller/products creates new product with plans', async () => {
  const cat = get('SELECT id FROM categories LIMIT 1');
  const fd = {
    title: 'اشتراك كانفا برو مكرر',
    category_id: String(cat.id),
    delivery_method: 'account',
    delivery_time: 'خلال 15 دقيقة',
    cloned_cover: '/uploads/public/products/canva.png',
    is_active: '1',
    'plans[0][name]': 'شهر كامل',
    'plans[0][duration_days]': '30',
    'plans[0][cost_price]': '10',
    'plans[0][profit]': '5',
    'plans[0][is_active]': '1',
  };
  const res = await admin.post('/seller/products', fd);
  assert.equal(res.body.ok, true);
  const created = get("SELECT * FROM products WHERE title = 'اشتراك كانفا برو مكرر'");
  assert.ok(created);
  assert.equal(created.cover_url, '/uploads/public/products/canva.png');
  const plan = get('SELECT * FROM product_plans WHERE product_id = ?', created.id);
  assert.ok(plan);
  assert.equal(plan.price, 1500); // 10 + 5 in minor units
});
