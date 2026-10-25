'use strict';
// Outgoing e-mail. Transport, in order of preference:
//   gmail  - Gmail API over HTTPS (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN). Works on every Railway plan.
//   smtp   - any SMTP server (SMTP_HOST/USER/PASS, e.g. Gmail with an app password). Railway allows SMTP on Pro only.
//   outbox - MAIL_TRANSPORT=outbox writes each message to data/outbox for a local preview.
//   off    - nothing configured: nothing is sent and e-mail verification stays switched off.
// A configured gmail/smtp transport only counts as usable once a live check has passed (startChecks), so a broken
// setup leaves verification off instead of locking new customers out. The Gmail check asks Gmail to send an empty
// message: Gmail turns it down as empty only after it has accepted the token, the permission to send and the API
// being enabled for the Google Cloud project, so every setup problem shows and nothing is ever sent.
// Every message is written to mail_log for the admin's mail card. Tests use useMemoryTransport().
const fs = require('fs');
const path = require('path');
const MailComposer = require('nodemailer/lib/mail-composer');
const config = require('../config');
const { all, run } = require('../db');

const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const HOUR = 3600000;

let memory = null;
let gmailClient = null;
let smtpTransport = null;
// The last check, or the last message when that is newer. reason is a code the admin page explains;
// until holds checks back while Gmail's daily sending limit is used up.
const health = { status: 'unknown', reason: null, error: null, project: null, checkedAt: null, lastSentAt: null, until: 0 };
let timer = null;
let firstCheck = null;
const retry = { ms: 1500 };

function transportName() {
  if (memory) return 'memory';
  const { gmail, smtp, transport, from } = config.mail;
  if (gmail.clientId && gmail.clientSecret && gmail.refreshToken && from) return 'gmail';
  if (smtp.host && smtp.user && smtp.pass) return 'smtp';
  if (transport === 'outbox') return 'outbox';
  return 'off';
}

const needsCheck = (name) => name === 'gmail' || name === 'smtp';

// True when codes can actually be delivered right now.
function isConfigured() {
  const name = transportName();
  if (name === 'off') return false;
  return needsCheck(name) ? health.status === 'ready' : true;
}

// For /healthz: "smtp", "smtp-unreachable", "gmail-checking", "off"… never a secret.
function status() {
  const name = transportName();
  if (!needsCheck(name)) return name;
  return health.status === 'ready' ? name : health.status === 'failed' ? `${name}-unreachable` : `${name}-checking`;
}

// Problems someone has to fix in Google Cloud, Railway or the mail account. Anything else may pass on its own.
const NEEDS_FIX = new Set(['api-disabled', 'scope', 'revoked', 'client', 'mailbox', 'login']);

function reasonOf(err) {
  const text = `${err.code || ''} ${err.reason || ''} ${err.message || ''}`;
  if (/SERVICE_DISABLED|accessNotConfigured|has not been used in project/i.test(text)) return 'api-disabled';
  if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(text)) return 'scope';
  if (/invalid_grant/i.test(text)) return 'revoked';
  if (/invalid_client|unauthorized_client|deleted_client/i.test(text)) return 'client';
  if (/failedPrecondition|Mail service not enabled/i.test(text)) return 'mailbox';
  if (/dailyLimitExceeded|quotaExceeded|rateLimitExceeded|(Gmail|Drive) API 429/i.test(text)) return 'quota';
  if (/EAUTH|Invalid login|\b53[45]\b/i.test(text)) return 'login';
  if (/(Gmail|Drive) API 401|UNAUTHENTICATED|invalid_token/i.test(text)) return 'revoked';
  if (/ECONN|ETIMEDOUT|ESOCKET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|timeout|timed out|aborted|fetch failed|socket hang up|(Gmail|Drive) API 5\d\d/i.test(text)) return 'network';
  return 'other';
}

// The Google Cloud project behind the client ID ("290156006782-abc.apps…"), for the link that enables the API.
const projectNumber = () => (/^(\d+)-/.exec(config.mail.gmail.clientId) || [])[1] || null;

const scrub = (text) => {
  const secrets = [config.mail.smtp.pass, config.mail.gmail.clientSecret, config.mail.gmail.refreshToken].filter(Boolean);
  return secrets.reduce((s, secret) => s.split(secret).join('***'), String(text || '')).slice(0, 300);
};

function markReady() {
  Object.assign(health, { status: 'ready', reason: null, error: null, project: null, until: 0 });
}

function markFailed(err) {
  const reason = reasonOf(err);
  Object.assign(health, {
    status: 'failed',
    reason,
    error: scrub(err.code ? `${err.code}: ${err.message}` : err.message),
    project: err.project || projectNumber(),
    // The empty-message check would pass while the day's limit is used up, so it waits an hour instead.
    until: reason === 'quota' ? Date.now() + HOUR : 0,
  });
}

function fromAddress() {
  const address = config.mail.from || config.mail.smtp.user || 'no-reply@localhost';
  return { name: config.mail.fromName, address };
}

function build(message) {
  return new Promise((resolve, reject) => {
    new MailComposer({ ...message, from: fromAddress() }).compile().build((err, raw) => (err ? reject(err) : resolve(raw)));
  });
}

function gmail() {
  if (!gmailClient) {
    const { OAuth2Client } = require('google-auth-library');
    gmailClient = new OAuth2Client(config.mail.gmail.clientId, config.mail.gmail.clientSecret);
    gmailClient.setCredentials({ refresh_token: config.mail.gmail.refreshToken });
  }
  return gmailClient;
}

function smtp() {
  if (!smtpTransport) {
    const s = config.mail.smtp;
    smtpTransport = require('nodemailer').createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      auth: { user: s.user, pass: s.pass },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
    });
  }
  return smtpTransport;
}

async function gmailPost(body, again = false) {
  const { token } = await gmail().getAccessToken();
  const res = await fetch(GMAIL_SEND, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  // A stale access token: sign in once more before calling it a failure.
  if (res.status === 401 && !again) {
    gmailClient = null;
    return gmailPost(body, true);
  }
  return res;
}

// "Gmail API 403 SERVICE_DISABLED accessNotConfigured: Gmail API has not been used in project…"
async function gmailError(res) {
  const body = await res.text();
  let reason = '';
  let message = body.replace(/\s+/g, ' ');
  let project = null;
  try {
    const { error } = JSON.parse(body);
    const info = (error.details || []).find((d) => /ErrorInfo$/.test(d['@type'] || '')) || {};
    reason = [info.reason, ...(error.errors || []).map((e) => e.reason)].filter(Boolean).join(' ');
    message = error.message || message;
    project = (/projects\/(\d+)/.exec((info.metadata && info.metadata.consumer) || '') || /project (\d+)/.exec(message) || [])[1] || null;
  } catch {
    // Not JSON: keep the raw text.
  }
  return Object.assign(new Error(`Gmail API ${res.status}${reason ? ` ${reason}` : ''}: ${message}`.slice(0, 400)), { status: res.status, reason, project });
}

async function sendGmail(raw) {
  const res = await gmailPost({ raw: raw.toString('base64url') });
  if (!res.ok) throw await gmailError(res);
  const json = await res.json().catch(() => ({}));
  return json.id || null;
}

// Gmail answers an empty message with 400 once everything else is in order; any other answer names the problem.
async function probeGmail() {
  const res = await gmailPost({});
  if (res.ok) return;
  const err = await gmailError(res);
  if (res.status === 400 && reasonOf(err) !== 'mailbox') return;
  throw err;
}

// One more try after a network hiccup or a busy Google server (a code that arrives twice does no harm).
async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (reasonOf(err) !== 'network') throw err;
    await new Promise((resolve) => setTimeout(resolve, retry.ms));
    return fn();
  }
}

/** Checks the configured transport without sending anything. Resolves to the new status. */
async function check() {
  const name = transportName();
  if (!needsCheck(name)) return status();
  if (health.until > Date.now()) return status();
  try {
    if (name === 'smtp') await smtp().verify();
    else await probeGmail();
    markReady();
  } catch (err) {
    markFailed(err);
    console.warn(`[mail] ${name} cannot send (${health.reason}), so e-mail verification stays off: ${health.error}`);
  }
  health.checkedAt = new Date();
  return status();
}

// Checks now, then hourly while working and every five minutes while not.
function startChecks() {
  if (firstCheck || !needsCheck(transportName())) return firstCheck;
  const loop = async () => {
    const before = health.status;
    await check();
    if (health.status === 'ready' && before !== 'ready') console.log(`[mail] ${transportName()} is ready: e-mail verification is on.`);
    timer = setTimeout(loop, health.status === 'ready' ? HOUR : 300000);
    timer.unref();
  };
  firstCheck = loop();
  return firstCheck;
}

// Waits, a few seconds at most, for the first check after start-up, so a sign-up in that moment is not let
// through without a code only because Gmail has not answered yet.
function settled(ms = 8000) {
  if (!firstCheck || health.status !== 'unknown') return Promise.resolve();
  let wait;
  return Promise.race([firstCheck, new Promise((resolve) => (wait = setTimeout(resolve, ms)))]).finally(() => clearTimeout(wait));
}

function writeOutbox(raw, message) {
  const dir = path.join(config.dataDir, 'outbox');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${Date.now()}-${String(message.to).replace(/[^a-z0-9@._-]/gi, '_')}`);
  fs.writeFileSync(`${base}.eml`, raw);
  if (message.html) fs.writeFileSync(`${base}.html`, message.html);
}

function record(entry) {
  try {
    run(
      'INSERT INTO mail_log (kind, to_email, user_id, transport, ok, error, message_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      entry.kind,
      String(entry.to || '').slice(0, 254),
      entry.userId || null,
      entry.transport,
      entry.ok ? 1 : 0,
      entry.error || null,
      entry.messageId || null,
    );
    run("DELETE FROM mail_log WHERE created_at < datetime('now', '-90 days')");
  } catch (err) {
    console.warn(`[mail] could not log the message: ${err.message}`);
  }
}

// The latest messages, newest first, for the admin.
const recent = (limit = 12) => all('SELECT * FROM mail_log ORDER BY id DESC LIMIT ?', limit);

/**
 * Sends one message: { to, subject, text, html, attachments, kind, userId }. kind ("code", "test") and userId
 * only go to the log. Resolves to { ok: true, messageId } or { ok: false, error, reason } and never throws,
 * so a mail failure cannot break the request that triggered it.
 */
async function send(message) {
  const { kind = 'mail', userId = null, ...content } = message;
  const name = transportName();
  if (name === 'off') return { ok: false, error: 'mail is not configured', reason: 'off' };
  let messageId = null;
  try {
    if (name === 'memory') memory.push(content);
    else if (name === 'smtp') messageId = (await smtp().sendMail({ ...content, from: fromAddress() })).messageId || null;
    else {
      const raw = await build(content);
      if (name === 'gmail') messageId = await withRetry(() => sendGmail(raw));
      else writeOutbox(raw, content);
    }
  } catch (err) {
    const error = scrub(err.message);
    const reason = reasonOf(err);
    console.error(`[mail] sending to ${content.to} through ${name} failed (${reason}): ${error}`);
    if (needsCheck(name)) {
      // Settings that need fixing stop verification at once, so new customers are not left waiting for a code.
      // A failure that may pass on its own is checked again right away instead.
      if (NEEDS_FIX.has(reason) || reason === 'quota') {
        markFailed(err);
        health.checkedAt = new Date();
      } else if (reason === 'network') await check();
    }
    record({ kind, to: content.to, userId, transport: name, ok: false, error });
    return { ok: false, error, reason };
  }
  if (needsCheck(name)) {
    markReady();
    health.lastSentAt = new Date();
  }
  record({ kind, to: content.to, userId, transport: name, ok: true, messageId });
  return { ok: true, messageId };
}

// Tests: capture messages instead of sending them. Returns the array that receives them.
function useMemoryTransport() {
  memory = [];
  return memory;
}
function useRealTransport() {
  memory = null;
}
// Tests: forget the Gmail client, the last check and the check loop.
function reset() {
  gmailClient = null;
  smtpTransport = null;
  clearTimeout(timer);
  timer = null;
  firstCheck = null;
  Object.assign(health, { status: 'unknown', reason: null, error: null, project: null, checkedAt: null, lastSentAt: null, until: 0 });
}

module.exports = {
  send,
  check,
  startChecks,
  settled,
  isConfigured,
  status,
  transportName,
  reasonOf,
  recent,
  useMemoryTransport,
  useRealTransport,
  reset,
  build,
  health,
  retry,
};
