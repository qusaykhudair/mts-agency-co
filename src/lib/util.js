'use strict';
const { toLatinDigits } = require('./money');

// Request fields can be strings, arrays or (from multer) null-prototype objects; only scalars are accepted.
function str(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

// Only same-site relative redirects ("/path?x#y"). Rejects "//evil.com", "/\evil.com" and
// control characters such as "/\t/evil.com" that browsers strip when navigating.
const LOCAL_ORIGIN = 'http://local.invalid';
function safeNext(next, fallback = '/store') {
  const s = str(next);
  if (!s.startsWith('/') || /[\u0000-\u001F\u007F\\]/.test(s)) return fallback;
  try {
    const url = new URL(s, LOCAL_ORIGIN);
    if (url.origin !== LOCAL_ORIGIN) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

// Trimmed single-line string capped at `max` characters.
function clean(value, max = 200) {
  return str(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

// Multi-line text: normalises line endings and collapses runs of blank lines.
function cleanText(value, max = 5000) {
  return str(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

const lines = (value, max = 40) =>
  cleanText(value, 8000)
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-•*]|\d{1,2}[.)])\s+/, '').trim())
    .filter(Boolean)
    .slice(0, max);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const isEmail = (s) => EMAIL_RE.test(str(s)) && str(s).length <= 254;

function int(value, { min = -Infinity, max = Infinity, fallback = null } = {}) {
  const n = Number.parseInt(toLatinDigits(str(value)), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const bool = (value) => value === true || value === '1' || value === 'on' || value === 'true' || value === 1;

// Safe lookup in a constant map: own keys only ("constructor", "__proto__"… are ignored).
const pick = (map, key) => (typeof key === 'string' && Object.hasOwn(map, key) ? key : null);

const HEX_RE = /^#[0-9a-f]{6}$/i;
const color = (value, fallback) => (HEX_RE.test(str(value)) ? str(value).toLowerCase() : fallback);

// Accept "fa-solid fa-robot" style class lists only.
const icon = (value, fallback) => (/^(fa-[a-z0-9-]+\s*){1,4}$/.test(str(value).trim()) ? str(value).trim() : fallback);

// Up to `max` web links (http/https), one per line or as an array. A bare "example.com" gets https://.
function urls(value, max = 10) {
  const raw = Array.isArray(value) ? value.map(str) : str(value).split(/[\r\n]+/);
  const links = [];
  for (const item of raw) {
    const s = clean(item, 500);
    if (!s) continue;
    let url;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s);
    } catch {
      url = null;
    }
    if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) return { error: 'رابط غير صالح: ' + s.slice(0, 60) };
    if (links.length >= max) return { error: 'يمكنك إضافة ' + max + ' روابط كحد أقصى' };
    links.push(url.href);
  }
  return { links };
}

module.exports = { str, safeNext, clean, cleanText, lines, isEmail, int, bool, pick, color, icon, urls, toLatinDigits };
