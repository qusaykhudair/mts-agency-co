'use strict';
const express = require('express');
const { get, all, run } = require('../db');
const catalog = require('../lib/catalog');
const money = require('../lib/money');
const content = require('../lib/content');
const settings = require('../lib/settings');
const orders = require('../lib/orders');
const { parseJson } = require('../lib/format');
const { receiptUpload, discard } = require('../lib/uploads');
const { str, safeNext, clean, cleanText, int, bool, pick, toLatinDigits } = require('../lib/util');
const { paginate, requireAuth } = require('../middleware');
const { limiter } = require('../lib/limits');

const router = express.Router();
const PER_PAGE = 24;
const MAX_OPEN_ORDERS = 5;

router.use((req, res, next) => {
  res.locals.nav = 'store';
  res.locals.navCategories = catalog.categoriesWithCounts();
  next();
});

function activeMethods() {
  return all('SELECT * FROM payment_methods WHERE is_active = 1 ORDER BY sort_order, id').map((m) => ({
    ...m,
    details: parseJson(m.details, []),
    steps: String(m.instructions || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    currency: money.byCode(m.currency_code) || money.base(),
  }));
}

/* ---------- Home ---------- */
router.get('/', (req, res) => {
  const platforms = catalog.platformsWithCounts({ featuredOnly: true }).slice(0, 16);
  const deals = catalog.listProducts({ sort: 'deals', onSale: true, limit: 10 }).items;
  const spotlight = catalog.pickSpotlight(deals);
  res.render('store/home', {
    active: 'home',
    platforms,
    newest: catalog.listProducts({ sort: 'newest', limit: 10 }).items,
    deals,
    popular: catalog.listProducts({ sort: 'popular', limit: 8 }).items,
    spotlight: spotlight.product,
    spotlightPlan: spotlight.plan,
    totals: { products: catalog.listProducts({ limit: 1 }).total, platforms: catalog.platformsWithCounts().filter((p) => p.product_count > 0).length },
    methods: activeMethods(),
    reviews: all(
      `SELECT r.*, p.title AS product_title, p.slug AS product_slug FROM reviews r JOIN products p ON p.id = r.product_id
       WHERE r.is_visible = 1 AND p.is_active = 1 AND r.comment IS NOT NULL AND r.comment <> '' ORDER BY r.id DESC LIMIT 6`,
    ),
    faq: content.STORE_FAQ,
    steps: content.HOW_TO_BUY,
    trust: content.TRUST,
  });
});

/* ---------- Catalogue ---------- */
function renderCatalog(req, res, { category = null, platform = null }) {
  const q = clean(req.query.q, 80);
  const onSale = req.query.sale === '1';
  const sort = pick(catalog.SORTS, req.query.sort) || (onSale ? 'deals' : 'popular');
  const page = int(req.query.page, { min: 1, fallback: 1 });
  const filters = {
    q,
    sort,
    onSale,
    category: category ? category.slug : clean(req.query.category, 60) || undefined,
    platform: platform ? platform.slug : undefined,
  };
  let result = catalog.listProducts({ ...filters, limit: PER_PAGE, offset: (page - 1) * PER_PAGE });
  const pg = paginate(result.total, page, PER_PAGE);
  if (pg.offset !== (page - 1) * PER_PAGE) result = catalog.listProducts({ ...filters, limit: PER_PAGE, offset: pg.offset });

  let head;
  let chips = [];
  if (platform) {
    head = {
      title: platform.name,
      desc: platform.description || `جميع اشتراكات ${platform.name} المتوفرة في المتجر بأفضل الأسعار وتسليم سريع.`,
      logo: platform.logo_url,
      c1: platform.color1,
      c2: platform.color2,
      crumbs: [platform.category_name && { label: platform.category_name, href: '/store/category/' + platform.category_slug }].filter(Boolean),
    };
    chips = catalog.platformsWithCounts({ categoryId: platform.category_id }).map((p) => ({ label: p.name, href: '/store/platform/' + p.slug, count: p.product_count, active: p.id === platform.id }));
  } else if (category) {
    head = { title: category.name, desc: category.description, icon: category.icon, crumbs: [] };
    chips = catalog.platformsWithCounts({ categoryId: category.id }).map((p) => ({ label: p.name, href: '/store/platform/' + p.slug, count: p.product_count }));
  } else {
    head = {
      title: q ? `نتائج البحث عن «${q}»` : onSale ? 'أفضل العروض والخصومات' : 'جميع الاشتراكات',
      desc: q ? 'المنتجات المطابقة لبحثك في المتجر.' : onSale ? 'اشتراكات عليها خصومات حقيقية لفترة محدودة.' : 'تصفّح كل الاشتراكات الرقمية المتوفرة واختر ما يناسبك.',
      icon: q ? 'fa-solid fa-magnifying-glass' : onSale ? 'fa-solid fa-fire' : 'fa-solid fa-grip',
      crumbs: [],
    };
    chips = res.locals.navCategories.map((c) => ({ label: c.name, href: '/store/category/' + c.slug, icon: c.icon, count: c.product_count }));
  }

  res.render('store/catalog', {
    active: platform ? '' : category ? 'cat-' + category.slug : onSale ? 'deals' : 'products',
    pageTitle: head.title,
    pageDesc: head.desc,
    head,
    chips,
    items: result.items,
    total: result.total,
    pg,
    sort,
    q,
    sortLabels: catalog.SORT_LABELS,
  });
}

router.get('/products', (req, res) => renderCatalog(req, res, {}));

router.get('/category/:slug', (req, res, next) => {
  const category = get('SELECT * FROM categories WHERE slug = ? AND is_active = 1', req.params.slug);
  if (!category) return next();
  renderCatalog(req, res, { category });
});

router.get('/platform/:slug', (req, res, next) => {
  const platform = get(
    `SELECT pl.*, c.name AS category_name, c.slug AS category_slug FROM platforms pl
     LEFT JOIN categories c ON c.id = pl.category_id WHERE pl.slug = ? AND pl.is_active = 1`,
    req.params.slug,
  );
  if (!platform) return next();
  renderCatalog(req, res, { platform });
});

router.get('/platforms', (req, res) => {
  const platforms = catalog.platformsWithCounts();
  const groups = res.locals.navCategories
    .map((c) => ({ ...c, platforms: platforms.filter((p) => p.category_id === c.id) }))
    .filter((g) => g.platforms.length);
  const orphans = platforms.filter((p) => !groups.some((g) => g.id === p.category_id));
  if (orphans.length) groups.push({ name: 'منصات أخرى', icon: 'fa-solid fa-shapes', platforms: orphans });
  res.render('store/platforms', { active: 'platforms', pageTitle: 'المنصات', groups, totalPlatforms: platforms.length });
});

/* ---------- Product ---------- */
router.get('/product/:slug', (req, res, next) => {
  const p = catalog.getProduct({ slug: req.params.slug });
  if (!p) return next();
  run('UPDATE products SET views = views + 1 WHERE id = ?', p.id);
  const seller = get('SELECT id, name, store_name, role, created_at FROM users WHERE id = ?', p.seller_id) || {};
  const sellerStats = get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status IN ('delivered', 'completed') THEN 1 ELSE 0 END) AS done
     FROM orders WHERE seller_id = ? AND status <> 'cancelled'`,
    p.seller_id,
  );
  const sellerRating = get(
    `SELECT ROUND(AVG(r.rating), 1) AS avg, COUNT(*) AS n FROM reviews r JOIN products pr ON pr.id = r.product_id
     WHERE pr.seller_id = ? AND r.is_visible = 1`,
    p.seller_id,
  );
  const selectedPlan = p.plans.find((pl) => String(pl.id) === str(req.query.plan) && pl.in_stock) || p.plans.find((pl) => pl.in_stock) || p.plans[0];
  res.render('store/product', {
    active: '',
    pageTitle: p.title,
    pageDesc: p.short_description,
    p,
    seller,
    sellerStats,
    sellerRating,
    selectedPlan,
    reviews: all('SELECT * FROM reviews WHERE product_id = ? AND is_visible = 1 ORDER BY id DESC LIMIT 20', p.id),
    summary: catalog.ratingSummary(p.id),
    similar: catalog.listProducts({ category: p.category_slug, excludeId: p.id, limit: 10 }).items,
    faq: content.productFaq(p, settings.getAll()),
    maxQty: int(settings.get('max_quantity'), { min: 1, max: 100, fallback: 10 }),
  });
});

/* ---------- Checkout ---------- */
function checkoutContext({ productSlug, productId, planId, qty }) {
  const product = str(productSlug) ? catalog.getProduct({ slug: str(productSlug) }) : catalog.getProduct({ id: int(productId, { fallback: 0 }) });
  if (!product) return { error: 'المنتج غير متوفر حالياً' };
  const plan = product.plans.find((pl) => String(pl.id) === str(planId));
  const back = '/store/product/' + product.slug;
  if (!plan) return { error: 'اختر باقة صحيحة لهذا المنتج', back };
  if (!plan.in_stock) return { error: 'هذه الباقة غير متوفرة حالياً', back };
  const maxQty = int(settings.get('max_quantity'), { min: 1, max: 100, fallback: 10 });
  const quantity = int(qty, { min: 1, max: maxQty, fallback: 1 });
  if (plan.stock !== null && plan.stock !== undefined && plan.stock < quantity) {
    return { error: `الكمية المتوفرة من هذه الباقة: ${plan.stock} فقط`, back };
  }
  return { product, plan, quantity, back, maxQty };
}

router.get('/checkout', requireAuth, (req, res) => {
  const ctx = checkoutContext({ productSlug: req.query.product, planId: req.query.plan, qty: req.query.qty });
  if (ctx.error) {
    req.flash('error', ctx.error);
    return res.redirect(ctx.back || '/store/products');
  }
  const total = ctx.plan.price * ctx.quantity;
  const methods = activeMethods().map((m) => ({ ...m, amount: money.convert(total, m.currency), amountText: money.format(total, m.currency) }));
  res.render('store/checkout', {
    ...ctx,
    active: '',
    pageTitle: 'إتمام الطلب',
    noindex: true,
    total,
    methods,
    checkoutNote: settings.get('checkout_note'),
  });
});

const checkoutLimiter = limiter(30, 60, 'عدد كبير من الطلبات خلال وقت قصير، حاول مرة أخرى بعد قليل');

router.post('/checkout', requireAuth, checkoutLimiter, receiptUpload('receipt'), (req, res) => {
  const fail = (errors, message) => {
    discard(req.file);
    return res.reply({ ok: false, errors, message: message || Object.values(errors || {})[0] || 'تحقق من البيانات المدخلة' });
  };
  const ctx = checkoutContext({ productId: req.body.product_id, planId: req.body.plan_id, qty: req.body.quantity });
  if (ctx.error) return fail(null, ctx.error);
  const { product, plan, quantity } = ctx;

  // Unpaid orders reserve stock, so one account may only keep a few of them open at a time.
  const open = get("SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND status IN ('under_review', 'payment_rejected')", req.user.id).n;
  if (open >= MAX_OPEN_ORDERS) {
    return fail(null, `لديك ${open} طلبات بانتظار مراجعة الدفع. انتظر تأكيدها أو أعد إرسال الإيصالات المرفوضة قبل طلب جديد.`);
  }

  const errors = {};
  const method = get('SELECT * FROM payment_methods WHERE id = ? AND is_active = 1', int(req.body.payment_method_id, { fallback: 0 }));
  if (!method) errors.payment_method_id = 'اختر طريقة الدفع التي حوّلت من خلالها';
  const senderName = clean(req.body.sender_name, 100);
  if (senderName.length < 3) errors.sender_name = 'اكتب اسم صاحب الحساب الذي تم التحويل منه';
  const senderAccount = toLatinDigits(clean(req.body.sender_account, 60));
  if (senderAccount.replace(/\s/g, '').length < 4) errors.sender_account = 'اكتب رقم الحساب أو المحفظة الذي حوّلت منه';
  let buyerInput = null;
  if (product.buyer_input_label) {
    buyerInput = clean(req.body.buyer_input, 200);
    if (buyerInput.length < 3) errors.buyer_input = `هذا الحقل مطلوب: ${product.buyer_input_label}`;
  }
  const buyerNote = cleanText(req.body.buyer_note, 500) || null;
  if (!bool(req.body.agree)) errors.agree = 'يجب الموافقة على الشروط وتأكيد صحة بيانات التحويل';
  if (!req.file) errors.receipt = 'أرفق صورة إيصال التحويل';
  if (Object.keys(errors).length) return fail(errors);

  const order = orders.create({
    user: req.user,
    product,
    plan,
    quantity,
    method,
    senderName,
    senderAccount,
    buyerInput,
    buyerNote,
    receipt: req.file,
  });
  req.file.kept = true;
  res.reply({ ok: true, message: `تم إرسال طلبك ${order.code} بنجاح 🎉`, redirect: `/account/orders/${order.code}?placed=1` });
});

/* ---------- Misc ---------- */
router.get('/currency/:code', (req, res) => {
  const c = money.byCode(String(req.params.code || '').toUpperCase());
  if (c && c.is_active) res.cookie('mts_cur', c.code, { maxAge: 365 * 86400000, sameSite: 'lax', path: '/' });
  res.redirect(safeNext(req.query.next, '/store'));
});

router.get('/help', (req, res) => {
  res.render('store/help', { active: 'help', pageTitle: 'كيف أشتري؟', steps: content.HOW_TO_BUY, faq: content.STORE_FAQ, methods: activeMethods() });
});

router.get('/terms', (req, res) => res.render('store/terms', { active: '', pageTitle: 'الشروط والأحكام' }));
router.get('/privacy', (req, res) => res.render('store/privacy', { active: '', pageTitle: 'سياسة الخصوصية' }));

module.exports = router;
