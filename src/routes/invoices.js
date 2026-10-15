'use strict';
// Invoices in the admin dashboard: the list, the editor with its live preview, a print page, and
// the JSON API behind them (/seller/api/invoices). Admin session only; writes go through the same
// origin check (CSRF) as every other form.
const express = require('express');
const money = require('../lib/money');
const invoices = require('../lib/invoices');
const { int } = require('../lib/util');
const { paginate, requireAdmin } = require('../middleware');

const router = express.Router();
const { sheet } = invoices;
const PER_PAGE = 30;

const notFound = () => new invoices.InvoiceError('الفاتورة غير موجودة', 404);
const idOf = (req) => {
  const id = int(req.params.id, { fallback: 0 });
  return /^\d+$/.test(String(req.params.id)) && id > 0 ? id : 0;
};

/* =====================================================================
   JSON API
   ===================================================================== */
const api = express.Router();
api.use(requireAdmin, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const invalid = (res, errors) => res.status(422).json({ ok: false, message: Object.values(errors)[0], errors });

api.get('/', (req, res) => {
  const filters = invoices.parseFilters(req.query);
  const perPage = int(req.query.per_page, { min: 1, max: 200, fallback: 50 });
  const total = invoices.count(filters);
  const pg = paginate(total, req.query.page, perPage);
  res.json({
    ok: true,
    total,
    page: pg.page,
    pages: pg.pages,
    filters,
    items: invoices.list(filters, { limit: perPage, offset: pg.offset }).map(invoices.toJSON),
    totals: invoices.totals(filters).map((t) => ({ currency: t.currency, count: t.count, total: t.total / 100, paid: t.paid / 100, remaining: t.remaining / 100 })),
  });
});

// Defined before /:id so these words are never read as an invoice id.
api.get('/suggestions', (req, res) => res.json({ ok: true, ...invoices.suggestions(), countries: invoices.countryOrder() }));

api.get('/settings', (req, res) => res.json({ ok: true, settings: invoices.invoiceSettings() }));

api.put('/settings', (req, res) => {
  const out = invoices.saveSettings(req.body);
  if (out.errors) return invalid(res, out.errors);
  res.json({ ok: true, message: 'حفظنا إعدادات الفاتورة', settings: out.settings });
});

api.post('/', (req, res) => {
  const { values, errors } = invoices.validate(req.body);
  if (Object.keys(errors).length) return invalid(res, errors);
  const inv = invoices.create(values, req.user);
  res.status(201).json({ ok: true, message: `حفظنا الفاتورة ${inv.number}`, invoice: invoices.toJSON(inv) });
});

api.get('/:id', (req, res) => {
  const inv = invoices.byId(idOf(req));
  if (!inv) throw notFound();
  res.json({ ok: true, invoice: invoices.toJSON(inv) });
});

api.put('/:id', (req, res) => {
  const current = invoices.byId(idOf(req));
  if (!current) throw notFound();
  const { values, errors } = invoices.validate(req.body, { current });
  if (Object.keys(errors).length) return invalid(res, errors);
  const inv = invoices.update(current.id, values);
  res.json({ ok: true, message: `حفظنا التعديلات على ${inv.number}`, invoice: invoices.toJSON(inv) });
});

api.delete('/:id', (req, res) => {
  const current = invoices.byId(idOf(req));
  if (!current) throw notFound();
  invoices.remove(current.id);
  res.json({ ok: true, message: `حذفنا الفاتورة ${current.number}. رقمها لن يستخدم مرة أخرى` });
});

// The API always answers in JSON, errors included.
// eslint-disable-next-line no-unused-vars
api.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ ok: false, message: err.expose || status < 500 ? err.message : 'حدث خطأ غير متوقع، حاول مرة أخرى' });
});

router.use('/api/invoices', api);

/* =====================================================================
   Pages
   ===================================================================== */
const page = (req, res, next) => {
  res.locals.nav = 'seller';
  res.locals.noindex = true;
  res.locals.active = 'admin-invoices';
  res.locals.styles = ['/static/css/invoice.css'];
  next();
};

function currencies(extra) {
  const list = money.list();
  if (extra && !list.some((c) => c.code === extra)) list.push(invoices.currencyMeta(extra));
  return list.map((c) => ({ code: c.code, symbol: c.symbol, name: c.name }));
}

router.get('/invoices', requireAdmin, page, (req, res) => {
  const filters = invoices.parseFilters(req.query);
  const total = invoices.count(filters);
  const pg = paginate(total, req.query.page, PER_PAGE);
  res.render('invoices/list', {
    pageTitle: 'الفواتير',
    filters,
    pg,
    total,
    items: invoices.list(filters, { limit: PER_PAGE, offset: pg.offset }),
    totals: invoices.totals(filters),
    services: sheet.SERVICES,
    periods: invoices.PERIODS,
    currencyList: currencies(),
    countriesUsed: invoices.usedCountries(),
    invSettings: invoices.invoiceSettings(),
    sheet,
    scripts: ['/static/js/invoice-sheet.js', '/static/js/invoices.js'],
  });
});

function editor(req, res, inv, { duplicateFrom = null } = {}) {
  const st = invoices.invoiceSettings();
  const data = inv
    ? { ...invoices.sheetData(inv), id: inv.id || null, project_id: inv.project_id || null }
    : { id: null, number: null, issued_on: invoices.today(), lang: 'ar', client_name: '', client_contact: '', client_country: '', currency: { code: (money.list()[0] || money.base()).code }, total: null, paid: 0, method: '', paid_on: '', due_on: '', purpose: '', service: '', note: '', project_id: null };
  res.render('invoices/editor', {
    pageTitle: inv && inv.number ? `الفاتورة ${inv.number}` : 'فاتورة جديدة',
    inv,
    duplicateFrom,
    sheetHtml: sheet.render(data, st),
    boot: {
      invoice: data,
      status: inv && inv.id ? { status: inv.status, remaining: inv.remaining } : null,
      settings: st,
      currencies: currencies(data.currency && data.currency.code),
      services: sheet.SERVICES,
      countries: invoices.COUNTRY_CODES,
      pinned: invoices.countryOrder(),
      today: invoices.today(),
      limits: invoices.LIMITS,
      ...invoices.suggestions(),
    },
    projects: invoices.projects(),
    services: sheet.SERVICES,
    currencyList: currencies(data.currency && data.currency.code),
    invSettings: st,
    scripts: ['/static/js/invoice-sheet.js', '/static/js/invoices.js'],
  });
}

router.get('/invoices/new', requireAdmin, page, (req, res) => {
  const from = req.query.from ? invoices.byId(int(req.query.from, { fallback: 0 })) : null;
  editor(req, res, from ? invoices.duplicateOf(from) : null, { duplicateFrom: from });
});

router.get('/invoices/:id', requireAdmin, page, (req, res) => {
  const inv = invoices.byId(idOf(req));
  if (!inv) throw notFound();
  editor(req, res, inv);
});

// The invoice alone, for printing or saving as PDF; prints itself unless ?noprint=1.
router.get('/invoices/:id/print', requireAdmin, (req, res) => {
  const inv = invoices.byId(idOf(req));
  if (!inv) throw notFound();
  res.set('Cache-Control', 'no-store');
  res.render('invoices/print', {
    title: `${inv.number} - ${inv.client_name}`,
    lang: inv.lang,
    sheetHtml: sheet.render(invoices.sheetData(inv), invoices.invoiceSettings()),
    autoPrint: req.query.noprint !== '1',
  });
});

module.exports = router;
