'use strict';
// Service-request pages and actions shared by the provider area (/provider/requests) and the admin
// dashboard (/seller/service-requests). Who may do what comes from lib/services and the user's role.
const config = require('../config');
const { all } = require('../db');
const services = require('../lib/services');
const settings = require('../lib/settings');
const { BUDGETS } = require('../lib/format');
const { isAdmin } = require('../lib/auth');
const { serviceFiles, SERVICE_FILE_MB } = require('../lib/uploads');
const { cleanText, int, urls } = require('../lib/util');
const { limiter } = require('../lib/limits');

const uploadLimiter = limiter(60, 60, 'عدد كبير من عمليات الرفع، حاول بعد قليل');

const forbidden = (message) => Object.assign(new Error(message), { status: 403, expose: true });

/** Mounts the request page and its actions on `router` under `base` (e.g. "/requests"). */
function mountRequestRoutes(router, { base, active }) {
  // Team pages are for working on requests; a client sees their own request from their account.
  function load(req) {
    const r = services.byCode(req.params.code);
    if (!r || !services.canView(req.user, r) || (r.user_id === req.user.id && !isAdmin(req.user))) {
      throw Object.assign(new Error('طلب الخدمة غير موجود أو ليس لديك صلاحية عليه'), { status: 404, expose: true });
    }
    return r;
  }
  const working = (req, r) => {
    if (!services.canWork(req.user, r)) throw forbidden('استلم الطلب أولاً حتى تتمكن من العمل عليه');
  };
  const adminOnly = (req) => {
    if (!isAdmin(req.user)) throw forbidden('هذا الإجراء من صلاحيات الإدارة');
  };
  const done = (req, r, message) => ({ ok: true, message, redirect: `${req.baseUrl}${base}/${r.code}` });

  router.get(`${base}/:code`, (req, res) => {
    const r = load(req);
    const work = services.canWork(req.user, r);
    const site = config.appUrl || `${req.protocol}://${req.get('host')}`;
    const first = String(r.client_name || '').split(/\s+/)[0];
    res.render('team/request', {
      active,
      pageTitle: `طلب الخدمة ${r.code}`,
      r,
      events: services.thread(r, { internal: work }),
      base: `${req.baseUrl}${base}`,
      can: {
        work,
        take: services.canTake(req.user, r),
        deliver: services.canDeliver(req.user, r),
        assign: isAdmin(req.user) && services.OPEN_STATUSES.includes(r.status),
        complete: isAdmin(req.user) && r.status === 'delivered',
        cancel: isAdmin(req.user) && services.OPEN_STATUSES.includes(r.status),
      },
      team: isAdmin(req.user) ? all("SELECT id, name, role FROM users WHERE role IN ('provider', 'admin') AND is_blocked = 0 ORDER BY role = 'admin', name") : [],
      budgets: BUDGETS,
      maxMb: SERVICE_FILE_MB,
      autoDays: Number(settings.get('service_auto_complete_days')) || 7,
      waText: `مرحباً ${first}، معك فريق MTS Agency بخصوص طلب الخدمة ${r.code} (${r.title}).\nرابط الطلب: ${site}/account/services/${r.code}`,
    });
  });

  router.post(`${base}/:code/take`, (req, res) => {
    const r = services.take(load(req), req.user);
    res.reply(done(req, r, 'استلمت الطلب، يمكنك البدء بالعمل عليه الآن'));
  });

  router.post(`${base}/:code/assign`, (req, res) => {
    adminOnly(req);
    const r = services.assign(load(req), req.user, int(req.body.member_id, { fallback: 0 }));
    res.reply(done(req, r, `تم إسناد الطلب إلى ${r.assignee_name}`));
  });

  router.post(`${base}/:code/message`, uploadLimiter, serviceFiles('files', 6), (req, res) => {
    const r = load(req);
    working(req, r);
    const body = cleanText(req.body.body, 4000);
    if (!body && !req.files.length) return res.reply({ ok: false, errors: { body: 'اكتب رسالتك أو أرفق ملفاً' } });
    services.message(r, req.user, { body, files: req.files });
    req.files.forEach((f) => (f.kept = true));
    res.reply(done(req, r, 'تم إرسال الرسالة إلى العميل'));
  });

  router.post(`${base}/:code/note`, (req, res) => {
    const r = load(req);
    working(req, r);
    const body = cleanText(req.body.body, 2000);
    if (body.length < 2) return res.reply({ ok: false, errors: { body: 'اكتب الملاحظة' } });
    services.note(r, req.user, body);
    res.reply(done(req, r, 'تمت إضافة الملاحظة الداخلية'));
  });

  router.post(`${base}/:code/deliver`, uploadLimiter, serviceFiles('files', 10), (req, res) => {
    const r = load(req);
    if (!services.canDeliver(req.user, r)) throw forbidden('لا يمكنك تسليم هذا الطلب في حالته الحالية');
    const body = cleanText(req.body.body, 4000);
    const links = urls(req.body.links, 10);
    if (links.error) return res.reply({ ok: false, errors: { links: links.error } });
    if (!links.links.length && !req.files.length) {
      return res.reply({ ok: false, message: 'أضف رابطاً أو ملفاً واحداً على الأقل للتسليم', errors: { links: 'أضف رابط التسليم أو أرفق الملفات' } });
    }
    const updated = services.deliver(r, req.user, { body, links: links.links, files: req.files });
    req.files.forEach((f) => (f.kept = true));
    res.reply(done(req, updated, 'تم تسليم الطلب للعميل وإبلاغه 🎉'));
  });

  router.post(`${base}/:code/complete`, (req, res) => {
    adminOnly(req);
    const r = load(req);
    services.complete(r, req.user);
    res.reply(done(req, r, 'تم إغلاق الطلب كمكتمل'));
  });

  router.post(`${base}/:code/cancel`, (req, res) => {
    adminOnly(req);
    const r = load(req);
    const reason = cleanText(req.body.reason, 400);
    if (reason.length < 3) return res.reply({ ok: false, errors: { reason: 'اكتب سبب الإلغاء ليظهر للعميل' } });
    services.cancel(r, req.user, reason);
    res.reply(done(req, r, 'تم إلغاء الطلب وإبلاغ العميل'));
  });
}

module.exports = { mountRequestRoutes };
