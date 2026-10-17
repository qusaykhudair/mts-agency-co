'use strict';
// Search engines and page speed against a throwaway database: canonical links, robots.txt, the sitemap,
// structured data, the move to a custom domain, Search Console codes, the icon stylesheet and compressed assets.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-seo-test-'));
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
  APP_URL: '',
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
const config = require('../src/config');
const icons = require('../src/lib/icons');
const assets = require('../src/lib/assets');
const { createApp } = require('../src/app');

let server;
let base;
let adminCookie = '';

const page = async (url, headers = {}) => {
  const res = await fetch(base + url, { redirect: 'manual', headers });
  return { res, html: await res.text() };
};
const pick = (html, re) => (re.exec(html) || [])[1];
// A raw request, for a Host header or a path that fetch() would rewrite.
const raw = (rawPath, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: rawPath, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end();
  });
const ldOf = (html) => JSON.parse(pick(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/))['@graph'];

before(async () => {
  migrate();
  settings.load();
  await seed();
  settings.load();
  money.load();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, 'x-requested-with': 'fetch' },
    body: new URLSearchParams({ email: 'admin@test.local', password: 'admin-pass-123' }).toString(),
  });
  adminCookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
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

test('public pages carry a canonical link, a share card and the organisation; private pages are not indexed', async () => {
  const { html } = await page('/');
  assert.equal(pick(html, /<link rel="canonical" href="([^"]*)"/), `${base}/`);
  assert.equal(pick(html, /<meta property="og:image" content="([^"]*)"/), `${base}/static/img/og-cover.png`);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.ok(!/fonts\.googleapis\.com|cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome/.test(html), 'no third-party font or icon stylesheets');
  const graph = ldOf(html);
  assert.deepEqual(graph.map((n) => n['@type']), ['Organization', 'WebSite']);
  assert.equal(graph[0].logo.url, `${base}/static/img/logo-256.png`);
  assert.ok(graph[0].sameAs.includes(settings.get('facebook_url')));

  const login = (await page('/login')).html;
  assert.match(login, /<meta name="robots" content="noindex, nofollow">/);
  assert.ok(!login.includes('rel="canonical"') && !login.includes('application/ld+json'));
});

test('listings keep one address: sorting is dropped, deals and page numbers stay, searches are not indexed', async () => {
  assert.equal(pick((await page('/store/products?sort=price')).html, /<link rel="canonical" href="([^"]*)"/), `${base}/store/products`);
  assert.equal(pick((await page('/store/products?sale=1&sort=deals')).html, /<link rel="canonical" href="([^"]*)"/), `${base}/store/products?sale=1`);
  const search = (await page('/store/products?q=canva')).html;
  assert.match(search, /<meta name="robots" content="noindex, follow">/);
  const platform = (await page('/store/platform/netflix')).html;
  assert.equal(pick(platform, /<title>([^<]*)<\/title>/), 'اشتراكات Netflix | MTS Store');
  assert.match(pick(platform, /<h1>([\s\S]*?)<\/h1>/), /نتفليكس/, 'the Arabic name people search for is on the page');
  const crumbs = ldOf(platform).find((n) => n['@type'] === 'BreadcrumbList');
  assert.deepEqual(crumbs.itemListElement.map((i) => i.name), ['المتجر', 'الأفلام والمسلسلات', 'اشتراكات Netflix']);
});

test('a product page describes the product, its prices and reviews for search engines', async () => {
  const p = get("SELECT * FROM products WHERE slug = 'chatgpt-plus'");
  run("INSERT INTO reviews (product_id, author_name, rating, comment) VALUES (?, 'أحمد', 5, 'وصلني الاشتراك بسرعة </script><b>')", p.id);
  const { html } = await page('/store/product/chatgpt-plus?plan=1');
  assert.equal(pick(html, /<link rel="canonical" href="([^"]*)"/), `${base}/store/product/chatgpt-plus`);
  assert.match(pick(html, /<title>([^<]*)<\/title>/), /^اشتراك ChatGPT Plus/);
  const desc = pick(html, /<meta name="description" content="([^"]*)"/);
  assert.ok(desc.length <= 160 && /شات جي بي تي/.test(desc) && /بسعر يبدأ من/.test(desc), desc);
  assert.ok(!html.includes('</script><b>'), 'review text cannot close the JSON-LD block');
  const product = ldOf(html).find((n) => n['@type'] === 'Product');
  assert.equal(product.name, p.title);
  assert.equal(product.offers.priceCurrency, 'USD');
  assert.ok(Number(product.offers.lowPrice || product.offers.price) > 0);
  assert.equal(product.aggregateRating.reviewCount, 1);
  assert.equal(product.review[0].author.name, 'أحمد');
  assert.ok(ldOf(html).some((n) => n['@type'] === 'BreadcrumbList'));
});

test('robots.txt points to the sitemap, which lists the public pages only', async () => {
  const robots = await (await fetch(base + '/robots.txt')).text();
  assert.match(robots, /Disallow: \/seller/);
  assert.match(robots, /Disallow: \/store\/checkout/);
  assert.ok(robots.includes(`Sitemap: ${base}/sitemap.xml`));

  run("UPDATE products SET is_active = 0 WHERE slug = 'netflix-premium-4k'");
  try {
    const res = await fetch(base + '/sitemap.xml');
    assert.match(res.headers.get('content-type'), /xml/);
    const xml = await res.text();
    for (const loc of ['/', '/store', '/services', '/store/product/chatgpt-plus', '/store/platform/chatgpt', '/store/category/ai']) {
      assert.ok(xml.includes(`<loc>${base}${loc}</loc>`), loc);
    }
    assert.ok(!xml.includes('netflix-premium-4k'), 'a hidden product is left out');
    assert.ok(!/\/seller|\/account|\/login/.test(xml));
  } finally {
    run("UPDATE products SET is_active = 1 WHERE slug = 'netflix-premium-4k'");
  }
});

test('with its own domain in APP_URL, the Railway address moves there for good', async () => {
  const saved = config.appUrl;
  config.appUrl = 'https://shop.example';
  try {
    const moved = await raw('/store/products?sale=1', { host: 'mts-agency-co-production.up.railway.app' });
    assert.equal(moved.statusCode, 301);
    assert.equal(moved.headers.location, 'https://shop.example/store/products?sale=1');
    const health = await raw('/healthz', { host: 'mts-agency-co-production.up.railway.app' });
    assert.equal(health.statusCode, 200, 'Railway health checks still answer');
    const local = await fetch(base + '/store', { redirect: 'manual' });
    assert.equal(local.status, 200, 'other hosts are left alone');
    assert.match(await local.text(), /<link rel="canonical" href="https:\/\/shop\.example\/store">/);
  } finally {
    config.appUrl = saved;
  }
});

test('the admin pastes the Search Console tag and its code is published on every page', async () => {
  const save = await fetch(base + '/seller/settings', {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded', origin: base, 'x-requested-with': 'fetch' },
    body: new URLSearchParams({
      ...settings.getAll(),
      google_site_verification: '<meta name="google-site-verification" content="AbC123_dEf-456xyz" />',
      bing_site_verification: '',
    }).toString(),
  });
  assert.equal((await save.json()).ok, true);
  assert.equal(settings.get('google_site_verification'), 'AbC123_dEf-456xyz');
  assert.match((await page('/')).html, /<meta name="google-site-verification" content="AbC123_dEf-456xyz">/);
  const bad = await fetch(base + '/seller/settings', {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded', origin: base, 'x-requested-with': 'fetch' },
    body: new URLSearchParams({ ...settings.getAll(), google_site_verification: 'not a code <b>' }).toString(),
  });
  assert.equal((await bad.json()).ok, false);
});

test('the icon stylesheet holds the icons in use with their widths, brands as shapes, and follows new icons', async () => {
  const site = icons.stylesheet('site').css;
  assert.match(site, /\.fa-house::before\{content:"\\f015"\}\.fa-house\{width:1\.125em\}/);
  assert.match(site, /\.fa-brands\.fa-whatsapp,\.fab\.fa-whatsapp\{width:0\.875em;--fa-mask:url\("data:image\/svg\+xml,/);
  assert.ok(!site.includes('.fa-dragon::before'), 'icons nobody uses stay out');
  assert.ok(!/fa-brands-400/.test(site), 'the brands font is never needed');
  assert.ok(icons.stylesheet('dash').css.includes('.fa-dragon::before'), 'dashboards get every icon for the icon fields');

  const before = icons.href('site');
  const cat = get('SELECT * FROM categories ORDER BY id LIMIT 1');
  const res = await fetch(`${base}/seller/categories`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded', origin: base, 'x-requested-with': 'fetch' },
    body: new URLSearchParams({ id: cat.id, name: cat.name, slug: cat.slug, icon: 'fa-solid fa-dragon', description: cat.description || '', sort_order: cat.sort_order, is_active: '1' }).toString(),
  });
  assert.equal(res.status, 200);
  assert.equal(get('SELECT icon FROM categories WHERE id = ?', cat.id).icon, 'fa-solid fa-dragon');
  assert.notEqual(icons.href('site'), before, 'a new icon gives the stylesheet a new address');
  assert.ok(icons.stylesheet('site').css.includes('.fa-dragon::before'));
  run('UPDATE categories SET icon = ? WHERE id = ?', cat.icon, cat.id);
  icons.invalidate();
});

test('stylesheets and scripts come minified and compressed, cached for a year when versioned', async () => {
  assert.equal(assets.minifyCss("/* note */ a > b ,  c { color : red ; content: '  a ; b  ' }  /*! keep */ x{y:z;}"), "a>b,c{color :red;content:'  a ; b  '}/*! keep */\n x{y:z}");
  assert.equal(assets.minifyCss('.a :hover , .b::after { margin : 0 }'), '.a :hover,.b::after{margin :0}', 'a space before a colon is a selector and stays');
  const css = await fetch(base + '/static/css/store.css?v=abc', { headers: { 'accept-encoding': 'br' } });
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-encoding'), 'br');
  assert.match(css.headers.get('vary'), /Accept-Encoding/);
  const etag = css.headers.get('etag');
  const plain = await fetch(base + '/static/css/store.css?v=abc', { headers: { 'accept-encoding': 'identity' } });
  const text = await plain.text();
  assert.ok(text.length < fs.statSync(path.join(__dirname, '..', 'public', 'css', 'store.css')).size, 'minified');
  assert.ok(text.includes("font-family:'IBM Plex Sans Arabic'"));
  const again = await fetch(base + '/static/css/store.css?v=abc', { headers: { 'accept-encoding': 'br', 'if-none-match': etag } });
  assert.equal(again.status, 304);
  const iconsCss = await fetch(base + icons.href('site'), { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(iconsCss.headers.get('content-encoding'), 'gzip');
  assert.notEqual((await raw('/static/%2e%2e%2fpackage.json')).statusCode, 200, 'nothing outside public/ is served');
  assert.notEqual((await raw('/static/css/..%2f..%2fpackage.json')).statusCode, 200);

  const saved = config.isProd;
  config.isProd = true;
  try {
    assert.equal((await fetch(base + '/static/js/app.js?v=abc')).headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await fetch(base + '/static/fonts/plex-arabic-400.woff2?v=15')).headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await fetch(base + '/static/js/app.js')).headers.get('cache-control'), 'public, max-age=86400');
    assert.equal((await fetch(base + '/static/img/platforms/netflix.svg')).headers.get('cache-control'), 'public, max-age=2592000');
  } finally {
    config.isProd = saved;
  }
});

test('the homepage has no layout or accessibility slips found by PageSpeed', async () => {
  const { html } = await page('/');
  assert.ok(!html.includes('&quot;true&quot;'), 'hidden logo copies use a real aria-hidden="true"');
  assert.match(html, /aria-hidden="true" tabindex="-1"/);
  assert.ok(!/<h4/.test(html), 'footer titles no longer skip heading levels');
  assert.ok(!html.includes('id="imageDialog"'), 'no link without an address on public pages');
  // Images in the first screen have their size in the markup, so nothing moves while they load.
  for (const cls of ['snav-brand', 'h-sc-tile', 'h-logo']) {
    const img = pick(html, new RegExp(`class="${cls}"[^>]*>\\s*<img ([^>]*)>`));
    assert.match(img || '', /width="\d+" height="\d+"/, cls);
  }
});
