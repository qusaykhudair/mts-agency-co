'use strict';
// Icons without a CDN. Pages keep Font Awesome's markup (<i class="fa-solid fa-house"></i>); this module writes the
// stylesheet behind it:
// - solid and regular icons draw from Font Awesome's own font files in /static/fonts. The stylesheet holds only the
//   icons the site uses (found in the views, scripts and database) and gives each one its exact width, so nothing
//   moves on the page when the font arrives.
// - brand icons are drawn from their SVG outline as a CSS mask, so the 117 KB brands font is never downloaded.
// The dashboard stylesheet also holds every solid and regular icon, so an icon typed into a form previews at once.
// Data: src/data/fa-icons.json, made by scripts/build-icons.js from Font Awesome Free.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const SCAN_DIRS = ['views', 'public/js', 'src'];
const FONT = '/static/fonts';

let data = null;
let scanned = null;
const cache = new Map();

function load() {
  if (!data) data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'fa-icons.json'), 'utf8'));
  return data;
}

// Every "fa-…" word in a text: names written with a style ("fa-brands fa-whatsapp") and bare ones ("fa-house").
function collect(text, into) {
  for (const m of String(text || '').matchAll(/\bfa-(solid|regular|brands)\s+fa-([a-z0-9]+(?:-[a-z0-9]+)*)/g)) {
    if (m[1] === 'brands') into.brands.add(m[2]);
    else into.names.add(m[2]);
  }
  for (const m of String(text || '').matchAll(/\bfa-([a-z0-9]+(?:-[a-z0-9]+)*)/g)) into.names.add(m[1]);
  return into;
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'data') walk(full, files);
    } else if (/\.(ejs|js)$/.test(entry.name)) files.push(full);
  }
  return files;
}

// Icons named in the code. Read once: the code only changes with a deploy.
function scanCode() {
  if (scanned) return scanned;
  const found = { names: new Set(), brands: new Set() };
  for (const dir of SCAN_DIRS) {
    const root = path.join(config.root, dir);
    if (fs.existsSync(root)) for (const file of walk(root)) collect(fs.readFileSync(file, 'utf8'), found);
  }
  scanned = found;
  return found;
}

// Icons chosen in the dashboard (categories, services, payment methods) and stored with notifications.
function scanDatabase(found) {
  const { all } = require('../db');
  const queries = [
    'SELECT DISTINCT icon FROM categories',
    'SELECT DISTINCT icon FROM services',
    'SELECT DISTINCT icon FROM payment_methods',
    'SELECT DISTINCT icon FROM notifications WHERE icon IS NOT NULL',
  ];
  for (const sql of queries) {
    try {
      for (const row of all(sql)) collect(row.icon, found);
    } catch {
      // A table that does not exist yet (fresh database before its migration) has no icons.
    }
  }
  return found;
}

const em = (units) => `${Math.round((units / 512) * 10000) / 10000}em`;

function fontRules() {
  return [
    `@font-face{font-family:"Font Awesome 6 Free";font-style:normal;font-weight:900;font-display:block;src:url(${FONT}/fa-solid-900.woff2?v=${load().version}) format("woff2")}`,
    `@font-face{font-family:"Font Awesome 6 Free";font-style:normal;font-weight:400;font-display:block;src:url(${FONT}/fa-regular-400.woff2?v=${load().version}) format("woff2")}`,
    '.fa,.fa-brands,.fa-regular,.fa-solid,.fab,.far,.fas{-moz-osx-font-smoothing:grayscale;-webkit-font-smoothing:antialiased;display:var(--fa-display,inline-block);font-style:normal;font-variant:normal;line-height:1;text-rendering:auto;text-align:center;width:1em}',
    '.fa,.fa-solid,.fas{font-family:"Font Awesome 6 Free";font-weight:900}',
    '.fa-regular,.far{font-family:"Font Awesome 6 Free";font-weight:400}',
    '.fa-brands,.fab{height:1em;vertical-align:-.125em;background-color:currentColor;-webkit-mask:var(--fa-mask) center/contain no-repeat;mask:var(--fa-mask) center/contain no-repeat}',
  ];
}

// The CSS for a set of names. Solid and regular share code points, so one rule serves both styles.
function build({ names, brands }, everything) {
  const d = load();
  const glyph = (name) => {
    const real = d.solid[name] ? name : d.aliases.solid[name] || (d.regular[name] ? name : d.aliases.regular[name]);
    return real ? d.solid[real] || d.regular[real] : null;
  };
  const brand = (name) => d.brands[name] || d.brands[d.aliases.brands[name]] || null;

  const wanted = new Set(names);
  if (everything) {
    for (const style of ['solid', 'regular']) {
      for (const name of Object.keys(d[style])) wanted.add(name);
      for (const name of Object.keys(d.aliases[style])) wanted.add(name);
    }
  }
  const rules = [];
  for (const name of [...wanted].sort()) {
    const g = glyph(name);
    if (!g) continue;
    rules.push(`.fa-${name}::before{content:"\\${g[0]}"}${g[1] === 512 ? '' : `.fa-${name}{width:${em(g[1])}}`}`);
  }
  // A bare name that only exists as a brand ("fa-whatsapp" next to fa-brands built elsewhere) is a brand too.
  const brandNames = new Set(brands);
  for (const name of names) if (!glyph(name) && brand(name)) brandNames.add(name);
  for (const name of [...brandNames].sort()) {
    const b = brand(name);
    if (!b) continue;
    const svg = `%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${b[0]} 512'%3E%3Cpath d='${b[1]}'/%3E%3C/svg%3E`;
    rules.push(`.fa-brands.fa-${name},.fab.fa-${name}{width:${em(b[0])};--fa-mask:url("data:image/svg+xml,${svg}")}`);
  }
  const licence = `/*! Font Awesome Free ${d.version} by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free (Icons: CC BY 4.0, Fonts: SIL OFL 1.1, Code: MIT License) Copyright 2023 Fonticons, Inc. */`;
  // Brand icons are masks: no glyph, even when a solid icon shares the name. Fixed-width icons come last.
  const tail = ['.fa-brands.fa-brands::before,.fab.fab::before{content:none}', '.fa-fw{text-align:center;width:1.25em}'];
  return [licence, ...fontRules(), ...rules, ...tail].join('\n') + '\n';
}

/** The stylesheet for "site" (only the icons in use) or "dash" (every solid and regular icon as well). */
function stylesheet(scope = 'site') {
  if (!cache.has(scope)) {
    const code = scanCode();
    const found = scanDatabase({ names: new Set(code.names), brands: new Set(code.brands) });
    const css = build(found, scope === 'dash');
    cache.set(scope, { css, version: crypto.createHash('sha1').update(css).digest('hex').slice(0, 10) });
  }
  return cache.get(scope);
}

const href = (scope = 'site') => `/static/css/icons-${scope}.css?v=${stylesheet(scope).version}`;

// Called after an icon is saved in the dashboard, so the next page links the new stylesheet.
function invalidate() {
  cache.clear();
}

module.exports = { stylesheet, href, invalidate, collect, build, load };
