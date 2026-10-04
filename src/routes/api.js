'use strict';
const express = require('express');
const { get, all, run } = require('../db');
const catalog = require('../lib/catalog');
const money = require('../lib/money');
const orders = require('../lib/orders');
const settings = require('../lib/settings');
const { timeAgo } = require('../lib/format');
const { clean, int } = require('../lib/util');
const { requireAuth } = require('../middleware');
const { isStaff } = require('../lib/auth');

const router = express.Router();

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/search', (req, res) => {
  const q = clean(req.query.q, 60);
  if (q.length < 2) return res.json({ ok: true, items: [] });
  const cur = money.resolve((req.cookies && req.cookies.mts_cur) || settings.get('default_currency'));
  const { items, total } = catalog.listProducts({ q, sort: 'popular', limit: 6 });
  res.json({
    ok: true,
    total,
    items: items.map((p) => ({
      title: p.title,
      url: `/store/product/${p.slug}`,
      platform: p.platform_name || '',
      logo: p.platform_logo || '/static/img/logo-96.png',
      price: p.cheapest ? money.format(p.cheapest.price, cur) : '',
      from: p.plan_count > 1,
    })),
  });
});

router.get('/notifications', requireAuth, (req, res) => {
  const items = all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 8', req.user.id);
  res.json({
    ok: true,
    unread: get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', req.user.id).n,
    items: items.map((n) => ({ id: n.id, title: n.title, body: n.body, link: n.link, icon: n.icon, tone: n.tone, read: !!n.is_read, ago: timeAgo(n.created_at) })),
  });
});

router.post('/notifications/read', requireAuth, (req, res) => {
  const id = int(req.body && req.body.id, { fallback: null });
  if (id) run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', id, req.user.id);
  else run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', req.user.id);
  res.json({ ok: true });
});

// Lightweight polling endpoint: unread count, newest notification and (for staff) pending orders.
router.get('/pulse', requireAuth, (req, res) => {
  const latest = get('SELECT id, title, body, link, tone FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1', req.user.id);
  const data = {
    ok: true,
    unread: get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', req.user.id).n,
    latest: latest || null,
  };
  if (isStaff(req.user)) {
    data.pendingOrders =
      req.user.role === 'admin'
        ? get("SELECT COUNT(*) AS n FROM orders WHERE status = 'under_review'").n
        : get("SELECT COUNT(*) AS n FROM orders WHERE status = 'under_review' AND seller_id = ? AND user_id <> ?", req.user.id, req.user.id).n;
  }
  res.json(data);
});

router.get('/orders/:code/status', requireAuth, (req, res) => {
  const order = orders.byCode(req.params.code);
  if (!order || (order.user_id !== req.user.id && !orders.canManage(req.user, order))) {
    return res.status(404).json({ ok: false });
  }
  res.json({ ok: true, status: order.status, updated: order.updated_at });
});

module.exports = router;
