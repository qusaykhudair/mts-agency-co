'use strict';
// Which Google client ID the "Continue with Google" button uses, and whether Google still accepts it.
// A deleted or unknown client makes Google show its own error page ("Error 401: deleted_client") to the customer,
// so each configured ID is checked the way the button's popup opens Google, without signing anyone in: a redirect
// to the account chooser means the client works, a redirect to /signin/oauth/error names the problem in its
// authError parameter. A client Google rejects is not offered on the site, and the admin is told how to fix it.
// The ID saved in the dashboard comes first, so a replacement can be pasted there without touching Railway;
// GOOGLE_CLIENT_ID on the server is the fallback.
const config = require('../config');
const settings = require('./settings');

const results = new Map();
let timer = null;

// Problems someone has to fix in Google Cloud. Anything else (a network error, an answer we do not know) leaves
// the button on, so a hiccup at Google never hides it.
const BROKEN = new Set(['deleted', 'missing', 'origin', 'wrong_type']);

function candidates() {
  return [settings.get('google_client_id'), config.googleClientId].map((v) => String(v || '').trim()).filter((v, i, all) => v && all.indexOf(v) === i);
}

// The address customers sign in from: APP_URL, or Railway's domain.
const siteOrigin = () => config.appUrl || '';

// authError is a base64 protobuf; the reason code is plain text inside it.
function reasonFrom(location) {
  const m = /[?&]authError=([^&]+)/.exec(location || '');
  if (!m) return '';
  const text = Buffer.from(decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
  return (/deleted_client|invalid_client|origin_mismatch|redirect_uri_mismatch|invalid_request|unauthorized_client|disabled_client/.exec(text) || [''])[0];
}

const STATUS = {
  deleted_client: 'deleted',
  invalid_client: 'missing',
  origin_mismatch: 'origin',
  redirect_uri_mismatch: 'origin',
  invalid_request: 'wrong_type',
  unauthorized_client: 'wrong_type',
  disabled_client: 'deleted',
};

/** Asks Google about one client ID. Resolves to { status, reason, checkedAt }; never throws. */
async function check(clientId, origin = siteOrigin()) {
  let result;
  if (!origin) result = { status: 'unknown', reason: 'no site address' };
  else {
    try {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: `storagerelay://${origin.replace('://', '/')}?id=auth1`,
        response_type: 'token',
        scope: 'openid email profile',
        prompt: 'select_account',
      });
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      const location = res.headers.get('location') || '';
      const reason = reasonFrom(location);
      if (reason) result = { status: STATUS[reason] || 'unknown', reason };
      else if (res.status >= 300 && res.status < 400 && /accounts\.google\.com/.test(location)) result = { status: 'ready', reason: '' };
      else result = { status: 'unknown', reason: `HTTP ${res.status}` };
    } catch (err) {
      result = { status: 'unknown', reason: String(err.message || err).slice(0, 120) };
    }
  }
  result.checkedAt = new Date();
  results.set(clientId, result);
  if (BROKEN.has(result.status)) console.warn(`[google] sign-in client …${clientId.slice(-24)} does not work (${result.reason}); the Google button is hidden until it is replaced.`);
  return result;
}

const checkAll = () => Promise.all(candidates().map((id) => check(id)));

// Checks now and every six hours (an ID can be deleted in Google Cloud at any time).
function startChecks() {
  if (timer) return;
  const loop = () => checkAll().finally(() => (timer = setTimeout(loop, 6 * 3600000).unref()));
  loop();
}

const usable = (id) => !BROKEN.has((results.get(id) || {}).status);

/** The client ID the site offers: the first configured one that Google has not rejected ('' = no Google button). */
function clientId() {
  return candidates().find(usable) || '';
}

/** For the admin: every configured ID with what Google said about it, and where it comes from. */
function report() {
  const fromDashboard = String(settings.get('google_client_id') || '').trim();
  return candidates().map((id) => ({
    id,
    source: id === fromDashboard ? 'dashboard' : 'server',
    active: id === clientId(),
    ...(results.get(id) || { status: 'unknown', reason: '', checkedAt: null }),
  }));
}

/** True when an ID is configured but none of them works, so the admin must act. */
const broken = () => candidates().length > 0 && !clientId();

// Tests: forget what Google said.
function reset() {
  results.clear();
  clearTimeout(timer);
  timer = null;
}

module.exports = { candidates, check, checkAll, startChecks, clientId, report, broken, reasonFrom, reset, BROKEN };
