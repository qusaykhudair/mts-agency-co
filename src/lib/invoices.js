'use strict';
// Invoices: strict validation, numbering that never repeats, search, filters, totals and the
// settings printed on every invoice. The printed sheet itself comes from public/js/invoice-sheet.js,
// shared with the editor's live preview.
const { get, all, run, tx } = require('../db');
const config = require('../config');
const money = require('./money');
const settings = require('./settings');
const { isoDay } = require('./format');
const { fromInternational } = require('./phone');
const { str, clean, cleanText, isEmail, int, toLatinDigits } = require('./util');
const COUNTRIES = require('../data/countries.json');
const sheet = require('../../public/js/invoice-sheet');

const SERVICE_KEYS = sheet.SERVICES.map((s) => s.key);
// ISO 3166-1 alpha-2 codes from the site's country list (AC and TA there are telephone-only codes).
const COUNTRY_CODES = [...new Set(COUNTRIES.map((c) => c.iso))].filter((c) => /^[A-Z]{2}$/.test(c) && !['AC', 'TA'].includes(c));
const COUNTRY_SET = new Set(COUNTRY_CODES);
const PINNED_COUNTRIES = ['PS', 'EG', 'SA', 'AE', 'JO'];
const METHOD_SUGGESTIONS = ['تحويل بنكي', 'InstaPay', 'فودافون كاش', 'PayPal', 'Payoneer', 'Wise', 'نقدا'];
const STATUSES = ['paid', 'partial', 'unpaid'];
const LIMITS = { client_name: 120, client_contact: 120, method: 60, purpose: 2000, note: 500 };
const SETTING_LIMITS = { name: 60, tagline_ar: 120, tagline_en: 120, footer_ar: 300, footer_en: 300 };
// 999,999,999.99 in minor units.
const MAX_AMOUNT = 99999999999;
const LOGO = '/static/img/logo-wordmark.png';

class InvoiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

/* ---------- Search ---------- */
// Shared with the editor: one spelling for search (see invoice-sheet.js).
const normalize = sheet.normalize;

function searchText(v) {
  return normalize(
    [v.number, v.client_name, v.client_contact, v.method, v.purpose, v.client_country ? sheet.countryName(v.client_country, 'ar') : '', v.client_country ? sheet.countryName(v.client_country, 'en') : '']
      .filter(Boolean)
      .join(' '),
  );
}

/* ---------- Parsing ---------- */
// null when empty, NaN when not an amount with at most two decimals, else minor units.
function amount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? money.parseMajorToMinor(String(value)) : NaN;
  if (typeof value !== 'string') return NaN;
  // Arabic thousands (٬) and decimal (٫) separators read like , and .
  return money.parseMajorToMinor(value.replace(/٬/g, '').replace(/٫/g, '.'));
}

// null when empty, NaN when not a real YYYY-MM-DD date, else the date string.
function dayValue(value) {
  const s = toLatinDigits(clean(str(value), 20));
  if (!s) return null;
  const d = sheet.parseDay(s);
  return d && d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2100 ? s : NaN;
}

const today = () => isoDay(new Date());

/**
 * Validates an invoice submission. Every message is keyed by the field name so the editor can
 * show it under that field. `current` is the stored invoice when editing.
 */
function validate(body, { current = null } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = {};
  const v = {};
  const longer = (n) => `النص أطول من ${n} حرفا`;

  v.client_name = clean(b.client_name, 1000);
  if (!v.client_name) errors.client_name = 'اكتب اسم العميل';
  else if (v.client_name.length > LIMITS.client_name) errors.client_name = longer(LIMITS.client_name);

  v.client_contact = clean(b.client_contact, 1000) || null;
  if (v.client_contact) {
    const c = toLatinDigits(v.client_contact);
    if (c.length > LIMITS.client_contact) errors.client_contact = longer(LIMITS.client_contact);
    else if (c.includes('@')) {
      if (!isEmail(c)) errors.client_contact = 'البريد الإلكتروني غير صحيح';
    } else if (!/^[+\d\s().-]+$/.test(c) || c.replace(/\D/g, '').length < 6 || c.replace(/\D/g, '').length > 16) {
      errors.client_contact = 'اكتب بريدا إلكترونيا أو رقم هاتف صحيحا';
    } else v.client_contact = c.replace(/\s+/g, ' ');
  }

  const country = clean(b.client_country, 10).toUpperCase();
  v.client_country = country || null;
  if (country && !COUNTRY_SET.has(country)) errors.client_country = 'اختر الدولة من القائمة';

  const cur = money.byCode(clean(b.currency, 10).toUpperCase());
  v.currency = cur ? cur.code : null;
  if (!cur) errors.currency = 'اختر العملة';

  const total = amount(b.total);
  v.total = total;
  if (total === null) errors.total = 'اكتب المبلغ الإجمالي';
  else if (Number.isNaN(total)) errors.total = 'اكتب المبلغ بالأرقام، وبخانتين عشريتين كحد أقصى';
  else if (total <= 0) errors.total = 'المبلغ الإجمالي يجب أن يكون أكبر من صفر';
  else if (total > MAX_AMOUNT) errors.total = 'المبلغ أكبر من الحد المسموح';

  let paid = amount(b.paid);
  if (paid === null) paid = 0;
  v.paid = paid;
  if (Number.isNaN(paid)) errors.paid = 'اكتب المدفوع بالأرقام، وبخانتين عشريتين كحد أقصى';
  else if (paid > MAX_AMOUNT || (Number.isInteger(total) && total > 0 && paid > total)) errors.paid = 'المدفوع لا يزيد على المبلغ الإجمالي';

  // Payment details belong to a payment: required once something was paid, dropped when nothing was.
  const hasPayment = Number.isInteger(paid) && paid > 0;
  v.method = clean(b.method, 1000) || null;
  if (v.method && v.method.length > LIMITS.method) errors.method = longer(LIMITS.method);
  else if (hasPayment && !v.method) errors.method = 'اكتب طريقة التحويل';
  const paidOn = dayValue(b.paid_on);
  v.paid_on = paidOn;
  if (Number.isNaN(paidOn)) errors.paid_on = 'التاريخ غير صحيح';
  else if (hasPayment && !paidOn) errors.paid_on = 'اختر تاريخ التحويل';
  if (!hasPayment) {
    v.method = null;
    v.paid_on = null;
  }

  const dueOn = dayValue(b.due_on);
  v.due_on = dueOn;
  if (Number.isNaN(dueOn)) errors.due_on = 'التاريخ غير صحيح';
  // A due date only means something while money is still owed.
  if (Number.isInteger(total) && Number.isInteger(paid) && paid >= total) v.due_on = null;

  v.purpose = cleanText(b.purpose, 100000) || null;
  if (v.purpose && v.purpose.length > LIMITS.purpose) errors.purpose = longer(LIMITS.purpose);

  v.service = typeof b.service === 'string' && SERVICE_KEYS.includes(b.service) ? b.service : null;
  if (!v.service) errors.service = 'اختر نوع الخدمة';

  v.note = cleanText(b.note, 100000) || null;
  if (v.note && v.note.length > LIMITS.note) errors.note = longer(LIMITS.note);

  const issued = dayValue(b.issued_on);
  v.issued_on = issued === null ? (current ? current.issued_on : today()) : issued;
  if (Number.isNaN(issued)) errors.issued_on = 'التاريخ غير صحيح';

  const lang = str(b.lang);
  v.lang = lang === 'en' ? 'en' : lang === 'ar' || !lang ? 'ar' : null;
  if (!v.lang) errors.lang = 'اختر لغة الفاتورة';

  const projectRaw = str(b.project_id).trim();
  v.project_id = null;
  if (projectRaw) {
    const id = int(projectRaw, { fallback: 0 });
    if (id > 0 && get('SELECT id FROM service_requests WHERE id = ?', id)) v.project_id = id;
    else errors.project_id = 'المشروع غير موجود';
  }

  return { values: v, errors };
}

/* ---------- Settings printed on every invoice ---------- */
const SETTING_KEYS = ['name', 'tagline_ar', 'tagline_en', 'footer_ar', 'footer_en', 'email', 'whatsapp', 'website', 'prefix'];

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^(localhost|127\.|\[::1\])/.test(u.hostname) ? '' : u.host;
  } catch {
    return '';
  }
}

// What the site already knows, used until the admin saves the invoice settings once.
function siteDefaults() {
  const s = settings.getAll();
  return {
    name: 'MTS Agency',
    tagline_ar: 'تصميم وبرمجة وتسويق لمشروعك',
    tagline_en: 'Design, development and marketing for your business',
    footer_ar: 'شكرا لثقتك بنا. لأي سؤال عن هذه الفاتورة راسلنا على واتساب.',
    footer_en: 'Thank you for your trust. If you have any question about this invoice, message us on WhatsApp.',
    email: s.support_email || '',
    whatsapp: s.whatsapp_number || '',
    website: hostOf(config.appUrl),
    prefix: 'MTS',
  };
}

function invoiceSettings() {
  const s = settings.getAll();
  const values = s.invoice_settings_saved === '1' ? Object.fromEntries(SETTING_KEYS.map((k) => [k, s[`invoice_${k}`] || ''])) : siteDefaults();
  if (!values.prefix) values.prefix = 'MTS';
  return { ...values, logo: LOGO };
}

function saveSettings(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = {};
  const v = {};
  for (const key of ['name', 'tagline_ar', 'tagline_en']) {
    v[key] = clean(b[key], 1000);
    if (v[key].length > SETTING_LIMITS[key]) errors[key] = `النص أطول من ${SETTING_LIMITS[key]} حرفا`;
  }
  if (!v.name) errors.name = 'اكتب الاسم الذي يظهر في رأس الفاتورة';
  for (const key of ['footer_ar', 'footer_en']) {
    v[key] = cleanText(b[key], 1000);
    if (v[key].length > SETTING_LIMITS[key]) errors[key] = `النص أطول من ${SETTING_LIMITS[key]} حرفا`;
  }
  v.email = clean(b.email, 254);
  if (v.email && !isEmail(v.email)) errors.email = 'البريد الإلكتروني غير صحيح';

  const wa = toLatinDigits(clean(b.whatsapp, 40));
  v.whatsapp = '';
  if (wa) {
    // A local number (starting with 0, or 00 instead of +) prints wrong for clients abroad.
    if (/^0/.test(wa)) errors.whatsapp = 'اكتب الرقم بالصيغة الدولية: علامة + ثم رمز الدولة ثم الرقم بدون الصفر الأول، مثل +201093525956';
    else {
      const parsed = fromInternational(wa);
      if (parsed.error || !parsed.e164) errors.whatsapp = 'رقم واتساب غير صحيح. اكتبه بالصيغة الدولية مثل +201093525956';
      else v.whatsapp = parsed.e164;
    }
  }

  let site = clean(b.website, 200).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (site) {
    let ok = false;
    try {
      const u = new URL('https://' + site);
      ok = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) && !/\s/.test(site);
      if (ok) site = u.hostname.toLowerCase() + (u.pathname === '/' ? '' : u.pathname) + u.search;
    } catch {
      ok = false;
    }
    if (!ok) errors.website = 'اكتب عنوان الموقع مثل example.com';
  }
  v.website = site;

  v.prefix = clean(b.prefix, 20).toUpperCase();
  if (!/^[A-Z0-9]{2,6}$/.test(v.prefix)) errors.prefix = 'من حرفين إلى 6 حروف إنجليزية أو أرقام، مثل MTS';

  if (Object.keys(errors).length) return { errors };
  settings.set({ ...Object.fromEntries(SETTING_KEYS.map((k) => [`invoice_${k}`, v[k]])), invoice_settings_saved: '1' });
  return { settings: invoiceSettings() };
}

/* ---------- Reading ---------- */
const SELECT = `SELECT i.*, r.code AS project_code, r.title AS project_title FROM invoices i LEFT JOIN service_requests r ON r.id = i.project_id`;

function decorate(row) {
  if (!row) return null;
  const st = sheet.computeStatus(row.total, row.paid);
  return { ...row, paid_amount: st.paid, remaining: st.remaining, status: st.status };
}

function byId(id) {
  return decorate(get(`${SELECT} WHERE i.id = ?`, id));
}

function currencyMeta(code) {
  const c = money.byCode(code);
  return c ? { code: c.code, symbol: c.symbol, name: c.name } : { code, symbol: code, name: code };
}

// The shape the sheet renderer takes.
function sheetData(inv) {
  return {
    number: inv.number || null,
    issued_on: inv.issued_on,
    lang: inv.lang,
    client_name: inv.client_name,
    client_contact: inv.client_contact,
    client_country: inv.client_country,
    currency: currencyMeta(inv.currency),
    total: inv.total,
    paid: inv.paid,
    method: inv.method,
    paid_on: inv.paid_on,
    due_on: inv.due_on,
    purpose: inv.purpose,
    service: inv.service,
    note: inv.note,
  };
}

const major = (minor) => (minor === null || minor === undefined ? null : Math.round(minor) / 100);

// API representation: amounts in major units, status and remaining computed.
function toJSON(inv) {
  return {
    id: inv.id,
    number: inv.number,
    issued_on: inv.issued_on,
    lang: inv.lang,
    client: {
      name: inv.client_name,
      contact: inv.client_contact,
      country: inv.client_country,
      country_name: inv.client_country ? { ar: sheet.countryName(inv.client_country, 'ar'), en: sheet.countryName(inv.client_country, 'en') } : null,
    },
    currency: inv.currency,
    total: major(inv.total),
    paid: major(inv.paid_amount),
    remaining: major(inv.remaining),
    status: inv.status,
    method: inv.method,
    paid_on: inv.paid_on,
    paid_on_label: inv.paid_on ? { ar: sheet.dayLabel(inv.paid_on, 'ar'), en: sheet.dayLabel(inv.paid_on, 'en') } : null,
    due_on: inv.remaining > 0 ? inv.due_on : null,
    purpose: inv.purpose,
    service: inv.service,
    note: inv.note,
    project: inv.project_id ? { id: inv.project_id, code: inv.project_code, title: inv.project_title } : null,
    // The PDF copy in Google Drive: up to date once this version went up.
    drive: { saved: inv.drive_done >= inv.drive_rev, url: inv.drive_file_id ? `https://drive.google.com/file/d/${inv.drive_file_id}/view` : null },
    created_at: inv.created_at,
    updated_at: inv.updated_at,
  };
}

/* ---------- Filters ---------- */
const PAID_SQL = 'COALESCE(i.paid, i.total)';
const STATUS_SQL = {
  paid: `${PAID_SQL} >= i.total`,
  partial: `${PAID_SQL} > 0 AND ${PAID_SQL} < i.total`,
  unpaid: `${PAID_SQL} = 0`,
};
// The period counts by the transfer date, or the issue date when nothing was transferred.
const PERIOD_DATE = 'COALESCE(i.paid_on, i.issued_on)';
const PERIODS = { '': 'كل الفترات', month: 'هذا الشهر', 'last-month': 'الشهر الماضي', year: 'هذه السنة', range: 'فترة محددة' };

function monthBounds(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  return [first.toISOString().slice(0, 10), last.toISOString().slice(0, 10)];
}

function parseFilters(q = {}) {
  const f = { q: clean(q.q, 100), service: null, currency: null, status: null, country: null, period: '', from: null, to: null };
  if (typeof q.service === 'string' && SERVICE_KEYS.includes(q.service)) f.service = q.service;
  const cur = typeof q.currency === 'string' && money.byCode(q.currency.toUpperCase());
  if (cur) f.currency = cur.code;
  if (typeof q.status === 'string' && STATUSES.includes(q.status)) f.status = q.status;
  const country = typeof q.country === 'string' ? q.country.toUpperCase() : '';
  if (COUNTRY_SET.has(country)) f.country = country;
  const [y, m] = today().split('-').map(Number);
  const period = typeof q.period === 'string' && Object.hasOwn(PERIODS, q.period) ? q.period : '';
  f.period = period;
  if (period === 'month') [f.from, f.to] = monthBounds(y, m);
  else if (period === 'last-month') [f.from, f.to] = m === 1 ? monthBounds(y - 1, 12) : monthBounds(y, m - 1);
  else if (period === 'year') [f.from, f.to] = [`${y}-01-01`, `${y}-12-31`];
  else {
    // A range, or plain from/to on the API.
    const from = dayValue(q.from);
    const to = dayValue(q.to);
    f.from = typeof from === 'string' ? from : null;
    f.to = typeof to === 'string' ? to : null;
    if (f.from && f.to && f.from > f.to) [f.from, f.to] = [f.to, f.from];
    if ((f.from || f.to) && !period) f.period = 'range';
  }
  return f;
}

function where(f) {
  const w = ['1 = 1'];
  const p = [];
  for (const word of normalize(f.q).split(' ').filter(Boolean).slice(0, 8)) {
    w.push("i.search_text LIKE ? ESCAPE '\\'");
    p.push(`%${word.replace(/[\\%_]/g, (ch) => '\\' + ch)}%`);
  }
  if (f.service) {
    w.push('i.service = ?');
    p.push(f.service);
  }
  if (f.currency) {
    w.push('i.currency = ?');
    p.push(f.currency);
  }
  if (f.country) {
    w.push('i.client_country = ?');
    p.push(f.country);
  }
  if (f.status) w.push(`(${STATUS_SQL[f.status]})`);
  if (f.from) {
    w.push(`${PERIOD_DATE} >= ?`);
    p.push(f.from);
  }
  if (f.to) {
    w.push(`${PERIOD_DATE} <= ?`);
    p.push(f.to);
  }
  return { sql: w.join(' AND '), params: p };
}

function count(f) {
  const w = where(f);
  return get(`SELECT COUNT(*) AS n FROM invoices i WHERE ${w.sql}`, ...w.params).n;
}

function list(f, { limit = 30, offset = 0 } = {}) {
  const w = where(f);
  return all(`${SELECT} WHERE ${w.sql} ORDER BY i.issued_on DESC, i.id DESC LIMIT ? OFFSET ?`, ...w.params, limit, offset).map(decorate);
}

// Totals of the filtered invoices for each currency (amounts never mix currencies).
function totals(f) {
  const w = where(f);
  return all(
    `SELECT i.currency, COUNT(*) AS n, SUM(i.total) AS total, SUM(${PAID_SQL}) AS paid FROM invoices i WHERE ${w.sql}
     GROUP BY i.currency ORDER BY COUNT(*) DESC, i.currency`,
    ...w.params,
  ).map((r) => ({ currency: r.currency, count: r.n, total: r.total, paid: r.paid, remaining: r.total - r.paid }));
}

/* ---------- Suggestions ---------- */
function uniqueCi(items) {
  const seen = new Set();
  return items.filter((x) => {
    const k = normalize(x);
    if (!x || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function suggestions() {
  const used = all(
    `SELECT method, COUNT(*) AS n, MAX(id) AS last FROM invoices WHERE method IS NOT NULL AND method <> '' GROUP BY method ORDER BY n DESC, last DESC LIMIT 20`,
  );
  const storeMethods = all('SELECT name FROM payment_methods WHERE is_active = 1 ORDER BY sort_order, id').map((r) => r.name);
  const methods = uniqueCi([...used.map((r) => r.method), ...METHOD_SUGGESTIONS, ...storeMethods]);
  const clients = all(
    `SELECT client_name AS name, client_contact AS contact, client_country AS country, n FROM (
       SELECT client_name, client_contact, client_country, COUNT(*) OVER (PARTITION BY client_name) AS n,
              ROW_NUMBER() OVER (PARTITION BY client_name ORDER BY id DESC) AS rn, MAX(id) OVER (PARTITION BY client_name) AS last
       FROM invoices)
     WHERE rn = 1 ORDER BY n DESC, last DESC LIMIT 20`,
  ).map((r) => ({ name: r.name, contact: r.contact, country: r.country, count: r.n }));
  return { methods, clients };
}

// The countries shown first: the usual ones, then the ones invoices use most.
function countryOrder() {
  const used = all(`SELECT client_country AS c, COUNT(*) AS n FROM invoices WHERE client_country IS NOT NULL GROUP BY client_country ORDER BY n DESC LIMIT 8`).map((r) => r.c);
  return uniqueCi([...PINNED_COUNTRIES, ...used]).filter((c) => COUNTRY_SET.has(c));
}

function usedCountries() {
  return all('SELECT DISTINCT client_country AS c FROM invoices WHERE client_country IS NOT NULL')
    .map((r) => r.c)
    .filter((c) => COUNTRY_SET.has(c))
    .sort((a, b) => sheet.countryName(a, 'ar').localeCompare(sheet.countryName(b, 'ar'), 'ar'));
}

function projects() {
  return all(
    `SELECT r.id, r.code, r.title, r.service_name, u.name AS client_name FROM service_requests r JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT 300`,
  );
}

/* ---------- Writing ---------- */
const COLUMNS = ['client_name', 'client_contact', 'client_country', 'currency', 'total', 'paid', 'method', 'paid_on', 'due_on', 'purpose', 'service', 'note', 'issued_on', 'lang', 'project_id'];

/**
 * Saves a new invoice. The number comes from an atomic per-year counter (an upsert that returns the
 * new value) inside the same transaction as the insert: concurrent creations get consecutive numbers,
 * and a number is never handed out twice, even after its invoice is deleted.
 */
function create(values, actor) {
  return tx(() => {
    const year = Number(values.issued_on.slice(0, 4));
    const { seq } = get('INSERT INTO invoice_counters (year, seq) VALUES (?, 1) ON CONFLICT(year) DO UPDATE SET seq = seq + 1 RETURNING seq', year);
    const number = `${invoiceSettings().prefix}-${year}-${String(seq).padStart(4, '0')}`;
    const row = { ...values, number };
    const info = run(
      `INSERT INTO invoices (number, year, seq, ${COLUMNS.join(', ')}, search_text, created_by) VALUES (?, ?, ?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
      number,
      year,
      seq,
      ...COLUMNS.map((c) => values[c]),
      searchText(row),
      actor ? actor.id : null,
    );
    return byId(Number(info.lastInsertRowid));
  });
}

// The number (and its year) never changes after creation. Every save makes the Drive copy out of date.
function update(id, values) {
  const current = byId(id);
  if (!current) throw new InvoiceError('الفاتورة غير موجودة', 404);
  run(
    `UPDATE invoices SET ${COLUMNS.map((c) => `${c} = ?`).join(', ')}, search_text = ?, updated_at = datetime('now'), drive_rev = drive_rev + 1, drive_error = NULL WHERE id = ?`,
    ...COLUMNS.map((c) => values[c]),
    searchText({ ...values, number: current.number }),
    id,
  );
  return byId(id);
}

// The invoice's Drive copy stays: drive_removed tells the backup to move it to the deleted folder.
function remove(id) {
  const current = byId(id);
  if (!current) throw new InvoiceError('الفاتورة غير موجودة', 404);
  tx(() => {
    run(
      'INSERT INTO drive_removed (file_id, number, client_name, currency, total, issued_on) VALUES (?, ?, ?, ?, ?, ?)',
      current.drive_file_id || null,
      current.number,
      current.client_name,
      current.currency,
      current.total,
      current.issued_on,
    );
    run('DELETE FROM invoices WHERE id = ?', id);
  });
  return current;
}

// A copy for the editor: everything but the number, issued today.
function duplicateOf(inv) {
  if (!inv) return null;
  const copy = { ...inv, id: null, number: null, issued_on: today() };
  return copy;
}

module.exports = {
  SERVICE_KEYS,
  COUNTRY_CODES,
  PINNED_COUNTRIES,
  METHOD_SUGGESTIONS,
  STATUSES,
  PERIODS,
  LIMITS,
  SETTING_LIMITS,
  InvoiceError,
  normalize,
  validate,
  invoiceSettings,
  saveSettings,
  siteDefaults,
  byId,
  sheetData,
  currencyMeta,
  toJSON,
  parseFilters,
  count,
  list,
  totals,
  suggestions,
  countryOrder,
  usedCountries,
  projects,
  create,
  update,
  remove,
  duplicateOf,
  today,
  sheet,
};
