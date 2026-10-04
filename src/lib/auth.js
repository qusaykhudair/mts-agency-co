'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const { get, run, toSql } = require('../db');
const config = require('../config');

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'mts_sid';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [algo, N, r, p, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function cookieOptions(req, maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: '/',
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const maxAge = config.sessionDays * 86400000;
  run(
    'INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
    sha256(token),
    userId,
    toSql(new Date(Date.now() + maxAge)),
    req.ip || null,
    String(req.get('user-agent') || '').slice(0, 300),
  );
  run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", userId);
  res.cookie(SESSION_COOKIE, token, cookieOptions(req, maxAge));
}

function endSession(req, res) {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (token) run('DELETE FROM sessions WHERE id = ?', sha256(token));
  res.clearCookie(SESSION_COOKIE, cookieOptions(req));
}

function endAllSessions(userId, exceptToken) {
  if (exceptToken) run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', userId, sha256(exceptToken));
  else run('DELETE FROM sessions WHERE user_id = ?', userId);
}

function loadUser(req, res, next) {
  req.user = null;
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (token) {
    const row = get(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > datetime('now')`,
      sha256(token),
    );
    if (row && !row.is_blocked) {
      req.user = row;
    } else {
      res.clearCookie(SESSION_COOKIE, cookieOptions(req));
    }
  }
  res.locals.user = req.user;
  next();
}

function purgeExpiredSessions() {
  run("DELETE FROM sessions WHERE expires_at <= datetime('now')");
}

const isStaff = (user) => !!user && (user.role === 'admin' || user.role === 'seller');
const isAdmin = (user) => !!user && user.role === 'admin';

/**
 * Find or create the account for a verified Google identity ({ sub, email, name, picture }).
 * E-mail registration is not verified, so when Google proves who owns an address that an existing
 * non-admin account claims, that account is handed to the Google owner: the old password and
 * WhatsApp number are cleared and every session is ended. Admin accounts are created by the
 * operator, so they are linked as they are.
 */
function resolveGoogleUser(payload) {
  const email = String(payload.email).toLowerCase();
  const picture = typeof payload.picture === 'string' ? payload.picture : null;
  let user = get('SELECT * FROM users WHERE google_sub = ?', payload.sub);
  if (user) return { user };

  user = get('SELECT * FROM users WHERE email = ?', email);
  if (user) {
    if (user.google_sub) return { error: 'هذا البريد مرتبط بحساب Google آخر' };
    if (user.role === 'admin') {
      run('UPDATE users SET google_sub = ?, avatar_url = COALESCE(avatar_url, ?) WHERE id = ?', payload.sub, picture, user.id);
      return { user: get('SELECT * FROM users WHERE id = ?', user.id), linked: true };
    }
    run(
      `UPDATE users SET google_sub = ?, avatar_url = COALESCE(avatar_url, ?), password_hash = NULL,
         wa_country = NULL, wa_dial = NULL, wa_number = NULL, wa_e164 = NULL WHERE id = ?`,
      payload.sub,
      picture,
      user.id,
    );
    endAllSessions(user.id);
    return { user: get('SELECT * FROM users WHERE id = ?', user.id), linked: true, reset: true };
  }

  const name = String(payload.name || email.split('@')[0]).trim().slice(0, 80) || email.split('@')[0];
  const id = Number(run('INSERT INTO users (name, email, google_sub, avatar_url) VALUES (?, ?, ?, ?)', name, email, payload.sub, picture).lastInsertRowid);
  return { user: get('SELECT * FROM users WHERE id = ?', id), created: true };
}

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  startSession,
  endSession,
  endAllSessions,
  loadUser,
  purgeExpiredSessions,
  isStaff,
  isAdmin,
  resolveGoogleUser,
};
