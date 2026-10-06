'use strict';
const express = require('express');
const { get, all, run } = require('../db');
const orders = require('../lib/orders');
const { notifyStaff } = require('../lib/notify');
const { hashPassword, verifyPassword, endAllSessions, SESSION_COOKIE } = require('../lib/auth');
const { normalizeWhatsapp } = require('../lib/phone');
const { receiptUpload, serviceFiles, discard, SERVICE_FILE_MB } = require('../lib/uploads');
const services = require('../lib/services');
const settings = require('../lib/settings');
const { BUDGETS } = require('../lib/format');
const { str, clean, cleanText, int, toLatinDigits } = require('../lib/util');
const { fromSql } = require('../db');
const { paginate, requireAuth } = require('../middleware');
const { limiter } = require('../lib/limits');

const router = express.Router();
const PER_PAGE = 15;

const uploadLimiter = limiter(20, 60, 'عدد كبير من محاولات رفع الإيصال، حاول مرة أخرى بعد قليل');
const serviceLimiter = limiter(60, 60, 'عدد كبير من الرسائل والمرفقات، حاول مرة أخرى بعد قليل');

router.use(requireAuth, (req, res, next) => {
  res.locals.nav = 'account';
  res.locals.noindex = true;
  next();
});

const ORDER_LIST_SQL = `
  SELECT o.*, p.slug AS product_slug, p.cover_url AS product_cover, pl.logo_url AS platform_logo, pl.color1, pl.color2
  FROM orders o
  LEFT JOIN products p ON p.id = o.product_id
  LEFT JOIN platforms pl ON pl.id = p.platform_id`;

const TABS = [
  { key: '', label: 'الكل', statuses: null },
  { key: 'review', label: 'قيد المراجعة', statuses: ['under_review'] },
  { key: 'rejected', label: 'الدفع مرفوض', statuses: ['payment_rejected'] },
  { key: 'processing', label: 'قيد التجهيز', statuses: ['processing'] },
  { key: 'delivered', label: 'تم التسليم', statuses: ['delivered', 'completed'] },
  { key: 'cancelled', label: 'ملغية', statuses: ['cancelled'] },
];

function subscriptions(userId) {
  const rows = all(`${ORDER_LIST_SQL} WHERE o.user_id = ? AND o.status IN ('delivered', 'completed') ORDER BY o.expires_at IS NULL, o.expires_at ASC`, userId);
  const now = Date.now();
  return rows.map((o) => {
    const start = fromSql(o.delivered_at) || fromSql(o.created_at);
    const end = fromSql(o.expires_at);
    let progress = null;
    let daysLeft = null;
    if (end) {
      daysLeft = Math.ceil((end.getTime() - now) / 86400000);
      const span = Math.max(1, end.getTime() - start.getTime());
      progress = Math.min(100, Math.max(0, Math.round(((end.getTime() - now) / span) * 100)));
    }
    return { ...o, daysLeft, progress, active: !end || end.getTime() > now };
  });
}

function ownOrder(req) {
  const order = orders.byCode(req.params.code);
  if (!order || order.user_id !== req.user.id) {
    const err = new Error('الطلب غير موجود');
    err.status = 404;
    err.expose = true;
    throw err;
  }
  return order;
}

/* ---------- Overview ---------- */
router.get('/', (req, res) => {
  const uid = req.user.id;
  const stats = get(
    `SELECT COALESCE(SUM(CASE WHEN o.status IN ('under_review', 'processing', 'payment_rejected') THEN 1 ELSE 0 END), 0) AS open
     FROM orders o WHERE o.user_id = ?`,
    uid,
  );
  const subs = subscriptions(uid).filter((s) => s.active);
  res.render('account/overview', {
    active: 'acc-home',
    pageTitle: 'لوحة حسابي',
    stats,
    activeSubs: subs.length,
    subs: subs.slice(0, 4),
    recent: all(`${ORDER_LIST_SQL} WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 5`, uid),
    attention: all(`SELECT code, product_title, reject_reason FROM orders WHERE user_id = ? AND status = 'payment_rejected' ORDER BY id DESC`, uid),
    openServices: services.list({ where: ['r.user_id = ?', `r.status IN ('pending', 'in_progress', 'delivered', 'revision')`], params: [uid], limit: 1 }).total,
    serviceRequests: services.list({ where: ['r.user_id = ?'], params: [uid], limit: 3 }).items,
  });
});

/* ---------- Orders ---------- */
router.get('/orders', (req, res) => {
  const uid = req.user.id;
  const tab = TABS.find((t) => t.key === (req.query.tab || '')) || TABS[0];
  const counts = Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM orders WHERE user_id = ? GROUP BY status', uid).map((r) => [r.status, r.n]));
  const tabs = TABS.map((t) => ({ ...t, count: t.statuses ? t.statuses.reduce((s, st) => s + (counts[st] || 0), 0) : Object.values(counts).reduce((a, b) => a + b, 0) }));
  const where = tab.statuses ? `AND o.status IN (${tab.statuses.map(() => '?').join(',')})` : '';
  const params = [uid, ...(tab.statuses || [])];
  const total = get(`SELECT COUNT(*) AS n FROM orders o WHERE o.user_id = ? ${where}`, ...params).n;
  const pg = paginate(total, req.query.page, PER_PAGE);
  res.render('account/orders', {
    active: 'acc-orders',
    pageTitle: 'طلباتي',
    tabs,
    tab: tab.key,
    pg,
    items: all(`${ORDER_LIST_SQL} WHERE o.user_id = ? ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`, ...params, PER_PAGE, pg.offset),
  });
});

router.get('/orders/:code', (req, res) => {
  const order = ownOrder(req);
  const method = order.payment_method_id ? get('SELECT * FROM payment_methods WHERE id = ?', order.payment_method_id) : null;
  res.render('account/order', {
    active: 'acc-orders',
    pageTitle: `الطلب ${order.code}`,
    order,
    method,
    delivery: orders.delivery(order),
    events: orders.events(order.id),
    placed: req.query.placed === '1',
    review: order.review_id ? get('SELECT * FROM reviews WHERE id = ?', order.review_id) : null,
    needFlags: false,
  });
});

router.post('/orders/:code/receipt', uploadLimiter, receiptUpload('receipt'), (req, res) => {
  const order = ownOrder(req);
  const errors = {};
  const senderName = clean(req.body.sender_name, 100);
  const senderAccount = toLatinDigits(clean(req.body.sender_account, 60));
  if (senderName.length < 3) errors.sender_name = 'اكتب اسم صاحب الحساب الذي تم التحويل منه';
  if (senderAccount.replace(/\s/g, '').length < 4) errors.sender_account = 'اكتب رقم الحساب أو المحفظة الذي حولت منه';
  if (!req.file) errors.receipt = 'أرفق صورة الإيصال الجديد';
  if (order.status !== 'payment_rejected') {
    discard(req.file);
    return res.reply({ ok: false, message: 'لا يمكن تعديل إيصال هذا الطلب حاليا' });
  }
  if (Object.keys(errors).length) {
    discard(req.file);
    return res.reply({ ok: false, errors });
  }
  orders.resubmitReceipt(order, req.user, { senderName, senderAccount, receipt: req.file });
  req.file.kept = true;
  res.reply({ ok: true, message: 'تم إرسال الإيصال الجديد، سنراجعه في أقرب وقت', reload: true });
});

router.post('/orders/:code/confirm', (req, res) => {
  const order = ownOrder(req);
  orders.complete(order, req.user);
  res.reply({ ok: true, message: 'شكرا، سجلنا أنك استلمت اشتراكك', reload: true });
});

router.post('/orders/:code/cancel', (req, res) => {
  const order = ownOrder(req);
  if (!['under_review', 'payment_rejected'].includes(order.status)) {
    return res.reply({ ok: false, message: 'لا يمكن إلغاء الطلب بعد تأكيد الدفع، تواصل معنا عبر واتساب' });
  }
  orders.cancel(order, req.user, 'ألغى العميل الطلب');
  res.reply({ ok: true, message: 'تم إلغاء الطلب', reload: true });
});

router.post('/orders/:code/review', (req, res) => {
  const order = ownOrder(req);
  if (!['delivered', 'completed'].includes(order.status)) return res.reply({ ok: false, message: 'يمكنك التقييم بعد استلام الاشتراك' });
  if (order.review_id) return res.reply({ ok: false, message: 'لقد قيمت هذا الطلب مسبقا' });
  if (!order.product_id) return res.reply({ ok: false, message: 'المنتج لم يعد متوفرا للتقييم' });
  const rating = int(req.body.rating, { min: 0, max: 5, fallback: 0 });
  if (rating < 1) return res.reply({ ok: false, errors: { rating: 'اختر عدد النجوم' } });
  const comment = cleanText(req.body.comment, 600) || null;
  const parts = req.user.name.trim().split(/\s+/);
  const author = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
  run('INSERT INTO reviews (product_id, user_id, order_id, author_name, rating, comment) VALUES (?, ?, ?, ?, ?, ?)', order.product_id, req.user.id, order.id, author, rating, comment);
  res.reply({ ok: true, message: 'شكرا على تقييمك، يساعد من يفكر في شراء هذا الاشتراك', reload: true });
});

/* ---------- Service requests ---------- */
const SERVICE_TABS = [
  { key: '', label: 'الكل', statuses: null },
  { key: 'open', label: 'قيد المتابعة', statuses: ['pending', 'in_progress', 'revision', 'delivered'] },
  { key: 'completed', label: 'مكتملة', statuses: ['completed'] },
  { key: 'cancelled', label: 'ملغاة', statuses: ['cancelled'] },
];

function ownRequest(req) {
  const r = services.byCode(req.params.code);
  if (!r || r.user_id !== req.user.id) {
    const err = new Error('طلب الخدمة غير موجود');
    err.status = 404;
    err.expose = true;
    throw err;
  }
  return r;
}

router.get('/services', (req, res) => {
  const uid = req.user.id;
  const tab = SERVICE_TABS.find((t) => t.key === (req.query.tab || '')) || SERVICE_TABS[0];
  const counts = services.countsByStatus(['r.user_id = ?'], [uid]);
  const tabs = SERVICE_TABS.map((t) => ({
    ...t,
    count: t.statuses ? t.statuses.reduce((s, st) => s + (counts[st] || 0), 0) : Object.values(counts).reduce((a, b) => a + b, 0),
  }));
  const where = ['r.user_id = ?'];
  const params = [uid];
  if (tab.statuses) {
    where.push(`r.status IN (${tab.statuses.map(() => '?').join(',')})`);
    params.push(...tab.statuses);
  }
  const total = services.list({ where, params, limit: 1 }).total;
  const pg = paginate(total, req.query.page, PER_PAGE);
  res.render('account/services', {
    active: 'acc-services',
    pageTitle: 'طلبات الخدمات',
    tabs,
    tab: tab.key,
    pg,
    items: services.list({ where, params, limit: PER_PAGE, offset: pg.offset }).items,
  });
});

router.get('/services/:code', (req, res) => {
  const r = ownRequest(req);
  res.render('account/service', {
    active: 'acc-services',
    pageTitle: `طلب الخدمة ${r.code}`,
    r,
    events: services.thread(r),
    budgets: BUDGETS,
    placed: req.query.new === '1',
    maxMb: SERVICE_FILE_MB,
    autoDays: Number(settings.get('service_auto_complete_days')) || 7,
  });
});

router.post('/services/:code/message', serviceLimiter, serviceFiles('files', 6), (req, res) => {
  const r = ownRequest(req);
  const body = cleanText(req.body.body, 4000);
  if (!body && !req.files.length) return res.reply({ ok: false, errors: { body: 'اكتب رسالتك أو أرفق ملفا' } });
  services.message(r, req.user, { body, files: req.files });
  req.files.forEach((f) => (f.kept = true));
  res.reply({ ok: true, message: 'تم إرسال رسالتك إلى الفريق', reload: true });
});

router.post('/services/:code/accept', (req, res) => {
  const r = ownRequest(req);
  services.complete(r, req.user);
  res.reply({ ok: true, message: 'شكرا لك. اعتمدنا التسليم وأغلقنا الطلب', reload: true });
});

router.post('/services/:code/revision', serviceLimiter, serviceFiles('files', 6), (req, res) => {
  const r = ownRequest(req);
  const body = cleanText(req.body.body, 4000);
  if (body.length < 10) {
    (req.files || []).forEach(discard);
    return res.reply({ ok: false, errors: { body: 'اكتب التعديلات المطلوبة بوضوح (10 أحرف على الأقل)' } });
  }
  services.requestRevision(r, req.user, { body, files: req.files });
  req.files.forEach((f) => (f.kept = true));
  res.reply({ ok: true, message: 'تم إرسال طلب التعديلات إلى الفريق', reload: true });
});

router.post('/services/:code/cancel', (req, res) => {
  const r = ownRequest(req);
  services.cancel(r, req.user, cleanText(req.body.reason, 400) || 'ألغى العميل الطلب');
  res.reply({ ok: true, message: 'تم إلغاء طلب الخدمة', reload: true });
});

/* ---------- Subscriptions ---------- */
router.get('/subscriptions', (req, res) => {
  const subs = subscriptions(req.user.id);
  res.render('account/subscriptions', {
    active: 'acc-subs',
    pageTitle: 'اشتراكاتي',
    activeSubs: subs.filter((s) => s.active),
    expiredSubs: subs.filter((s) => !s.active),
  });
});

/* ---------- Notifications ---------- */
router.get('/notifications', (req, res) => {
  const uid = req.user.id;
  const total = get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?', uid).n;
  const pg = paginate(total, req.query.page, 20);
  const items = all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?', uid, 20, pg.offset);
  run('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', uid);
  res.locals.counts.unread = 0;
  res.render('account/notifications', { active: 'acc-notifs', pageTitle: 'الإشعارات', items, pg });
});

/* ---------- Profile ---------- */
router.get('/profile', (req, res) => {
  res.render('account/profile', {
    active: 'acc-profile',
    pageTitle: 'الملف الشخصي',
    needFlags: true,
    sessions: get("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > datetime('now')", req.user.id).n,
  });
});

router.post('/profile', (req, res) => {
  const name = clean(req.body.name, 80);
  const wa = normalizeWhatsapp(clean(req.body.wa_country, 10), str(req.body.wa_number));
  const errors = {};
  if (name.length < 3) errors.name = 'اكتب اسمك الكامل (3 أحرف على الأقل)';
  if (wa.error) errors.wa_number = wa.error;
  if (Object.keys(errors).length) return res.reply({ ok: false, errors });
  run('UPDATE users SET name = ?, wa_country = ?, wa_dial = ?, wa_number = ?, wa_e164 = ? WHERE id = ?', name, wa.country, wa.dial, wa.number, wa.e164, req.user.id);
  res.reply({ ok: true, message: 'تم حفظ بياناتك', reload: true });
});

router.post('/password', async (req, res) => {
  const current = str(req.body.current_password);
  const password = str(req.body.password);
  const confirm = str(req.body.password_confirm);
  const errors = {};
  if (req.user.password_hash && !(await verifyPassword(current, req.user.password_hash))) errors.current_password = 'كلمة المرور الحالية غير صحيحة';
  if (password.length < 8) errors.password = 'كلمة المرور يجب أن تكون 8 أحرف على الأقل';
  else if (password.length > 128) errors.password = 'كلمة المرور طويلة جدا';
  if (confirm !== password) errors.password_confirm = 'كلمتا المرور غير متطابقتين';
  if (Object.keys(errors).length) return res.reply({ ok: false, errors });
  run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), req.user.id);
  endAllSessions(req.user.id, req.cookies[SESSION_COOKIE]);
  res.reply({ ok: true, message: req.user.password_hash ? 'تم تغيير كلمة المرور' : 'تم تعيين كلمة المرور، يمكنك الآن الدخول بالبريد أيضا', reload: true });
});

router.post('/sessions/revoke', (req, res) => {
  endAllSessions(req.user.id, req.cookies[SESSION_COOKIE]);
  res.reply({ ok: true, message: 'تم تسجيل الخروج من جميع الأجهزة الأخرى', reload: true });
});

/* ---------- Become a seller ---------- */
router.get('/become-seller', (req, res) => {
  res.render('account/become-seller', {
    active: 'acc-seller',
    pageTitle: 'أصبح بائعا',
    application: get('SELECT * FROM seller_applications WHERE user_id = ? ORDER BY id DESC LIMIT 1', req.user.id),
  });
});

router.post('/become-seller', (req, res) => {
  if (req.user.role !== 'buyer') return res.reply({ ok: false, message: 'حسابك يملك صلاحيات البائع بالفعل', redirect: '/seller' });
  if (get("SELECT id FROM seller_applications WHERE user_id = ? AND status = 'pending'", req.user.id)) {
    return res.reply({ ok: false, message: 'لديك طلب قيد المراجعة بالفعل' });
  }
  const storeName = clean(req.body.store_name, 60);
  const about = cleanText(req.body.about, 1000);
  const errors = {};
  if (storeName.length < 3) errors.store_name = 'اكتب اسم المتجر (3 أحرف على الأقل)';
  if (about.length < 20) errors.about = 'عرفنا بنشاطك والاشتراكات التي تبيعها (20 حرفا على الأقل)';
  if (Object.keys(errors).length) return res.reply({ ok: false, errors });
  run('INSERT INTO seller_applications (user_id, store_name, about) VALUES (?, ?, ?)', req.user.id, storeName, about);
  notifyStaff(null, {
    title: 'طلب انضمام بائع جديد',
    body: `${req.user.name} يرغب بفتح متجر «${storeName}»`,
    link: '/seller/applications',
    icon: 'fa-solid fa-store',
    tone: 'brand',
  });
  res.reply({ ok: true, message: 'تم إرسال طلبك، سنراجعه ونبلغك بالنتيجة قريبا', reload: true });
});

module.exports = router;
