'use strict';
// The monthly seller fee. A seller is paid up to users.fee_paid_until; after that comes a short grace
// period, and then (while enforcement is on) the seller dashboard closes and their products leave the
// store until the fee is paid. users.fee_due_at holds the moment that happens (NULL = never), so the
// catalogue can hide those products with a plain column check.
const fs = require('fs');
const path = require('path');
const { get, all, run, tx, toSql, fromSql } = require('../db');
const money = require('./money');
const settings = require('./settings');
const accounts = require('./accounts');
const { notify, notifyStaff } = require('./notify');
const { fmtDate } = require('./format');
const { RECEIPTS_DIR } = require('./uploads');

const METHODS = {
  transfer: 'تحويل',
  cash: 'نقدا',
  balance: 'خصم من رصيد البائع',
  waived: 'إعفاء بدون مبلغ',
};
const STATUS = {
  pending: { label: 'بانتظار المراجعة', tone: 'warning' },
  approved: { label: 'مقبول', tone: 'success' },
  rejected: { label: 'مرفوض', tone: 'danger' },
  void: { label: 'ملغى', tone: 'muted' },
};
// Days before the paid period ends when the seller starts seeing a reminder.
const SOON_DAYS = 5;

class FeeError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.expose = true;
  }
}

/* ---------- Settings ---------- */
function config() {
  const amount = Math.max(0, Number(settings.get('seller_fee_amount')) || 0);
  const cur = money.byCode(settings.get('seller_fee_currency')) || money.base();
  const graceDays = Math.min(60, Math.max(0, Math.round(Number(settings.get('seller_fee_grace_days')) || 0)));
  return {
    amount,
    minor: Math.round(amount * 100),
    currency: cur,
    // The fee expressed in the current base currency (minor units).
    baseMinor: accounts.toBaseMinor(Math.round(amount * 100), cur),
    graceDays,
    enforce: settings.get('seller_fee_enforce') === '1',
    label: money.formatMajor(amount, cur),
  };
}

/* ---------- Dates ---------- */
// Calendar months, keeping the day of month where it exists (31 Jan + 1 month = 28/29 Feb).
function addMonths(date, n) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * Recomputes when sellers lose access (fee_due_at) from what they have paid and the current settings.
 * New sellers without a paid date start owing the fee now.
 */
function sync(userId = null) {
  const c = config();
  const only = userId ? ' AND id = ?' : '';
  const args = userId ? [userId] : [];
  tx(() => {
    run(`UPDATE users SET fee_paid_until = datetime('now') WHERE role = 'seller' AND fee_paid_until IS NULL${only}`, ...args);
    if (c.enforce && c.amount > 0) {
      run(`UPDATE users SET fee_due_at = datetime(fee_paid_until, '+${c.graceDays} days') WHERE role = 'seller'${only}`, ...args);
      run(`UPDATE users SET fee_due_at = NULL WHERE role <> 'seller'${only}`, ...args);
    } else {
      run(`UPDATE users SET fee_due_at = NULL WHERE 1 = 1${only}`, ...args);
    }
  });
}

/** Where a seller stands with the fee: active, due soon, in the grace period, overdue or locked. */
function state(user, now = new Date()) {
  if (!user || user.role !== 'seller') return { applies: false, locked: false };
  const c = config();
  const paidUntil = fromSql(user.fee_paid_until);
  const dueAt = fromSql(user.fee_due_at);
  const pending = get("SELECT * FROM seller_fees WHERE seller_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", user.id) || null;
  const locked = !!dueAt && dueAt.getTime() <= now.getTime();
  let status = 'active';
  if (c.amount <= 0) status = 'free';
  else if (locked) status = 'locked';
  else if (!paidUntil || paidUntil.getTime() <= now.getTime()) status = c.enforce ? 'grace' : 'overdue';
  else if (paidUntil.getTime() - now.getTime() <= SOON_DAYS * 86400000) status = 'soon';
  const days = (d) => (d ? Math.max(0, Math.ceil((d.getTime() - now.getTime()) / 86400000)) : null);
  return {
    applies: c.amount > 0,
    status,
    locked,
    paidUntil,
    dueAt,
    daysLeft: days(paidUntil),
    graceLeft: days(dueAt),
    pending,
    config: c,
  };
}

function isLocked(user) {
  return state(user).locked;
}

/* ---------- Payments ---------- */
// The next paid period starts where the current one ends, or now when it already ended.
function nextPeriod(seller, months) {
  const now = new Date();
  const current = fromSql(seller.fee_paid_until);
  const from = current && current.getTime() > now.getTime() ? current : now;
  return { from, to: addMonths(from, months) };
}

function applyPayment(fee, seller, actor) {
  const { from, to } = nextPeriod(seller, fee.months);
  run(
    "UPDATE seller_fees SET status = 'approved', period_from = ?, period_to = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?",
    toSql(from),
    toSql(to),
    actor ? actor.id : null,
    fee.id,
  );
  run('UPDATE users SET fee_paid_until = ?, fee_notice = NULL WHERE id = ?', toSql(to), seller.id);
  sync(seller.id);
  return to;
}

function monthsText(n) {
  return n === 1 ? 'شهر' : n === 2 ? 'شهرين' : n <= 10 ? `${n} أشهر` : `${n} شهرا`;
}

function seller(id) {
  const u = get('SELECT * FROM users WHERE id = ?', id);
  if (!u || u.role !== 'seller') throw new FeeError('هذا الحساب ليس حساب بائع');
  return u;
}

/** A seller sends a transfer receipt for `months` of the fee; an admin reviews it. */
function submit({ user, months, method, senderName, senderAccount, receipt, note }) {
  const s = seller(user.id);
  if (get("SELECT id FROM seller_fees WHERE seller_id = ? AND status = 'pending'", s.id)) throw new FeeError('لديك دفعة اشتراك بانتظار المراجعة');
  const c = config();
  const cur = money.byCode(method.currency_code) || money.base();
  const baseMinor = c.baseMinor * months;
  const id = Number(
    run(
      `INSERT INTO seller_fees (seller_id, months, amount, currency, base_amount, base_currency, method, payment_method_id, payment_method_name,
         sender_name, sender_account, receipt_file, receipt_mime, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'transfer', ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.id,
      months,
      Math.round(money.convert(baseMinor, cur) * 100),
      cur.code,
      baseMinor,
      money.base().code,
      method.id,
      method.name,
      senderName,
      senderAccount,
      receipt.filename,
      receipt.realType,
      note || null,
      s.id,
    ).lastInsertRowid,
  );
  notifyStaff(null, {
    title: `إيصال اشتراك بائع من ${s.store_name || s.name}`,
    body: `${monthsText(months)} عبر ${method.name}`,
    link: '/seller/accounts/fees',
    icon: 'fa-solid fa-file-invoice-dollar',
    tone: 'warning',
  });
  return id;
}

/** The seller pays from what MTS owes them; done at once when the balance covers it. */
function payFromBalance({ user, months }) {
  const s = seller(user.id);
  const c = config();
  const need = c.baseMinor * months;
  return tx(() => {
    const due = accounts.balance(s.id).due;
    if (due < need) throw new FeeError(`رصيدك المستحق (${accounts.format(Math.max(0, due))}) لا يكفي لاشتراك ${monthsText(months)}`);
    const base = money.base();
    const id = Number(
      run(
        `INSERT INTO seller_fees (seller_id, months, amount, currency, base_amount, base_currency, method, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'balance', ?)`,
        s.id,
        months,
        need,
        base.code,
        need,
        base.code,
        s.id,
      ).lastInsertRowid,
    );
    return applyPayment({ id, months }, s, null);
  });
}

/** An admin records a payment received some other way (or a free period). Approved at once. */
function record({ sellerId, months, method, minor, cur, note, actor }) {
  const s = seller(sellerId);
  if (!METHODS[method]) throw new FeeError('اختر طريقة الدفع');
  const c = config();
  const base = money.base();
  let amount = 0;
  let currency = (cur || c.currency).code;
  let baseAmount = 0;
  if (method === 'balance') {
    baseAmount = c.baseMinor * months;
    amount = baseAmount;
    currency = base.code;
  } else if (method !== 'waived') {
    if (!Number.isInteger(minor) || minor <= 0) throw new FeeError('اكتب المبلغ الذي استلمته');
    amount = minor;
    baseAmount = accounts.toBaseMinor(minor, cur || c.currency);
  }
  return tx(() => {
    if (method === 'balance') {
      const due = accounts.balance(s.id).due;
      if (due < baseAmount) throw new FeeError(`رصيد البائع المستحق (${accounts.format(Math.max(0, due))}) لا يكفي لهذه المدة`);
    }
    const id = Number(
      run(
        `INSERT INTO seller_fees (seller_id, months, amount, currency, base_amount, base_currency, method, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        s.id,
        months,
        amount,
        currency,
        baseAmount,
        base.code,
        method,
        note || null,
        actor.id,
      ).lastInsertRowid,
    );
    const until = applyPayment({ id, months }, s, actor);
    notify(s.id, {
      title: method === 'waived' ? `أضفنا مدة ${monthsText(months)} إلى اشتراكك كبائع` : `سجلنا دفعة اشتراكك كبائع (${monthsText(months)})`,
      body: `اشتراكك فعال حتى ${fmtDate(until)}.`,
      link: '/seller/subscription',
      icon: 'fa-solid fa-circle-check',
      tone: 'success',
    });
    return id;
  });
}

function approve(fee, actor) {
  if (fee.status !== 'pending') throw new FeeError('تمت مراجعة هذه الدفعة من قبل');
  const s = seller(fee.seller_id);
  const until = tx(() => applyPayment(fee, s, actor));
  notify(s.id, {
    title: 'أكدنا دفع اشتراكك كبائع',
    body: `اشتراكك فعال حتى ${fmtDate(until)}.`,
    link: '/seller/subscription',
    icon: 'fa-solid fa-circle-check',
    tone: 'success',
  });
  return until;
}

function reject(fee, actor, reason) {
  if (fee.status !== 'pending') throw new FeeError('تمت مراجعة هذه الدفعة من قبل');
  run("UPDATE seller_fees SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?", reason, actor.id, fee.id);
  notify(fee.seller_id, {
    title: 'لم نتمكن من تأكيد دفع اشتراكك كبائع',
    body: `${reason}. أرسل إيصالا صحيحا من صفحة اشتراك البائع.`,
    link: '/seller/subscription',
    icon: 'fa-solid fa-triangle-exclamation',
    tone: 'danger',
  });
}

/**
 * Cancels an approved payment recorded by mistake. Only the latest approved payment of a seller can be
 * cancelled, so the paid date can step back to where that payment started.
 */
function voidFee(fee, actor) {
  if (fee.status !== 'approved') throw new FeeError('يمكن إلغاء الدفعات المقبولة فقط');
  const latest = get("SELECT id FROM seller_fees WHERE seller_id = ? AND status = 'approved' ORDER BY period_to DESC, id DESC LIMIT 1", fee.seller_id);
  if (!latest || latest.id !== fee.id) throw new FeeError('ألغ آخر دفعة مقبولة أولا');
  tx(() => {
    run("UPDATE seller_fees SET status = 'void', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?", actor.id, fee.id);
    run('UPDATE users SET fee_paid_until = ?, fee_notice = NULL WHERE id = ?', fee.period_from || toSql(new Date()), fee.seller_id);
    sync(fee.seller_id);
  });
}

function list({ sellerId = null, status = null, limit = 200 } = {}) {
  const where = ['1 = 1'];
  const args = [];
  if (sellerId) {
    where.push('f.seller_id = ?');
    args.push(sellerId);
  }
  if (status) {
    where.push('f.status = ?');
    args.push(status);
  }
  return all(
    `SELECT f.*, u.name AS seller_name, u.store_name AS seller_store, u.fee_paid_until, a.name AS reviewer_name,
            pm.icon AS pm_icon, pm.color AS pm_color, pm.logo_url AS pm_logo
     FROM seller_fees f JOIN users u ON u.id = f.seller_id LEFT JOIN users a ON a.id = f.reviewed_by
     LEFT JOIN payment_methods pm ON pm.id = f.payment_method_id
     WHERE ${where.join(' AND ')} ORDER BY CASE f.status WHEN 'pending' THEN 0 ELSE 1 END, f.id DESC LIMIT ?`,
    ...args,
    limit,
  );
}

function byId(id) {
  return get('SELECT * FROM seller_fees WHERE id = ?', id);
}

/* ---------- Reminders ---------- */
// One notice per stage of each paid period: ending soon, ended (grace started), and dashboard closed.
function remind(now = new Date()) {
  const c = config();
  if (c.amount <= 0) return 0;
  let sent = 0;
  for (const u of all("SELECT * FROM users WHERE role = 'seller' AND is_blocked = 0 AND fee_paid_until IS NOT NULL")) {
    const st = state(u, now);
    const stage = st.status === 'locked' ? 'locked' : st.status === 'grace' || st.status === 'overdue' ? 'due' : st.status === 'soon' ? 'soon' : null;
    if (!stage || st.pending) continue;
    const key = `${u.fee_paid_until}#${stage}`;
    if (u.fee_notice === key) continue;
    // A seller who never paid has nothing that "ended": they are asked for their first month.
    const first = !get("SELECT id FROM seller_fees WHERE seller_id = ? AND status = 'approved' LIMIT 1", u.id);
    const text = {
      soon: [`اشتراكك كبائع ينتهي ${fmtDate(st.paidUntil)}`, `جدد الاشتراك (${c.label} شهريا) قبل هذا التاريخ ليبقى متجرك ظاهرا.`],
      due: [
        first ? 'ادفع اشتراك البائع الشهري' : 'انتهى اشتراكك كبائع',
        c.enforce ? `الاشتراك ${c.label} شهريا. ادفعه قبل ${fmtDate(st.dueAt)} حتى تبقى لوحة البائع ومنتجاتك ظاهرة.` : `الاشتراك ${c.label} شهريا، وتدفعه من صفحة اشتراك البائع.`,
      ],
      locked: ['أوقفنا لوحة البائع لعدم دفع الاشتراك', `منتجاتك مخفية من المتجر الآن. ادفع ${c.label} لنعيد تفعيلها.`],
    }[stage];
    notify(u.id, { title: text[0], body: text[1], link: '/seller/subscription', icon: 'fa-solid fa-calendar-check', tone: stage === 'soon' ? 'warning' : 'danger' });
    run('UPDATE users SET fee_notice = ? WHERE id = ?', key, u.id);
    sent++;
  }
  return sent;
}

// Receipts of fee payments live with the order receipts (private files).
function receiptPath(file) {
  return path.join(RECEIPTS_DIR, file);
}

function removeReceipt(file) {
  if (file) fs.rm(receiptPath(file), { force: true }, () => {});
}

module.exports = {
  METHODS,
  STATUS,
  FeeError,
  config,
  addMonths,
  sync,
  state,
  isLocked,
  monthsText,
  submit,
  payFromBalance,
  record,
  approve,
  reject,
  voidFee,
  list,
  byId,
  remind,
  receiptPath,
  removeReceipt,
};
