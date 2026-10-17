'use strict';
// Search engines and link previews: one canonical address per page, robots.txt and sitemap.xml, and structured
// data (schema.org JSON-LD) for the organisation, products, breadcrumbs and questions. Every absolute link uses the
// site's own address (APP_URL, or Railway's domain until a custom domain is set).
const config = require('../config');
const catalog = require('./catalog');
const money = require('./money');

// How people search for the seeded platforms in Arabic. Shown next to the brand name on its pages, so a search
// for "اشتراك نتفليكس" finds the Netflix page too.
const ARABIC_NAMES = {
  adobe: 'أدوبي',
  anghami: 'أنغامي',
  canva: 'كانفا',
  capcut: 'كاب كات',
  chatgpt: 'شات جي بي تي',
  claude: 'كلود',
  coursera: 'كورسيرا',
  cursor: 'كيرسر',
  discord: 'ديسكورد',
  duolingo: 'دولينجو',
  elevenlabs: 'إليفن لابز',
  expressvpn: 'إكسبريس في بي إن',
  figma: 'فيجما',
  freepik: 'فري بيك',
  gemini: 'جيميني',
  grammarly: 'جرامرلي',
  linkedin: 'لينكد إن',
  'microsoft-365': 'مايكروسوفت 365',
  midjourney: 'ميدجورني',
  netflix: 'نتفليكس',
  nordvpn: 'نورد في بي إن',
  notion: 'نوشن',
  perplexity: 'بربلكسيتي',
  playstation: 'بلايستيشن',
  shahid: 'شاهد',
  spotify: 'سبوتيفاي',
  surfshark: 'سيرف شارك',
  udemy: 'يوديمي',
  xbox: 'إكس بوكس',
  youtube: 'يوتيوب بريميوم',
};
const arabicName = (slug) => ARABIC_NAMES[slug] || '';

const BRAND = 'MTS Agency';
const ADDRESS = { '@type': 'PostalAddress', streetAddress: 'جسر السويس', addressLocality: 'القاهرة', addressCountry: 'EG' };
const SHARE_IMAGE = '/static/img/og-cover.png';

// "https://example.com", no trailing slash.
function origin(req) {
  return config.appUrl || `${req.protocol}://${req.get('host')}`;
}

const absolute = (base, href) => (/^https?:\/\//i.test(href) ? href : `${base}${href.startsWith('/') ? '' : '/'}${href}`);

// A description for search results: whole words, at most `max` characters.
function clip(text, max = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30)).replace(/[،,.:;\s]+$/, '')}…`;
}

// JSON for a <script type="application/ld+json"> block. "<" is escaped so no text can close the tag early.
const jsonLd = (data) => JSON.stringify(data).replace(/</g, '\\' + 'u003c');

/* ---------- Structured data ---------- */
function organization(s, base) {
  return {
    '@type': 'Organization',
    '@id': `${base}/#organization`,
    name: BRAND,
    alternateName: [s.store_name, 'MTS'].filter((n, i, a) => n && a.indexOf(n) === i && n !== BRAND),
    url: `${base}/`,
    logo: { '@type': 'ImageObject', url: `${base}/static/img/logo-256.png`, width: 256, height: 256 },
    image: `${base}${SHARE_IMAGE}`,
    description: 'اشتراكات المنصات الرقمية بالدفع المحلي، وخدمات التصميم والبرمجة والتسويق للمشاريع.',
    email: s.support_email || undefined,
    telephone: s.whatsapp_number || undefined,
    address: ADDRESS,
    sameAs: [s.facebook_url, s.instagram_url].filter(Boolean),
    contactPoint: s.whatsapp_number
      ? [{ '@type': 'ContactPoint', telephone: s.whatsapp_number, contactType: 'customer service', availableLanguage: ['ar', 'en'] }]
      : undefined,
  };
}

function website(s, base) {
  return { '@type': 'WebSite', '@id': `${base}/#website`, url: `${base}/`, name: BRAND, alternateName: s.store_name, inLanguage: 'ar', publisher: { '@id': `${base}/#organization` } };
}

// items: [{ name, href }]; the last item is the page itself.
function breadcrumbs(base, items) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, ...(it.href ? { item: absolute(base, it.href) } : {}) })),
  };
}

const major = (minor) => (Number(minor) / 100).toFixed(2);

function product(p, base, { summary, reviews, url }) {
  const plans = p.plans.filter((pl) => pl.in_stock);
  const priced = plans.length ? plans : p.plans;
  const prices = priced.map((pl) => pl.price);
  const currency = money.base().code;
  const availability = plans.length ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock';
  const offers =
    priced.length > 1
      ? { '@type': 'AggregateOffer', priceCurrency: currency, lowPrice: major(Math.min(...prices)), highPrice: major(Math.max(...prices)), offerCount: priced.length, availability, url }
      : { '@type': 'Offer', priceCurrency: currency, price: major(prices[0] || 0), availability, url, seller: { '@id': `${base}/#organization` } };
  const image = p.cover_url && !/\.svg$/i.test(p.cover_url) ? absolute(base, p.cover_url) : `${base}${SHARE_IMAGE}`;
  return {
    '@type': 'Product',
    '@id': `${url}#product`,
    name: p.title,
    alternateName: arabicName(p.platform_slug) ? `اشتراك ${arabicName(p.platform_slug)}` : undefined,
    description: clip(p.short_description || p.title, 300),
    sku: String(100000 + p.id),
    image,
    url,
    category: p.category_name || undefined,
    brand: p.platform_name ? { '@type': 'Brand', name: p.platform_name } : undefined,
    offers,
    aggregateRating: summary && summary.total ? { '@type': 'AggregateRating', ratingValue: summary.avg, reviewCount: summary.total, bestRating: 5, worstRating: 1 } : undefined,
    review: (reviews || [])
      .filter((r) => r.comment)
      .slice(0, 5)
      .map((r) => ({
        '@type': 'Review',
        author: { '@type': 'Person', name: r.author_name },
        reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5, worstRating: 1 },
        reviewBody: clip(r.comment, 500),
        datePublished: String(r.created_at || '').slice(0, 10) || undefined,
      })),
  };
}

function faq(items) {
  return {
    '@type': 'FAQPage',
    mainEntity: items.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  };
}

function services(list, base) {
  return {
    '@type': 'ItemList',
    itemListElement: list.map((s, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: { '@type': 'Service', name: s.name, description: clip(s.summary, 300), provider: { '@id': `${base}/#organization` }, areaServed: ['PS', 'EG', 'JO', 'SA', 'AE'] },
    })),
  };
}

// One graph per page, so every node can point at the organisation by its @id.
const graph = (nodes) => jsonLd({ '@context': 'https://schema.org', '@graph': nodes.filter(Boolean) });

/* ---------- robots.txt, sitemap.xml and the canonical host ---------- */
function robots(req) {
  const disallow = ['/account', '/seller', '/provider', '/api', '/files', '/auth/', '/store/checkout', '/store/currency/', '/services/request'];
  return ['User-agent: *', ...disallow.map((p) => `Disallow: ${p}`), '', `Sitemap: ${origin(req)}/sitemap.xml`, ''].join('\n');
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const day = (v) => (v ? String(v).slice(0, 10) : null);

function sitemap(req) {
  const base = origin(req);
  const urls = [
    { loc: '/', priority: '1.0' },
    { loc: '/store', priority: '0.9' },
    { loc: '/store/products', priority: '0.8' },
    { loc: '/services', priority: '0.8' },
    { loc: '/store/platforms', priority: '0.6' },
    { loc: '/store/help', priority: '0.5' },
    { loc: '/store/terms', priority: '0.2' },
    { loc: '/store/privacy', priority: '0.2' },
  ];
  for (const c of catalog.categoriesWithCounts()) if (c.product_count > 0) urls.push({ loc: `/store/category/${c.slug}`, priority: '0.7' });
  for (const p of catalog.platformsWithCounts()) if (p.product_count > 0) urls.push({ loc: `/store/platform/${p.slug}`, priority: '0.7' });
  for (const p of catalog.listProducts({ sort: 'newest', limit: 5000 }).items) urls.push({ loc: `/store/product/${p.slug}`, lastmod: day(p.updated_at), priority: '0.8' });
  const body = urls
    .map((u) => `  <url><loc>${xml(absolute(base, u.loc))}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<priority>${u.priority}</priority></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

// Once the site has its own domain in APP_URL, visits to the Railway address move there for good (301), so search
// engines keep one address. /healthz answers on every host for Railway's checks.
function canonicalHost(req, res, next) {
  if (!config.appUrl || (req.method !== 'GET' && req.method !== 'HEAD') || req.path === '/healthz') return next();
  let target;
  try {
    target = new URL(config.appUrl);
  } catch {
    return next();
  }
  const host = String(req.get('host') || '');
  if (!host || host === target.host || !/\.up\.railway\.app$/i.test(host)) return next();
  return res.redirect(301, `${target.origin}${req.originalUrl}`);
}

module.exports = {
  ARABIC_NAMES,
  arabicName,
  SHARE_IMAGE,
  origin,
  absolute,
  clip,
  jsonLd,
  graph,
  organization,
  website,
  breadcrumbs,
  product,
  faq,
  services,
  robots,
  sitemap,
  canonicalHost,
};
