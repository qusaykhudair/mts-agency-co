'use strict';
const crypto = require('crypto');
const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const { get, run } = require('../db');
const { hashPassword, verifyPassword, startSession, endSession, isStaff, isProvider, resolveGoogleUser } = require('../lib/auth');
const { normalizeWhatsapp } = require('../lib/phone');
const settings = require('../lib/settings');
const emailVerify = require('../lib/email-verify');
const { str, safeNext, clean, isEmail, bool } = require('../lib/util');
const { requireAuth } = require('../middleware');
const { limiter } = require('../lib/limits');

const router = express.Router();

const loginLimiter = limiter(20, 15, 'محاولات دخول كثيرة، انتظر بضع دقائق ثم حاول مجددا');
const registerLimiter = limiter(10, 60, 'محاولات تسجيل كثيرة من هذا الجهاز، حاول لاحقا');
const googleLimiter = limiter(30, 15, 'محاولات كثيرة، حاول بعد قليل');
const verifyLimiter = limiter(30, 15, 'محاولات كثيرة، انتظر بضع دقائق ثم حاول مرة أخرى');
const codeLimiter = limiter(10, 60, 'طلبت أكوادا كثيرة، حاول بعد قليل');

const homeFor = (user) => (isStaff(user) ? '/seller' : isProvider(user) ? '/provider' : '/account');
const verifyUrl = (next) => '/auth/verify-email' + (next ? '?next=' + encodeURIComponent(next) : '');
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
  if (!isEmail(email)) errors.email = 'أدخل بريدا إلكترونيا صحيحا';
  if (!password) errors.password = 'أدخل كلمة المرور';
  if (Object.keys(errors).length) return res.reply({ ok: false, errors });

  const user = get('SELECT * FROM users WHERE email = ?', email);
  let valid = false;
  if (user && user.password_hash) valid = await verifyPassword(password, user.password_hash);
  else await burnTime(password);
  if (!valid) {
    const message =
      user && !user.password_hash && user.google_sub
        ? 'هذا الحساب مسجل عبر Google، ادخل بزر «المتابعة باستخدام Google»'
        : 'البريد الإلكتروني أو كلمة المرور غير صحيحة';
    return res.reply({ ok: false, message, errors: { password: message } });
  }
  if (user.is_blocked) return res.reply({ ok: false, message: 'تم إيقاف هذا الحساب. تواصل مع الدعم لمزيد من التفاصيل.' });

  startSession(req, res, user.id);
  if (emailVerify.required(user)) {
    // Signed up but never confirmed the e-mail: send a code unless one is already waiting.
    const sent = await emailVerify.ensureCode(user);
    if (!sent.ok && !sent.wait) req.flash('error', sent.message);
    return res.reply({ ok: true, redirect: verifyUrl(next) });
  }
  const redirect = user.wa_e164 ? next || homeFor(user) : '/auth/complete-profile' + (next ? '?next=' + encodeURIComponent(next) : '');
  res.reply({ ok: true, message: `أهلا بعودتك يا ${firstName(user.name)}`, redirect });
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
  if (!isEmail(email)) errors.email = 'أدخل بريدا إلكترونيا صحيحا';
  else if (get('SELECT id FROM users WHERE email = ?', email)) errors.email = 'هذا البريد مسجل مسبقا، يمكنك تسجيل الدخول مباشرة';
  if (password.length < 8) errors.password = 'كلمة المرور يجب أن تكون 8 أحرف على الأقل';
  else if (password.length > 128) errors.password = 'كلمة المرور طويلة جدا';
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
    if (/UNIQUE/i.test(err.message)) return res.reply({ ok: false, errors: { email: 'هذا البريد مسجل مسبقا' } });
    throw err;
  }
  startSession(req, res, userId);
  const user = get('SELECT * FROM users WHERE id = ?', userId);
  if (emailVerify.required(user)) {
    const sent = await emailVerify.sendCode(user, { force: true });
    if (!sent.ok) req.flash('error', sent.message);
    return res.reply({ ok: true, message: sent.ok ? 'أرسلنا كود التأكيد إلى بريدك' : null, redirect: verifyUrl(next || '/store') });
  }
  res.reply({ ok: true, message: `أهلا بك يا ${firstName(name)}، حسابك جاهز`, redirect: next || '/store' });
});

/* ---------- E-mail verification (6-digit code) ---------- */
router.get('/auth/verify-email', requireAuth, (req, res) => {
  const next = safeNext(req.query.next, '');
  if (!emailVerify.required(req.user)) return res.redirect(next || homeFor(req.user));
  authPage(res, 'auth/verify-email', {
    pageTitle: 'تأكيد البريد الإلكتروني',
    next,
    maskedEmail: emailVerify.maskEmail(req.user.email),
    wait: emailVerify.cooldown(req.user.id),
    hasCode: Boolean(emailVerify.activeCode(req.user)),
    minutes: emailVerify.CODE_MINUTES,
  });
});

router.post('/auth/verify-email', requireAuth, verifyLimiter, (req, res) => {
  const next = safeNext(req.body.next, '');
  if (!emailVerify.required(req.user)) return res.reply({ ok: true, redirect: next || homeFor(req.user) });
  const result = emailVerify.verify(req.user, req.body.code);
  if (!result.ok) return res.reply({ ok: false, message: result.message, errors: { code: result.message } });
  res.reply({ ok: true, message: `تم تأكيد بريدك، أهلا بك يا ${firstName(req.user.name)}`, redirect: next || homeFor(req.user) });
});

router.post('/auth/verify-email/resend', requireAuth, codeLimiter, async (req, res) => {
  if (!emailVerify.required(req.user)) return res.reply({ ok: true, reload: true });
  const sent = await emailVerify.sendCode(req.user);
  if (!sent.ok) return res.reply({ ok: false, message: sent.message, data: { wait: sent.wait || 0 } });
  res.reply({ ok: true, message: 'أرسلنا كودا جديدا إلى بريدك', data: { wait: sent.wait } });
});

// A typo in the address at sign-up: fix it here and the code goes to the new address.
router.post('/auth/verify-email/change', requireAuth, codeLimiter, async (req, res) => {
  if (!emailVerify.required(req.user)) return res.reply({ ok: true, reload: true });
  const email = clean(req.body.email, 254).toLowerCase();
  if (!isEmail(email)) return res.reply({ ok: false, errors: { email: 'أدخل بريدا إلكترونيا صحيحا' } });
  if (email === req.user.email.toLowerCase()) return res.reply({ ok: false, errors: { email: 'هذا هو بريدك الحالي نفسه' } });
  if (get('SELECT id FROM users WHERE email = ? AND id != ?', email, req.user.id)) return res.reply({ ok: false, errors: { email: 'هذا البريد مسجل في حساب آخر' } });
  try {
    run('UPDATE users SET email = ? WHERE id = ?', email, req.user.id);
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) return res.reply({ ok: false, errors: { email: 'هذا البريد مسجل في حساب آخر' } });
    throw err;
  }
  const sent = await emailVerify.sendCode({ ...req.user, email }, { force: true });
  if (!sent.ok) {
    req.flash('error', sent.message);
    return res.reply({ ok: true, reload: true });
  }
  res.reply({ ok: true, message: 'غيرنا بريدك وأرسلنا الكود إليه', reload: true });
});

/* ---------- Google ----------
 * Our own button opens Google's sign-in popup (Google Identity Services token client), which needs only the
 * site's JavaScript origin in Google Console; the server checks the access token with Google (POST
 * /auth/google/token). Without Google's script or when the popup is blocked, the button falls back to the
 * redirect flow (OpenID Connect, response_type=id_token): Google returns to /auth/google/callback with the ID
 * token in the URL fragment and that page posts it to /auth/google. That flow needs the callback URL in
 * Google Console; a short-lived cookie carries its state (anti-CSRF), nonce (anti-replay) and next page. */
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

async function googleJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Google answered ${res.status}`);
  return res.json();
}

// Profile behind an access token from the popup. The token must have been issued to this site's client ID,
// so a token obtained by another app cannot be replayed here.
async function googleProfile(accessToken, clientId) {
  const info = await googleJson(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
  if (info.aud !== clientId || !(Number(info.expires_in) > 0)) throw new Error('Token was not issued for this client');
  const me = await googleJson('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!me.sub || me.sub !== info.sub) throw new Error('Profile does not match the token');
  return { sub: me.sub, email: me.email, email_verified: me.email_verified === true || me.email_verified === 'true', name: me.name, picture: me.picture };
}

// Shared by both flows once Google has vouched for the profile.
function finishGoogleSignIn(req, res, payload, next) {
  if (!payload.sub || !payload.email || !payload.email_verified) {
    return res.reply({ ok: false, message: 'يجب أن يكون البريد الإلكتروني في حساب Google موثقا' });
  }
  const existing = get('SELECT is_blocked FROM users WHERE google_sub = ? OR email = ? ORDER BY google_sub = ? DESC LIMIT 1', payload.sub, payload.email.toLowerCase(), payload.sub);
  if (existing && existing.is_blocked) return res.reply({ ok: false, message: 'تم إيقاف هذا الحساب. تواصل مع الدعم لمزيد من التفاصيل.' });
  const result = resolveGoogleUser(payload);
  if (result.error) return res.reply({ ok: false, message: result.error });
  const user = result.user;

  startSession(req, res, user.id);
  if (!user.wa_e164) {
    return res.reply({
      ok: true,
      message: result.reset ? 'تم ربط حسابك بـ Google. لحماية حسابك أعد إدخال رقم الواتساب، ويمكنك تعيين كلمة مرور جديدة من الملف الشخصي.' : null,
      redirect: '/auth/complete-profile' + (next ? '?next=' + encodeURIComponent(next) : ''),
    });
  }
  res.reply({ ok: true, message: `أهلا يا ${firstName(user.name)}`, redirect: next || homeFor(user) });
}

router.post('/auth/google/token', googleLimiter, async (req, res) => {
  const clientId = settings.googleClientId();
  if (!clientId) return res.reply({ ok: false, message: 'تسجيل الدخول عبر Google غير مفعل حاليا' });
  const accessToken = str(req.body.access_token);
  if (!accessToken || accessToken.length > 4096) return res.reply({ ok: false, message: 'تعذر التحقق من حساب Google، حاول مرة أخرى' });
  let profile;
  try {
    profile = await googleProfile(accessToken, clientId);
  } catch {
    return res.reply({ ok: false, message: 'تعذر التحقق من حساب Google، حاول مرة أخرى' });
  }
  finishGoogleSignIn(req, res, profile, safeNext(req.body.next, ''));
});

router.get('/auth/google/start', googleLimiter, (req, res) => {
  const clientId = settings.googleClientId();
  if (!clientId) {
    req.flash('error', 'تسجيل الدخول عبر Google غير مفعل حاليا');
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
  if (!clientId) return res.reply({ ok: false, message: 'تسجيل الدخول عبر Google غير مفعل حاليا' });
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
    return res.reply({ ok: false, message: 'تعذر التحقق من حساب Google، حاول مرة أخرى' });
  }
  if (!payload || !sameSecret(payload.nonce, flow.nonce)) return res.reply({ ok: false, message: 'تعذر التحقق من حساب Google، حاول مرة أخرى' });
  finishGoogleSignIn(req, res, payload, safeNext(flow.next, ''));
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
  res.reply({ ok: true, message: 'حفظنا بياناتك، أهلا بك في المتجر', redirect: safeNext(req.body.next, homeFor(req.user)) });
});

/* ---------- Logout / password help ---------- */
router.post('/logout', (req, res) => {
  endSession(req, res);
  req.flash('success', 'تم تسجيل الخروج');
  res.redirect('/store');
});

router.get('/forgot-password', (req, res) => {
  authPage(res, 'auth/forgot', { pageTitle: 'استعادة كلمة المرور' });
});

module.exports = router;
