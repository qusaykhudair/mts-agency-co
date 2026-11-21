'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-content-test-'));
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
const buyer = new Client();

before(async () => {
  migrate();
  await seed();

  const buyerPass = await hashPassword('buyer-pass-123');
  run(
    `INSERT INTO users (name, email, password_hash, role, wa_country, wa_dial, wa_number, wa_e164, email_verified_at)
     VALUES ('مشتري تجريبي', 'buyer@test.local', ?, 'buyer', 'EG', '20', '01012345678', '+201012345678', datetime('now'))`,
    buyerPass,
  );

  const app = createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const adminLog = await admin.post('/login', { email: 'admin@test.local', password: 'admin-pass-123' });
  assert.equal(adminLog.status, 200);
  const buyerLog = await buyer.post('/login', { email: 'buyer@test.local', password: 'buyer-pass-123' });
  assert.equal(buyerLog.status, 200);
});

after(() => {
  server && server.close();
  try {
    require('../src/db').db.close();
  } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('GET /seller/content access control', async () => {
  const stranger = new Client();
  const unauth = await stranger.get('/seller/content');
  assert.equal(unauth.status, 302);
  assert.ok(unauth.headers.get('location').includes('/login'));

  const buyerRes = await buyer.get('/seller/content');
  assert.equal(buyerRes.status, 403);

  const adminRes = await admin.get('/seller/content');
  assert.equal(adminRes.status, 200);
  const html = await adminRes.text();
  assert.ok(html.includes('إدارة نصوص الموقع'));
  assert.ok(html.includes('نصوص الصفحة الرئيسية'));
  assert.ok(html.includes('متجر الاشتراكات'));
  assert.ok(html.includes('الأسئلة الشائعة'));
  assert.ok(html.includes('الفوتر وبيانات الهوية'));
});

test('POST /seller/content updates texts and renders on public site', async () => {
  const customTexts = {
    home_hero_title: 'منصة MTS الرقمية الرائدة في مصر والعالم',
    home_hero_subtitle: 'اشتراكات برمجيات وتصميم وذكاء اصطناعي بأسعار منافسة ودفع محلي ودولي سهل.',
    home_hero_badge: 'دفع فوري بالجنيه والدولار',
    home_feature_1: 'شحن فوري بفودافون كاش وانستا باي',
    home_feature_2: 'دعم فني مستمر 24/7',
    home_feature_3: 'ضمان كامل واسترجاع',
    announcement: 'خصم خاص 20% بمناسبة الافتتاح في مصر!',
    hero_title: 'متجر الاشتراكات الرقمية… بالجنيه والدولار',
    hero_subtitle: 'نوفر لك باقات معتمدة ومضمونة لأشهر المنصات العالمية.',
    store_trust_1_title: 'تحقق فوري من الدفع',
    store_trust_1_desc: 'فريق متخصص لمراجعة إيصالات التحويل',
    faq_how_to_buy_q: 'كيف أتمكن من شراء اشتراك بسهولة؟',
    faq_how_to_buy_a: 'اختر باقتك المفضلة وسجل طلبك وحول القيمة عبر فودافون كاش أو انستا باي أو البطاقة.',
    footer_about: 'وكالة MTS الرقمية تقدم حلول التجارة الإلكترونية والاشتراكات الرقمية لعملائنا في مصر وحول العالم.',
    store_address: 'مدينة نصر، القاهرة، مصر',
    footer_copyright: 'جميع الحقوق محفوظة لوكالة MTS © 2026',
    whatsapp_number: '+201093525956',
    support_email: 'support@mts-egypt.com',
  };

  const saveRes = await admin.post('/seller/content', customTexts);
  assert.equal(saveRes.status, 200);
  assert.equal(saveRes.body.ok, true);

  // Check settings module
  assert.equal(settings.get('home_hero_title'), customTexts.home_hero_title);
  assert.equal(settings.get('announcement'), customTexts.announcement);
  assert.equal(settings.get('footer_about'), customTexts.footer_about);
  assert.equal(settings.get('store_address'), customTexts.store_address);

  // Check home page renders updated texts
  const homeRes = await (new Client()).get('/');
  assert.equal(homeRes.status, 200);
  const homeHtml = await homeRes.text();
  assert.ok(homeHtml.includes('منصة MTS الرقمية الرائدة في مصر والعالم'));
  assert.ok(homeHtml.includes('دفع فوري بالجنيه والدولار'));
  assert.ok(homeHtml.includes('شحن فوري بفودافون كاش وانستا باي'));
  assert.ok(homeHtml.includes('مدينة نصر، القاهرة، مصر'));
  assert.ok(homeHtml.includes('جميع الحقوق محفوظة لوكالة MTS © 2026'));

  // Check store page renders updated texts
  const storeRes = await (new Client()).get('/store');
  assert.equal(storeRes.status, 200);
  const storeHtml = await storeRes.text();
  assert.ok(storeHtml.includes('خصم خاص 20% بمناسبة الافتتاح في مصر!'));
  assert.ok(storeHtml.includes('متجر الاشتراكات الرقمية'));
});

test('POST /seller/content input validation', async () => {
  const badEmail = await admin.post('/seller/content', { support_email: 'not-an-email' });
  assert.equal(badEmail.status, 422);
  assert.equal(badEmail.body.ok, false);
  assert.ok(badEmail.body.errors.support_email);

  const badPhone = await admin.post('/seller/content', { whatsapp_number: '123' });
  assert.equal(badPhone.status, 422);
  assert.equal(badPhone.body.ok, false);
  assert.ok(badPhone.body.errors.whatsapp_number);
});

test('payment methods are clean of Palestinian banks and contain Egyptian & Global methods', () => {
  const methods = all('SELECT * FROM payment_methods ORDER BY sort_order');
  const serialized = JSON.stringify(methods);
  assert.ok(!serialized.includes('بنك فلسطين'), 'should not contain Bank of Palestine');
  assert.ok(!serialized.includes('جوال باي'), 'should not contain Jawwal Pay');
  assert.ok(!serialized.includes('بال باي'), 'should not contain PalPay');
  assert.ok(serialized.includes('فودافون كاش'), 'should contain Vodafone Cash');
  assert.ok(serialized.includes('انستا باي'), 'should contain InstaPay');
});
