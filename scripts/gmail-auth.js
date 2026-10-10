'use strict';
// One-time Gmail API authorisation for sending verification codes.
// Needs GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET (an OAuth client of type "Desktop app") in .env. Opens Google's
// consent page for the gmail.send scope, then saves GMAIL_REFRESH_TOKEN (and MAIL_FROM if empty) to .env.
// The token is written to the file only, never printed.
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { OAuth2Client } = require('google-auth-library');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
try {
  process.loadEnvFile(ENV_FILE);
} catch {
  /* no .env yet */
}

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('ضع GMAIL_CLIENT_ID و GMAIL_CLIENT_SECRET في ملف .env أولا (OAuth client من نوع Desktop app).');
  process.exit(1);
}

function saveEnv(values) {
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, () => line) : `${text.replace(/\s*$/, '\n')}${line}\n`;
  }
  fs.writeFileSync(ENV_FILE, text);
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* the link is printed anyway */
  }
}

const page = (title, body) =>
  `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${title}</title></head>` +
  '<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#eef3ff;font-family:Tahoma,Arial,sans-serif;color:#0b1530">' +
  `<div style="background:#fff;border:1px solid #dce6ff;border-top:5px solid #2f6bff;border-radius:16px;padding:28px 32px;max-width:440px;text-align:center"><h2 style="margin:0 0 10px">${title}</h2><p style="margin:0;color:#475569;line-height:1.9">${body}</p></div></body></html>`;

const state = crypto.randomBytes(16).toString('base64url');
let client;
let codeVerifier;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404);
    return res.end();
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url.searchParams.get('error') || url.searchParams.get('state') !== state) {
    res.end(page('لم يكتمل الربط', 'أغلق هذه الصفحة وشغل الأمر npm run gmail-auth مرة أخرى.'));
    console.error(`لم يكتمل الربط: ${url.searchParams.get('error') || 'state mismatch'}`);
    return finish(1);
  }
  try {
    const { tokens } = await client.getToken({ code: url.searchParams.get('code'), codeVerifier });
    if (!tokens.refresh_token) {
      throw new Error('لم يرسل Google رمز التحديث. احذف وصول التطبيق من myaccount.google.com/permissions ثم أعد المحاولة.');
    }
    let email = '';
    if (tokens.id_token) {
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      email = ticket.getPayload().email || '';
    }
    const values = { GMAIL_REFRESH_TOKEN: tokens.refresh_token };
    if (email && !process.env.MAIL_FROM) values.MAIL_FROM = email;
    saveEnv(values);
    res.end(page('تم ربط Gmail', 'حفظنا المفتاح في ملف .env. أغلق هذه الصفحة وارجع إلى الطرفية.'));
    console.log(`تم الربط وحفظ GMAIL_REFRESH_TOKEN في ملف .env${email ? ` (الحساب: ${email})` : ''}.`);
    if (email && process.env.MAIL_FROM && process.env.MAIL_FROM.toLowerCase() !== email.toLowerCase()) {
      console.warn(`تنبيه: MAIL_FROM (${process.env.MAIL_FROM}) يختلف عن الحساب الذي وافقت به (${email}). اجعلهما البريد نفسه.`);
    }
    console.log('الخطوة التالية: جرب الإرسال بالأمر npm run mail-test -- بريدك@gmail.com ثم انسخ القيم إلى Variables في Railway.');
    finish(0);
  } catch (err) {
    res.end(page('لم يكتمل الربط', 'حدث خطأ أثناء الحفظ. ارجع إلى الطرفية لترى التفاصيل.'));
    console.error(`لم يكتمل الربط: ${err.message}`);
    finish(1);
  }
});

function finish(code) {
  setTimeout(() => {
    server.close();
    process.exit(code);
  }, 300);
}

server.listen(0, '127.0.0.1', async () => {
  const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
  client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const pkce = await client.generateCodeVerifierAsync();
  codeVerifier = pkce.codeVerifier;
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send'],
    state,
    code_challenge_method: 'S256',
    code_challenge: pkce.codeChallenge,
    login_hint: process.env.MAIL_FROM || undefined,
  });
  console.log('افتح هذا الرابط وسجل بحساب Gmail الذي سترسل منه الأكواد، ثم اضغط Allow:\n');
  console.log(authUrl + '\n');
  openBrowser(authUrl);
});

// Give up after ten minutes without an answer.
setTimeout(() => {
  console.error('انتهت المهلة دون موافقة. شغل الأمر مرة أخرى عندما تكون جاهزا.');
  finish(1);
}, 10 * 60 * 1000).unref();
