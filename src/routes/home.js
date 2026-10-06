'use strict';
const express = require('express');
const { get, all } = require('../db');
const catalog = require('../lib/catalog');
const content = require('../lib/content');

const router = express.Router();

// Reviews count only when the product is publicly listed (active, visible, sold by an active seller).
const PUBLIC_REVIEWS = `FROM reviews r JOIN products p ON p.id = r.product_id
  LEFT JOIN platforms pl ON pl.id = p.platform_id
  LEFT JOIN categories c ON c.id = p.category_id
  WHERE r.is_visible = 1 AND ${catalog.PUBLIC_FILTER}`;

router.get('/', (req, res) => {
  const popular = catalog.listProducts({ sort: 'popular', limit: 8 }).items;
  const platforms = catalog.platformsWithCounts().filter((p) => p.logo_url && p.product_count > 0);
  const rating = get(`SELECT COUNT(*) AS n, ROUND(AVG(r.rating), 1) AS avg ${PUBLIC_REVIEWS}`);

  res.render('home', {
    nav: 'site',
    active: 'home',
    pageTitle: null,
    pageDesc: 'اشتراكات ChatGPT وClaude وCanva وCapCut وغيرها، تدفع ثمنها من بنك فلسطين أو جوال باي أو بال باي أو فودافون كاش. ومن MTS Agency أيضا تصميم وبرمجة وتسويق لمشروعك.',
    // The hero card shows plan choices, so prefer a best-seller that has several plans.
    heroProduct: popular.find((p) => p.plans.length >= 2) || popular[0] || null,
    popular,
    platforms,
    services: all('SELECT * FROM services WHERE is_active = 1 ORDER BY sort_order, id'),
    stats: { platforms: platforms.length },
    rating: rating && rating.n >= 3 ? rating : null,
    reviews: all(
      `SELECT r.*, p.title AS product_title, p.slug AS product_slug ${PUBLIC_REVIEWS}
       AND r.comment IS NOT NULL AND r.comment <> '' ORDER BY r.rating DESC, r.id DESC LIMIT 3`,
    ),
    clients: content.CLIENTS,
    faq: content.STORE_FAQ.slice(0, 5),
  });
});

module.exports = router;
