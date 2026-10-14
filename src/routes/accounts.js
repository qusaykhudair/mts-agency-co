'use strict';
// Admin "Accounts": MTS commission on seller sales, what every seller is owed, payouts, refunds,
// the monthly seller fee, and the exports.
const express = require('express');
const { get } = require('../db');
const money = require('../lib/money');
const settings = require('../lib/settings');
const accounts = require('../lib/accounts');
const fees = require('../lib/seller-fees');
const { renderSellerAccount, sendReport, viewContext } = require('./seller-accounts');
const { clean, cleanText, int } = require('../lib/util');
const { paginate, requireAdmin } = require('../middleware');

const router = express.Router();

router.use('/accounts', requireAdmin, (req, res, next) => {
  res.locals.nav = 'seller';
  res.locals.noindex = true;
  next();
});

const notFound = (what) => {
  const err = new Error(`${what} غير موجود`);
  err.status = 404;
  err.expose = true;
  return err;
};

function sellerById(id) {
  const s = get('SELECT * FROM users WHERE id = ?', int(id, { fallback: 0 }));
  // Former sellers stay reachable here while they have sales or payouts on record.
  if (!s || (s.role !== 'seller' && !get('SELECT id FROM orders WHERE seller_id = ? AND commission_rate IS NOT NULL LIMIT 1', s.id) && !get('SELECT id FROM seller_payouts WHERE seller_id = ? LIMIT 1', s.id))) {
    throw notFound('البائع');
  }
  return s;
}

const SECTIONS = [
  { key: 'summary', href: '/seller/accounts', label: 'الملخص', icon: 'fa-solid fa-chart-pie' },
  { key: 'sales', href: '/seller/accounts/sales', label: 'المبيعات', icon: 'fa-solid fa-receipt' },
  { key: 'refunds', href: '/seller/accounts/refunds', label: 'المسترجعات', icon: 'fa-solid fa-rotate-left' },
  { key: 'payouts', href: '/seller/accounts/payouts', label: 'التحويلات للبائعين', icon: 'fa-solid fa-money-bill-transfer' },
  { key: 'fees', href: '/seller/accounts/fees', label: 'اشتراكات البائعين', icon: 'fa-solid fa-calendar-check' },
  { key: 'settings', href: '/seller/accounts/settings', label: 'العمولة والاشتراك', icon: 'fa-solid fa-sliders' },
];

function page(res, view, section, data) {
  res.render(`accounts/${view}`, {
    active: 'admin-accounts',
    pageTitle: 'الحسابات',
    sections: SECTIONS,
    section,
    pendingFees: get("SELECT COUNT(*) AS n FROM seller_fees WHERE status = 'pending'").n,
    monthsText: fees.monthsText,
    ...data,
  });
}

/* ---------- Summary ---------- */
router.get('/accounts', (req, res) => {
  const { period } = viewContext(req, res);
  const list = accounts.sellers({ period });
  const owed = list.reduce((s, u) => s + Math.max(0, u.balance.due), 0);
  const pending = list.reduce((s, u) => s + u.balance.pending, 0);
  page(res, 'summary', 'summary', {
    totals: accounts.totals({ period }),
    sellers: list.map((u) => ({ ...u, fee: fees.state(u) })),
    owed,
    pending,
  });
});

/* ---------- Lists ---------- */
function sellerFilter(req) {
  const id = int(req.query.seller, { fallback: 0 });
  return id ? get('SELECT id, name, store_name FROM users WHERE id = ?', id) : null;
}

const sellerOptions = () => accounts.sellers({ period: accounts.period({ period: 'all' }) }).map((u) => ({ id: u.id, label: u.store_name || u.name }));

router.get('/accounts/sales', (req, res) => {
  const { period } = viewContext(req, res);
  const seller = sellerFilter(req);
  const total = accounts.salesCount({ period, sellerId: seller && seller.id });
  const pg = paginate(total, req.query.page, 50);
  page(res, 'sales', 'sales', {
    seller,
    sellerOptions: sellerOptions(),
    pg,
    totals: accounts.totals({ period, sellerId: seller && seller.id }),
    sales: accounts.sales({ period, sellerId: seller && seller.id, limit: 50, offset: pg.offset }),
  });
});

router.get('/accounts/refunds', (req, res) => {
  const { period } = viewContext(req, res);
  const seller = sellerFilter(req);
  page(res, 'refunds', 'refunds', {
    seller,
    sellerOptions: sellerOptions(),
    refunds: accounts.sales({ period, sellerId: seller && seller.id, refunded: true, limit: 1000 }),
  });
});

router.get('/accounts/payouts', (req, res) => {
  const { period } = viewContext(req, res);
  const seller = sellerFilter(req);
  page(res, 'payouts', 'payouts', {
    seller,
    sellerOptions: sellerOptions(),
    payouts: accounts.payouts({ period, sellerId: seller && seller.id, limit: 1000 }),
  });
});

router.get('/accounts/export', (req, res) => {
  const seller = int(req.query.seller, { fallback: 0 }) ? sellerById(req.query.seller) : null;
  sendReport(req, res, seller && seller.id);
});

/* ---------- One seller ---------- */
router.get('/accounts/sellers/:id', (req, res) => {
  const seller = sellerById(req.params.id);
  res.locals.sections = SECTIONS;
  renderSellerAccount(req, res, seller, { admin: true });
});

router.post('/accounts/sellers/:id/payouts', (req, res) => {
  const seller = sellerById(req.params.id);
  const cur = money.byCode(String(req.body.currency || '').toUpperCase()) || money.base();
  const minor = money.parseMajorToMinor(clean(req.body.amount, 20));
  if (minor === null || Number.isNaN(minor) || minor <= 0) return res.reply({ ok: false, errors: { amount: 'اكتب المبلغ الذي حولته' } });
  accounts.recordPayout({
    seller,
    minor,
    cur,
    method: clean(req.body.method, 60),
    reference: clean(req.body.reference, 80),
    note: cleanText(req.body.note, 300),
    actor: req.user,
  });
  res.reply({ ok: true, message: 'سجلنا التحويل وأبلغنا البائع', reload: true });
});

router.post('/accounts/payouts/:id/delete', (req, res) => {
  const p = accounts.deletePayout(int(req.params.id, { fallback: 0 }));
  res.reply({ ok: true, message: 'حذفنا التحويل من السجل', redirect: `/seller/accounts/sellers/${p.seller_id}?tab=payouts` });
});

router.post('/accounts/sellers/:id/fees', (req, res) => {
  const seller = sellerById(req.params.id);
  const months = int(req.body.months, { min: 1, max: 12, fallback: 0 });
  if (!months) return res.reply({ ok: false, errors: { months: 'اختر عدد الأشهر' } });
  const method = String(req.body.method || '');
  const cur = money.byCode(String(req.body.currency || '').toUpperCase()) || fees.config().currency;
  const minor = ['transfer', 'cash'].includes(method) ? money.parseMajorToMinor(clean(req.body.amount, 20)) : 0;
  if (Number.isNaN(minor) || minor === null) return res.reply({ ok: false, errors: { amount: 'اكتب المبلغ الذي استلمته' } });
  fees.record({ sellerId: seller.id, months, method, minor, cur, note: cleanText(req.body.note, 300), actor: req.user });
  res.reply({ ok: true, message: 'سجلنا الدفعة ومددنا اشتراك البائع', reload: true });
});

/* ---------- Seller fees ---------- */
router.get('/accounts/fees', (req, res) => {
  const people = accounts.sellers({ period: accounts.period({ period: 'all' }) }).filter((u) => u.role === 'seller');
  page(res, 'fees', 'fees', {
    feeConfig: fees.config(),
    feeStatus: fees.STATUS,
    feeMethods: fees.METHODS,
    pending: fees.list({ status: 'pending' }),
    history: fees.list({ limit: 100 }).filter((f) => f.status !== 'pending'),
    sellers: people.map((u) => ({ ...u, fee: fees.state(u) })),
    amtBase: (v) => accounts.format(v, money.base(), { html: true }),
  });
});

function feeById(req) {
  const f = fees.byId(int(req.params.id, { fallback: 0 }));
  if (!f) throw notFound('الدفعة');
  return f;
}

router.post('/accounts/fees/:id/approve', (req, res) => {
  fees.approve(feeById(req), req.user);
  res.reply({ ok: true, message: 'أكدنا الدفعة ومددنا اشتراك البائع', reload: true });
});

router.post('/accounts/fees/:id/reject', (req, res) => {
  const reason = cleanText(req.body.reason, 300);
  if (reason.length < 3) return res.reply({ ok: false, errors: { reason: 'اكتب سبب الرفض ليظهر للبائع' } });
  fees.reject(feeById(req), req.user, reason);
  res.reply({ ok: true, message: 'رفضنا الإيصال وأبلغنا البائع', reload: true });
});

router.post('/accounts/fees/:id/void', (req, res) => {
  fees.voidFee(feeById(req), req.user);
  res.reply({ ok: true, message: 'ألغينا الدفعة وأرجعنا تاريخ الاشتراك', reload: true });
});

/* ---------- Settings ---------- */
router.get('/accounts/settings', (req, res) => {
  page(res, 'settings', 'settings', {
    s: settings.getAll(),
    basis: accounts.BASIS,
    feeCurrencies: money.list({ activeOnly: false }),
    // A worked example at the saved rate, under both ways of counting: 10 original price + 5 profit.
    example: (() => {
      const rate = accounts.commissionRate();
      const total = 1500;
      const cost = 1000;
      const row = (basis) => {
        const commission = Math.round(((basis === 'profit' ? total - cost : total) * rate) / 100);
        return { commission, sellerNet: total - commission };
      };
      return { rate, total, cost, sale: row('sale'), profit: row('profit'), current: accounts.commissionBasis() };
    })(),
  });
});

router.post('/accounts/settings', (req, res) => {
  const b = req.body;
  const errors = {};
  const rate = Number(String(b.commission_rate ?? '').replace('٫', '.').replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660));
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) errors.commission_rate = 'اكتب نسبة بين 0 و100';
  const fee = money.parseMajorToMinor(clean(b.seller_fee_amount, 20));
  if (fee === null || Number.isNaN(fee)) errors.seller_fee_amount = 'اكتب قيمة الاشتراك الشهري (0 لإلغائه)';
  const feeCur = money.byCode(String(b.seller_fee_currency || '').toUpperCase());
  if (!feeCur) errors.seller_fee_currency = 'اختر عملة الاشتراك';
  if (Object.keys(errors).length) return res.reply({ ok: false, errors, message: Object.values(errors)[0] });
  settings.set({
    commission_rate: String(Math.round(rate * 100) / 100),
    commission_basis: b.commission_basis === 'profit' ? 'profit' : 'sale',
    seller_fee_amount: String(fee / 100),
    seller_fee_currency: feeCur.code,
    seller_fee_grace_days: String(int(b.seller_fee_grace_days, { min: 0, max: 60, fallback: 3 })),
    seller_fee_enforce: b.seller_fee_enforce === '1' ? '1' : '0',
  });
  fees.sync();
  res.reply({ ok: true, message: 'حفظنا إعدادات العمولة والاشتراك. تطبق العمولة الجديدة على الطلبات القادمة فقط', reload: true });
});

module.exports = router;
