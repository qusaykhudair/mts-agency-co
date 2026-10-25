'use strict';
// "Forgot password" by e-mail against a throwaway database: the code goes out, wrong and expired codes are
// refused, the right one sets the new password, ends other sessions and signs the visitor in, and unknown
// addresses get the same answer.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-reset-test-'));
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
const mail = require('../src/lib/mail');
const { hashPassword, verifyPassword } = require('../src/lib/auth');
const { createApp } = require('../src/app');

let server;
let base;
let outbox;

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
  async get(url) {
    const res = await fetch(base + url, { redirect: 'manual', headers: this.headers() });
    this.store(res);
    return res;
  }
  async post(url, fields) {
    const res = await fetch(base + url, {
      method: 'POST',
      redirect: 'manual',
      headers: this.headers({ 'content-type': 'application/x-www-form-urlencoded', origin: base, 'x-requested-with': 'fetch' }),
      body: new URLSearchParams(fields).toString(),
    });
    this.store(res);
    return { status: res.status, body: await res.json() };
  }
}

// The code is sent in the background; wait for it to land in the memory outbox.
async function codeFor(email, count) {
  for (let i = 0; i < 50; i++) {
    const mails = outbox.filter((m) => m.to === email && /استعادة كلمة المرور/.test(m.subject));
    if (mails.length >= count) return mails[mails.length - 1].subject.match(/\d{6}/)[0];
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no reset code for ${email}`);
}

before(async () => {
  migrate();
  settings.load();
  await seed();
  settings.load();
  money.load();
  outbox = mail.useMemoryTransport();
  run("INSERT INTO users (name, email, password_hash, wa_e164, email_verified_at) VALUES ('Sara Buyer', 'sara@test.local', ?, '+970599000111', datetime('now'))", await hashPassword('old-password-1'));
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  mail.useRealTransport();
  server && server.close();
  try {
    require('../src/db').db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('the forgot-password page asks for the e-mail instead of sending people to WhatsApp', async () => {
  const html = await (await new Client().get('/forgot-password')).text();
  assert.ok(html.includes('action="/forgot-password"') && html.includes('name="email"'));
  assert.ok(!html.includes('طلب إعادة التعيين عبر واتساب'), 'WhatsApp is only the way out while e-mail is down');
});

test('a code by e-mail sets a new password, signs the visitor in and signs out every other device', async () => {
  const user = get("SELECT id FROM users WHERE email = 'sara@test.local'");
  const elsewhere = new Client();
  assert.equal((await elsewhere.post('/login', { email: 'sara@test.local', password: 'old-password-1' })).body.ok, true);

  const c = new Client();
  const asked = await c.post('/forgot-password', { email: 'Sara@Test.local' });
  assert.equal(asked.body.ok, true);
  assert.equal(asked.body.redirect, '/forgot-password/code');
  const page = await (await c.get('/forgot-password/code')).text();
  assert.ok(page.includes('sa••@test.local') && page.includes('name="code"'), 'the address shows masked');
  const code = await codeFor('sara@test.local', 1);
  const mailSent = outbox.find((m) => m.to === 'sara@test.local');
  assert.ok(mailSent.html.includes(code) && mailSent.html.includes('استعادة كلمة المرور') && !mailSent.html.includes('تأكيد بريدك'));
  assert.ok(!get('SELECT code_hash FROM password_resets WHERE user_id = ?', user.id).code_hash.includes(code), 'only a salted hash is stored');

  const mismatch = await c.post('/forgot-password/code', { email: 'sara@test.local', code, password: 'new-password-2', password_confirm: 'different-2' });
  assert.equal(mismatch.body.ok, false);
  assert.ok(mismatch.body.errors.password_confirm);
  const wrong = await c.post('/forgot-password/code', { email: 'sara@test.local', code: code === '000000' ? '111111' : '000000', password: 'new-password-2', password_confirm: 'new-password-2' });
  assert.equal(wrong.body.ok, false);
  assert.match(wrong.body.message, /4 محاولات/);

  // Digits typed on an Arabic keyboard work too.
  const arabic = code.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
  const done = await c.post('/forgot-password/code', { email: 'sara@test.local', code: arabic, password: 'new-password-2', password_confirm: 'new-password-2' });
  assert.equal(done.body.ok, true, JSON.stringify(done.body));
  assert.equal((await c.get('/account')).status, 200, 'signed in on this device');
  assert.equal((await elsewhere.get('/account')).status, 302, 'the other device was signed out');
  const row = get("SELECT password_hash FROM users WHERE email = 'sara@test.local'");
  assert.equal(await verifyPassword('new-password-2', row.password_hash), true);
  assert.equal(await verifyPassword('old-password-1', row.password_hash), false);
  assert.ok(outbox.some((m) => m.to === 'sara@test.local' && /تغيرت كلمة مرور حسابك/.test(m.subject)), 'the owner hears about the change');

  const again = await c.post('/forgot-password/code', { email: 'sara@test.local', code, password: 'another-pass-3', password_confirm: 'another-pass-3' });
  assert.equal(again.body.ok, false, 'a code works once');
});

test('codes expire, lock after five wrong tries, and come at most once a minute', async () => {
  const c = new Client();
  await c.post('/forgot-password', { email: 'sara@test.local' });
  const before = outbox.length;
  await new Promise((r) => setTimeout(r, 100));
  await c.post('/forgot-password/resend', {});
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(outbox.filter((m) => /استعادة كلمة المرور/.test(m.subject)).length, outbox.slice(0, before).filter((m) => /استعادة كلمة المرور/.test(m.subject)).length, 'no second code within a minute');

  const user = get("SELECT id FROM users WHERE email = 'sara@test.local'");
  run("UPDATE password_resets SET created_at = datetime('now', '-2 minutes') WHERE user_id = ?", user.id);
  await c.post('/forgot-password/resend', {});
  const code = await codeFor('sara@test.local', 2);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await c.post('/forgot-password/code', { email: 'sara@test.local', code: wrong, password: 'locked-pass-4', password_confirm: 'locked-pass-4' });
  const locked = await c.post('/forgot-password/code', { email: 'sara@test.local', code, password: 'locked-pass-4', password_confirm: 'locked-pass-4' });
  assert.equal(locked.body.ok, false);
  assert.match(locked.body.message, /اطلب كودا جديدا/);

  run("UPDATE password_resets SET created_at = datetime('now', '-2 minutes') WHERE user_id = ?", user.id);
  await c.post('/forgot-password/resend', {});
  const fresh = await codeFor('sara@test.local', 3);
  run("UPDATE password_resets SET expires_at = datetime('now', '-1 minute') WHERE user_id = ? AND used_at IS NULL", user.id);
  const expired = await c.post('/forgot-password/code', { email: 'sara@test.local', code: fresh, password: 'late-pass-5', password_confirm: 'late-pass-5' });
  assert.match(expired.body.message, /انتهت صلاحيته/);
});

test('an unknown address gets the same answer and no e-mail', async () => {
  const before = outbox.length;
  const c = new Client();
  const res = await c.post('/forgot-password', { email: 'nobody@test.local' });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.redirect, '/forgot-password/code');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(outbox.length, before);
  const tryIt = await c.post('/forgot-password/code', { email: 'nobody@test.local', code: '123456', password: 'whatever-6', password_confirm: 'whatever-6' });
  assert.equal(tryIt.body.ok, false);
});

test('while e-mail cannot be sent, the page offers WhatsApp instead', async () => {
  mail.useRealTransport();
  try {
    const html = await (await new Client().get('/forgot-password')).text();
    assert.ok(html.includes('طلب إعادة التعيين عبر واتساب') && !html.includes('name="email"'));
  } finally {
    outbox = mail.useMemoryTransport();
  }
});
