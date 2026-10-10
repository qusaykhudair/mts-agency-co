'use strict';
// Outgoing e-mail. Transport, in order of preference:
//   gmail  - Gmail API over HTTPS (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN). Works on every Railway plan.
//   smtp   - any SMTP server (SMTP_HOST/USER/PASS, e.g. Gmail with an app password). Railway allows SMTP on Pro only.
//   outbox - MAIL_TRANSPORT=outbox writes each message to data/outbox for a local preview.
//   off    - nothing configured: nothing is sent and e-mail verification stays switched off.
// Tests swap in an in-memory transport with useMemoryTransport().
const fs = require('fs');
const path = require('path');
const MailComposer = require('nodemailer/lib/mail-composer');
const config = require('../config');

let memory = null;
let gmailClient = null;
let smtpTransport = null;

function transportName() {
  if (memory) return 'memory';
  const { gmail, smtp, transport, from } = config.mail;
  if (gmail.clientId && gmail.clientSecret && gmail.refreshToken && from) return 'gmail';
  if (smtp.host && smtp.user && smtp.pass) return 'smtp';
  if (transport === 'outbox') return 'outbox';
  return 'off';
}

const isConfigured = () => transportName() !== 'off';

function fromAddress() {
  const address = config.mail.from || config.mail.smtp.user || 'no-reply@localhost';
  return { name: config.mail.fromName, address };
}

function build(message) {
  return new Promise((resolve, reject) => {
    new MailComposer({ ...message, from: fromAddress() }).compile().build((err, raw) => (err ? reject(err) : resolve(raw)));
  });
}

async function sendGmail(raw) {
  const { gmail } = config.mail;
  if (!gmailClient) {
    const { OAuth2Client } = require('google-auth-library');
    gmailClient = new OAuth2Client(gmail.clientId, gmail.clientSecret);
    gmailClient.setCredentials({ refresh_token: gmail.refreshToken });
  }
  const { token } = await gmailClient.getAccessToken();
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: raw.toString('base64url') }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function sendSmtp(message) {
  const { smtp } = config.mail;
  if (!smtpTransport) {
    smtpTransport = require('nodemailer').createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
      connectionTimeout: 15000,
    });
  }
  await smtpTransport.sendMail({ ...message, from: fromAddress() });
}

function writeOutbox(raw, message) {
  const dir = path.join(config.dataDir, 'outbox');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${Date.now()}-${String(message.to).replace(/[^a-z0-9@._-]/gi, '_')}`);
  fs.writeFileSync(`${base}.eml`, raw);
  if (message.html) fs.writeFileSync(`${base}.html`, message.html);
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
      await sendSmtp(message);
      return { ok: true };
    }
    const raw = await build(message);
    if (name === 'gmail') await sendGmail(raw);
    else writeOutbox(raw, message);
    return { ok: true };
  } catch (err) {
    console.error(`[mail] sending to ${message.to} through ${name} failed: ${err.message}`);
    return { ok: false, error: err.message };
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

module.exports = { send, isConfigured, transportName, useMemoryTransport, useRealTransport, build };
