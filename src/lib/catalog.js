'use strict';
const { get, all, fromSql } = require('../db');
const { parseJson, discountPercent } = require('./format');

// A plan's live price: when a timed offer has ended the plan reverts to its old price.
const EFFECTIVE_PRICE_SQL = `CASE WHEN pp.old_price > pp.price AND p.offer_ends_at IS NOT NULL AND p.offer_ends_at <= datetime('now') THEN pp.old_price ELSE pp.price END`;
const DISCOUNT_SQL = `CASE WHEN pp.old_price > pp.price AND (p.offer_ends_at IS NULL OR p.offer_ends_at > datetime('now')) THEN (pp.old_price - pp.price) * 100.0 / pp.old_price ELSE 0 END`;

const PRODUCT_SELECT = `
  SELECT p.*,
         pl.name AS platform_name, pl.slug AS platform_slug, pl.logo_url AS platform_logo,
         pl.color1 AS color1, pl.color2 AS color2,
         c.name AS category_name, c.slug AS category_slug, c.icon AS category_icon,
         (SELECT MIN(${EFFECTIVE_PRICE_SQL}) FROM product_plans pp WHERE pp.product_id = p.id AND pp.is_active = 1) AS min_price,
         (SELECT MAX(${DISCOUNT_SQL}) FROM product_plans pp WHERE pp.product_id = p.id AND pp.is_active = 1) AS max_discount,
         (SELECT COUNT(*) FROM product_plans pp WHERE pp.product_id = p.id AND pp.is_active = 1) AS plan_count,
         (SELECT ROUND(AVG(r.rating), 1) FROM reviews r WHERE r.product_id = p.id AND r.is_visible = 1) AS rating_avg,
         (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id AND r.is_visible = 1) AS rating_count
  FROM products p
  LEFT JOIN platforms pl ON pl.id = p.platform_id
  LEFT JOIN categories c ON c.id = p.category_id`;

// Products are public when active, in a visible platform/category, sold by an active seller and
// with at least one active plan.
const SELLER_OK = `AND EXISTS (SELECT 1 FROM users su WHERE su.id = p.seller_id AND su.is_blocked = 0 AND su.role IN ('seller', 'admin'))`;

const PUBLIC_FILTER = `p.is_active = 1
  AND (pl.id IS NULL OR pl.is_active = 1)
  AND (c.id IS NULL OR c.is_active = 1)
  ${SELLER_OK}
  AND EXISTS (SELECT 1 FROM product_plans pp WHERE pp.product_id = p.id AND pp.is_active = 1)`;

const SORTS = {
  popular: 'p.is_featured DESC, p.sales_count DESC, p.views DESC, p.id ASC',
  newest: 'p.created_at DESC, p.id DESC',
  price_asc: 'min_price ASC, p.id DESC',
  price_desc: 'min_price DESC, p.id DESC',
  deals: 'max_discount DESC, p.sales_count DESC, p.id DESC',
  rating: 'rating_avg IS NULL, rating_avg DESC, rating_count DESC, p.id DESC',
};

const SORT_LABELS = {
  popular: 'الأكثر طلباً',
  newest: 'الأحدث',
  deals: 'أعلى خصم',
  price_asc: 'السعر: من الأقل',
  price_desc: 'السعر: من الأعلى',
  rating: 'الأعلى تقييماً',
};

function offerEnd(product) {
  const d = product.offer_ends_at ? fromSql(product.offer_ends_at) : null;
  return d && d.getTime() > Date.now() ? d : null;
}

function effectivePlan(plan, product) {
  const end = product.offer_ends_at ? fromSql(product.offer_ends_at) : null;
  const expired = !!end && end.getTime() <= Date.now();
  let price = plan.price;
  let old = plan.old_price && plan.old_price > plan.price ? plan.old_price : null;
  if (old && expired) {
    price = old;
    old = null;
  }
  const inStock = plan.stock === null || plan.stock === undefined || plan.stock > 0;
  return { ...plan, price, old_price: old, discount: discountPercent(price, old), in_stock: inStock };
}

function plansFor(productIds, { activeOnly = true } = {}) {
  if (!productIds.length) return new Map();
  const rows = all(
    `SELECT * FROM product_plans WHERE product_id IN (${productIds.map(() => '?').join(',')})
     ${activeOnly ? 'AND is_active = 1' : ''} ORDER BY sort_order, price, id`,
    ...productIds,
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.product_id)) map.set(r.product_id, []);
    map.get(r.product_id).push(r);
  }
  return map;
}

// Attach parsed JSON fields, effective plans and the "starting from" plan.
function decorate(products, { activeOnly = true } = {}) {
  const plans = plansFor(products.map((p) => p.id), { activeOnly });
  return products.map((p) => {
    const list = (plans.get(p.id) || []).map((pl) => effectivePlan(pl, p));
    const cheapest = list.reduce((best, pl) => (!best || pl.price < best.price ? pl : best), null);
    const days = (p.created_at && fromSql(p.created_at)) || new Date();
    return {
      ...p,
      features: parseJson(p.features, []),
      activation_steps: parseJson(p.activation_steps, []),
      plans: list,
      cheapest,
      offer_end: offerEnd(p),
      is_new: Date.now() - days.getTime() < 14 * 86400000,
      max_discount: Math.round(p.max_discount || 0),
    };
  });
}

function listProducts({ category, platform, q, sort = 'popular', featured, limit = 24, offset = 0, onSale, excludeId } = {}) {
  const where = [PUBLIC_FILTER];
  const params = [];
  if (category) {
    where.push('c.slug = ?');
    params.push(category);
  }
  if (platform) {
    where.push('pl.slug = ?');
    params.push(platform);
  }
  if (featured) where.push('p.is_featured = 1');
  if (excludeId) {
    where.push('p.id <> ?');
    params.push(excludeId);
  }
  if (q) {
    const like = '%' + String(q).trim().replace(/[%_]/g, (m) => '\\' + m) + '%';
    where.push("(p.title LIKE ? ESCAPE '\\' OR pl.name LIKE ? ESCAPE '\\' OR p.short_description LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  const order = typeof sort === 'string' && Object.hasOwn(SORTS, sort) ? SORTS[sort] : SORTS.popular;
  const inner = `${PRODUCT_SELECT} WHERE ${where.join(' AND ')}`;
  const filtered = onSale ? `SELECT * FROM (${inner}) WHERE max_discount > 0` : inner;
  const total = get(`SELECT COUNT(*) AS n FROM (${filtered})`, ...params).n;
  const rows = all(`SELECT * FROM (${filtered}) p ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
  return { items: decorate(rows), total };
}

function getProduct({ slug, id }, { publicOnly = true } = {}) {
  const row = get(`${PRODUCT_SELECT} WHERE ${slug ? 'p.slug = ?' : 'p.id = ?'}${publicOnly ? ' AND ' + PUBLIC_FILTER : ''}`, slug || id);
  if (!row) return null;
  return decorate([row], { activeOnly: publicOnly })[0];
}

function categoriesWithCounts() {
  return all(
    `SELECT c.*, (SELECT COUNT(*) FROM products p LEFT JOIN platforms pl ON pl.id = p.platform_id
                   WHERE p.category_id = c.id AND p.is_active = 1 AND (pl.id IS NULL OR pl.is_active = 1) ${SELLER_OK}
                     AND EXISTS (SELECT 1 FROM product_plans pp WHERE pp.product_id = p.id AND pp.is_active = 1)) AS product_count
     FROM categories c WHERE c.is_active = 1 ORDER BY c.sort_order, c.id`,
  );
}

function platformsWithCounts({ featuredOnly = false, categoryId } = {}) {
  const where = ['pl.is_active = 1'];
  const params = [];
  if (featuredOnly) where.push('pl.is_featured = 1');
  if (categoryId) {
    where.push('pl.category_id = ?');
    params.push(categoryId);
  }
  return all(
    `SELECT pl.*, c.name AS category_name, c.slug AS category_slug,
            (SELECT COUNT(*) FROM products p WHERE p.platform_id = pl.id AND p.is_active = 1 ${SELLER_OK}
               AND EXISTS (SELECT 1 FROM product_plans pp WHERE pp.product_id = p.id AND pp.is_active = 1)) AS product_count
     FROM platforms pl LEFT JOIN categories c ON c.id = pl.category_id
     WHERE ${where.join(' AND ')} ORDER BY pl.sort_order, pl.name`,
    ...params,
  );
}

function ratingSummary(productId) {
  const rows = all('SELECT rating, COUNT(*) AS n FROM reviews WHERE product_id = ? AND is_visible = 1 GROUP BY rating', productId);
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  let sum = 0;
  for (const r of rows) {
    dist[r.rating] = r.n;
    total += r.n;
    sum += r.rating * r.n;
  }
  return { total, avg: total ? Math.round((sum / total) * 10) / 10 : 0, dist };
}

// The deal worth featuring: one with a running countdown first, otherwise the biggest discount.
function pickSpotlight(deals) {
  const product = deals.find((p) => p.offer_end) || deals[0] || null;
  const plan = product ? product.plans.find((pl) => pl.discount > 0) || product.cheapest : null;
  return product && plan && plan.old_price ? { product, plan } : { product: null, plan: null };
}

module.exports = {
  PUBLIC_FILTER,
  pickSpotlight,
  SORTS,
  SORT_LABELS,
  PRODUCT_SELECT,
  effectivePlan,
  decorate,
  listProducts,
  getProduct,
  categoriesWithCounts,
  platformsWithCounts,
  ratingSummary,
  offerEnd,
};
