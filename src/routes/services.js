'use strict';
// Public side of MTS Agency services: the catalogue and the request form.
const express = require('express');
const { get, all } = require('../db');
const services = require('../lib/services');
const { BUDGETS, isoDay } = require('../lib/format');
const { serviceFiles, discard, SERVICE_FILE_MB } = require('../lib/uploads');
const { clean, cleanText, int, pick, urls } = require('../lib/util');
const { requireAuth } = require('../middleware');
const { limiter } = require('../lib/limits');

const router = express.Router();
const requestLimiter = limiter(10, 60, 'عدد كبير من الطلبات، حاول مرة أخرى بعد قليل');

const activeServices = () => all('SELECT * FROM services WHERE is_active = 1 ORDER BY sort_order, id');

router.get('/services', (req, res) => {
  res.render('services/index', {
    nav: 'site',
    pageTitle: 'خدماتنا',
    fullTitle: 'خدمات MTS Agency | تصميم وبرمجة وتسويق وإنتاج مرئي',
    pageDesc: 'اطلب من MTS Agency موقعك أو هويتك البصرية أو حملتك الإعلانية أو فيديو لمشروعك، وتابع العمل واستلمه من حسابك.',
    services: activeServices(),
  });
});

router.get('/services/request', requireAuth, (req, res) => {
  const list = activeServices();
  res.render('services/request', {
    nav: 'site',
    pageTitle: 'اطلب خدمة',
    noindex: true,
    services: list,
    selected: list.find((s) => s.slug === req.query.service) || null,
    budgets: BUDGETS,
    today: isoDay(new Date()),
    maxMb: SERVICE_FILE_MB,
  });
});

router.post('/services/request', requireAuth, requestLimiter, serviceFiles('files', 6), (req, res) => {
  const b = req.body;
  const errors = {};
  const service = get('SELECT * FROM services WHERE id = ? AND is_active = 1', int(b.service_id, { fallback: 0 }));
  if (!service) errors.service_id = 'اختر الخدمة المطلوبة';
  const title = clean(b.title, 120);
  if (title.length < 4) errors.title = 'اكتب عنوانا مختصرا لطلبك';
  const details = cleanText(b.details, 5000);
  if (details.length < 20) errors.details = 'اشرح ما تحتاجه بتفاصيل أكثر (20 حرفا على الأقل)';
  const budget = pick(BUDGETS, b.budget);
  let deadline = clean(b.deadline, 10) || null;
  if (deadline && (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || Number.isNaN(Date.parse(deadline)))) errors.deadline = 'تاريخ غير صالح';
  else if (deadline && deadline < isoDay(new Date())) errors.deadline = 'اختر تاريخا قادما';
  const links = urls(b.links, 10);
  if (links.error) errors.links = links.error;
  if (Object.keys(errors).length) {
    (req.files || []).forEach(discard);
    return res.reply({ ok: false, errors });
  }
  if (!deadline) deadline = null;
  const r = services.create({ user: req.user, service, title, details, budget, deadline, links: links.links, files: req.files });
  req.files.forEach((f) => (f.kept = true));
  res.reply({ ok: true, message: 'وصلنا طلبك، وسنتواصل معك بعد أن نقرأه', redirect: `/account/services/${r.code}?new=1` });
});

module.exports = router;
