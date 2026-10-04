'use strict';
// Prices are stored as integer minor units (×100) of the base currency.
// Other currencies carry a rate = units of that currency per 1 unit of the base currency.
const { all } = require('../db');

let cache = null;

function load() {
  const rows = all('SELECT * FROM currencies ORDER BY is_base DESC, sort_order, code');
  const base = rows.find((c) => c.is_base) || rows[0] || { code: 'USD', name: 'دولار أمريكي', symbol: '$', rate: 1, decimals: 2, is_base: 1, is_active: 1 };
  cache = { list: rows, base, byCode: new Map(rows.map((c) => [c.code, c])) };
  return cache;
}

function state() {
  return cache || load();
}

function base() {
  return state().base;
}

function list({ activeOnly = true } = {}) {
  return state().list.filter((c) => !activeOnly || c.is_active);
}

function byCode(code) {
  return state().byCode.get(code) || null;
}

// Display currency requested by the visitor, falling back to the base currency.
function resolve(code) {
  const c = code && byCode(code);
  return c && c.is_active ? c : base();
}

// Round *up* to the currency precision so conversions never under-charge.
function ceilTo(value, decimals) {
  const f = 10 ** decimals;
  return Math.ceil(Number((value * f).toFixed(6))) / f;
}

// Base minor units -> major units of the target currency.
function convert(baseMinor, currency) {
  const cur = currency || base();
  const major = (Number(baseMinor) / 100) * (cur.is_base ? 1 : cur.rate);
  return ceilTo(major, cur.decimals);
}

function formatNumber(value, decimals = 2) {
  const n = Number(value) || 0;
  const whole = Number.isInteger(Number(n.toFixed(decimals)));
  return n.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : decimals,
    maximumFractionDigits: decimals,
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// Amount already in major units of `currency`.
function formatMajor(amount, currency, { html = false } = {}) {
  const cur = currency || base();
  const num = formatNumber(amount, cur.decimals);
  if (!html) return `${num} ${cur.symbol}`;
  return `<span class="money"><bdi class="amt">${num}</bdi> <span class="cur">${escapeHtml(cur.symbol)}</span></span>`;
}

// Base minor units rendered in the given (or base) currency.
function format(baseMinor, currency, opts) {
  const cur = currency || base();
  return formatMajor(convert(baseMinor, cur), cur, opts);
}

// Parse a user-entered major amount ("12.5", "١٢٫٥") into minor units.
function parseMajorToMinor(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string' && typeof input !== 'number') return NaN;
  const s = toLatinDigits(String(input)).replace(/[,\s]/g, '').replace('٫', '.');
  if (s === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}

function toLatinDigits(s) {
  return String(s)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

module.exports = { load, base, list, byCode, resolve, convert, ceilTo, format, formatMajor, formatNumber, parseMajorToMinor, toLatinDigits };
