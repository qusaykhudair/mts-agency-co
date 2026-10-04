'use strict';
const express = require('express');
const { get, all, run, tx } = require('../db');
const money = require('../lib/money');
const settings = require('../lib/settings');
const orders = require('../lib/orders');
const { notify } = require('../lib/notify');
const { hashPassword, endAllSessions } = require('../lib/auth');
const { fromInternational } = require('../lib/phone');
const { slugify, parseJson } = require('../lib/format');
const { imageUpload, publicUrl, removePublic, discard } = require('../lib/uploads');
const { str, clean, cleanText, lines, int, bool, color, icon, isEmail } = require('../lib/util');
const { paginate, requireAdmin } = require('../middleware');

const router = express.Router();

router.use(requireAdmin, (req, res, next) => {
  res.locals.nav = 'seller';
  res.locals.noindex = true;
  next();
});

const notFound = (what) => {
  const err = new Error(`${what} غير موجود`);
  err.status = 404;
  err.expose = true;
  return err;
};

function uniqueSlug(table, base, excludeId) {
  const root = slugify(base) || 'item';
  let n = 1;
  const candidate = () => (n === 1 ? root : `${root}-${n}`);
  while (get(`SELECT id FROM ${table} WHERE slug = ? AND id <> ?`, candidate(), excludeId || 0)) n++;
  return candidate();
}

const PM_ICONS = [
  ['fa-solid fa-building-columns', 'بنك'],
  ['fa-solid fa-mobile-screen-button', 'جوال'],
  ['fa-solid fa-wallet', 'محفظة'],
  ['fa-solid fa-money-bill-transfer', 'تحويل نقدي'],
  ['fa-solid fa-credit-card', 'بطاقة'],
  ['fa-solid fa-money-check-dollar', 'شيك/حوالة'],
  ['fa-solid fa-coins', 'عملات'],
  ['fa-brands fa-paypal', 'PayPal'],
];

/* =====================================================================
   Platforms
   ===================================================================== */
router.get('/platforms', (req, res) => {
  res.render('seller/platforms', {
    active: 'admin-platforms',
    pageTitle: 'المنصات',
    items: all(
      `SELECT pl.*, c.name AS category_name, (SELECT COUNT(*) FROM products p WHERE p.platform_id = pl.id) AS product_count
       FROM platforms pl LEFT JOIN categories c ON c.id = pl.category_id ORDER BY pl.sort_order, pl.name`,
    ),
  });
});

const platformForm = (platform) => ({
  active: 'admin-platforms',
  pageTitle: platform ? `تعديل منصة: ${platform.name}` : 'إضافة منصة',
  platform,
  categories: all('SELECT id, name FROM categories ORDER BY sort_order, id'),
});

router.get('/platforms/new', (req, res) => res.render('seller/platform-form', platformForm(null)));
router.get('/platforms/:id/edit', (req, res) => {
  const platform = get('SELECT * FROM platforms WHERE id = ?', int(req.params.id, { fallback: 0 }));
  if (!platform) throw notFound('المنصة');
  res.render('seller/platform-form', platformForm(platform));
});

function savePlatform(req, res, existing) {
  const b = req.body;
  const name = clean(b.name, 60);
  if (name.length < 2) {
    discard(req.file);
    return res.reply({ ok: false, errors: { name: 'اسم المنصة مطلوب' } });
  }
  const categoryId = get('SELECT id FROM categories WHERE id = ?', int(b.category_id, { fallback: 0 }));
  let logo = existing ? existing.logo_url : null;
  const oldLogo = logo;
  if (req.file) logo = publicUrl('platforms', req.file.filename);
  else if (bool(b.remove_logo)) logo = null;
  const v = [
    name,
    uniqueSlug('platforms', clean(b.slug, 60) || name, existing && existing.id),
    categoryId ? categoryId.id : null,
    logo,
    color(b.color1, '#3e7bff'),
    color(b.color2, '#1b3fbf'),
    cleanText(b.description, 600) || null,
    bool(b.is_featured) ? 1 : 0,
    int(b.sort_order, { min: 0, max: 9999, fallback: 0 }),
    bool(b.is_active) ? 1 : 0,
  ];
  if (existing) {
    run('UPDATE platforms SET name = ?, slug = ?, category_id = ?, logo_url = ?, color1 = ?, color2 = ?, description = ?, is_featured = ?, sort_order = ?, is_active = ? WHERE id = ?', ...v, existing.id);
  } else {
    run('INSERT INTO platforms (name, slug, category_id, logo_url, color1, color2, description, is_featured, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...v);
  }
  if (req.file) req.file.kept = true;
  if (oldLogo && oldLogo !== logo) removePublic(oldLogo);
  res.reply({ ok: true, message: existing ? 'تم حفظ المنصة' : 'تمت إضافة المنصة', redirect: '/seller/platforms' });
}

router.post('/platforms', imageUpload('platforms', 'logo'), (req, res) => savePlatform(req, res, null));
router.post('/platforms/:id', imageUpload('platforms', 'logo'), (req, res) => {
  const existing = get('SELECT * FROM platforms WHERE id = ?', int(req.params.id, { fallback: 0 }));
  if (!existing) {
    discard(req.file);
    throw notFound('المنصة');
  }
  savePlatform(req, res, existing);
});

router.post('/platforms/:id/delete', (req, res) => {
  const p = get('SELECT * FROM platforms WHERE id = ?', int(req.params.id, { fallback: 0 }));
  if (!p) throw notFound('المنصة');
  if (get('SELECT id FROM products WHERE platform_id = ? LIMIT 1', p.id)) {
    return res.reply({ ok: false, message: 'لا يمكن حذف منصة مرتبطة بمنتجات. انقل المنتجات أو أخفِ المنصة بدلاً من ذلك.' });
  }
  run('DELETE FROM platforms WHERE id = ?', p.id);
  if (p.logo_url) removePublic(p.logo_url);
  res.reply({ ok: true, message: 'تم حذف المنصة', reload: true });
});

/* =====================================================================
   Categories
   ===================================================================== */
router.get('/categories', (req, res) => {
  const editing = req.query.edit ? get('SELECT * FROM categories WHERE id = ?', int(req.query.edit, { fallback: 0 })) : null;
  res.render('seller/categories', {
    active: 'admin-categories',
    pageTitle: 'الأقسام',
    editing,
    items: all(
      `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count,
              (SELECT COUNT(*) FROM platforms pl WHERE pl.category_id = c.id) AS platform_count
       FROM categories c ORDER BY c.sort_order, c.id`,
    ),
  });
});

router.post('/categories', (req, res) => {
  const b = req.body;
  const id = int(b.id, { fallback: null });
  const existing = id ? get('SELECT * FROM categories WHERE id = ?', id) : null;
  const name = clean(b.name, 60);
  if (name.length < 2) return res.reply({ ok: false, errors: { name: 'اسم القسم مطلوب' } });
  const v = [name, uniqueSlug('categories', clean(b.slug, 60) || name, existing && existing.id), icon(b.icon, 'fa-solid fa-layer-group'), cleanText(b.description, 400) || null, int(b.sort_order, { min: 0, max: 9999, fallback: 0 }), bool(b.is_active) ? 1 : 0];
  if (existing) run('UPDATE categories SET name = ?, slug = ?, icon = ?, description = ?, sort_order = ?, is_active = ? WHERE id = ?', ...v, existing.id);
  else run('INSERT INTO categories (name, slug, icon, description, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?)', ...v);
  res.reply({ ok: true, message: existing ? 'تم حفظ القسم' : 'تمت إضافة القسم', redirect: '/seller/categories' });
});

router.post('/categories/:id/delete', (req, res) => {
  const c = get('SELECT * FROM categories WHERE id = ?', int(req.params.id, { fallback: 0 }));
  if (!c) throw notFound('القسم');
  if (get('SELECT id FROM products WHERE category_id = ? LIMIT 1', c.id)) {
    return res.reply({ ok: false, message: 'لا يمكن حذف قسم يحتوي على منتجات. انقلها لقسم آخر أو أخفِ القسم.' });
  }
  run('UPDATE platforms SET category_id = NULL WHERE category_id = ?', c.id);
  run('DELETE FROM categories WHERE id = ?', c.id);
  res.reply({ ok: true, message: 'تم حذف القسم', reload: true });
});

/* =====================================================================
   Payment methods
   ===================================================================== */
router.get('/payment-methods', (req, res) => {
  res.render('seller/payment-methods', {
    active: 'admin-payments',
    pageTitle: 'طرق الدفع',
    items: all(
      `SELECT pm.*, (SELECT COUNT(*) FROM orders o WHERE o.payment_method_id = pm.id) AS orders_count
       FROM payment_methods pm ORDER BY pm.sort_order, pm.id`,
    ).map((m) => ({ ...m, details: parseJson(m.details, []), currency: money.byCode(m.currency_code) })),
  });
});

const methodForm = (method) => ({
  active: 'admin-payments',
  pageTitle: method ? `تعديل: ${method.name}` : 'إضافة طريقة دفع',
  method: method ? { ...method, details: parseJson(method.details, []) } : null,
  currencies: money.list({ activeOnly: false }),
  icons: PM_ICONS,
});

router.get('/payment-methods/new', (req, res) => res.render('seller/payment-method-form', methodForm(null)));
router.get('/payment-methods/:id/edit', (req, res) => {
  const m = get('SELECT * FROM payment_methods WHERE id = ?', int(req.params.id, { fallback: 0 }));
  if (!m) throw notFound('طريقة الدفع');
  res.render('seller/payment-method-form', methodForm(m));
});

function saveMethod(req, res, existing) {
  const b = req.body;
  const errors = {};
  const name = clean(b.name, 60);
  if (name.length < 2) errors.name = 'اسم طريقة الدفع مطلوب';
  const currency = money.byCode(clean(b.currency_code, 8).toUpperCase());
  if (!currency) errors.currency_code = 'اختر العملة';
  const raw = Array.isArray(b.details) ? b.details : Object.values(b.details || {});
  const details = raw
    .filter(Boolean)
    .map((d) => ({ label: clean(d.label, 60), value: clean(d.value, 200), copy: bool(d.copy) }))
    .filter((d) => d.label && d.value)
    .slice(0, 12);
  if (!details.length) errors.details = 'أضف تفاصيل الحساب (رقم الحساب/المحفظة واسم المستفيد)';
  if (Object.keys(errors).length) {
    discard(req.file);
    return res.reply({ ok: false, errors, message: Object.values(errors)[0] });
  }
  let logo = existing ? existing.logo_url : null;
  const oldLogo = logo;
  if (req.file) logo = publicUrl('payments', req.file.filename);
  else if (bool(b.remove_logo)) logo = null;
  const v = [
    name,
    clean(b.subtitle, 100) || null,
    b.type === 'wallet' ? 'wallet' : 'bank',
    icon(b.icon, 'fa-solid fa-building-columns'),
    color(b.color, '#2457e8'),
    logo,
    currency.code,
    JSON.stringify(details),
    lines(b.instructions, 12).join('\n') || null,
    clean(b.sender_account_label, 80) || 'رقم الحساب المحوَّل منه',
    bool(b.is_active) ? 1 : 0,
    int(b.sort_order, { min: 0, max: 999, fallback: 0 }),
  ];
  if (existing) {
    run(
      `UPDATE payment_methods SET name = ?, subtitle = ?, type = ?, icon = ?, color = ?, logo_url = ?, currency_code = ?, details = ?,
         instructions = ?, sender_account_label = ?, is_active = ?, sort_order = ? WHERE id = ?`,
      ...v,
      existing.id,
    );
  } else {
    run(
      `INSERT INTO payment_methods (name, subtitle, type, icon, color, logo_url, currency_code, details, instructions, sender_account_label, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...v,
    );
  }
  if (req.file) req.file.kept = true;
  if (oldLogo && oldLogo !== logo) removePublic(oldLogo);
  res.reply({ ok: true, message: existing ? 'تم حفظ طريقة الدفع' : 'تمت إضافة طريقة الدفع', redirect: '/seller/payment-methods' });
}

router.post('/payment-methods', imageUpload('payments', 'logo'), (req, res) => saveMethod(req, res, null));
router.post('/payment-methods/:id', imageUpload('payments', 'logo'), (req, res) => {
  const existing = get('SELECT * FROM payment_methods WHERE id = ?', int(req.params.id, { fallback: 0 }));
  if (!existing) {
    discard(req.file);
    throw notFound('طريقة الدفع');
  }
  saveMethod(req, res, existing);
});

router.post('/payment-methods/:id/toggle', (req, res) => {
  const m = get('SELECT * FROM payment_methods WHERE id = ?', int(req.params.id, { fallback: 0 }));
  if (!m) throw notFound('طريقة الدفع');
  run('UPDATE payment_methods SET is_active = 1 - is_active WHERE id = ?', m.id);
  res.reply({ ok: true, message: m.is_active ? 'تم إيقاف طريقة الدفع' : 'تم تفعيل طريقة الدفع', reload: true });
});

router.post('/payment-methods/:id/delete', (req, res) => {
  const m = get('SELECT * FROM payment_methods WHERE id = ?', int(req.params.id, { fallback: 0 }));
  if (!m) throw notFound('طريقة الدفع');
  if (get('SELECT id FROM orders WHERE payment_method_id = ? LIMIT 1', m.id)) {
    run('UPDATE payment_methods SET is_active = 0 WHERE id = ?', m.id);
    return res.reply({ ok: true, message: 'طريقة الدفع مستخدمة في طلبات سابقة، لذلك تم إيقافها بدلاً من حذفها', reload: true });
  }
  run('DELETE FROM payment_methods WHERE id = ?', m.id);
  if (m.logo_url) removePublic(m.logo_url);
  res.reply({ ok: true, message: 'تم حذف طريقة الدفع', reload: true });
});

/* =====================================================================
   Currencies
   ===================================================================== */
router.get('/currencies', (req, res) => {
  res.render('seller/currencies', {
    active: 'admin-currencies',
    pageTitle: 'العملات وأسعار الصرف',
    items: all(
      `SELECT c.*, (SELECT COUNT(*) FROM payment_methods pm WHERE pm.currency_code = c.code) AS methods_count
       FROM currencies c ORDER BY c.is_base DESC, c.sort_order, c.code`,
    ),
    defaultCurrency: settings.get('default_currency'),
  });
});

router.post('/currencies', (req, res) => {
  const rows = Array.isArray(req.body.c) ? req.body.c : Object.values(req.body.c || {});
  const errors = [];
  tx(() => {
    for (const r of rows.filter(Boolean)) {
      const cur = money.byCode(clean(r.code, 8));
      if (!cur) continue;
      const rate = Number(str(r.rate).replace(',', '.'));
      if (!cur.is_base && !(rate > 0)) {
        errors.push(`سعر صرف ${cur.code} غير صالح`);
        continue;
      }
      run(
        'UPDATE currencies SET name = ?, symbol = ?, rate = ?, decimals = ?, is_active = ?, sort_order = ? WHERE code = ?',
        clean(r.name, 40) || cur.name,
        clean(r.symbol, 8) || cur.symbol,
        cur.is_base ? 1 : rate,
        int(r.decimals, { min: 0, max: 2, fallback: Math.min(2, cur.decimals) }),
        cur.is_base ? 1 : bool(r.is_active) ? 1 : 0,
        int(r.sort_order, { min: 0, max: 99, fallback: cur.sort_order }),
        cur.code,
      );
    }
  });
  money.load();
  const def = clean(req.body.default_currency, 8).toUpperCase();
  settings.set({ default_currency: def && money.byCode(def) ? def : '' });
  res.reply({ ok: !errors.length, message: errors.length ? errors[0] : 'تم حفظ أسعار الصرف', reload: !errors.length });
});

router.post('/currencies/add', (req, res) => {
  const code = clean(req.body.code, 3).toUpperCase();
  const rate = Number(str(req.body.rate).replace(',', '.'));
  const errors = {};
  if (!/^[A-Z]{3}$/.test(code)) errors.code = 'رمز العملة 3 أحرف لاتينية مثل JOD';
  else if (money.byCode(code)) errors.code = 'العملة موجودة مسبقاً';
  if (!clean(req.body.name, 40)) errors.name = 'اسم العملة مطلوب';
  if (!clean(req.body.symbol, 8)) errors.symbol = 'رمز العرض مطلوب';
  if (!(rate > 0)) errors.rate = 'سعر الصرف غير صالح';
  if (Object.keys(errors).length) return res.reply({ ok: false, errors });
  run(
    'INSERT INTO currencies (code, name, symbol, rate, decimals, is_base, is_active, sort_order) VALUES (?, ?, ?, ?, ?, 0, 1, 50)',
    code,
    clean(req.body.name, 40),
    clean(req.body.symbol, 8),
    rate,
    int(req.body.decimals, { min: 0, max: 2, fallback: 2 }),
  );
  money.load();
  res.reply({ ok: true, message: 'تمت إضافة العملة', reload: true });
});

router.post('/currencies/:code/delete', (req, res) => {
  const cur = money.byCode(String(req.params.code || '').toUpperCase());
  if (!cur) throw notFound('العملة');
  if (cur.is_base) return res.reply({ ok: false, message: 'لا يمكن حذف العملة الأساسية' });
  if (get('SELECT id FROM payment_methods WHERE currency_code = ? LIMIT 1', cur.code) || get('SELECT id FROM orders WHERE pay_currency = ? OR base_currency = ? LIMIT 1', cur.code, cur.code)) {
    run('UPDATE currencies SET is_active = 0 WHERE code = ?', cur.code);
    money.load();
    return res.reply({ ok: true, message: 'العملة مستخدمة في طرق دفع أو طلبات، لذلك تم إيقافها بدلاً من حذفها', reload: true });
  }
  run('DELETE FROM currencies WHERE code = ?', cur.code);
  money.load();
  res.reply({ ok: true, message: 'تم حذف العملة', reload: true });
});

// Re-price the whole catalogue in another currency and make it the base.
router.post('/currencies/:code/make-base', (req, res) => {
  const target = money.byCode(String(req.params.code || '').toUpperCase());
  if (!target) throw notFound('العملة');
  if (target.is_base) return res.reply({ ok: false, message: 'هذه هي العملة الأساسية بالفعل' });
  const r = target.rate;
  tx(() => {
    run('UPDATE product_plans SET price = CAST(ROUND(price * ?) AS INTEGER), old_price = CASE WHEN old_price IS NULL THEN NULL ELSE CAST(ROUND(old_price * ?) AS INTEGER) END', r, r);
    run('UPDATE currencies SET rate = rate / ?', r);
    run('UPDATE currencies SET is_base = CASE WHEN code = ? THEN 1 ELSE 0 END, rate = CASE WHEN code = ? THEN 1 ELSE rate END, is_active = CASE WHEN code = ? THEN 1 ELSE is_active END', target.code, target.code, target.code);
  });
  money.load();
  res.reply({ ok: true, message: `أصبحت ${target.name} العملة الأساسية وتم تحويل جميع الأسعار إليها`, reload: true });
});

/* =====================================================================
   Users
   ===================================================================== */
router.get('/users', (req, res) => {
  const q = clean(req.query.q, 80);
  const role = ['buyer', 'seller', 'admin'].includes(req.query.role) ? req.query.role : '';
  const where = ['1 = 1'];
  const params = [];
  if (q) {
    where.push('(u.name LIKE ? OR u.email LIKE ? OR u.wa_e164 LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q.replace(/^\+?0*/, '')}%`);
  }
  if (role) {
    where.push('u.role = ?');
    params.push(role);
  }
  const total = get(`SELECT COUNT(*) AS n FROM users u WHERE ${where.join(' AND ')}`, ...params).n;
  const pg = paginate(total, req.query.page, 25);
  const roleCounts = Object.fromEntries(all('SELECT role, COUNT(*) AS n FROM users GROUP BY role').map((r) => [r.role, r.n]));
  res.render('seller/users', {
    active: 'admin-users',
    pageTitle: 'العملاء والمستخدمون',
    q,
    role,
    pg,
    roleCounts,
    items: all(
      `SELECT u.*, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders_count,
              (SELECT COALESCE(SUM(${orders.TOTAL_IN_BASE_SQL}), 0) FROM orders o WHERE o.user_id = u.id AND o.status IN ${orders.PAID_STATUSES}) AS spent
       FROM users u WHERE ${where.join(' AND ')} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
      ...params,
      25,
      pg.offset,
    ),
  });
});

function loadUser(req) {
  const u = get('SELECT * FROM users WHERE id = ?', int(req.params.id, { fallback: 0 }));
  if (!u) throw notFound('المستخدم');
  return u;
}

router.get('/users/:id', (req, res) => {
  const u = loadUser(req);
  res.render('seller/user', {
    active: 'admin-users',
    pageTitle: u.name,
    member: u,
    orders: all(
      `SELECT o.*, p.cover_url AS product_cover, pl.logo_url AS platform_logo, pl.color1, pl.color2
       FROM orders o LEFT JOIN products p ON p.id = o.product_id LEFT JOIN platforms pl ON pl.id = p.platform_id
       WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 50`,
      u.id,
    ),
    stats: get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN o.status IN ${orders.PAID_STATUSES} THEN ${orders.TOTAL_IN_BASE_SQL} ELSE 0 END), 0) AS spent
       FROM orders o WHERE o.user_id = ?`,
      u.id,
    ),
    productCount: get('SELECT COUNT(*) AS n FROM products WHERE seller_id = ?', u.id).n,
  });
});

const adminCount = () => get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_blocked = 0").n;

router.post('/users/:id/role', (req, res) => {
  const u = loadUser(req);
  const role = ['buyer', 'seller', 'admin'].includes(req.body.role) ? req.body.role : null;
  if (!role) return res.reply({ ok: false, message: 'صلاحية غير صالحة' });
  if (u.id === req.user.id && role !== 'admin') return res.reply({ ok: false, message: 'لا يمكنك إزالة صلاحية المدير عن حسابك' });
  if (u.role === 'admin' && role !== 'admin' && adminCount() <= 1) return res.reply({ ok: false, message: 'يجب أن يبقى مدير واحد على الأقل' });
  const storeName = clean(req.body.store_name, 60) || u.store_name || null;
  run('UPDATE users SET role = ?, store_name = ? WHERE id = ?', role, storeName, u.id);
  if (role !== u.role) {
    notify(u.id, {
      title: role === 'buyer' ? 'تم تحديث صلاحيات حسابك' : 'تم منحك صلاحيات ' + (role === 'admin' ? 'مدير المتجر' : 'البائع') + ' 🎉',
      body: role === 'buyer' ? null : 'يمكنك الآن الوصول إلى لوحة البائع لإدارة المنتجات والطلبات.',
      link: role === 'buyer' ? '/account' : '/seller',
      icon: 'fa-solid fa-user-shield',
      tone: 'brand',
    });
  }
  res.reply({ ok: true, message: 'تم تحديث صلاحيات المستخدم', reload: true });
});

router.post('/users/:id/block', (req, res) => {
  const u = loadUser(req);
  if (u.id === req.user.id) return res.reply({ ok: false, message: 'لا يمكنك إيقاف حسابك' });
  if (!u.is_blocked && u.role === 'admin' && adminCount() <= 1) return res.reply({ ok: false, message: 'لا يمكن إيقاف آخر مدير' });
  run('UPDATE users SET is_blocked = 1 - is_blocked WHERE id = ?', u.id);
  if (!u.is_blocked) endAllSessions(u.id);
  res.reply({ ok: true, message: u.is_blocked ? 'تم تفعيل الحساب' : 'تم إيقاف الحساب وتسجيل خروجه', reload: true });
});

router.post('/users/:id/password', async (req, res) => {
  const u = loadUser(req);
  const password = str(req.body.password);
  if (password.length < 8) return res.reply({ ok: false, errors: { password: 'كلمة المرور 8 أحرف على الأقل' } });
  run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), u.id);
  if (u.id !== req.user.id) endAllSessions(u.id);
  res.reply({ ok: true, message: 'تم تعيين كلمة المرور الجديدة — أرسلها للمستخدم وانصحه بتغييرها', reload: true });
});

router.post('/users/:id/whatsapp', (req, res) => {
  const u = loadUser(req);
  const wa = fromInternational(req.body.whatsapp);
  if (wa.error) return res.reply({ ok: false, errors: { whatsapp: 'اكتب الرقم بالصيغة الدولية مثل +970599123456' } });
  run('UPDATE users SET wa_country = ?, wa_dial = ?, wa_number = ?, wa_e164 = ? WHERE id = ?', wa.country, wa.dial, wa.number, wa.e164, u.id);
  res.reply({ ok: true, message: 'تم تحديث رقم الواتساب', reload: true });
});

/* =====================================================================
   Seller applications
   ===================================================================== */
router.get('/applications', (req, res) => {
  res.render('seller/applications', {
    active: 'admin-apps',
    pageTitle: 'طلبات الانضمام كبائع',
    items: all(
      `SELECT a.*, u.name, u.email, u.wa_e164, u.role, u.created_at AS joined_at FROM seller_applications a JOIN users u ON u.id = a.user_id
       ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.id DESC LIMIT 200`,
    ),
  });
});

router.post('/applications/:id/:decision', (req, res) => {
  const a = get('SELECT * FROM seller_applications WHERE id = ?', int(req.params.id, { fallback: 0 }));
  if (!a) throw notFound('الطلب');
  if (a.status !== 'pending') return res.reply({ ok: false, message: 'تمت مراجعة هذا الطلب مسبقاً' });
  const approve = req.params.decision === 'approve';
  if (!approve && req.params.decision !== 'reject') throw notFound('الإجراء');
  const note = cleanText(req.body.note, 400) || null;
  tx(() => {
    run("UPDATE seller_applications SET status = ?, admin_note = ?, reviewed_at = datetime('now') WHERE id = ?", approve ? 'approved' : 'rejected', note, a.id);
    if (approve) run("UPDATE users SET role = CASE WHEN role = 'admin' THEN 'admin' ELSE 'seller' END, store_name = ? WHERE id = ?", a.store_name, a.user_id);
  });
  notify(a.user_id, {
    title: approve ? 'تمت الموافقة على طلبك كبائع 🎉' : 'لم تتم الموافقة على طلب البائع',
    body: approve ? `متجرك «${a.store_name}» جاهز، ابدأ بإضافة منتجاتك من لوحة البائع.` : note || 'يمكنك تعديل بياناتك وإعادة التقديم لاحقاً.',
    link: approve ? '/seller' : '/account/become-seller',
    icon: approve ? 'fa-solid fa-store' : 'fa-solid fa-circle-xmark',
    tone: approve ? 'success' : 'danger',
  });
  res.reply({ ok: true, message: approve ? 'تمت الموافقة وتفعيل صلاحيات البائع' : 'تم رفض الطلب', reload: true });
});

/* =====================================================================
   Reviews
   ===================================================================== */
router.get('/reviews', (req, res) => {
  const total = get('SELECT COUNT(*) AS n FROM reviews').n;
  const pg = paginate(total, req.query.page, 30);
  res.render('seller/reviews', {
    active: 'admin-reviews',
    pageTitle: 'التقييمات',
    pg,
    items: all(
      `SELECT r.*, p.title AS product_title, p.slug AS product_slug, o.code AS order_code FROM reviews r
       JOIN products p ON p.id = r.product_id LEFT JOIN orders o ON o.id = r.order_id ORDER BY r.id DESC LIMIT ? OFFSET ?`,
      30,
      pg.offset,
    ),
  });
});

router.post('/reviews/:id/toggle', (req, res) => {
  const r = get('SELECT * FROM reviews WHERE id = ?', int(req.params.id, { fallback: 0 }));
  if (!r) throw notFound('التقييم');
  run('UPDATE reviews SET is_visible = 1 - is_visible WHERE id = ?', r.id);
  res.reply({ ok: true, message: r.is_visible ? 'تم إخفاء التقييم' : 'تم إظهار التقييم', reload: true });
});

router.post('/reviews/:id/delete', (req, res) => {
  run('DELETE FROM reviews WHERE id = ?', int(req.params.id, { fallback: 0 }));
  res.reply({ ok: true, message: 'تم حذف التقييم', reload: true });
});

/* =====================================================================
   Settings
   ===================================================================== */
router.get('/settings', (req, res) => {
  res.render('seller/settings', {
    active: 'admin-settings',
    pageTitle: 'إعدادات المتجر',
    s: settings.getAll(),
    envGoogle: !!process.env.GOOGLE_CLIENT_ID,
    origin: `${req.protocol}://${req.get('host')}`,
  });
});

router.post('/settings', (req, res) => {
  const b = req.body;
  const errors = {};
  const wa = fromInternational(b.whatsapp_number);
  if (wa.error) errors.whatsapp_number = 'اكتب رقم واتساب المتجر بالصيغة الدولية مثل +201093525956';
  const email = clean(b.support_email, 120);
  if (email && !isEmail(email)) errors.support_email = 'بريد إلكتروني غير صالح';
  const url = (v) => {
    const s = clean(v, 300);
    return /^https?:\/\//i.test(s) ? s : '';
  };
  const googleId = clean(b.google_client_id, 200);
  if (googleId && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(googleId)) errors.google_client_id = 'المعرّف يجب أن ينتهي بـ .apps.googleusercontent.com';
  if (Object.keys(errors).length) return res.reply({ ok: false, errors, message: Object.values(errors)[0] });
  settings.set({
    store_name: clean(b.store_name, 60) || 'MTS Store',
    store_tagline: clean(b.store_tagline, 80),
    whatsapp_number: wa.e164,
    support_email: email,
    facebook_url: url(b.facebook_url),
    instagram_url: url(b.instagram_url),
    announcement: clean(b.announcement, 200),
    hero_title: clean(b.hero_title, 120) || settings.DEFAULTS.hero_title,
    hero_subtitle: cleanText(b.hero_subtitle, 300) || settings.DEFAULTS.hero_subtitle,
    checkout_note: cleanText(b.checkout_note, 400),
    google_client_id: googleId,
    auto_complete_days: String(int(b.auto_complete_days, { min: 1, max: 60, fallback: 3 })),
    max_quantity: String(int(b.max_quantity, { min: 1, max: 100, fallback: 10 })),
    sellers_can_approve: bool(b.sellers_can_approve) ? '1' : '0',
  });
  res.reply({ ok: true, message: 'تم حفظ إعدادات المتجر', reload: true });
});

module.exports = router;
