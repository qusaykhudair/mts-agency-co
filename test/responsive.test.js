'use strict';
// Phone layout against a throwaway store in headless Chrome: pages must never be wider than the screen.
// Safari lays out content-visibility:auto sections before it draws them, sized by contain-intrinsic-size, while
// Chrome draws them once first and remembers their real size; so the pages are also opened with those sections
// kept undrawn from the start, the way an iPhone first shows them. That is how the product page got wider than
// iPhone screens (a placeholder width stretched its grid). Also: fields stay at 16px on touch screens, so iPhone
// Safari does not zoom in. Skips when Chrome is not installed (CHROME_PATH points at it).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-responsive-test-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: TMP,
  DB_FILE: path.join(TMP, 'test.db'),
  UPLOAD_DIR: path.join(TMP, 'uploads'),
  ADMIN_EMAIL: 'admin@test.local',
  ADMIN_PASSWORD: 'admin-pass-123',
  ADMIN_WHATSAPP: '+201093525956',
  // Shown on the sign-in pages (never checked with Google here): the app-browser test needs the button.
  GOOGLE_CLIENT_ID: '1234567890-test.apps.googleusercontent.com',
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
const invoices = require('../src/lib/invoices');
const { createApp } = require('../src/app');

const CHROME =
  [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((p) => p && fs.existsSync(p)) || null;
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'store.css'), 'utf8').replace(/\r\n/g, '\n');
// Undrawn from the first byte, like Safari before the visitor scrolls there.
const SAFARI = '.cv-auto,.h-section,.h-logos,.footer{content-visibility:hidden!important}';

let server;
let base;
let chrome;
let adminCookies;

/* ---------- A small DevTools client ---------- */
async function launch() {
  // Apart from the database folder: Chrome's helper processes may hold files here for a moment after it exits.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-responsive-chrome-'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    proc.stderr.on('data', (d) => {
      const m = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec((out += d));
      if (m) resolve(m[1]);
    });
    setTimeout(() => reject(new Error('Chrome did not start')), 20000).unref();
  });
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) events.forEach((fn) => fn(msg));
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send('Page.enable');
  const { userAgent } = await send('Browser.getVersion');
  return {
    send,
    async open(url, { width, safari = false, cookies = [], ua = userAgent }) {
      await send('Network.setUserAgentOverride', { userAgent: ua });
      await send('Network.clearBrowserCookies');
      for (const [name, value] of cookies) await send('Network.setCookie', { name, value, url: base });
      const scripts = [];
      if (safari) {
        const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', {
          source: `new MutationObserver((_, o) => { if (document.head) { const s = document.createElement('style'); s.textContent = ${JSON.stringify(SAFARI)}; document.head.appendChild(s); o.disconnect(); } }).observe(document, { childList: true, subtree: true });`,
        });
        scripts.push(identifier);
      }
      await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 768, screenWidth: width, screenHeight: 844 });
      await send('Emulation.setTouchEmulationEnabled', width < 768 ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      const loaded = new Promise((resolve) => {
        const fn = (msg) => {
          if (msg.method === 'Page.loadEventFired') {
            events.splice(events.indexOf(fn), 1);
            resolve();
          }
        };
        events.push(fn);
      });
      await send('Page.navigate', { url: base + url });
      await loaded;
      await new Promise((r) => setTimeout(r, 300));
      for (const identifier of scripts) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    },
    async evaluate(expression) {
      const out = await send('Runtime.evaluate', { expression, returnByValue: true });
      return out.result.value;
    },
    // Asks Chrome to quit, waits for it, then removes its profile (a leftover temp folder fails nothing).
    async close() {
      const exited = new Promise((resolve) => {
        proc.once('exit', resolve);
        setTimeout(resolve, 5000).unref();
      });
      await send('Browser.close').catch(() => proc.kill());
      await exited;
      ws.close();
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        /* still held by a helper process */
      }
    },
  };
}

// How far the page is wider than the screen (a phone browser widens its layout to fit, so compare to the screen).
const extra = () => chrome.evaluate('document.documentElement.scrollWidth - Math.min(document.documentElement.clientWidth, screen.width)');

before(async () => {
  migrate();
  settings.load();
  await seed();
  settings.load();
  money.load();
  invoices.create(invoices.validate({ client_name: 'شركة النخبة للتجارة', currency: 'USD', total: '1500', paid: '500', method: 'InstaPay', paid_on: invoices.today(), service: 'design', lang: 'ar' }).values, null);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, 'x-requested-with': 'fetch' },
    body: 'email=admin%40test.local&password=admin-pass-123',
  });
  adminCookies = login.headers.getSetCookie().map((c) => c.split(';')[0].split('='));
  if (CHROME) chrome = await launch();
});

after(async () => {
  if (chrome) await chrome.close();
  server && server.close();
  try {
    require('../src/db').db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('sections laid out later only reserve a height, and single-column grids cannot grow past the screen', () => {
  // A placeholder width becomes a section's minimum width in Safari and stretches the grid column it sits in.
  assert.ok(!/contain-intrinsic-size\s*:/.test(CSS), 'use contain-intrinsic-height, not the shorthand that also sets a width');
  assert.match(CSS, /contain-intrinsic-height:\s*auto \d+px/);
  // "1fr" alone is minmax(auto, 1fr): the column grows to fit its widest content.
  assert.deepEqual(CSS.match(/grid-template-columns:\s*1fr;/g), null);
  assert.match(CSS, /\.table-wrap \{[^}]*position: relative/);
});

test('fields are 16px on touch screens, so iPhone Safari does not zoom the page in', { skip: CHROME ? false : 'Chrome is not installed here' }, async () => {
  for (const [url, cookies] of [['/login'], ['/register'], ['/store/products'], ['/seller/invoices', adminCookies], ['/seller/invoices/new', adminCookies], ['/seller/settings', adminCookies]]) {
    await chrome.open(url, { width: 390, cookies });
    const sizes = await chrome.evaluate(`Array.from(document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea')).filter((f) => f.offsetParent).map((f) => parseFloat(getComputedStyle(f).fontSize))`);
    assert.ok(sizes.length, `${url}: fields found`);
    assert.ok(sizes.every((s) => s >= 16), `${url}: ${sizes.join(', ')}`);
  }
});

test('store pages fit phone screens, also the way Safari first lays them out', { skip: CHROME ? false : 'Chrome is not installed here' }, async () => {
  const product = get("SELECT slug FROM products WHERE is_active = 1 AND description <> '' ORDER BY id LIMIT 1").slug;
  for (const url of ['/', '/store', `/store/product/${product}`, '/services']) {
    for (const width of [320, 390]) {
      for (const safari of [false, true]) {
        await chrome.open(url, { width, safari });
        assert.equal(await extra(), 0, `${url} at ${width}px${safari ? ' (Safari)' : ''}`);
      }
    }
  }
});

test('the dashboard pages that were too wide now fit', { skip: CHROME ? false : 'Chrome is not installed here' }, async () => {
  const invoice = get('SELECT id FROM invoices ORDER BY id LIMIT 1').id;
  const cases = [
    ['/seller/settings', [320, 360, 390]],
    ['/seller/currencies', [320]],
    ['/seller/invoices/new', [320]],
    [`/seller/invoices/${invoice}`, [320]],
    ['/seller/invoices', [320, 768]],
  ];
  for (const [url, widths] of cases) {
    for (const width of widths) {
      await chrome.open(url, { width, cookies: adminCookies });
      assert.equal(await extra(), 0, `${url} at ${width}px`);
    }
  }
  // The notifications popover stays inside the screen on a phone.
  await chrome.open('/seller', { width: 390, cookies: adminCookies });
  const box = await chrome.evaluate(`(() => { document.querySelector('[data-notif] [data-dd-toggle]').click(); const r = document.querySelector('[data-notif] .dd-menu').getBoundingClientRect(); return { left: r.left, right: r.right }; })()`);
  assert.ok(box.left >= 0 && box.right <= 390, JSON.stringify(box));
});

test('inside Instagram, Facebook or TikTok the Google button says it cannot work there and opens the real browser', { skip: CHROME ? false : 'Chrome is not installed here' }, async () => {
  const inApp = [
    ['Instagram on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 389.0.0.29.88 (iPhone15,2; iOS 18_5; ar_EG; ar; scale=3.00; 1179x2556; 754843247)', 'x-safari-http'],
    ['Facebook on Android', 'Mozilla/5.0 (Linux; Android 14; SM-A546E Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.7339.207 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/512.0.0.45.103;]', 'intent://'],
    ['TikTok on Android', 'Mozilla/5.0 (Linux; Android 14; SM-A546E Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.7339.207 Mobile Safari/537.36 trill_410005 AppName/musical_ly app_version/41.0.5', 'intent://'],
  ];
  for (const [name, ua, scheme] of inApp) {
    for (const url of ['/login', '/register']) {
      await chrome.open(url, { width: 390, ua });
      const r = await chrome.evaluate(`(() => {
        const note = document.querySelector('.g-inapp');
        const open = note && note.querySelector('[data-open-outside]');
        document.querySelector('a.g-btn').click();
        return { note: !!note, text: note ? note.innerText : '', href: open ? open.getAttribute('href') : '', path: location.pathname };
      })()`);
      assert.ok(r.note && /لا يسمح بتسجيل الدخول/.test(r.text), `${name} ${url}: the note shows`);
      assert.ok(r.href.startsWith(scheme) && r.href.includes(url), `${name} ${url}: ${r.href}`);
      assert.equal(r.path, url, `${name}: the button does not lead to Google's "Access blocked" page`);
      assert.equal(await extra(), 0, `${name} ${url}: the note fits the screen`);
    }
  }
  const browsers = [
    ['Safari on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'],
    ['Chrome on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1'],
    ['Chrome on Android', 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.207 Mobile Safari/537.36'],
  ];
  for (const [name, ua] of browsers) {
    await chrome.open('/login', { width: 390, ua });
    assert.equal(await chrome.evaluate(`!!document.querySelector('.g-inapp')`), false, `${name}: Google sign-in works as usual`);
  }
});
