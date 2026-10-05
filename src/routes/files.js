'use strict';
const path = require('path');
const express = require('express');
const { get } = require('../db');
const orders = require('../lib/orders');
const services = require('../lib/services');
const { RECEIPTS_DIR, SERVICE_DIR } = require('../lib/uploads');
const { requireAuth } = require('../middleware');

const router = express.Router();

// Payment receipts are private: only the buyer and the staff handling the order can open them.
router.get('/receipts/:file', requireAuth, (req, res, next) => {
  const file = String(req.params.file || '');
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp|gif|heic|heif|pdf)$/.test(file)) return next();
  const row = get('SELECT code FROM orders WHERE receipt_file = ?', file);
  const order = row && orders.byCode(row.code);
  if (!order || (order.user_id !== req.user.id && !orders.canManage(req.user, order))) return next();
  res.set({
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': `inline; filename="receipt-${order.code}${path.extname(file)}"`,
    'X-Content-Type-Options': 'nosniff',
  });
  if (order.receipt_mime) res.type(order.receipt_mime);
  res.sendFile(path.join(RECEIPTS_DIR, file), (err) => {
    if (err && !res.headersSent) next();
  });
});

// Service-request attachments: the client, the admins and the provider working on the request.
router.get('/services/:file', requireAuth, (req, res, next) => {
  const file = String(req.params.file || '');
  if (!/^[0-9a-f-]{36}\.[a-z0-9]{2,4}$/.test(file)) return next();
  const f = services.fileFor(req.user, file);
  if (!f) return next();
  // Images and PDFs open in the browser; anything else is always downloaded.
  const inline = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(f.mime) && req.query.download !== '1';
  res.attachment(f.original_name);
  if (inline) res.set('Content-Disposition', res.get('Content-Disposition').replace(/^attachment/, 'inline'));
  res.set({ 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  res.type(f.mime);
  res.sendFile(path.join(SERVICE_DIR, file), (err) => {
    if (err && !res.headersSent) next();
  });
});

module.exports = router;
