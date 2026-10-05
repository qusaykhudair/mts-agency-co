'use strict';
const fs = require('fs');
const helmet = require('helmet');
const { get } = require('./db');
const config = require('./config');
const settings = require('./lib/settings');
const money = require('./lib/money');
const fmt = require('./lib/format');
const phone = require('./lib/phone');
const { isStaff, isAdmin, isProvider, isServiceTeam } = require('./lib/auth');

const BUILD = Date.now().toString(36);
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const shortHash = (s) => require('crypto').createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
const isAjax =(req) => req.get('x-requested-with') === 'fetch' || (req.get('accept') || '').startsWith('application/json');

function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        formAction: ["'self'"],
        scriptSrc: ["'self'", 'https://accounts.google.com/gsi/client'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com', 'https://accounts.google.com/gsi/style'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://*.googleusercontent.com', 'https://cdnjs.cloudflare.com'],
        connectSrc: ["'self'", 'https://accounts.google.com/gsi/'],
        frameSrc: ['https://accounts.google.com/gsi/'],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    // Google's sign-in popup reports back to the page that opened it.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    strictTransportSecurity: config.isProd ? { maxAge: 15552000, includeSubDomains: false } : false,
  });
}

// Reject state-changing requests that do not originate from this site (CSRF defence).
function originCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const source = req.get('origin') || req.get('referer');
  let host = null;
  try {
    host = source ? new URL(source).host : null;
  } catch {
    host = null;
  }
  const allowed = new Set([req.get('host')]);
  if (config.appUrl) {
    try {
      allowed.add(new URL(config.appUrl).host);
    } catch {
      /* ignore malformed APP_URL */
    }
  }
  if (host && allowed.has(host)) return next();
  const err = new Error('تم رفض الطلب لأسباب أمنية. حدّث الصفحة وحاول مرة أخرى.');
  err.status = 403;
  err.expose = true;
  next(err);
}

const FLASH_COOKIE = 'mts_flash';

function flash(req, res, next) {
  res.locals.flash = null;
  const raw = req.cookies && req.cookies[FLASH_COOKIE];
  if (raw) {
    try {
      res.locals.flash = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
      res.locals.flash = null;
    }
    res.clearCookie(FLASH_COOKIE, { path: '/' });
  }
  req.flash = (type, message) => {
    res.cookie(FLASH_COOKIE, Buffer.from(JSON.stringify({ type, message }), 'utf8').toString('base64url'), {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      path: '/',
      maxAge: 60000,
    });
  };
  // Uniform reply for form submissions: JSON for fetch(), flash + redirect otherwise.
  res.reply = ({ ok = true, message = null, redirect = null, reload = false, errors = null, status, data } = {}) => {
    if (isAjax(req)) {
      if (ok && message && (redirect || reload)) req.flash('success', message);
      return res.status(status || (ok ? 200 : 422)).json({ ok, message, redirect, reload, errors, ...(data || {}) });
    }
    if (message) req.flash(ok ? 'success' : 'error', message || Object.values(errors || {})[0]);
    else if (!ok && errors) req.flash('error', Object.values(errors)[0]);
    return res.redirect(redirect || req.get('referer') || '/store');
  };
  next();
}

function paginate(total, page, perPage) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  return { total, page: current, pages, perPage, offset: (current - 1) * perPage };
}

function locals(req, res, next) {
  const s = settings.getAll();
  const displayCurrency = money.resolve((req.cookies && req.cookies.mts_cur) || s.default_currency);
  const user = req.user;
  const announceHash = s.announcement ? shortHash(s.announcement) : '';
  Object.assign(res.locals, {
    settings: s,
    announceHash,
    announceHidden: !!announceHash && !!req.cookies && req.cookies.mts_ann === announceHash,
    path: req.path,
    url: req.originalUrl,
    query: req.query,
    theme: ['light', 'dark'].includes(req.cookies && req.cookies.mts_theme) ? req.cookies.mts_theme : null,
    asset: (p) => `${p}?v=${BUILD}`,
    googleClientId: settings.googleClientId(),
    currencies: money.list(),
    displayCurrency,
    baseCurrency: money.base(),
    // Base-currency minor units shown in the visitor's display currency.
    money: (baseMinor) => money.format(baseMinor, displayCurrency, { html: true }),
    moneyText: (baseMinor) => money.format(baseMinor, displayCurrency),
    // Base-currency minor units shown in the base currency (dashboards).
    moneyBase: (baseMinor) => money.format(baseMinor, money.base(), { html: true }),
    // Base-currency minor units converted to a given currency (e.g. what a bank transfer would cost).
    moneyTo: (baseMinor, code) => money.format(baseMinor, money.byCode(code) || money.base(), { html: true }),
    // Minor units that are already denominated in `code` (no conversion).
    moneyIn: (minor, code) => money.formatMajor(Number(minor) / 100, money.byCode(code) || { symbol: code, decimals: 2 }, { html: true }),
    moneyMajor: (amount, code) => money.formatMajor(amount, money.byCode(code) || { symbol: code, decimals: 2 }, { html: true }),
    orderPay: (o) => money.formatMajor(o.pay_amount / 100, money.byCode(o.pay_currency) || { symbol: o.pay_currency, decimals: 2 }, { html: true }),
    orderPayText: (o) => money.formatMajor(o.pay_amount / 100, money.byCode(o.pay_currency) || { symbol: o.pay_currency, decimals: 2 }),
    ...fmt,
    esc: escapeHtml,
    displayWhatsapp: phone.displayWhatsapp,
    waLink: phone.waLink,
    isStaff: isStaff(user),
    isAdmin: isAdmin(user),
    isProvider: isProvider(user),
    storeWa: s.whatsapp_number,
    pageUrl: (n) => {
      const q = new URLSearchParams(req.query);
      if (n > 1) q.set('page', n);
      else q.delete('page');
      const qs = q.toString();
      return req.path + (qs ? '?' + qs : '');
    },
    withQuery: (changes) => {
      const q = new URLSearchParams(req.query);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === undefined || v === '') q.delete(k);
        else q.set(k, v);
      }
      q.delete('page');
      const qs = q.toString();
      return req.path + (qs ? '?' + qs : '');
    },
    counts: { unread: 0, pendingOrders: 0, pendingApps: 0, services: 0 },
    // Admins are warned when uploads and the database would not survive a redeploy.
    storageWarning: isAdmin(user) && config.ephemeralStorage,
  });
  if (user) {
    res.locals.counts.unread = get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', user.id).n;
    if (isAdmin(user)) {
      res.locals.counts.pendingOrders = get("SELECT COUNT(*) AS n FROM orders WHERE status = 'under_review'").n;
      res.locals.counts.pendingApps = get("SELECT COUNT(*) AS n FROM seller_applications WHERE status = 'pending'").n;
      // New service requests waiting for someone to pick them up.
      res.locals.counts.services = get("SELECT COUNT(*) AS n FROM service_requests WHERE status = 'pending'").n;
    } else if (isProvider(user)) {
      // Open requests nobody has taken yet, plus the provider's own requests that need work.
      res.locals.counts.services = get(
        "SELECT COUNT(*) AS n FROM service_requests WHERE (status = 'pending' AND assigned_to IS NULL AND user_id <> ?) OR (assigned_to = ? AND status IN ('in_progress', 'revision'))",
        user.id,
        user.id,
      ).n;
    } else if (isStaff(user)) {
      res.locals.counts.pendingOrders = get("SELECT COUNT(*) AS n FROM orders WHERE status = 'under_review' AND seller_id = ? AND user_id <> ?", user.id, user.id).n;
    }
  }
  next();
}

const PROFILE_EXEMPT = /^\/(auth\/|logout|static\/|assets\/|uploads\/|files\/|api\/|favicon)/;

// Accounts (e.g. new Google sign-ups) must add a WhatsApp number before using the store.
function requireProfileCompletion(req, res, next) {
  if (!req.user || req.user.wa_e164 || PROFILE_EXEMPT.test(req.path) || req.path === '/') return next();
  if (req.method !== 'GET') {
    const err = new Error('أكمل بيانات حسابك (رقم الواتساب) أولاً');
    err.status = 403;
    err.expose = true;
    return next(err);
  }
  return res.redirect('/auth/complete-profile?next=' + encodeURIComponent(req.originalUrl));
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET' && !isAjax(req)) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  const err = new Error('سجّل الدخول أولاً للمتابعة');
  err.status = 401;
  err.expose = true;
  next(err);
}

function requireRole(check, message) {
  return (req, res, next) => {
    if (!req.user) return requireAuth(req, res, next);
    if (check(req.user)) return next();
    const err = new Error(message || 'ليست لديك صلاحية الوصول إلى هذه الصفحة');
    err.status = 403;
    err.expose = true;
    next(err);
  };
}

const requireStaff = requireRole(isStaff, 'هذه الصفحة مخصصة للبائعين وإدارة المتجر');
const requireAdmin = requireRole(isAdmin, 'هذه الصفحة مخصصة لمدير المتجر فقط');
const requireServiceTeam = requireRole(isServiceTeam, 'هذه الصفحة مخصصة لفريق تنفيذ الخدمات');

function notFound(req, res) {
  res.status(404);
  if (isAjax(req) || req.path.startsWith('/api/')) return res.json({ ok: false, message: 'الصفحة غير موجودة' });
  res.render('errors/error', { pageTitle: 'الصفحة غير موجودة', code: 404, message: 'الصفحة التي تبحث عنها غير موجودة أو تم نقلها.' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // A failed request must not leave its upload behind (routes mark files they stored as kept).
  if (req.file && req.file.path && !req.file.kept) fs.rm(req.file.path, { force: true }, () => {});
  for (const f of Array.isArray(req.files) ? req.files : []) if (f.path && !f.kept) fs.rm(f.path, { force: true }, () => {});
  const status = err.status || err.statusCode || 500;
  const expose = err.expose || status < 500;
  if (status >= 500) console.error(err);
  const message = expose && err.message ? err.message : 'حدث خطأ غير متوقع، حاول مرة أخرى لاحقاً.';
  if (res.headersSent) return;
  res.status(status);
  if (isAjax(req) || req.path.startsWith('/api/')) return res.json({ ok: false, message });
  if (status === 403 && req.method !== 'GET' && req.get('referer') && req.flash) {
    req.flash('error', message);
    return res.redirect(req.get('referer'));
  }
  // Errors raised before the locals middleware ran still need the layout variables.
  if (res.locals.user === undefined) res.locals.user = req.user || null;
  if (!res.locals.settings) {
    try {
      locals(req, res, () => {});
    } catch {
      /* render below falls back to plain text */
    }
  }
  res.render('errors/error', { pageTitle: 'حدث خطأ', code: status, message }, (renderErr, html) => {
    if (renderErr) {
      console.error(renderErr);
      return res.type('text').send(message);
    }
    res.send(html);
  });
}

module.exports = {
  isAjax,
  securityHeaders,
  originCheck,
  flash,
  locals,
  paginate,
  requireProfileCompletion,
  requireAuth,
  requireStaff,
  requireAdmin,
  requireServiceTeam,
  notFound,
  errorHandler,
};
