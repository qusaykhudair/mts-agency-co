'use strict';
// Seller accounts: the MTS commission on every seller sale, what each seller has earned and is owed,
// payouts, and the period reports and exports. Amounts are integer minor units of the base currency
// the order (or payout) was recorded in; queries convert them to the *current* base currency.
const { get, all, run, toSql } = require('../db');
const money = require('./money');
const settings = require('./settings');
const { notify } = require('./notify');
const { isoDay, fmtDate, zonedLocalToUtc, zonedLocal, ORDER_STATUS } = require('./format');

const PAID = "('processing', 'delivered', 'completed')";
const BASIS = {
  sale: { label: 'من سعر البيع', long: 'من سعر البيع كاملا' },
  profit: { label: 'من الربح', long: 'من الربح فقط (سعر البيع ناقص السعر الأصلي)' },
};

/* ---------- Commission ---------- */
function commissionRate() {
  const n = Number(settings.get('commission_rate'));
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 20;
}

function commissionBasis() {
  return settings.get('commission_basis') === 'profit' ? 'profit' : 'sale';
}

/**
 * How a sale of `total` (minor units) splits between MTS and the seller. Products owned by the admin
 * belong to MTS itself: no commission and nothing owed to anyone.
 */
function split({ total, unitCost = null, quantity = 1, ownerRole }) {
  if (ownerRole !== 'seller') return { rate: null, basis: null, commission: 0, sellerNet: 0 };
  const rate = commissionRate();
  const cost = unitCost === null || unitCost === undefined ? null : unitCost * quantity;
  // Without an original price the profit is unknown, so the commission falls back to the sale price.
  const basis = commissionBasis() === 'profit' && cost !== null ? 'profit' : 'sale';
  const base = basis === 'profit' ? Math.max(0, total - cost) : total;
  const commission = Math.round((base * rate) / 100);
  return { rate, basis, commission, sellerNet: total - commission };
}

function rateLabel(rate = commissionRate(), basis = commissionBasis()) {
  return `${Number(rate).toLocaleString('en-US', { maximumFractionDigits: 2 })}% ${BASIS[basis] ? BASIS[basis].label : BASIS.sale.label}`;
}

/* ---------- Currency ---------- */
// SQL: a stored amount converted to the current base currency (its own currency column says which base it used).
const inBase = (expr, curCol) => `((${expr}) * 1.0 / COALESCE((SELECT c.rate FROM currencies c WHERE c.code = ${curCol} AND c.is_base = 0), 1))`;
const O = (expr) => inBase(expr, 'o.base_currency');

// Display currency of an accounts page: an active currency picked by the viewer, or the base currency.
function currency(code) {
  return money.resolve(String(code || '').toUpperCase());
}

// Current-base minor units (may be fractional after conversion) -> major units of `cur`, rounded half up.
function toMajor(baseMinor, cur) {
  const c = cur || money.base();
  const major = (Number(baseMinor) || 0) / 100 * (c.is_base ? 1 : c.rate);
  const f = 10 ** c.decimals;
  return Math.round((major + Number.EPSILON) * f) / f;
}

function format(baseMinor, cur, opts) {
  return money.formatMajor(toMajor(baseMinor, cur), cur || money.base(), opts);
}

// Amount the admin typed in `cur` -> minor units of the current base currency.
function toBaseMinor(minor, cur) {
  if (!cur || cur.is_base) return Math.round(minor);
  return Math.round(minor / cur.rate);
}

/* ---------- Periods ---------- */
const PERIODS = {
  day: 'يومي',
  week: 'أسبوعي',
  month: 'شهري',
  range: 'فترة محددة',
  all: 'كل الفترات',
};

const validDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s ? s : null);
const ymdParts = (day) => day.split('-').map(Number);
function addDays(day, n) {
  const [y, m, d] = ymdParts(day);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function addMonthsToDay(day, n) {
  const [y, m] = ymdParts(day);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
}
// Weeks start on Saturday, as on the calendars our customers use.
function weekStart(day) {
  const [y, m, d] = ymdParts(day);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(day, -((weekday + 1) % 7));
}
const dayLabel = (day) => fmtDate(zonedLocalToUtc(`${day}T12:00`));
function monthLabel(day) {
  const [y, m] = ymdParts(day);
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, 15)));
}

/**
 * Reads ?period=day|week|month|range|all with ?date= (any day inside the period) or ?from=&to= for a
 * range. Boundaries are midnights in the store timezone, returned as UTC SQL datetimes [from, to).
 */
function period(q = {}, { fallback = 'month' } = {}) {
  const today = isoDay(new Date());
  const kind = Object.hasOwn(PERIODS, q.period) ? q.period : fallback;
  const anchor = validDay(String(q.date || '')) || today;
  let fromDay = null;
  let toDay = null;
  if (kind === 'day') {
    fromDay = anchor;
    toDay = addDays(anchor, 1);
  } else if (kind === 'week') {
    fromDay = weekStart(anchor);
    toDay = addDays(fromDay, 7);
  } else if (kind === 'month') {
    fromDay = `${anchor.slice(0, 7)}-01`;
    toDay = addMonthsToDay(fromDay, 1);
  } else if (kind === 'range') {
    let a = validDay(String(q.from || '')) || `${today.slice(0, 7)}-01`;
    let b = validDay(String(q.to || '')) || today;
    if (a > b) [a, b] = [b, a];
    fromDay = a;
    toDay = addDays(b, 1);
  }
  const lastDay = toDay ? addDays(toDay, -1) : null;
  let prev = null;
  let next = null;
  if (kind === 'day') [prev, next] = [addDays(anchor, -1), addDays(anchor, 1)];
  if (kind === 'week') [prev, next] = [addDays(fromDay, -7), addDays(fromDay, 7)];
  if (kind === 'month') [prev, next] = [addMonthsToDay(fromDay, -1), addMonthsToDay(fromDay, 1)];
  if (next && next > today) next = null;

  let label = 'كل الفترات';
  if (kind === 'day') label = dayLabel(anchor);
  else if (kind === 'month') label = monthLabel(fromDay);
  else if (kind === 'week' || kind === 'range') label = fromDay === lastDay ? dayLabel(fromDay) : `من ${dayLabel(fromDay)} إلى ${dayLabel(lastDay)}`;

  const slug = kind === 'all' ? 'all' : kind === 'month' ? fromDay.slice(0, 7) : fromDay === lastDay ? fromDay : `${fromDay}_${lastDay}`;
  return {
    kind,
    kindLabel: PERIODS[kind],
    anchor,
    fromDay,
    lastDay,
    from: fromDay ? toSql(zonedLocalToUtc(`${fromDay}T00:00`)) : null,
    to: toDay ? toSql(zonedLocalToUtc(`${toDay}T00:00`)) : null,
    prev,
    next,
    label,
    slug,
    // Query string values that reproduce this period (for links and the export button).
    params: kind === 'range' ? { period: kind, from: fromDay, to: lastDay } : kind === 'all' ? { period: kind } : { period: kind, date: anchor },
  };
}

// SQL condition on a datetime column for a period.
function within(col, p) {
  if (!p || !p.from) return { sql: '1 = 1', params: [] };
  return { sql: `${col} >= ? AND ${col} < ?`, params: [p.from, p.to] };
}

/* ---------- Sales ---------- */
// Seller sales are orders sold under a commission; MTS's own products have commission_rate NULL.
const SALE_COLUMNS = `o.id, o.code, o.seller_id, o.user_id, o.product_id, o.product_title, o.plan_name, o.quantity, o.status,
  o.paid_at, o.refunded_at, o.refund_reason, o.cancelled_at, o.completed_at, o.created_at, o.commission_rate, o.commission_basis,
  o.pay_amount, o.pay_currency, o.payment_method_name,
  ${O('o.total')} AS total, ${O('o.unit_price')} AS unit_price,
  CASE WHEN o.unit_cost IS NULL THEN NULL ELSE ${O('o.unit_cost * o.quantity')} END AS cost,
  ${O('o.commission')} AS commission, ${O('o.seller_net')} AS seller_net`;

function sellerFilter(sellerId) {
  return sellerId ? { sql: 'o.seller_id = ?', params: [sellerId] } : { sql: '1 = 1', params: [] };
}

function decorateSale(r) {
  const profit = r.cost === null ? null : r.total - r.cost;
  return {
    ...r,
    profit,
    seller_profit: r.cost === null ? null : r.seller_net - r.cost,
    status_key: r.refunded_at ? 'refunded' : r.status,
  };
}

/** Paid seller sales in a period (by payment date). `refunded` lists the ones refunded in the period instead. */
function sales({ period: p, sellerId = null, refunded = false, limit = 5000, offset = 0 } = {}) {
  const w = within(refunded ? 'o.refunded_at' : 'o.paid_at', p);
  const s = sellerFilter(sellerId);
  const status = refunded ? 'o.refunded_at IS NOT NULL' : `o.status IN ${PAID}`;
  return all(
    `SELECT ${SALE_COLUMNS}, u.name AS buyer_name, sl.name AS seller_name, sl.store_name AS seller_store
     FROM orders o JOIN users u ON u.id = o.user_id LEFT JOIN users sl ON sl.id = o.seller_id
     WHERE o.commission_rate IS NOT NULL AND o.paid_at IS NOT NULL AND ${status} AND ${w.sql} AND ${s.sql}
     ORDER BY ${refunded ? 'o.refunded_at' : 'o.paid_at'} DESC, o.id DESC LIMIT ? OFFSET ?`,
    ...w.params,
    ...s.params,
    limit,
    offset,
  ).map(decorateSale);
}

function salesCount({ period: p, sellerId = null, refunded = false } = {}) {
  const w = within(refunded ? 'o.refunded_at' : 'o.paid_at', p);
  const s = sellerFilter(sellerId);
  const status = refunded ? 'o.refunded_at IS NOT NULL' : `o.status IN ${PAID}`;
  return get(`SELECT COUNT(*) AS n FROM orders o WHERE o.commission_rate IS NOT NULL AND o.paid_at IS NOT NULL AND ${status} AND ${w.sql} AND ${s.sql}`, ...w.params, ...s.params).n;
}

/** Totals for a period: seller sales, the MTS commission, refunds, fees collected and MTS's own sales. */
function totals({ period: p, sellerId = null } = {}) {
  const w = within('o.paid_at', p);
  const s = sellerFilter(sellerId);
  const t = get(
    `SELECT COUNT(*) AS sales_count, COALESCE(SUM(${O('o.total')}), 0) AS gross, COALESCE(SUM(${O('o.commission')}), 0) AS commission,
            COALESCE(SUM(${O('o.seller_net')}), 0) AS seller_net,
            COALESCE(SUM(CASE WHEN o.unit_cost IS NOT NULL THEN ${O('o.unit_cost * o.quantity')} END), 0) AS cost,
            COALESCE(SUM(CASE WHEN o.unit_cost IS NOT NULL THEN ${O('o.total')} END), 0) AS gross_with_cost,
            COALESCE(SUM(o.unit_cost IS NULL), 0) AS unknown_cost
     FROM orders o WHERE o.commission_rate IS NOT NULL AND o.status IN ${PAID} AND o.paid_at IS NOT NULL AND ${w.sql} AND ${s.sql}`,
    ...w.params,
    ...s.params,
  );
  const rw = within('o.refunded_at', p);
  const refunds = get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(${O('o.total')}), 0) AS amount FROM orders o
     WHERE o.commission_rate IS NOT NULL AND o.refunded_at IS NOT NULL AND o.paid_at IS NOT NULL AND ${rw.sql} AND ${s.sql}`,
    ...rw.params,
    ...s.params,
  );
  const fw = within('f.reviewed_at', p);
  const fees = get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(${inBase('f.base_amount', 'f.base_currency')}), 0) AS amount FROM seller_fees f
     WHERE f.status = 'approved' AND f.method <> 'waived' AND ${fw.sql}${sellerId ? ' AND f.seller_id = ?' : ''}`,
    ...fw.params,
    ...(sellerId ? [sellerId] : []),
  );
  const pw = within('p.created_at', p);
  const payouts = get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(${inBase('p.base_amount', 'p.base_currency')}), 0) AS amount FROM seller_payouts p
     WHERE ${pw.sql}${sellerId ? ' AND p.seller_id = ?' : ''}`,
    ...pw.params,
    ...(sellerId ? [sellerId] : []),
  );
  const direct = sellerId
    ? null
    : get(
        `SELECT COUNT(*) AS n, COALESCE(SUM(${O('o.total')}), 0) AS amount FROM orders o
         WHERE o.commission_rate IS NULL AND o.status IN ${PAID} AND o.paid_at IS NOT NULL AND ${w.sql}`,
        ...w.params,
      );
  return { ...t, refunds, fees, payouts, direct };
}

/* ---------- Balances ---------- */
// What MTS owes each seller right now: completed sales, minus payouts and fees taken from the balance.
// Sales still being delivered (or waiting for the buyer) are "pending" until they complete.
function balances(sellerId = null) {
  const s = sellerId ? 'AND o.seller_id = ?' : '';
  const args = sellerId ? [sellerId] : [];
  const map = new Map();
  const row = (id) => {
    if (!map.has(id)) map.set(id, { seller_id: id, available: 0, pending: 0, earned: 0, paid_out: 0, fee_deducted: 0, due: 0 });
    return map.get(id);
  };
  for (const r of all(
    `SELECT o.seller_id,
            COALESCE(SUM(CASE WHEN o.status = 'completed' THEN ${O('o.seller_net')} END), 0) AS available,
            COALESCE(SUM(CASE WHEN o.status IN ('processing', 'delivered') THEN ${O('o.seller_net')} END), 0) AS pending,
            COALESCE(SUM(${O('o.seller_net')}), 0) AS earned
     FROM orders o WHERE o.commission_rate IS NOT NULL AND o.status IN ${PAID} ${s} GROUP BY o.seller_id`,
    ...args,
  )) {
    Object.assign(row(r.seller_id), { available: r.available, pending: r.pending, earned: r.earned });
  }
  for (const r of all(
    `SELECT p.seller_id, COALESCE(SUM(${inBase('p.base_amount', 'p.base_currency')}), 0) AS amount FROM seller_payouts p
     ${sellerId ? 'WHERE p.seller_id = ?' : ''} GROUP BY p.seller_id`,
    ...args,
  )) {
    row(r.seller_id).paid_out = r.amount;
  }
  for (const r of all(
    `SELECT f.seller_id, COALESCE(SUM(${inBase('f.base_amount', 'f.base_currency')}), 0) AS amount FROM seller_fees f
     WHERE f.status = 'approved' AND f.method = 'balance' ${sellerId ? 'AND f.seller_id = ?' : ''} GROUP BY f.seller_id`,
    ...args,
  )) {
    row(r.seller_id).fee_deducted = r.amount;
  }
  for (const b of map.values()) b.due = b.available - b.paid_out - b.fee_deducted;
  return map;
}

function balance(sellerId) {
  return balances(sellerId).get(sellerId) || { seller_id: sellerId, available: 0, pending: 0, earned: 0, paid_out: 0, fee_deducted: 0, due: 0 };
}

/** Every seller (current, or past ones with sales or payouts) with period figures and balances. */
function sellers({ period: p } = {}) {
  const people = all(
    `SELECT u.id, u.name, u.email, u.store_name, u.role, u.is_blocked, u.wa_e164, u.fee_paid_until, u.fee_due_at, u.created_at,
            (SELECT COUNT(*) FROM products pr WHERE pr.seller_id = u.id) AS products_count,
            (SELECT COUNT(*) FROM products pr WHERE pr.seller_id = u.id AND pr.is_active = 1) AS active_products
     FROM users u
     WHERE u.role = 'seller' OR u.id IN (SELECT seller_id FROM orders WHERE commission_rate IS NOT NULL) OR u.id IN (SELECT seller_id FROM seller_payouts)
     ORDER BY u.role = 'seller' DESC, COALESCE(u.store_name, u.name)`,
  );
  const w = within('o.paid_at', p);
  const inPeriod = new Map(
    all(
      `SELECT o.seller_id, COUNT(*) AS sales_count, COALESCE(SUM(${O('o.total')}), 0) AS gross, COALESCE(SUM(${O('o.commission')}), 0) AS commission,
              COALESCE(SUM(${O('o.seller_net')}), 0) AS seller_net
       FROM orders o WHERE o.commission_rate IS NOT NULL AND o.status IN ${PAID} AND o.paid_at IS NOT NULL AND ${w.sql} GROUP BY o.seller_id`,
      ...w.params,
    ).map((r) => [r.seller_id, r]),
  );
  const rw = within('o.refunded_at', p);
  const refunds = new Map(
    all(
      `SELECT o.seller_id, COUNT(*) AS n, COALESCE(SUM(${O('o.total')}), 0) AS amount FROM orders o
       WHERE o.commission_rate IS NOT NULL AND o.refunded_at IS NOT NULL AND o.paid_at IS NOT NULL AND ${rw.sql} GROUP BY o.seller_id`,
      ...rw.params,
    ).map((r) => [r.seller_id, r]),
  );
  const bal = balances();
  return people.map((u) => ({
    ...u,
    period: inPeriod.get(u.id) || { sales_count: 0, gross: 0, commission: 0, seller_net: 0 },
    refunds: refunds.get(u.id) || { n: 0, amount: 0 },
    balance: bal.get(u.id) || { available: 0, pending: 0, earned: 0, paid_out: 0, fee_deducted: 0, due: 0 },
  }));
}

/* ---------- Products ---------- */
/** A seller's products with every plan's price split: original price, profit, MTS commission, seller share. */
function products(sellerId) {
  const owner = get('SELECT role FROM users WHERE id = ?', sellerId);
  const rows = all(
    `SELECT p.id, p.title, p.slug, p.is_active, p.sales_count, p.offer_ends_at, pl.name AS platform_name, pl.logo_url AS platform_logo,
            pl.color1, pl.color2, p.cover_url AS product_cover
     FROM products p LEFT JOIN platforms pl ON pl.id = p.platform_id WHERE p.seller_id = ? ORDER BY p.is_active DESC, p.id DESC`,
    sellerId,
  );
  const plans = new Map();
  if (rows.length) {
    for (const pl of all(`SELECT * FROM product_plans WHERE product_id IN (${rows.map(() => '?').join(',')}) ORDER BY sort_order, id`, ...rows.map((r) => r.id))) {
      if (!plans.has(pl.product_id)) plans.set(pl.product_id, []);
      const parts = split({ total: pl.price, unitCost: pl.cost_price, quantity: 1, ownerRole: owner ? owner.role : 'seller' });
      plans.get(pl.product_id).push({
        ...pl,
        profit: pl.cost_price === null ? null : pl.price - pl.cost_price,
        commission: parts.commission,
        seller_net: parts.sellerNet,
        seller_profit: pl.cost_price === null ? null : parts.sellerNet - pl.cost_price,
      });
    }
  }
  return rows.map((r) => ({ ...r, plans: plans.get(r.id) || [] }));
}

/* ---------- Payouts ---------- */
function payouts({ period: p, sellerId = null, limit = 500 } = {}) {
  const w = within('p.created_at', p);
  return all(
    `SELECT p.*, ${inBase('p.base_amount', 'p.base_currency')} AS base_now, u.name AS seller_name, u.store_name AS seller_store, a.name AS admin_name
     FROM seller_payouts p JOIN users u ON u.id = p.seller_id LEFT JOIN users a ON a.id = p.created_by
     WHERE ${w.sql}${sellerId ? ' AND p.seller_id = ?' : ''} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
    ...w.params,
    ...(sellerId ? [sellerId] : []),
    limit,
  );
}

class AccountsError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.expose = true;
  }
}

/** Record money MTS sent to a seller. `minor` is in `cur` (an active currency). */
function recordPayout({ seller, minor, cur, method, reference, note, actor }) {
  if (!seller) throw new AccountsError('البائع غير موجود');
  if (!Number.isInteger(minor) || minor <= 0) throw new AccountsError('اكتب مبلغا صحيحا أكبر من صفر');
  const base = money.base();
  const baseMinor = toBaseMinor(minor, cur);
  if (baseMinor <= 0) throw new AccountsError('المبلغ صغير جدا');
  const id = Number(
    run(
      'INSERT INTO seller_payouts (seller_id, amount, currency, base_amount, base_currency, method, reference, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      seller.id,
      minor,
      cur.code,
      baseMinor,
      base.code,
      method || null,
      reference || null,
      note || null,
      actor.id,
    ).lastInsertRowid,
  );
  notify(seller.id, {
    title: `حولنا لك ${money.formatMajor(minor / 100, cur)} من أرباحك`,
    body: [method, reference ? `رقم العملية: ${reference}` : null, note].filter(Boolean).join(' · ') || null,
    link: '/seller/earnings?tab=payouts',
    icon: 'fa-solid fa-money-bill-transfer',
    tone: 'success',
  });
  return id;
}

function deletePayout(id) {
  const p = get('SELECT * FROM seller_payouts WHERE id = ?', id);
  if (!p) throw new AccountsError('التحويل غير موجود');
  run('DELETE FROM seller_payouts WHERE id = ?', id);
  return p;
}

/* ---------- Export ---------- */
const statusText = (key) => (key === 'refunded' ? 'مسترجع' : ORDER_STATUS[key] ? ORDER_STATUS[key].short : key);
const stamp = (v) => {
  const local = zonedLocal(v);
  return local ? local.replace('T', ' ') : '';
};
const sellerLabel = (r) => r.seller_store || r.seller_name || '';

/**
 * Builds the export: a summary, the sales, the refunds and the payouts of a period, all in `cur`.
 * Returns sheets for the .xlsx writer; the CSV export uses the sales sheet.
 */
function report({ period: p, sellerId = null, cur }) {
  const c = cur || money.base();
  const m = (v) => (v === null || v === undefined ? null : toMajor(v, c));
  const curName = `${c.name} (${c.code})`;
  const seller = sellerId ? get('SELECT id, name, store_name FROM users WHERE id = ?', sellerId) : null;
  const t = totals({ period: p, sellerId });
  const meta = [
    [{ v: seller ? `حساب البائع: ${seller.store_name || seller.name}` : 'حسابات البائعين في MTS', s: 'title' }],
    [{ v: 'الفترة', s: 'bold' }, p.label],
    [{ v: 'العملة', s: 'bold' }, curName],
    [{ v: 'عمولة MTS', s: 'bold' }, rateLabel()],
    [{ v: 'تاريخ التصدير', s: 'bold' }, stamp(new Date())],
  ];
  if (!c.is_base) meta.push([{ v: 'ملاحظة', s: 'bold' }, { v: `المبالغ محولة من ${money.base().code} بسعر الصرف الحالي`, s: 'muted' }]);

  // Summary: one row per seller (or the one seller), then totals.
  const people = sellerId ? sellers({ period: p }).filter((u) => u.id === sellerId) : sellers({ period: p }).filter((u) => u.period.sales_count || u.refunds.n || u.balance.due || u.balance.pending || u.role === 'seller');
  const paidInPeriod = new Map(payouts({ period: p, sellerId, limit: 100000 }).reduce((acc, x) => acc.set(x.seller_id, (acc.get(x.seller_id) || 0) + x.base_now), new Map()));
  const sumHead = ['البائع', 'عدد المبيعات', `المبيعات (${c.code})`, `عمولة MTS (${c.code})`, `مستحقات البائع (${c.code})`, 'عدد المسترجعات', `المسترجعات (${c.code})`, `حولنا له في الفترة (${c.code})`, `قيد الانتظار الآن (${c.code})`, `المستحق له الآن (${c.code})`];
  const sumRows = people.map((u) => [
    u.store_name || u.name,
    { v: u.period.sales_count, s: 'int' },
    m(u.period.gross),
    m(u.period.commission),
    m(u.period.seller_net),
    { v: u.refunds.n, s: 'int' },
    m(u.refunds.amount),
    m(paidInPeriod.get(u.id) || 0),
    m(u.balance.pending),
    m(u.balance.due),
  ]);
  const sumTotal = (i) => sumRows.reduce((s, r) => s + (typeof r[i] === 'object' && r[i] ? r[i].v : r[i] || 0), 0);
  const round = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
  const summary = {
    name: 'الملخص',
    widths: [30, 14, 18, 18, 20, 16, 18, 22, 22, 22],
    rows: [
      ...meta,
      [],
      sumHead.map((h) => ({ v: h, s: 'head' })),
      ...sumRows,
      [{ v: 'الإجمالي', s: 'totalText' }, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ v: [1, 5].includes(i) ? sumTotal(i) : round(sumTotal(i)), s: [1, 5].includes(i) ? 'totalText' : 'total' }))],
      [],
      [{ v: 'أرقام الفترة', s: 'bold' }],
      ['اشتراكات البائعين المحصلة', m(t.fees.amount)],
      ...(t.direct ? [['مبيعات منتجات MTS المباشرة', m(t.direct.amount)]] : []),
      ['إجمالي إيراد MTS من البائعين (العمولة + الاشتراكات)', m(t.commission + t.fees.amount)],
    ],
    freeze: meta.length + 2,
  };

  const saleHead = ['التاريخ', 'رقم الطلب', 'البائع', 'المنتج', 'الباقة', 'الكمية', 'الحالة', `سعر البيع (${c.code})`, `السعر الأصلي (${c.code})`, `الربح (${c.code})`, 'العمولة', `عمولة MTS (${c.code})`, `مستحقات البائع (${c.code})`, `صافي ربح البائع (${c.code})`, 'دفع العميل'];
  const saleRow = (r) => [
    stamp(r.paid_at),
    r.code,
    sellerLabel(r),
    r.product_title,
    r.plan_name,
    { v: r.quantity, s: 'int' },
    statusText(r.status_key),
    m(r.total),
    m(r.cost),
    m(r.profit),
    rateLabel(r.commission_rate, r.commission_basis || 'sale'),
    m(r.commission),
    m(r.seller_net),
    m(r.seller_profit),
    `${money.formatNumber(r.pay_amount / 100)} ${r.pay_currency} عبر ${r.payment_method_name}`,
  ];
  const list = sales({ period: p, sellerId, limit: 100000 });
  const sum = (key) => round(list.reduce((s, r) => s + (r[key] === null ? 0 : toMajor(r[key], c)), 0));
  const salesSheet = {
    name: 'المبيعات',
    widths: [17, 12, 22, 30, 14, 8, 12, 16, 16, 14, 16, 16, 18, 18, 26],
    rows: [
      saleHead.map((h) => ({ v: h, s: 'head' })),
      ...list.map(saleRow),
      list.length
        ? [{ v: `الإجمالي (${list.length} عملية)`, s: 'totalText' }, ...Array(6).fill({ v: '', s: 'totalText' }), { v: sum('total'), s: 'total' }, { v: sum('cost'), s: 'total' }, { v: sum('profit'), s: 'total' }, { v: '', s: 'totalText' }, { v: sum('commission'), s: 'total' }, { v: sum('seller_net'), s: 'total' }, { v: sum('seller_profit'), s: 'total' }, { v: '', s: 'totalText' }]
        : ['لا توجد مبيعات في هذه الفترة'],
    ],
    freeze: 1,
  };

  const refunds = sales({ period: p, sellerId, refunded: true, limit: 100000 });
  const refundSheet = {
    name: 'المسترجعات',
    widths: [17, 17, 12, 22, 30, 14, 8, 16, 40],
    rows: [
      ['تاريخ الاسترجاع', 'تاريخ الدفع', 'رقم الطلب', 'البائع', 'المنتج', 'الباقة', 'الكمية', `المبلغ المسترجع (${c.code})`, 'السبب'].map((h) => ({ v: h, s: 'head' })),
      ...refunds.map((r) => [stamp(r.refunded_at), stamp(r.paid_at), r.code, sellerLabel(r), r.product_title, r.plan_name, { v: r.quantity, s: 'int' }, m(r.total), r.refund_reason || '']),
      refunds.length ? [{ v: `الإجمالي (${refunds.length})`, s: 'totalText' }, ...Array(6).fill({ v: '', s: 'totalText' }), { v: round(refunds.reduce((s, r) => s + toMajor(r.total, c), 0)), s: 'total' }, { v: '', s: 'totalText' }] : ['لا توجد مسترجعات في هذه الفترة'],
    ],
    freeze: 1,
  };

  const outs = payouts({ period: p, sellerId, limit: 100000 });
  const payoutSheet = {
    name: 'التحويلات للبائعين',
    widths: [17, 22, 18, 18, 20, 20, 30],
    rows: [
      ['التاريخ', 'البائع', 'المبلغ المحول', `بعملة التقرير (${c.code})`, 'الطريقة', 'رقم العملية', 'ملاحظة'].map((h) => ({ v: h, s: 'head' })),
      ...outs.map((x) => [stamp(x.created_at), x.seller_store || x.seller_name, `${money.formatNumber(x.amount / 100)} ${x.currency}`, m(x.base_now), x.method || '', x.reference || '', x.note || '']),
      outs.length ? [{ v: `الإجمالي (${outs.length})`, s: 'totalText' }, { v: '', s: 'totalText' }, { v: '', s: 'totalText' }, { v: round(outs.reduce((s, x) => s + toMajor(x.base_now, c), 0)), s: 'total' }, { v: '', s: 'totalText' }, { v: '', s: 'totalText' }, { v: '', s: 'totalText' }] : ['لا توجد تحويلات في هذه الفترة'],
    ],
    freeze: 1,
  };

  const who = seller ? `-${(seller.store_name || seller.name).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 30)}` : '';
  return { filename: `mts-accounts${who}-${p.slug}-${c.code}`, sheets: [summary, salesSheet, refundSheet, payoutSheet], salesSheet, summary };
}

// RFC 4180 CSV with a UTF-8 BOM so Excel shows Arabic correctly.
function csv(rows) {
  const cell = (c) => {
    const v = c && typeof c === 'object' ? c.v : c;
    if (v === null || v === undefined) return '';
    const s = String(v);
    // Spreadsheet apps run cells that start with = + - @ as formulas; text cells get a leading quote.
    const safe = typeof v === 'string' && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '﻿' + rows.map((r) => (r || []).map(cell).join(',')).join('\r\n') + '\r\n';
}

module.exports = {
  PAID,
  BASIS,
  PERIODS,
  AccountsError,
  commissionRate,
  commissionBasis,
  split,
  rateLabel,
  inBase,
  currency,
  toMajor,
  toBaseMinor,
  format,
  period,
  within,
  sales,
  salesCount,
  totals,
  balances,
  balance,
  sellers,
  products,
  payouts,
  recordPayout,
  deletePayout,
  report,
  csv,
  statusText,
};
