'use strict';
const express = require('express');
const { get, all } = require('../db');
const catalog = require('../lib/catalog');
const money = require('../lib/money');
const content = require('../lib/content');
const { parseJson } = require('../lib/format');

const router = express.Router();

// Reviews count only when the product is publicly listed (active, visible, sold by an active seller).
const PUBLIC_REVIEWS = `FROM reviews r JOIN products p ON p.id = r.product_id
  LEFT JOIN platforms pl ON pl.id = p.platform_id
  LEFT JOIN categories c ON c.id = p.category_id
  WHERE r.is_visible = 1 AND ${catalog.PUBLIC_FILTER}`;

function activeMethods() {
  return all('SELECT * FROM payment_methods WHERE is_active = 1 ORDER BY sort_order, id').map((m) => ({
    ...m,
    details: parseJson(m.details, []),
    currency: money.byCode(m.currency_code) || money.base(),
  }));
}

// Category cards: a few platform logos, how many products and the lowest current price.
function categoryCards() {
  return catalog
    .categoriesWithCounts()
    .filter((c) => c.product_count > 0)
    .map((c) => {
      const cheapest = catalog.listProducts({ category: c.slug, sort: 'price_asc', limit: 1 }).items[0];
      return {
        ...c,
        logos: catalog
          .platformsWithCounts({ categoryId: c.id })
          .filter((p) => p.logo_url && p.product_count > 0)
          .slice(0, 4),
        from: cheapest && cheapest.cheapest ? cheapest.cheapest.price : null,
      };
    });
}

router.get('/', (req, res) => {
  const popular = catalog.listProducts({ sort: 'popular', limit: 8 }).items;
  const newest = catalog.listProducts({ sort: 'newest', limit: 8 }).items;
  const deals = catalog.listProducts({ sort: 'deals', onSale: true, limit: 8 }).items;
  const spotlight = catalog.pickSpotlight(deals);
  const platforms = catalog.platformsWithCounts().filter((p) => p.logo_url && p.product_count > 0);
  const rating = get(`SELECT COUNT(*) AS n, ROUND(AVG(r.rating), 1) AS avg ${PUBLIC_REVIEWS}`);

  res.render('home', {
    nav: 'site',
    active: 'home',
    pageTitle: null,
    pageDesc: 'اشتراكات ChatGPT وClaude وCanva وCapCut وغيرها من المنصات العالمية بدفع محلي (بنك فلسطين، جوال باي، بال باي، فودافون كاش) وتسليم سريع مع ضمان — من MTS Agency.',
    // The hero card shows plan choices, so prefer a best-seller that has several plans.
    heroProduct: popular.find((p) => p.plans.length >= 2) || popular[0] || null,
    popularSearches: popular.slice(0, 4),
    platforms,
    categories: categoryCards(),
    tabs: [
      { key: 'popular', label: 'الأكثر طلباً', items: popular },
      { key: 'deals', label: 'العروض', items: deals },
      { key: 'newest', label: 'وصل حديثاً', items: newest },
    ].filter((t) => t.items.length),
    spotlight: spotlight.product,
    spotlightPlan: spotlight.plan,
    methods: activeMethods(),
    stats: { platforms: platforms.length },
    rating: rating && rating.n >= 3 ? rating : null,
    reviews: all(
      `SELECT r.*, p.title AS product_title, p.slug AS product_slug ${PUBLIC_REVIEWS}
       AND r.comment IS NOT NULL AND r.comment <> '' ORDER BY r.rating DESC, r.id DESC LIMIT 3`,
    ),
    services: content.SERVICES,
    agencyStats: content.AGENCY_STATS,
    clients: content.CLIENTS,
    whyUs: content.WHY_US,
    faq: content.STORE_FAQ.slice(0, 6),
  });
});

module.exports = router;
