'use strict';
// Stylesheets, scripts and SVG files from /static are served from memory: CSS is minified, and each file is
// compressed once with brotli and gzip instead of on every request. A versioned URL (?v=…) may be kept by
// browsers for a year, because a new version always comes with a new URL.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const config = require('../config');

const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const YEAR = 'public, max-age=31536000, immutable';
const DAY = 'public, max-age=86400';
const MONTH = 'public, max-age=2592000';
const cache = new Map();

// Drops comments (keeping /*! licences */) and extra whitespace. Text inside quotes is never touched.
function minifyCss(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c) j += css[j] === '\\' ? 2 : 1;
      out += css.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end < 0 ? css.length : end + 2;
      if (css[i + 2] === '!') out += css.slice(i, stop) + '\n';
      i = stop;
    } else {
      let j = i;
      while (j < css.length && css[j] !== '"' && css[j] !== "'" && !(css[j] === '/' && css[j + 1] === '*')) j++;
      out += css
        .slice(i, j)
        .replace(/\s+/g, ' ')
        .replace(/\s*([{};,>])\s*/g, '$1')
        // Only the space after a colon goes: before one it may be a descendant selector (".a :hover").
        .replace(/:\s+/g, ':')
        .replace(/;}/g, '}');
      i = j;
    }
  }
  return out.trim();
}

function compressed(body, type) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    type,
    raw,
    br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
    gzip: zlib.gzipSync(raw, { level: 9 }),
    tag: crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 16),
  };
}

function send(req, res, entry) {
  const accept = String(req.get('accept-encoding') || '');
  const encoding = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
  const etag = `"${entry.tag}${encoding ? `-${encoding}` : ''}"`;
  // While developing, files change under the same URL, so the browser asks every time.
  // Platform logos are linked without a version, so images keep a month; scripts and styles always carry one.
  const cacheControl = !config.isProd ? 'no-cache' : req.query.v ? YEAR : entry.type.startsWith('image/') ? MONTH : DAY;
  res.set({ 'Content-Type': entry.type, Vary: 'Accept-Encoding', 'Cache-Control': cacheControl, ETag: etag });
  if (req.get('if-none-match') === etag) return res.status(304).end();
  const body = encoding ? entry[encoding] : entry.raw;
  if (encoding) res.set('Content-Encoding', encoding);
  res.set('Content-Length', String(body.length));
  return res.end(req.method === 'HEAD' ? undefined : body);
}

/** Serves CSS/JS/SVG files under `root`; anything else goes on to express.static. */
function middleware(root) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const ext = path.extname(req.path).toLowerCase();
    if (!TYPES[ext]) return next();
    let file;
    try {
      file = path.join(root, decodeURIComponent(req.path));
    } catch {
      return next();
    }
    if (!file.startsWith(root + path.sep) || path.relative(root, file).split(path.sep).some((part) => part.startsWith('.'))) return next();
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return next();
    }
    if (!stat.isFile()) return next();
    let entry = cache.get(file);
    // The modification time is compared, so an edited file is picked up without a restart.
    if (!entry || entry.mtime !== stat.mtimeMs) {
      const body = fs.readFileSync(file);
      entry = { ...compressed(ext === '.css' ? minifyCss(body.toString('utf8')) : body, TYPES[ext]), mtime: stat.mtimeMs };
      cache.set(file, entry);
    }
    return send(req, res, entry);
  };
}

/** Serves text made at run time (the icon stylesheet), compressed once per version. */
function sendText(req, res, key, text, type = TYPES['.css']) {
  let entry = cache.get(key);
  if (!entry || entry.text !== text) {
    entry = { ...compressed(text, type), text };
    cache.set(key, entry);
  }
  return send(req, res, entry);
}

// Long-lived caching for fonts and images handed out by express.static.
function staticHeaders(res) {
  if (config.isProd && res.req && res.req.query && res.req.query.v) res.setHeader('Cache-Control', YEAR);
}

module.exports = { middleware, sendText, staticHeaders, minifyCss };
