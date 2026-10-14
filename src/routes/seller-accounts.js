'use strict';
// The seller's own accounts (earnings, payouts, refunds) and the monthly seller fee page. Mounted on
// /seller after the seller router, which already checked the user is staff and closes everything but
// /seller/subscription for sellers whose fee is overdue.
const express = require('express');
const { get, all } = require('../db');
const money = require('../lib/money');
const accounts = require('../lib/accounts');
const fees = require('../lib/seller-fees');
const xlsx = require('../lib/xlsx');
const { parseJson } = require('../lib/format');
const { receiptUpload, discard } = require('../lib/uploads');
const { clean, cleanText, int, toLatinDigits } = require('../lib/util');
const { paginate } = require('../middleware');

const router = express.Router();
const TABS = ['sales', 'products', 'refunds', 'payouts', 'fees'];
const PER_PAGE = 50;

// Period, display currency and amount formatters shared by every accounts page.
function viewContext(req, res) {
  const period = accounts.period(req.query);
  const cur = accounts.currency(req.query.cur);
  Object.assign(res.locals, {
    period,
    cur,
    periods: accounts.PERIODS,
    amt: (v) => accounts.format(v, cur, { html: true }),
    amtText: (v) => accounts.format(v, cur),
    rateLabel: accounts.rateLabel,
    commissionLabel: accounts.rateLabel(),
  });
  return { period, cur };
}

/** Everything the seller account page shows; `admin` adds the actions and links of the admin view. */
function renderSellerAccount(req, res, seller, { admin }) {
  const { period, cur } = viewContext(req, res);
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'sales';
  const data = {};
  if (tab === 'sales') {
    const total = accounts.salesCount({ period, sellerId: seller.id });
    data.pg = paginate(total, req.query.page, PER_PAGE);
    data.sales = accounts.sales({ period, sellerId: seller.id, limit: PER_PAGE, offset: data.pg.offset });
  } else if (tab === 'products') {
    data.products = accounts.products(seller.id);
  } else if (tab === 'refunds') {
    data.refunds = accounts.sales({ period, sellerId: seller.id, refunded: true, limit: 500 });
  } else if (tab === 'payouts') {
    data.payouts = accounts.payouts({ sellerId: seller.id, limit: 200 });
  } else if (tab === 'fees') {
    data.feeList = fees.list({ sellerId: seller.id });
  }
  res.render('accounts/seller', {
    active: admin ? 'admin-accounts' : 'seller-earnings',
    pageTitle: admin ? `حسابات ${seller.store_name || seller.name}` : 'أرباحي وحساباتي',
    admin,
    seller,
    base: admin ? `/seller/accounts/sellers/${seller.id}` : '/seller/earnings',
    exportBase: admin ? '/seller/accounts/export' : '/seller/earnings/export',
    tab,
    totals: accounts.totals({ period, sellerId: seller.id }),
    balance: accounts.balance(seller.id),
    fee: fees.state(seller),
    feeConfig: fees.config(),
    feeMethods: fees.METHODS,
    feeStatus: fees.STATUS,
    monthsText: fees.monthsText,
    currenciesAll: money.list(),
    ...data,
  });
}

/** Sends the report of a period as .xlsx (default) or .csv. */
function sendReport(req, res, sellerId) {
  const period = accounts.period(req.query);
  const cur = accounts.currency(req.query.cur);
  const report = accounts.report({ period, sellerId, cur });
  const ascii = report.filename.replace(/[^\x20-\x7e]/g, '').replace(/-+/g, '-');
  const encoded = encodeURIComponent(report.filename);
  res.set('Cache-Control', 'no-store');
  if (req.query.format === 'csv') {
    res.type('text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${ascii}.csv"; filename*=UTF-8''${encoded}.csv`);
    return res.send(accounts.csv(report.salesSheet.rows));
  }
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${ascii}.xlsx"; filename*=UTF-8''${encoded}.xlsx`);
  res.send(xlsx.build(report.sheets));
}

/* ---------- Earnings ---------- */
router.get('/earnings', (req, res) => {
  if (req.user.role === 'admin') return res.redirect('/seller/accounts');
  renderSellerAccount(req, res, get('SELECT * FROM users WHERE id = ?', req.user.id), { admin: false });
});

router.get('/earnings/export', (req, res) => {
  if (req.user.role === 'admin') return res.redirect('/seller/accounts');
  sendReport(req, res, req.user.id);
});

/* ---------- Monthly seller fee ---------- */
function activeMethods() {
  return all('SELECT * FROM payment_methods WHERE is_active = 1 ORDER BY sort_order, id').map((m) => ({
    ...m,
    details: parseJson(m.details, []),
    currency: money.byCode(m.currency_code) || money.base(),
  }));
}

const MONTH_CHOICES = [1, 2, 3, 6, 12];

router.get('/subscription', (req, res) => {
  if (req.user.role === 'admin') return res.redirect('/seller/accounts/fees');
  const c = fees.config();
  res.render('accounts/subscription', {
    active: 'seller-subscription',
    pageTitle: 'اشتراك البائع',
    fee: fees.state(req.user),
    feeConfig: c,
    // What each payment method would charge for every choice of months (converted once, rounded up).
    methods: activeMethods().map((m) => ({ ...m, amounts: Object.fromEntries(MONTH_CHOICES.map((n) => [n, money.convert(c.baseMinor * n, m.currency)])) })),
    monthChoices: MONTH_CHOICES,
    balance: accounts.balance(req.user.id),
    history: fees.list({ sellerId: req.user.id, limit: 50 }),
    feeStatus: fees.STATUS,
    feeMethods: fees.METHODS,
    monthsText: fees.monthsText,
    amtBase: (v) => accounts.format(v, money.base(), { html: true }),
  });
});

const sellerOnly = (req, res, next) => {
  if (req.user.role !== 'seller') return res.reply({ ok: false, status: 403, message: 'هذه الصفحة لحسابات البائعين' });
  next();
};

router.post('/subscription', sellerOnly, receiptUpload('receipt'), (req, res) => {
  const fail = (errors, message) => {
    discard(req.file);
    return res.reply({ ok: false, errors, message: message || Object.values(errors || {})[0] });
  };
  if (fees.config().amount <= 0) return fail(null, 'لا يوجد اشتراك مطلوب حاليا');
  const months = int(req.body.months, { fallback: 0 });
  const errors = {};
  if (!MONTH_CHOICES.includes(months)) errors.months = 'اختر عدد الأشهر';
  const method = get('SELECT * FROM payment_methods WHERE id = ? AND is_active = 1', int(req.body.payment_method_id, { fallback: 0 }));
  if (!method) errors.payment_method_id = 'اختر الحساب الذي حولت إليه';
  const senderName = clean(req.body.sender_name, 100);
  if (senderName.length < 3) errors.sender_name = 'اكتب اسم صاحب الحساب الذي حولت منه';
  const senderAccount = toLatinDigits(clean(req.body.sender_account, 60));
  if (senderAccount.replace(/\s/g, '').length < 4) errors.sender_account = 'اكتب رقم الحساب أو المحفظة الذي حولت منه';
  if (!req.file) errors.receipt = 'أرفق صورة إيصال التحويل';
  if (Object.keys(errors).length) return fail(errors);
  fees.submit({ user: req.user, months, method, senderName, senderAccount, receipt: req.file, note: cleanText(req.body.note, 300) });
  req.file.kept = true;
  res.reply({ ok: true, message: 'وصلنا إيصالك. نراجعه ونفعل اشتراكك بعد التأكد من التحويل', reload: true });
});

router.post('/subscription/balance', sellerOnly, (req, res) => {
  const months = int(req.body.months, { fallback: 0 });
  if (!MONTH_CHOICES.includes(months)) return res.reply({ ok: false, message: 'اختر عدد الأشهر' });
  const until = fees.payFromBalance({ user: req.user, months });
  res.reply({ ok: true, message: `خصمنا الاشتراك من رصيدك. اشتراكك فعال حتى ${require('../lib/format').fmtDate(until)}`, redirect: '/seller' });
});

module.exports = router;
module.exports.renderSellerAccount = renderSellerAccount;
module.exports.sendReport = sendReport;
module.exports.viewContext = viewContext;
