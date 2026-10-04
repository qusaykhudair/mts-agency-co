'use strict';
const express = require('express');
const { get, all, run, tx, toSql, fromSql } = require('../db');
const config = require('../config');
const orders = require('../lib/orders');
const catalog = require('../lib/catalog');
const money = require('../lib/money');
const settings = require('../lib/settings');
const { DELIVERY_METHODS, slugify, isoDay, zonedLocalToUtc, zonedLocal } = require('../lib/format');
const { imageUpload, publicUrl, removePublic, discard } = require('../lib/uploads');
const { str, clean, cleanText, lines, int, bool, pick } = require('../lib/util');
const { paginate, requireStaff } = require('../middleware');

const router = express.Router();

router.use(requireStaff, (req, res, next) => {
  res.locals.nav = 'seller';
  res.locals.noindex = true;
  next();
});

const isAdminUser = (user) => user.role === 'admin';
// Orders a staff member works on ("o" alias): everything for admins; for sellers, orders of their
// own products except the ones they placed themselves.
const orderScope = (user) => (isAdminUser(user) ? { sql: '1 = 1', params: [] } : { sql: 'o.seller_id = ? AND o.user_id <> ?', params: [user.id, user.id] });
const productScope = (user) => (isAdminUser(user) ? { sql: '1 = 1', params: [] } : { sql: 'p.seller_id = ?', params: [user.id] });
// Payments land in the store's accounts, so confirming them is the admin's call unless sellers are allowed.
const canReviewPayment = (user) => isAdminUser(user) || settings.get('sellers_can_approve') !== '0';
const siteUrl = (req) => config.appUrl || `${req.protocol}://${req.get('host')}`;

// The last `n` calendar days (YYYY-MM-DD) in the store timezone, oldest first.
function lastDays(n) {
  const [y, m, d] = isoDay(new Date()).split('-').map(Number);
  const days = [];
  for (let i = n - 1; i >= 0; i--) days.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  return days;
}

/* =====================================================================
   Overview
   ===================================================================== */
router.get('/', (req, res) => {
  const scope = orderScope(req.user);
  const [year, month] = isoDay(new Date()).split('-');
  const monthStart = toSql(zonedLocalToUtc(`${year}-${month}-01T00:00`));
  const stats = get(
    `SELECT
       COALESCE(SUM(CASE WHEN o.status IN ${orders.PAID_STATUSES} AND o.paid_at >= ? THEN ${orders.TOTAL_IN_BASE_SQL} ELSE 0 END), 0) AS month_revenue,
       COALESCE(SUM(CASE WHEN o.status IN ${orders.PAID_STATUSES} THEN ${orders.TOTAL_IN_BASE_SQL} ELSE 0 END), 0) AS total_revenue,
       COALESCE(SUM(CASE WHEN o.status = 'under_review' THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN o.status = 'processing' THEN 1 ELSE 0 END), 0) AS processing,
       COALESCE(SUM(CASE WHEN o.status IN ('delivered', 'completed') THEN 1 ELSE 0 END), 0) AS delivered,
       COUNT(DISTINCT o.user_id) AS customers,
       COUNT(*) AS orders_count
     FROM orders o WHERE ${scope.sql}`,
    monthStart,
    ...scope.params,
  );

  // Revenue per day for the last 14 days, bucketed by payment date in the store timezone.
  const days = lastDays(14);
  const buckets = new Map(days.map((k) => [k, { amount: 0, n: 0 }]));
  const rows = all(
    `SELECT o.paid_at, ${orders.TOTAL_IN_BASE_SQL} AS amount FROM orders o
     WHERE o.paid_at >= ? AND o.status IN ${orders.PAID_STATUSES} AND ${scope.sql}`,
    toSql(zonedLocalToUtc(`${days[0]}T00:00`)),
    ...scope.params,
  );
  for (const r of rows) {
    const bucket = buckets.get(isoDay(fromSql(r.paid_at)));
    if (bucket) {
      bucket.amount += r.amount;
      bucket.n += 1;
    }
  }
  const chart = days.map((key) => ({ key, label: `${Number(key.slice(8))}/${Number(key.slice(5, 7))}`, ...buckets.get(key) }));
  const chartMax = Math.max(1, ...chart.map((c) => c.amount));

  const pScope = productScope(req.user);
  res.render('seller/overview', {
    active: 'seller-home',
    pageTitle: 'لوحة البائع',
    stats,
    chart,
    chartMax,
    chartTotal: chart.reduce((s, c) => s + c.amount, 0),
    queue: all(
      `SELECT o.*, u.name AS buyer_name, u.wa_e164 AS buyer_whatsapp, p.cover_url AS product_cover, pl.logo_url AS platform_logo, pl.color1, pl.color2
       FROM orders o JOIN users u ON u.id = o.user_id LEFT JOIN products p ON p.id = o.product_id LEFT JOIN platforms pl ON pl.id = p.platform_id
       WHERE o.status IN ('under_review', 'processing') AND ${scope.sql}
       ORDER BY CASE o.status WHEN 'under_review' THEN 0 ELSE 1 END, o.id ASC LIMIT 8`,
      ...scope.params,
    ),
    topProducts: all(
      `SELECT p.id, p.title, p.slug, p.sales_count, p.views, pl.logo_url AS platform_logo, pl.color1, pl.color2, p.cover_url AS product_cover
       FROM products p LEFT JOIN platforms pl ON pl.id = p.platform_id
       WHERE ${pScope.sql} ORDER BY p.sales_count DESC, p.views DESC LIMIT 5`,
      ...pScope.params,
    ),
    productCount: get(`SELECT COUNT(*) AS n FROM products p WHERE ${pScope.sql}`, ...pScope.params).n,
  });
});

/* =====================================================================
   Orders
   ===================================================================== */
const ORDER_TABS = [
  { key: '', label: 'الكل', statuses: null },
  { key: 'under_review', label: 'بانتظار المراجعة', statuses: ['under_review'] },
  { key: 'processing', label: 'قيد التجهيز', statuses: ['processing'] },
  { key: 'delivered', label: 'تم التسليم', statuses: ['delivered'] },
  { key: 'completed', label: 'مكتملة', statuses: ['completed'] },
  { key: 'payment_rejected', label: 'الدفع مرفوض', statuses: ['payment_rejected'] },
  { key: 'cancelled', label: 'ملغية', statuses: ['cancelled'] },
];

router.get('/orders', (req, res) => {
  const scope = orderScope(req.user);
  const tab = ORDER_TABS.find((t) => t.key === (req.query.status || '')) || ORDER_TABS[0];
  const q = clean(req.query.q, 80);
  const methodId = int(req.query.method, { fallback: null });

  const counts = Object.fromEntries(all(`SELECT o.status, COUNT(*) AS n FROM orders o WHERE ${scope.sql} GROUP BY o.status`, ...scope.params).map((r) => [r.status, r.n]));
  const tabs = ORDER_TABS.map((t) => ({ ...t, count: t.statuses ? t.statuses.reduce((s, st) => s + (counts[st] || 0), 0) : Object.values(counts).reduce((a, b) => a + b, 0) }));

  const where = [scope.sql];
  const params = [...scope.params];
  if (tab.statuses) {
    where.push(`o.status IN (${tab.statuses.map(() => '?').join(',')})`);
    params.push(...tab.statuses);
  }
  if (methodId) {
    where.push('o.payment_method_id = ?');
    params.push(methodId);
  }
  if (q) {
    const like = `%${q}%`;
    // WhatsApp numbers are stored as +E.164, so drop a typed "+" or trunk "0" before matching.
    const waLike = `%${q.replace(/^\+?0*/, '')}%`;
    where.push('(o.code LIKE ? OR u.name LIKE ? OR u.email LIKE ? OR u.wa_e164 LIKE ? OR o.sender_name LIKE ? OR o.sender_account LIKE ? OR o.product_title LIKE ?)');
    params.push(like, like, like, waLike, like, like, like);
  }
  const base = `FROM orders o JOIN users u ON u.id = o.user_id LEFT JOIN products p ON p.id = o.product_id LEFT JOIN platforms pl ON pl.id = p.platform_id WHERE ${where.join(' AND ')}`;
  const total = get(`SELECT COUNT(*) AS n ${base}`, ...params).n;
  const pg = paginate(total, req.query.page, 20);
  res.render('seller/orders', {
    active: 'seller-orders',
    pageTitle: 'الطلبات',
    tabs,
    tab: tab.key,
    q,
    methodId,
    methods: all('SELECT id, name FROM payment_methods ORDER BY sort_order, id'),
    pg,
    items: all(
      `SELECT o.*, u.name AS buyer_name, u.email AS buyer_email, u.wa_e164 AS buyer_whatsapp, p.cover_url AS product_cover, pl.logo_url AS platform_logo, pl.color1, pl.color2
       ${base} ORDER BY o.id DESC LIMIT ? OFFSET ?`,
      ...params,
      20,
      pg.offset,
    ),
  });
});

function managedOrder(req) {
  const order = orders.byCode(req.params.code);
  if (!order || !orders.canManage(req.user, order)) {
    const err = new Error('الطلب غير موجود أو ليس لديك صلاحية عليه');
    err.status = 404;
    err.expose = true;
    throw err;
  }
  return order;
}

function deliveryPreset(order) {
  const input = order.buyer_input || '';
  switch (order.delivery_method) {
    case 'upgrade':
      return [{ label: 'الحساب المفعّل', value: input }, { label: 'حالة التفعيل', value: 'تم تفعيل الاشتراك على حسابك ✅' }];
    case 'invite':
      return [{ label: 'تم إرسال الدعوة إلى', value: input }, { label: 'طريقة القبول', value: 'افتح بريدك الإلكتروني واضغط على زر قبول الدعوة' }];
    case 'code':
      return [{ label: 'كود التفعيل', value: '' }, { label: 'رابط الاسترداد', value: '' }];
    case 'link':
      return [{ label: 'رابط التفعيل', value: '' }];
    default:
      return [{ label: 'البريد الإلكتروني', value: '' }, { label: 'كلمة المرور', value: '', secret: true }];
  }
}

router.get('/orders/:code', (req, res) => {
  const order = managedOrder(req);
  const delivery = orders.delivery(order);
  const link = `${siteUrl(req)}/account/orders/${order.code}`;
  const first = String(order.buyer_name || '').split(/\s+/)[0];
  const pay = orders.payLabel(order);
  const waTemplates = [
    { icon: 'fa-solid fa-hand', label: 'تأكيد استلام الطلب', text: `مرحباً ${first} 👋\nاستلمنا طلبك ${order.code} (${order.product_title} — ${order.plan_name}) ونراجع إيصال التحويل الآن، وسنبلغك فور التأكيد.` },
    { icon: 'fa-solid fa-image', label: 'طلب إيصال أوضح', text: `مرحباً ${first}،\nبخصوص طلبك ${order.code}: نحتاج صورة أوضح لإيصال التحويل بمبلغ ${pay} تُظهر المبلغ والتاريخ واسم المستفيد. يمكنك رفعها من صفحة الطلب:\n${link}` },
    { icon: 'fa-solid fa-gift', label: 'إبلاغ بالتسليم', text: `مرحباً ${first} 🎉\nتم تسليم اشتراك ${order.product_title} — ${order.plan_name}.\nبيانات الاشتراك متاحة في صفحة طلبك:\n${link}` },
    { icon: 'fa-solid fa-comment', label: 'رسالة عامة', text: `مرحباً ${first}،\nبخصوص طلبك ${order.code} في ${settings.get('store_name')}:\n` },
  ];
  res.render('seller/order', {
    active: 'seller-orders',
    pageTitle: `الطلب ${order.code}`,
    order,
    delivery,
    deliveryFields: delivery && delivery.fields && delivery.fields.length ? delivery.fields : deliveryPreset(order),
    defaultExpiry: order.expires_at ? isoDay(order.expires_at) : order.duration_days ? isoDay(new Date(Date.now() + order.duration_days * 86400000)) : '',
    events: orders.events(order.id, { includePrivate: true }),
    method: order.payment_method_id ? get('SELECT * FROM payment_methods WHERE id = ?', order.payment_method_id) : null,
    // Sellers only see the customer's history with their own products.
    customer: get(
      `SELECT COUNT(*) AS orders_count, COALESCE(SUM(CASE WHEN o.status IN ${orders.PAID_STATUSES} THEN ${orders.TOTAL_IN_BASE_SQL} ELSE 0 END), 0) AS spent
       FROM orders o WHERE o.user_id = ? ${isAdminUser(req.user) ? '' : 'AND o.seller_id = ?'}`,
      order.user_id,
      ...(isAdminUser(req.user) ? [] : [req.user.id]),
    ),
    customerScoped: !isAdminUser(req.user),
    canReview: canReviewPayment(req.user),
    waTemplates,
    rejectReasons: ['المبلغ المحوَّل غير مطابق للمبلغ المطلوب', 'صورة الإيصال غير واضحة', 'لم يصل التحويل إلى الحساب بعد', 'بيانات المحوِّل لا تطابق الإيصال', 'الإيصال مستخدم في طلب سابق'],
  });
});

const PAYMENT_REVIEW_DENIED = { ok: false, status: 403, message: 'تأكيد الدفع أو رفضه من صلاحيات إدارة المتجر' };

router.post('/orders/:code/approve', (req, res) => {
  const order = managedOrder(req);
  if (!canReviewPayment(req.user)) return res.reply(PAYMENT_REVIEW_DENIED);
  orders.approve(order, req.user);
  res.reply({ ok: true, message: `تم تأكيد الدفع للطلب ${order.code} وإبلاغ العميل`, reload: true });
});

router.post('/orders/:code/reject', (req, res) => {
  const order = managedOrder(req);
  if (!canReviewPayment(req.user)) return res.reply(PAYMENT_REVIEW_DENIED);
  const reason = cleanText(req.body.reason, 400);
  if (reason.length < 5) return res.reply({ ok: false, errors: { reason: 'اكتب سبب الرفض ليظهر للعميل' } });
  orders.reject(order, req.user, reason);
  res.reply({ ok: true, message: 'تم رفض الإيصال وإبلاغ العميل بالسبب', reload: true });
});

router.post('/orders/:code/deliver', (req, res) => {
  const order = managedOrder(req);
  // Delivering an order still under review also confirms its payment.
  if (order.status === 'under_review' && !canReviewPayment(req.user)) return res.reply(PAYMENT_REVIEW_DENIED);
  const raw = Array.isArray(req.body.fields) ? req.body.fields : req.body.fields && typeof req.body.fields === 'object' ? Object.values(req.body.fields) : [];
  const fields = raw
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({ label: clean(f.label, 60), value: cleanText(f.value, 1000), secret: bool(f.secret) }))
    .filter((f) => f.label && f.value)
    .slice(0, 20);
  const note = cleanText(req.body.note, 2000);
  if (!fields.length && !note) {
    return res.reply({ ok: false, message: 'أضف بيانات الاشتراك (حقل واحد على الأقل) أو تعليمات التسليم' });
  }
  let expiresAt = null;
  const expiresInput = clean(req.body.expires_at, 20);
  if (expiresInput) {
    const d = zonedLocalToUtc(expiresInput.slice(0, 10) + 'T23:59');
    if (!d) return res.reply({ ok: false, errors: { expires_at: 'تاريخ انتهاء غير صالح' } });
    expiresAt = toSql(d);
  }
  const wasUnderReview = order.status === 'under_review';
  orders.deliver(order, req.user, { fields, note, expiresAt });
  res.reply({
    ok: true,
    message: wasUnderReview ? 'تم تأكيد الدفع وتسليم الاشتراك للعميل 🎉' : order.delivered_at ? 'تم تحديث بيانات الاشتراك وإبلاغ العميل' : 'تم تسليم الاشتراك للعميل 🎉',
    reload: true,
  });
});

router.post('/orders/:code/complete', (req, res) => {
  const order = managedOrder(req);
  orders.complete(order, req.user);
  res.reply({ ok: true, message: 'تم تعليم الطلب كمكتمل', reload: true });
});

router.post('/orders/:code/cancel', (req, res) => {
  const order = managedOrder(req);
  const reason = cleanText(req.body.reason, 400);
  if (reason.length < 3) return res.reply({ ok: false, errors: { reason: 'اكتب سبب الإلغاء ليظهر للعميل' } });
  orders.cancel(order, req.user, reason);
  res.reply({ ok: true, message: 'تم إلغاء الطلب وإبلاغ العميل', reload: true });
});

router.post('/orders/:code/note', (req, res) => {
  const order = managedOrder(req);
  const text = cleanText(req.body.note, 1000);
  if (text.length < 2) return res.reply({ ok: false, errors: { note: 'اكتب الملاحظة' } });
  orders.addNote(order, req.user, text);
  res.reply({ ok: true, message: 'تمت إضافة الملاحظة', reload: true });
});

/* =====================================================================
   Products
   ===================================================================== */
router.get('/products', (req, res) => {
  const scope = productScope(req.user);
  const q = clean(req.query.q, 80);
  const status = ['active', 'inactive'].includes(req.query.status) ? req.query.status : '';
  const categoryId = int(req.query.category, { fallback: null });
  const where = [scope.sql];
  const params = [...scope.params];
  if (q) {
    where.push('(p.title LIKE ? OR pl.name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (status) where.push(status === 'active' ? 'p.is_active = 1' : 'p.is_active = 0');
  if (categoryId) {
    where.push('p.category_id = ?');
    params.push(categoryId);
  }
  const fromSql = `FROM products p LEFT JOIN platforms pl ON pl.id = p.platform_id LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN users s ON s.id = p.seller_id WHERE ${where.join(' AND ')}`;
  const total = get(`SELECT COUNT(*) AS n ${fromSql}`, ...params).n;
  const pg = paginate(total, req.query.page, 25);
  const rows = all(
    `SELECT p.*, pl.name AS platform_name, pl.logo_url AS platform_logo, pl.color1, pl.color2, c.name AS category_name,
            s.name AS seller_name, s.store_name AS seller_store,
            (SELECT COUNT(*) FROM orders o WHERE o.product_id = p.id AND o.status = 'under_review') AS pending_orders
     ${fromSql} ORDER BY p.id DESC LIMIT ? OFFSET ?`,
    ...params,
    25,
    pg.offset,
  );
  res.render('seller/products', {
    active: 'seller-products',
    pageTitle: 'المنتجات',
    items: catalog.decorate(rows, { activeOnly: false }),
    pg,
    q,
    status,
    categoryId,
    categories: all('SELECT id, name FROM categories ORDER BY sort_order, id'),
  });
});

function productFormData(req, product) {
  const platforms = all('SELECT pl.id, pl.name, pl.category_id, c.name AS category_name FROM platforms pl LEFT JOIN categories c ON c.id = pl.category_id ORDER BY c.sort_order, pl.sort_order, pl.name');
  return {
    active: 'seller-products',
    pageTitle: product ? `تعديل: ${product.title}` : 'إضافة منتج جديد',
    product,
    plans: product ? all('SELECT * FROM product_plans WHERE product_id = ? ORDER BY sort_order, id', product.id) : [],
    platforms,
    categories: all('SELECT id, name FROM categories ORDER BY sort_order, id'),
    sellers: isAdminUser(req.user) ? all("SELECT id, name, store_name, role FROM users WHERE role IN ('seller', 'admin') ORDER BY role DESC, name") : [],
    offerLocal: product && product.offer_ends_at ? zonedLocal(product.offer_ends_at) : '',
    baseCurrency: money.base(),
    deliveryMethods: DELIVERY_METHODS,
  };
}

function ownProduct(req) {
  const product = get('SELECT * FROM products WHERE id = ?', int(req.params.id, { fallback: 0 }));
  if (!product || (!isAdminUser(req.user) && product.seller_id !== req.user.id)) {
    const err = new Error('المنتج غير موجود أو ليس لديك صلاحية عليه');
    err.status = 404;
    err.expose = true;
    throw err;
  }
  return product;
}

router.get('/products/new', (req, res) => res.render('seller/product-form', productFormData(req, null)));
router.get('/products/:id/edit', (req, res) => res.render('seller/product-form', productFormData(req, ownProduct(req))));

function uniqueSlug(base, excludeId) {
  let slug = slugify(base) || 'product';
  let n = 1;
  const candidate = () => (n === 1 ? slug : `${slug}-${n}`);
  while (get('SELECT id FROM products WHERE slug = ? AND id <> ?', candidate(), excludeId || 0)) n++;
  return candidate();
}

function parsePlans(body) {
  const raw = Array.isArray(body.plans) ? body.plans : Object.values(body.plans || {});
  const errors = [];
  const plans = raw
    .filter(Boolean)
    .map((p, i) => {
      const price = money.parseMajorToMinor(str(p.price));
      const old = str(p.old_price).trim() === '' ? null : money.parseMajorToMinor(str(p.old_price));
      const stockRaw = str(p.stock).trim();
      const plan = {
        id: int(p.id, { fallback: null }),
        name: clean(p.name, 60),
        duration_days: str(p.duration_days).trim() === '' ? null : int(p.duration_days, { min: 1, max: 3650, fallback: null }),
        price,
        old_price: old,
        stock: stockRaw === '' ? null : int(stockRaw, { min: 0, max: 1000000, fallback: null }),
        is_active: bool(p.is_active) ? 1 : 0,
        sort_order: i + 1,
      };
      if (!plan.name) errors.push(`اسم الباقة رقم ${i + 1} مطلوب`);
      if (price === null || Number.isNaN(price)) errors.push(`سعر الباقة «${plan.name || i + 1}» غير صالح`);
      if (Number.isNaN(old)) errors.push(`السعر قبل الخصم للباقة «${plan.name || i + 1}» غير صالح`);
      if (old !== null && !Number.isNaN(old) && price !== null && old <= price) plan.old_price = null;
      return plan;
    });
  if (!plans.length) errors.push('أضف باقة واحدة على الأقل');
  return { plans, errors };
}

function saveProduct(req, res, existing) {
  const b = req.body;
  const errors = {};
  const title = clean(b.title, 120);
  if (title.length < 3) errors.title = 'اسم المنتج مطلوب (3 أحرف على الأقل)';
  const category = get('SELECT id FROM categories WHERE id = ?', int(b.category_id, { fallback: 0 }));
  if (!category) errors.category_id = 'اختر القسم';
  const platformId = int(b.platform_id, { fallback: null });
  const platform = platformId ? get('SELECT id FROM platforms WHERE id = ?', platformId) : null;
  const deliveryMethod = pick(DELIVERY_METHODS, b.delivery_method) || 'account';
  let offerEndsAt = null;
  if (clean(b.offer_ends_at, 20)) {
    const d = zonedLocalToUtc(b.offer_ends_at);
    if (!d) errors.offer_ends_at = 'تاريخ انتهاء العرض غير صالح';
    else offerEndsAt = toSql(d);
  }
  const { plans, errors: planErrors } = parsePlans(b);
  if (planErrors.length) errors.plans = planErrors[0];
  if (Object.keys(errors).length) {
    discard(req.file);
    return res.reply({ ok: false, errors, message: Object.values(errors)[0] });
  }

  let sellerId = existing ? existing.seller_id : req.user.id;
  if (isAdminUser(req.user) && b.seller_id) {
    const s = get("SELECT id FROM users WHERE id = ? AND role IN ('seller', 'admin')", int(b.seller_id, { fallback: 0 }));
    if (s) sellerId = s.id;
  }
  let coverUrl = existing ? existing.cover_url : null;
  const oldCover = coverUrl;
  if (req.file) coverUrl = publicUrl('products', req.file.filename);
  else if (bool(b.remove_cover)) coverUrl = null;

  const values = {
    seller_id: sellerId,
    category_id: category.id,
    platform_id: platform ? platform.id : null,
    title,
    slug: uniqueSlug(clean(b.slug, 80) || title, existing && existing.id),
    short_description: clean(b.short_description, 300) || null,
    description: cleanText(b.description, 6000) || null,
    features: JSON.stringify(lines(b.features)),
    activation_steps: JSON.stringify(lines(b.activation_steps)),
    cover_url: coverUrl,
    badge: clean(b.badge, 30) || null,
    delivery_method: deliveryMethod,
    delivery_time: clean(b.delivery_time, 40) || null,
    warranty: clean(b.warranty, 80) || null,
    region_note: clean(b.region_note, 80) || null,
    buyer_input_label: clean(b.buyer_input_label, 100) || null,
    buyer_input_placeholder: clean(b.buyer_input_placeholder, 100) || null,
    offer_ends_at: offerEndsAt,
    is_active: bool(b.is_active) ? 1 : 0,
    is_featured: bool(b.is_featured) ? 1 : 0,
  };

  const id = tx(() => {
    let productId;
    if (existing) {
      run(
        `UPDATE products SET seller_id = $seller_id, category_id = $category_id, platform_id = $platform_id, title = $title, slug = $slug,
           short_description = $short_description, description = $description, features = $features, activation_steps = $activation_steps,
           cover_url = $cover_url, badge = $badge, delivery_method = $delivery_method, delivery_time = $delivery_time, warranty = $warranty,
           region_note = $region_note, buyer_input_label = $buyer_input_label, buyer_input_placeholder = $buyer_input_placeholder,
           offer_ends_at = $offer_ends_at, is_active = $is_active, is_featured = $is_featured, updated_at = datetime('now')
         WHERE id = $id`,
        { ...values, id: existing.id },
      );
      productId = existing.id;
    } else {
      productId = Number(
        run(
          `INSERT INTO products (seller_id, category_id, platform_id, title, slug, short_description, description, features, activation_steps,
             cover_url, badge, delivery_method, delivery_time, warranty, region_note, buyer_input_label, buyer_input_placeholder, offer_ends_at,
             is_active, is_featured)
           VALUES ($seller_id, $category_id, $platform_id, $title, $slug, $short_description, $description, $features, $activation_steps,
             $cover_url, $badge, $delivery_method, $delivery_time, $warranty, $region_note, $buyer_input_label, $buyer_input_placeholder, $offer_ends_at,
             $is_active, $is_featured)`,
          values,
        ).lastInsertRowid,
      );
    }
    const keep = new Set();
    for (const p of plans) {
      const owned = p.id ? get('SELECT id FROM product_plans WHERE id = ? AND product_id = ?', p.id, productId) : null;
      if (owned) {
        run('UPDATE product_plans SET name = ?, duration_days = ?, price = ?, old_price = ?, stock = ?, is_active = ?, sort_order = ? WHERE id = ?', p.name, p.duration_days, p.price, p.old_price, p.stock, p.is_active, p.sort_order, owned.id);
        keep.add(owned.id);
      } else {
        keep.add(Number(run('INSERT INTO product_plans (product_id, name, duration_days, price, old_price, stock, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', productId, p.name, p.duration_days, p.price, p.old_price, p.stock, p.is_active, p.sort_order).lastInsertRowid));
      }
    }
    // Plans removed from the form: delete unless orders still reference them (then just hide).
    for (const { id: planId } of all('SELECT id FROM product_plans WHERE product_id = ?', productId)) {
      if (keep.has(planId)) continue;
      if (get('SELECT id FROM orders WHERE plan_id = ? LIMIT 1', planId)) run('UPDATE product_plans SET is_active = 0 WHERE id = ?', planId);
      else run('DELETE FROM product_plans WHERE id = ?', planId);
    }
    return productId;
  });
  if (req.file) req.file.kept = true;
  if (oldCover && oldCover !== coverUrl) removePublic(oldCover);
  res.reply({ ok: true, message: existing ? 'تم حفظ التعديلات بنجاح' : 'تمت إضافة المنتج بنجاح 🎉', redirect: `/seller/products/${id}/edit` });
}

router.post('/products', imageUpload('products', 'cover'), (req, res) => saveProduct(req, res, null));
router.post('/products/:id', imageUpload('products', 'cover'), (req, res) => {
  let existing;
  try {
    existing = ownProduct(req);
  } catch (err) {
    discard(req.file);
    throw err;
  }
  saveProduct(req, res, existing);
});

router.post('/products/:id/toggle', (req, res) => {
  const p = ownProduct(req);
  run("UPDATE products SET is_active = 1 - is_active, updated_at = datetime('now') WHERE id = ?", p.id);
  res.reply({ ok: true, message: p.is_active ? 'تم إخفاء المنتج من المتجر' : 'تم تفعيل المنتج وعرضه في المتجر', reload: true });
});

router.post('/products/:id/delete', (req, res) => {
  const p = ownProduct(req);
  if (get('SELECT id FROM orders WHERE product_id = ? LIMIT 1', p.id)) {
    run('UPDATE products SET is_active = 0 WHERE id = ?', p.id);
    return res.reply({ ok: true, message: 'المنتج مرتبط بطلبات سابقة، لذلك تم إخفاؤه بدلاً من حذفه', redirect: '/seller/products' });
  }
  run('DELETE FROM products WHERE id = ?', p.id);
  if (p.cover_url) removePublic(p.cover_url);
  res.reply({ ok: true, message: 'تم حذف المنتج', redirect: '/seller/products' });
});

module.exports = router;
