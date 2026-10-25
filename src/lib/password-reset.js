'use strict';
// "Forgot password" by e-mail: a 6-digit code goes to the account's address, and that code with a new password
// resets it. Only a salted hash of the code is stored; a code works once, expires after CODE_MINUTES and locks
// after MAX_ATTEMPTS wrong tries. Asking for a code answers the same whether or not the address has an account.
const crypto = require('crypto');
const path = require('path');
const ejs = require('ejs');
const { get, run, tx, fromSql } = require('../db');
const config = require('../config');
const settings = require('./settings');
const mail = require('./mail');
const { waLink } = require('./phone');
const { toLatinDigits } = require('./money');
const { hashCode, matches, attemptsLeft, CODE_MINUTES, MAX_ATTEMPTS, COOLDOWN_SECONDS } = require('./email-verify');
const { hashPassword, endAllSessions } = require('./auth');

const MAX_PER_HOUR = 5;
const lastReset = (userId) => get('SELECT * FROM password_resets WHERE user_id = ? ORDER BY id DESC LIMIT 1', userId);
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
    title: 'كود استعادة كلمة المرور',
    heading: 'استعادة كلمة المرور',
    intro: `طلبت تغيير كلمة مرور حسابك في ${s.store_name}. اكتب هذا الكود في صفحة الاستعادة مع كلمة المرور الجديدة:`,
    path: '/forgot-password/code',
    buttonLabel: 'افتح صفحة الاستعادة',
    note: 'لم تطلب تغيير كلمة المرور؟ تجاهل هذه الرسالة، فكلمة مرورك لن تتغير دون هذا الكود. ولا تعط الكود لأي شخص، ففريقنا لن يطلبه منك.',
  };
  const html = await ejs.renderFile(path.join(config.root, 'views', 'emails', 'verify-code.ejs'), data);
  const text = [
    `أهلا ${data.name}،`,
    '',
    `كود استعادة كلمة المرور في ${data.storeName}: ${code}`,
    `ينتهي الكود بعد ${CODE_MINUTES} دقيقة، ويعمل مرة واحدة فقط.`,
    data.appUrl ? `${data.appUrl}/forgot-password/code` : '',
    '',
    'لم تطلب تغيير كلمة المرور؟ تجاهل هذه الرسالة، فكلمة مرورك لن تتغير دون هذا الكود.',
  ].join('\n');
  return {
    to: user.email,
    subject: `${code} هو كود استعادة كلمة المرور في ${data.storeName}`,
    text,
    html,
    attachments: [{ filename: 'mts.png', path: path.join(config.root, 'public', 'img', 'logo-wordmark.png'), cid: 'logo@mts' }],
  };
}

/**
 * Sends a code to the account with this address, if there is one and it may ask now (one a minute, five an hour).
 * Resolves to { sent } for logging and tests; callers answer the visitor the same way whatever it says.
 */
async function request(email) {
  const user = get('SELECT * FROM users WHERE email = ?', String(email || '').trim().toLowerCase());
  if (!user || user.is_blocked) return { sent: false };
  const last = lastReset(user.id);
  if (last && Date.now() - fromSql(last.created_at).getTime() < COOLDOWN_SECONDS * 1000) return { sent: false };
  if (get("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at > datetime('now', '-1 hour')", user.id).n >= MAX_PER_HOUR) return { sent: false };

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const id = tx(() => {
    run("UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL", user.id);
    return Number(run("INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES (?, ?, datetime('now', ?))", user.id, hashCode(code), `+${CODE_MINUTES} minutes`).lastInsertRowid);
  });
  const sent = await mail.send({ ...(await message(user, code)), kind: 'reset', userId: user.id });
  if (!sent.ok) run('DELETE FROM password_resets WHERE id = ?', id);
  return { sent: sent.ok };
}

// Tells the account owner that the password changed, in case it was not them.
function notifyChanged(user) {
  const s = settings.getAll();
  const wa = waLink(s.whatsapp_number);
  return mail.send({
    to: user.email,
    subject: `تغيرت كلمة مرور حسابك في ${s.store_name}`,
    text: [
      `أهلا ${firstName(user.name)}،`,
      '',
      `غيرنا كلمة مرور حسابك في ${s.store_name} بكود الاستعادة الذي وصلك على بريدك، وسجلنا خروجك من الأجهزة الأخرى.`,
      'إن لم تكن أنت من غيرها، تواصل معنا فورا على واتساب.',
      wa || '',
    ].join('\n'),
    kind: 'notice',
    userId: user.id,
  });
}

/**
 * Checks the code for this address and sets the new password. Resolves to { ok: true, user } or { ok: false,
 * message, field } with the field the message belongs to.
 */
async function reset(email, input, password) {
  const user = get('SELECT * FROM users WHERE email = ?', String(email || '').trim().toLowerCase());
  const code = toLatinDigits(String(input || '')).replace(/\D/g, '');
  if (code.length !== 6) return { ok: false, field: 'code', message: 'اكتب الكود كاملا، 6 أرقام' };
  const row = user && !user.is_blocked ? lastReset(user.id) : null;
  if (!row || row.used_at || fromSql(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, field: 'code', message: 'هذا الكود غير صالح أو انتهت صلاحيته. اطلب كودا جديدا' };
  }
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, field: 'code', message: 'أخطأت في الكود عدة مرات. اطلب كودا جديدا' };
  if (!matches(code, row.code_hash)) {
    run('UPDATE password_resets SET attempts = attempts + 1 WHERE id = ?', row.id);
    const left = MAX_ATTEMPTS - row.attempts - 1;
    return { ok: false, field: 'code', message: left > 0 ? `الكود غير صحيح. باقي لك ${attemptsLeft(left)}` : 'الكود غير صحيح. اطلب كودا جديدا' };
  }
  const hash = await hashPassword(password);
  tx(() => {
    run("UPDATE password_resets SET used_at = datetime('now') WHERE id = ?", row.id);
    // The code came to this address, so the address is confirmed too.
    run("UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE id = ?", hash, user.id);
  });
  endAllSessions(user.id);
  notifyChanged(user).catch(() => {});
  return { ok: true, user: get('SELECT * FROM users WHERE id = ?', user.id) };
}

module.exports = { request, reset, message, MAX_PER_HOUR };
