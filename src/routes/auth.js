'use strict';
const crypto = require('crypto');
const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const { get, run } = require('../db');
const { hashPassword, verifyPassword, startSession, endSession, isStaff, isProvider, resolveGoogleUser } = require('../lib/auth');
const { normalizeWhatsapp } = require('../lib/phone');
const settings = require('../lib/settings');
const { str, safeNext, clean, isEmail, bool } = require('../lib/util');
const { requireAuth } = require('../middleware');
const { limiter } = require('../lib/limits');

const router = express.Router();

const loginLimiter = limiter(20, 15, 'محاولات دخول كثيرة، انتظر بضع دقائق ثم حاول مجدداً');
const registerLimiter = limiter(10, 60, 'محاولات تسجيل كثيرة من هذا الجهاز، حاول لاحقاً');
const googleLimiter = limiter(30, 15, 'محاولات كثيرة، حاول بعد قليل');

const homeFor = (user) => (isStaff(user) ? '/seller' : isProvider(user) ? '/provider' : '/account');
const firstName = (name) => String(name || '').trim().split(/\s+/)[0];

// Equalise timing between unknown e-mails and wrong passwords.
let dummyHash = null;
async function burnTime(password) {
  dummyHash = dummyHash || (await hashPassword('timing-equaliser'));
  await verifyPassword(password, dummyHash);
}

const authPage = (res, view, data) => res.render(view, { nav: 'bare', noindex: true, ...data });

/* ---------- Login ---------- */
router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next, homeFor(req.user)));
  authPage(res, 'auth/login', { pageTitle: 'تسجيل الدخول', next: safeNext(req.query.next, '') });
});

router.post('/login', loginLimiter, async (req, res) => {
  const email = clean(req.body.email, 254).toLowerCase();
  const password = str(req.body.password);
  const next = safeNext(req.body.next, '');
  const errors = {};
  if (!isEmail(email)) errors.email = 'أدخل بريداً إلكترونياً صحيحاً';
  if (!password) errors.password = 'أدخل كلمة المرور';
  if (Object.keys(errors).length) return res.reply({ ok: false, errors });

  const user = get('SELECT * FROM users WHERE email = ?', email);
  let valid = false;
  if (user && user.password_hash) valid = await verifyPassword(password, user.password_hash);
  else await burnTime(password);
  if (!valid) {
    const message =
      user && !user.password_hash && user.google_sub
        ? 'هذا الحساب مسجّل عبر Google — استخدم زر المتابعة باستخدام Google'
        : 'البريد الإلكتروني أو كلمة المرور غير صحيحة';
    return res.reply({ ok: false, message, errors: { password: message } });
  }
  if (user.is_blocked) return res.reply({ ok: false, message: 'تم إيقاف هذا الحساب. تواصل مع الدعم لمزيد من التفاصيل.' });

  startSession(req, res, user.id);
  const redirect = user.wa_e164 ? next || homeFor(user) : '/auth/complete-profile' + (next ? '?next=' + encodeURIComponent(next) : '');
  res.reply({ ok: true, message: `مرحباً بعودتك يا ${firstName(user.name)} 👋`, redirect });
});

/* ---------- Register ---------- */
router.get('/register', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next, homeFor(req.user)));
  authPage(res, 'auth/register', { pageTitle: 'إنشاء حساب جديد', next: safeNext(req.query.next, ''), needFlags: true });
});

router.post('/register', registerLimiter, async (req, res) => {
  const name = clean(req.body.name, 80);
  const email = clean(req.body.email, 254).toLowerCase();
  const password = str(req.body.password);
  const confirm = str(req.body.password_confirm);
  const wa = normalizeWhatsapp(clean(req.body.wa_country, 10), str(req.body.wa_number));
  const next = safeNext(req.body.next, '');

  const errors = {};
  if (name.length < 3) errors.name = 'اكتب اسمك الكامل (3 أحرف على الأقل)';
  if (!isEmail(email)) errors.email = 'أدخل بريداً إلكترونياً صحيحاً';
  else if (get('SELECT id FROM users WHERE email = ?', email)) errors.email = 'هذا البريد مسجّل مسبقاً، يمكنك تسجيل الدخول مباشرة';
  if (password.length < 8) errors.password = 'كلمة المرور يجب أن تكون 8 أحرف على الأقل';
  else if (password.length > 128) errors.password = 'كلمة المرور طويلة جداً';
  if (confirm !== password) errors.password_confirm = 'كلمتا المرور غير متطابقتين';
  if (wa.error) errors.wa_number = wa.error;
  if (!bool(req.body.agree)) errors.agree = 'يجب الموافقة على الشروط والأحكام';
  if (Object.keys(errors).length) return res.reply({ ok: false, errors });

  let userId;
  try {
    userId = Number(
      run(
        'INSERT INTO users (name, email, password_hash, wa_country, wa_dial, wa_number, wa_e164) VALUES (?, ?, ?, ?, ?, ?, ?)',
        name,
        email,
        await hashPassword(password),
        wa.country,
        wa.dial,
        wa.number,
        wa.e164,
      ).lastInsertRowid,
    );
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) return res.reply({ ok: false, errors: { email: 'هذا البريد مسجّل مسبقاً' } });
    throw err;
  }
  startSession(req, res, userId);
  res.reply({ ok: true, message: `أهلاً بك يا ${firstName(name)}! تم إنشاء حسابك بنجاح 🎉`, redirect: next || '/store' });
});

/* ---------- Google ----------
 * Our own button sends the visitor to Google (OpenID Connect, response_type=id_token). Google returns to
 * /auth/google/callback with the ID token in the URL fragment; that page posts it here. A short-lived
 * cookie set at the start carries the state (anti-CSRF), the nonce (anti-replay) and where to go next. */
let oauthClient = null;
const GOOGLE_COOKIE = 'mts_google';
const googleCookieOptions = (req) => ({ httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: 10 * 60 * 1000 });

function readGoogleFlow(req) {
  try {
    const flow = JSON.parse(Buffer.from(str(req.cookies[GOOGLE_COOKIE]), 'base64url').toString('utf8'));
    return flow && typeof flow.state === 'string' && typeof flow.nonce === 'string' ? flow : null;
  } catch {
    return null;
  }
}

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

router.get('/auth/google/start', googleLimiter, (req, res) => {
  const clientId = settings.googleClientId();
  if (!clientId) {
    req.flash('error', 'تسجيل الدخول عبر Google غير مفعّل حالياً');
    return res.redirect('/login');
  }
  const flow = { state: crypto.randomBytes(16).toString('base64url'), nonce: crypto.randomBytes(16).toString('base64url'), next: safeNext(req.query.next, '') };
  res.cookie(GOOGLE_COOKIE, Buffer.from(JSON.stringify(flow)).toString('base64url'), googleCookieOptions(req));
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${req.protocol}://${req.get('host')}/auth/google/callback`,
    response_type: 'id_token',
    scope: 'openid email profile',
    nonce: flow.nonce,
    state: flow.state,
    prompt: 'select_account',
    hl: 'ar',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/auth/google/callback', (req, res) => {
  authPage(res, 'auth/google-callback', { pageTitle: 'تسجيل الدخول عبر Google' });
});

router.post('/auth/google', googleLimiter, async (req, res) => {
  const clientId = settings.googleClientId();
  if (!clientId) return res.reply({ ok: false, message: 'تسجيل الدخول عبر Google غير مفعّل حالياً' });
  const flow = readGoogleFlow(req);
  res.clearCookie(GOOGLE_COOKIE, { path: '/' });
  const credential = str(req.body.credential);
  if (!credential || !flow || !sameSecret(str(req.body.state), flow.state)) {
    return res.reply({ ok: false, message: 'انتهت صلاحية محاولة الدخول عبر Google، ابدأ من جديد' });
  }

  let payload;
  try {
    oauthClient = oauthClient || new OAuth2Client();
    const ticket = await oauthClient.verifyIdToken({ idToken: credential, audience: clientId });
    payload = ticket.getPayload();
  } catch {
    return res.reply({ ok: false, message: 'تعذّر التحقق من حساب Google، حاول مرة أخرى' });
  }
  if (!payload || !sameSecret(payload.nonce, flow.nonce)) return res.reply({ ok: false, message: 'تعذّر التحقق من حساب Google، حاول مرة أخرى' });
  if (!payload.sub || !payload.email || !payload.email_verified) {
    return res.reply({ ok: false, message: 'يجب أن يكون البريد الإلكتروني في حساب Google موثّقاً' });
  }

  const existing = get('SELECT is_blocked FROM users WHERE google_sub = ? OR email = ? ORDER BY google_sub = ? DESC LIMIT 1', payload.sub, payload.email.toLowerCase(), payload.sub);
  if (existing && existing.is_blocked) return res.reply({ ok: false, message: 'تم إيقاف هذا الحساب. تواصل مع الدعم لمزيد من التفاصيل.' });
  const result = resolveGoogleUser(payload);
  if (result.error) return res.reply({ ok: false, message: result.error });
  const user = result.user;

  startSession(req, res, user.id);
  const next = safeNext(flow.next, '');
  if (!user.wa_e164) {
    return res.reply({
      ok: true,
      message: result.reset ? 'تم ربط حسابك بـ Google. لحماية حسابك أعد إدخال رقم الواتساب، ويمكنك تعيين كلمة مرور جديدة من الملف الشخصي.' : null,
      redirect: '/auth/complete-profile' + (next ? '?next=' + encodeURIComponent(next) : ''),
    });
  }
  res.reply({ ok: true, message: `مرحباً يا ${firstName(user.name)} 👋`, redirect: next || homeFor(user) });
});

/* ---------- Mandatory WhatsApp number ---------- */
router.get('/auth/complete-profile', requireAuth, (req, res) => {
  if (req.user.wa_e164) return res.redirect(safeNext(req.query.next, homeFor(req.user)));
  authPage(res, 'auth/complete-profile', { pageTitle: 'إكمال بيانات الحساب', next: safeNext(req.query.next, ''), needFlags: true });
});

router.post('/auth/complete-profile', requireAuth, (req, res) => {
  const name = clean(req.body.name, 80) || req.user.name;
  const wa = normalizeWhatsapp(clean(req.body.wa_country, 10), str(req.body.wa_number));
  const errors = {};
  if (name.length < 3) errors.name = 'اكتب اسمك الكامل (3 أحرف على الأقل)';
  if (wa.error) errors.wa_number = wa.error;
  if (Object.keys(errors).length) return res.reply({ ok: false, errors });
  run('UPDATE users SET name = ?, wa_country = ?, wa_dial = ?, wa_number = ?, wa_e164 = ? WHERE id = ?', name, wa.country, wa.dial, wa.number, wa.e164, req.user.id);
  res.reply({ ok: true, message: 'تم حفظ بياناتك، أهلاً بك في المتجر 🎉', redirect: safeNext(req.body.next, homeFor(req.user)) });
});

/* ---------- Logout / password help ---------- */
router.post('/logout', (req, res) => {
  endSession(req, res);
  req.flash('success', 'تم تسجيل الخروج بنجاح');
  res.redirect('/store');
});

router.get('/forgot-password', (req, res) => {
  authPage(res, 'auth/forgot', { pageTitle: 'استعادة كلمة المرور' });
});

module.exports = router;
