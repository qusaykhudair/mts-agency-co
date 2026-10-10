'use strict';
// E-mail verification with a 6-digit code. Only the salted hash of a code is stored; a code works once,
// expires after CODE_MINUTES, and locks after MAX_ATTEMPTS wrong tries. Verification is required only
// while outgoing mail is configured, so the store keeps working before the Gmail keys are added.
const crypto = require('crypto');
const path = require('path');
const ejs = require('ejs');
const { get, run, tx, fromSql } = require('../db');
const config = require('../config');
const settings = require('./settings');
const mail = require('./mail');
const { waLink } = require('./phone');
const { toLatinDigits } = require('./money');

const CODE_MINUTES = 15;
const MAX_ATTEMPTS = 5;
const COOLDOWN_SECONDS = 60;
const MAX_PER_HOUR = 5;

const required = (user) => Boolean(user && !user.email_verified_at && mail.isConfigured());

function hashCode(code, salt = crypto.randomBytes(12).toString('base64url')) {
  return `${salt}$${crypto.createHash('sha256').update(`${salt}:${code}`).digest('base64url')}`;
}

function matches(code, stored) {
  const a = Buffer.from(hashCode(code, String(stored).split('$')[0]));
  const b = Buffer.from(String(stored));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// "qu••••@gmail.com": enough to recognise the address without showing all of it.
function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  if (!domain) return email;
  const shown = name.length > 3 ? name.slice(0, 2) : name.slice(0, 1);
  return `${shown}${'•'.repeat(Math.min(6, Math.max(2, name.length - shown.length)))}@${domain}`;
}

const lastCode = (userId) => get('SELECT * FROM email_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1', userId);

// Seconds before another code may be sent (0 = now).
function cooldown(userId) {
  const last = lastCode(userId);
  if (!last) return 0;
  return Math.max(0, Math.ceil(COOLDOWN_SECONDS - (Date.now() - fromSql(last.created_at).getTime()) / 1000));
}

// The code waiting to be typed in, if it is still usable.
function activeCode(user) {
  const row = lastCode(user.id);
  if (!row || row.used_at || row.attempts >= MAX_ATTEMPTS || row.email.toLowerCase() !== user.email.toLowerCase()) return null;
  return fromSql(row.expires_at).getTime() > Date.now() ? row : null;
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

async function message(user, code) {
  const s = settings.getAll();
  const data = {
    name: firstName(user.name),
    code,
    minutes: CODE_MINUTES,
    storeName: s.store_name,
    appUrl: config.appUrl,
    waUrl: waLink(s.whatsapp_number),
  };
  const html = await ejs.renderFile(path.join(config.root, 'views', 'emails', 'verify-code.ejs'), data);
  const text = [
    `أهلا ${data.name}،`,
    '',
    `كود تأكيد بريدك في ${data.storeName}: ${code}`,
    `ينتهي الكود بعد ${CODE_MINUTES} دقيقة، ويعمل مرة واحدة فقط.`,
    data.appUrl ? `${data.appUrl}/auth/verify-email` : '',
    '',
    `لم تنشئ حسابا في ${data.storeName}؟ تجاهل هذه الرسالة، فلن يتفعل أي حساب ببريدك دون هذا الكود.`,
  ].join('\n');
  return {
    to: user.email,
    subject: `${code} هو كود تأكيد بريدك في ${data.storeName}`,
    text,
    html,
    attachments: [{ filename: 'mts.png', path: path.join(config.root, 'public', 'img', 'logo-wordmark.png'), cid: 'logo@mts' }],
  };
}

/**
 * Creates a new code, retires the previous one and e-mails it. `force` skips the one-minute wait
 * (used after the address is corrected); the hourly cap always applies.
 */
async function sendCode(user, { force = false } = {}) {
  if (!force) {
    const wait = cooldown(user.id);
    if (wait) return { ok: false, wait, message: `انتظر ${wait} ثانية ثم اطلب كودا جديدا` };
  }
  const recent = get("SELECT COUNT(*) AS n FROM email_codes WHERE user_id = ? AND created_at > datetime('now', '-1 hour')", user.id).n;
  if (recent >= MAX_PER_HOUR) return { ok: false, message: 'طلبت أكوادا كثيرة خلال ساعة. انتظر قليلا ثم حاول مرة أخرى' };

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const id = tx(() => {
    run("UPDATE email_codes SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL", user.id);
    return Number(
      run("INSERT INTO email_codes (user_id, email, code_hash, expires_at) VALUES (?, ?, ?, datetime('now', ?))", user.id, user.email, hashCode(code), `+${CODE_MINUTES} minutes`)
        .lastInsertRowid,
    );
  });
  const sent = await mail.send(await message(user, code));
  if (!sent.ok) {
    run('DELETE FROM email_codes WHERE id = ?', id);
    return { ok: false, message: 'لم نتمكن من إرسال الكود الآن. حاول مرة أخرى بعد قليل' };
  }
  return { ok: true, wait: COOLDOWN_SECONDS };
}

// Sends a code unless one is already waiting (used after login, so reloading does not flood the inbox).
const ensureCode = (user) => (activeCode(user) ? Promise.resolve({ ok: true }) : sendCode(user));

const attemptsLeft = (n) => (n === 1 ? 'محاولة واحدة' : n === 2 ? 'محاولتان' : `${n} محاولات`);

function verify(user, input) {
  const code = toLatinDigits(String(input || '')).replace(/\D/g, '');
  if (code.length !== 6) return { ok: false, message: 'اكتب الكود كاملا، 6 أرقام' };
  const row = lastCode(user.id);
  if (!row || row.used_at || row.email.toLowerCase() !== user.email.toLowerCase() || fromSql(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, message: 'انتهت صلاحية هذا الكود. اطلب كودا جديدا' };
  }
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, message: 'أخطأت في الكود عدة مرات. اطلب كودا جديدا' };
  if (!matches(code, row.code_hash)) {
    run('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    const left = MAX_ATTEMPTS - row.attempts - 1;
    return { ok: false, message: left > 0 ? `الكود غير صحيح. باقي لك ${attemptsLeft(left)}` : 'الكود غير صحيح. اطلب كودا جديدا' };
  }
  tx(() => {
    run("UPDATE email_codes SET used_at = datetime('now') WHERE id = ?", row.id);
    run("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?", user.id);
  });
  return { ok: true };
}

const markVerified = (userId) => run("UPDATE users SET email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE id = ?", userId);

module.exports = { CODE_MINUTES, MAX_ATTEMPTS, COOLDOWN_SECONDS, required, maskEmail, cooldown, activeCode, sendCode, ensureCode, verify, markVerified, message };
