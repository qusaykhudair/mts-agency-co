'use strict';
// Service providers' area: the requests they work on and the new ones waiting to be picked up.
const express = require('express');
const services = require('../lib/services');
const { clean } = require('../lib/util');
const { paginate, requireServiceTeam } = require('../middleware');
const { mountRequestRoutes } = require('./team');

const router = express.Router();
const PER_PAGE = 20;

router.use(requireServiceTeam, (req, res, next) => {
  res.locals.nav = 'provider';
  res.locals.noindex = true;
  next();
});

// Each tab is a filter on the "r" (request) alias for the signed-in provider.
const TABS = [
  { key: 'active', label: 'قيد العمل', sql: "r.assigned_to = ? AND r.status IN ('in_progress', 'revision')", mine: true },
  { key: 'pool', label: 'طلبات متاحة', sql: "r.assigned_to IS NULL AND r.status = 'pending' AND r.user_id <> ?", mine: true },
  { key: 'delivered', label: 'بانتظار العميل', sql: "r.assigned_to = ? AND r.status = 'delivered'", mine: true },
  { key: 'done', label: 'المنتهية', sql: "r.assigned_to = ? AND r.status IN ('completed', 'cancelled')", mine: true },
];

router.get('/', (req, res) => {
  const uid = req.user.id;
  const counts = Object.fromEntries(TABS.map((t) => [t.key, services.list({ where: [t.sql], params: [uid], limit: 1 }).total]));
  const fallback = counts.active ? 'active' : counts.pool ? 'pool' : 'active';
  const tab = TABS.find((t) => t.key === req.query.tab) || TABS.find((t) => t.key === fallback);
  const q = clean(req.query.q, 80);
  const where = [tab.sql];
  const params = [uid];
  if (q) {
    where.push('(r.code LIKE ? OR r.title LIKE ? OR c.name LIKE ? OR r.service_name LIKE ?)');
    params.push(...Array(4).fill(`%${q}%`));
  }
  const total = services.list({ where, params, limit: 1 }).total;
  const pg = paginate(total, req.query.page, PER_PAGE);
  res.render('team/requests', {
    active: 'prov-requests',
    pageTitle: 'طلبات الخدمات',
    scope: 'provider',
    tabs: TABS.map((t) => ({ key: t.key, label: t.label, count: counts[t.key] })),
    tab: tab.key,
    q,
    pg,
    items: services.list({ where, params, order: tab.key === 'pool' ? 'r.id ASC' : 'r.updated_at DESC, r.id DESC', limit: PER_PAGE, offset: pg.offset }).items,
    base: '/provider/requests',
  });
});

router.get('/requests', (req, res) => res.redirect('/provider'));
mountRequestRoutes(router, { base: '/requests', active: 'prov-requests' });

module.exports = router;
