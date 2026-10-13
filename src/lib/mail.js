'use strict';
// Outgoing e-mail. Transport, in order of preference:
//   gmail  - Gmail API over HTTPS (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN). Works on every Railway plan.
//   smtp   - any SMTP server (SMTP_HOST/USER/PASS, e.g. Gmail with an app password). Railway allows SMTP on Pro only.
//   outbox - MAIL_TRANSPORT=outbox writes each message to data/outbox for a local preview.
//   off    - nothing configured: nothing is sent and e-mail verification stays switched off.
// A configured gmail/smtp transport only counts as usable once a live check has passed (startChecks), so a host
// that blocks SMTP leaves verification off instead of locking new customers out. Tests use useMemoryTransport().
const fs = require('fs');
const path = require('path');
const MailComposer = require('nodemailer/lib/mail-composer');
const config = require('../config');

let memory = null;
let gmailClient = null;
let smtpTransport = null;
// Result of the last live check of the configured transport.
const health = { status: 'unknown', error: null, checkedAt: null };
let timer = null;

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

async function sendGmail(raw) {
  const { token } = await gmail().getAccessToken();
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: raw.toString('base64url') }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

function writeOutbox(raw, message) {
  const dir = path.join(config.dataDir, 'outbox');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${Date.now()}-${String(message.to).replace(/[^a-z0-9@._-]/gi, '_')}`);
  fs.writeFileSync(`${base}.eml`, raw);
  if (message.html) fs.writeFileSync(`${base}.html`, message.html);
}

const scrub = (text) => {
  const secrets = [config.mail.smtp.pass, config.mail.gmail.clientSecret, config.mail.gmail.refreshToken].filter(Boolean);
  return secrets.reduce((s, secret) => s.split(secret).join('***'), String(text || '')).slice(0, 300);
};

/** Signs in to the configured transport without sending anything. Resolves to the new status. */
async function check() {
  const name = transportName();
  if (!needsCheck(name)) return status();
  try {
    if (name === 'smtp') await smtp().verify();
    else await gmail().getAccessToken();
    health.status = 'ready';
    health.error = null;
  } catch (err) {
    health.status = 'failed';
    health.error = scrub(err.code ? `${err.code}: ${err.message}` : err.message);
    console.warn(`[mail] ${name} is not reachable, so e-mail verification stays off: ${health.error}`);
  }
  health.checkedAt = new Date();
  return status();
}

// Checks now, then hourly while working and every ten minutes while not.
function startChecks() {
  if (timer || !needsCheck(transportName())) return;
  const loop = async () => {
    const before = health.status;
    await check();
    if (health.status === 'ready' && before !== 'ready') console.log(`[mail] ${transportName()} is ready: e-mail verification is on.`);
    timer = setTimeout(loop, health.status === 'ready' ? 3600000 : 600000);
    timer.unref();
  };
  loop();
}

/**
 * Sends one message: { to, subject, text, html, attachments }. Resolves to { ok: true } or
 * { ok: false, error } and never throws, so a mail failure cannot break the request that triggered it.
 */
async function send(message) {
  const name = transportName();
  try {
    if (name === 'off') return { ok: false, error: 'mail is not configured' };
    if (name === 'memory') {
      memory.push(message);
      return { ok: true };
    }
    if (name === 'smtp') {
      await smtp().sendMail({ ...message, from: fromAddress() });
      return { ok: true };
    }
    const raw = await build(message);
    if (name === 'gmail') await sendGmail(raw);
    else writeOutbox(raw, message);
    return { ok: true };
  } catch (err) {
    const error = scrub(err.message);
    console.error(`[mail] sending to ${message.to} through ${name} failed: ${error}`);
    // A connection or sign-in failure means nothing else will get through either: switch verification
    // off until the next successful check, so new customers are not stuck waiting for a code.
    if (needsCheck(name) && /ECONN|ETIMEDOUT|ESOCKET|EAUTH|ENOTFOUND|EAI_AGAIN|timeout|invalid_grant|401|403/i.test(`${err.code} ${err.message}`)) {
      health.status = 'failed';
      health.error = error;
    }
    return { ok: false, error };
  }
}

// Tests: capture messages instead of sending them. Returns the array that receives them.
function useMemoryTransport() {
  memory = [];
  return memory;
}
function useRealTransport() {
  memory = null;
}

module.exports = { send, check, startChecks, isConfigured, status, transportName, useMemoryTransport, useRealTransport, build, health };
