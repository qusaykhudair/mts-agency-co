'use strict';
const fs = require('fs');
const path = require('path');
const { get, all, run, tx, toSql, fromSql } = require('../db');
const { notify, notifyStaff } = require('./notify');
const money = require('./money');
const settings = require('./settings');
const { parseJson } = require('./format');
const { RECEIPTS_DIR } = require('./uploads');

// An order total (alias "o") expressed in the *current* base currency, even if the base changed since.
const TOTAL_IN_BASE_SQL = `(o.total / COALESCE((SELECT c.rate FROM currencies c WHERE c.code = o.base_currency AND c.is_base = 0), 1))`;
const PAID_STATUSES = "('processing', 'delivered', 'completed')";

class OrderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

function addEvent(orderId, actorId, type, message = null, isPublic = true) {
  run('INSERT INTO order_events (order_id, actor_id, type, message, is_public) VALUES (?, ?, ?, ?, ?)', orderId, actorId || null, type, message, isPublic ? 1 : 0);
}

function byCode(code) {
  return get(
    `SELECT o.*, u.name AS buyer_name, u.email AS buyer_email, u.wa_e164 AS buyer_whatsapp, u.avatar_url AS buyer_avatar,
            p.slug AS product_slug, p.cover_url AS product_cover, p.delivery_method AS delivery_method,
            pl.logo_url AS platform_logo, pl.color1 AS color1, pl.color2 AS color2, pl.slug AS platform_slug,
            pm.icon AS pm_icon, pm.color AS pm_color, pm.logo_url AS pm_logo,
            s.name AS seller_name, s.store_name AS seller_store, r.name AS reviewer_name,
            (SELECT id FROM reviews WHERE order_id = o.id) AS review_id
     FROM orders o
     JOIN users u ON u.id = o.user_id
     LEFT JOIN products p ON p.id = o.product_id
     LEFT JOIN platforms pl ON pl.id = p.platform_id
     LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
     LEFT JOIN users s ON s.id = o.seller_id
     LEFT JOIN users r ON r.id = o.reviewed_by
     WHERE o.code = ?`,
    String(code || '').toUpperCase(),
  );
}

function events(orderId, { includePrivate = false } = {}) {
  return all(
    `SELECT e.*, u.name AS actor_name, u.role AS actor_role FROM order_events e
     LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.order_id = ? ${includePrivate ? '' : 'AND e.is_public = 1'} ORDER BY e.id`,
    orderId,
  );
}

// Sellers handle orders for their own products, but never an order they placed themselves.
const canManage = (user, order) =>
  !!user && (user.role === 'admin' || (user.role === 'seller' && order.seller_id === user.id && order.user_id !== user.id));

function delivery(order) {
  return parseJson(order.delivery, null);
}

function orderLink(order, staff) {
  return staff ? `/seller/orders/${order.code}` : `/account/orders/${order.code}`;
}

function payLabel(order) {
  return money.formatMajor(order.pay_amount / 100, money.byCode(order.pay_currency) || { symbol: order.pay_currency, decimals: 2 });
}

/** Create an order from a validated checkout submission. Throws OrderError on stock problems. */
function create({ user, product, plan, quantity, method, senderName, senderAccount, buyerInput, buyerNote, receipt }) {
  const base = money.base();
  const payCurrency = money.byCode(method.currency_code) || base;
  return tx(() => {
    const reserved = reserveStock(plan.id, quantity);
    const total = plan.price * quantity;
    const payMajor = money.convert(total, payCurrency);
    const info = run(
      `INSERT INTO orders (user_id, seller_id, product_id, plan_id, product_title, plan_name, platform_name, duration_days,
         quantity, unit_price, total, base_currency, pay_currency, pay_rate, pay_amount, payment_method_id, payment_method_name,
         sender_name, sender_account, receipt_file, receipt_mime, buyer_input_label, buyer_input, buyer_note, stock_reserved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      user.id,
      product.seller_id,
      product.id,
      plan.id,
      product.title,
      plan.name,
      product.platform_name || null,
      plan.duration_days || null,
      quantity,
      plan.price,
      total,
      base.code,
      payCurrency.code,
      payCurrency.is_base ? 1 : payCurrency.rate,
      Math.round(payMajor * 100),
      method.id,
      method.name,
      senderName,
      senderAccount,
      receipt.filename,
      receipt.realType,
      product.buyer_input_label || null,
      buyerInput || null,
      buyerNote || null,
      reserved,
    );
    const id = Number(info.lastInsertRowid);
    const code = `MTS-${10000 + id}`;
    run('UPDATE orders SET code = ? WHERE id = ?', code, id);
    addEvent(id, user.id, 'created', `عبر ${method.name}`);
    const order = byCode(code);
    notifyStaff(
      product.seller_id,
      {
        title: `طلب جديد ${code} بانتظار مراجعة الدفع`,
        body: `${product.title} — ${plan.name} • ${payLabel(order)} عبر ${method.name}`,
        link: orderLink(order, true),
        icon: 'fa-solid fa-receipt',
        tone: 'warning',
      },
      { exclude: user.id },
    );
    return order;
  });
}

/** Takes `quantity` units from a plan with limited stock. Returns how many were reserved (0 when unlimited). */
function reserveStock(planId, quantity) {
  if (!planId) return 0;
  const plan = get('SELECT stock FROM product_plans WHERE id = ?', planId);
  if (!plan || plan.stock === null) return 0;
  if (plan.stock < quantity) throw new OrderError('الكمية المطلوبة غير متوفرة حالياً لهذه الباقة');
  run('UPDATE product_plans SET stock = stock - ? WHERE id = ?', quantity, planId);
  return quantity;
}

/** Gives back exactly what this order reserved. */
function releaseStock(order) {
  if (!order.stock_reserved) return;
  if (order.plan_id) run('UPDATE product_plans SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL', order.stock_reserved, order.plan_id);
  run('UPDATE orders SET stock_reserved = 0 WHERE id = ?', order.id);
}

function resubmitReceipt(order, user, { senderName, senderAccount, receipt }) {
  if (order.status !== 'payment_rejected') throw new OrderError('لا يمكن تعديل إيصال هذا الطلب حالياً');
  const oldFile = order.receipt_file;
  tx(() => {
    // Rejection released the stock; take it again (fails if the plan sold out meanwhile).
    let reserved = order.stock_reserved || 0;
    if (!reserved) {
      try {
        reserved = reserveStock(order.plan_id, order.quantity);
      } catch (err) {
        if (err instanceof OrderError) throw new OrderError('نفدت الكمية المتاحة من هذه الباقة حالياً، تواصل معنا عبر واتساب لإكمال طلبك');
        throw err;
      }
    }
    run(
      `UPDATE orders SET status = 'under_review', sender_name = ?, sender_account = ?, receipt_file = ?, receipt_mime = ?,
         reject_reason = NULL, stock_reserved = ?, updated_at = datetime('now') WHERE id = ?`,
      senderName,
      senderAccount,
      receipt.filename,
      receipt.realType,
      reserved,
      order.id,
    );
    addEvent(order.id, user.id, 'receipt_resubmitted');
  });
  if (oldFile) fs.rm(path.join(RECEIPTS_DIR, oldFile), { force: true }, () => {});
  notifyStaff(
    order.seller_id,
    {
      title: `إيصال جديد للطلب ${order.code}`,
      body: `أعاد ${order.buyer_name} إرسال إيصال الدفع بعد الرفض، بانتظار المراجعة.`,
      link: orderLink(order, true),
      icon: 'fa-solid fa-file-invoice',
      tone: 'warning',
    },
    { exclude: user.id },
  );
}

function markPaid(order, actor) {
  run(
    `UPDATE orders SET paid_at = COALESCE(paid_at, datetime('now')), reviewed_by = ?, reject_reason = NULL, updated_at = datetime('now') WHERE id = ?`,
    actor.id,
    order.id,
  );
  if (!order.paid_at && order.product_id) {
    run('UPDATE products SET sales_count = sales_count + ? WHERE id = ?', order.quantity, order.product_id);
  }
}

function approve(order, actor) {
  if (order.status !== 'under_review') throw new OrderError('يمكن تأكيد الدفع للطلبات التي بانتظار المراجعة فقط');
  tx(() => {
    markPaid(order, actor);
    run("UPDATE orders SET status = 'processing' WHERE id = ?", order.id);
    addEvent(order.id, actor.id, 'approved');
  });
  notify(order.user_id, {
    title: `تم تأكيد الدفع لطلبك ${order.code} ✅`,
    body: 'نعمل الآن على تجهيز اشتراكك، وسيصلك إشعار فور تسليم البيانات.',
    link: orderLink(order),
    icon: 'fa-solid fa-circle-check',
    tone: 'success',
  });
  // Let the product's seller know the order is paid and ready to deliver.
  if (order.seller_id && order.seller_id !== actor.id && order.seller_id !== order.user_id) {
    notify(order.seller_id, {
      title: `تم تأكيد الدفع للطلب ${order.code} — جاهز للتسليم`,
      body: `${order.product_title} — ${order.plan_name}`,
      link: orderLink(order, true),
      icon: 'fa-solid fa-truck-fast',
      tone: 'success',
    });
  }
}

function reject(order, actor, reason) {
  if (order.status !== 'under_review') throw new OrderError('يمكن رفض الإيصال للطلبات التي بانتظار المراجعة فقط');
  tx(() => {
    run(
      `UPDATE orders SET status = 'payment_rejected', reject_reason = ?, reviewed_by = ?, updated_at = datetime('now') WHERE id = ?`,
      reason,
      actor.id,
      order.id,
    );
    // Unpaid orders must not hold limited stock; resubmitting the receipt reserves it again.
    releaseStock(order);
    addEvent(order.id, actor.id, 'rejected', reason);
  });
  notify(order.user_id, {
    title: `تعذّر تأكيد الدفع لطلبك ${order.code}`,
    body: `${reason} — يمكنك إرسال إيصال صحيح من صفحة الطلب.`,
    link: orderLink(order),
    icon: 'fa-solid fa-triangle-exclamation',
    tone: 'danger',
  });
}

/** Save subscription details for the buyer. Approves the payment first when still under review. */
function deliver(order, actor, { fields, note, expiresAt }) {
  if (!['under_review', 'processing', 'delivered', 'completed'].includes(order.status)) {
    throw new OrderError('لا يمكن تسليم هذا الطلب في حالته الحالية');
  }
  const isUpdate = order.status === 'delivered' || order.status === 'completed';
  const payload = JSON.stringify({ fields, note: note || '' });
  tx(() => {
    if (order.status === 'under_review') {
      markPaid(order, actor);
      addEvent(order.id, actor.id, 'approved');
    }
    run(
      `UPDATE orders SET delivery = ?, expires_at = ?, status = CASE WHEN status = 'completed' THEN 'completed' ELSE 'delivered' END,
         delivered_at = COALESCE(delivered_at, datetime('now')), updated_at = datetime('now') WHERE id = ?`,
      payload,
      expiresAt || null,
      order.id,
    );
    addEvent(order.id, actor.id, isUpdate ? 'delivery_updated' : 'delivered');
  });
  notify(order.user_id, {
    title: isUpdate ? `تم تحديث بيانات اشتراكك (${order.code})` : `تم تسليم اشتراكك 🎉 (${order.code})`,
    body: `بيانات ${order.product_title} — ${order.plan_name} جاهزة في صفحة الطلب.`,
    link: orderLink(order),
    icon: 'fa-solid fa-gift',
    tone: 'success',
  });
}

function complete(order, actor, { auto = false } = {}) {
  if (order.status !== 'delivered') throw new OrderError('يمكن إكمال الطلبات التي تم تسليمها فقط');
  tx(() => {
    run(`UPDATE orders SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, order.id);
    addEvent(order.id, actor ? actor.id : null, 'completed', auto ? 'اكتمل تلقائياً بعد انتهاء مهلة التأكيد' : actor && actor.id === order.user_id ? 'أكّد العميل استلام الاشتراك' : null);
  });
  if (!auto && actor && actor.id === order.user_id) {
    notifyStaff(
      order.seller_id,
      {
        title: `أكّد العميل استلام الطلب ${order.code}`,
        body: `${order.buyer_name} — ${order.product_title}`,
        link: orderLink(order, true),
        icon: 'fa-solid fa-handshake',
        tone: 'success',
      },
      { exclude: actor.id },
    );
  }
}

function cancel(order, actor, reason) {
  if (!['under_review', 'payment_rejected', 'processing'].includes(order.status)) {
    throw new OrderError('لا يمكن إلغاء هذا الطلب في حالته الحالية');
  }
  tx(() => {
    run(`UPDATE orders SET status = 'cancelled', cancelled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, order.id);
    releaseStock(order);
    // A paid order that gets cancelled no longer counts as a sale.
    if (order.paid_at && order.product_id) {
      run('UPDATE products SET sales_count = MAX(0, sales_count - ?) WHERE id = ?', order.quantity, order.product_id);
    }
    addEvent(order.id, actor.id, 'cancelled', reason || null);
  });
  if (actor.id !== order.user_id) {
    notify(order.user_id, {
      title: `تم إلغاء طلبك ${order.code}`,
      body: reason || 'تواصل معنا عبر واتساب لأي استفسار.',
      link: orderLink(order),
      icon: 'fa-solid fa-ban',
      tone: 'danger',
    });
  } else {
    notifyStaff(
      order.seller_id,
      {
        title: `ألغى العميل الطلب ${order.code}`,
        body: `${order.buyer_name} — ${order.product_title}`,
        link: orderLink(order, true),
        icon: 'fa-solid fa-ban',
        tone: 'muted',
      },
      { exclude: actor.id },
    );
  }
}

function addNote(order, actor, text) {
  addEvent(order.id, actor.id, 'note', text, false);
}

// Delivered orders the buyer never confirmed are closed after the configured grace period.
function autoComplete() {
  const days = Math.max(1, Number(settings.get('auto_complete_days')) || 3);
  const cutoff = toSql(new Date(Date.now() - days * 86400000));
  const due = all("SELECT code FROM orders WHERE status = 'delivered' AND delivered_at <= ?", cutoff);
  for (const { code } of due) {
    const order = byCode(code);
    if (order && order.status === 'delivered') complete(order, null, { auto: true });
  }
  return due.length;
}

function isExpired(order) {
  const d = fromSql(order.expires_at);
  return !!d && d.getTime() < Date.now();
}

module.exports = {
  TOTAL_IN_BASE_SQL,
  PAID_STATUSES,
  OrderError,
  byCode,
  events,
  canManage,
  delivery,
  create,
  resubmitReceipt,
  approve,
  reject,
  deliver,
  complete,
  cancel,
  addNote,
  autoComplete,
  isExpired,
  payLabel,
};
