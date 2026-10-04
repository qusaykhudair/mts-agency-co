'use strict';
const { all, run } = require('../db');

// Notifications are a side effect: a failure is logged, never allowed to undo the action that caused it.
function notify(userId, { title, body = null, link = null, icon = 'fa-solid fa-bell', tone = 'brand' }) {
  if (!userId) return;
  try {
    run('INSERT INTO notifications (user_id, title, body, link, icon, tone) VALUES (?, ?, ?, ?, ?, ?)', userId, title, body, link, icon, tone);
  } catch (err) {
    console.error('[notify] failed', err);
  }
}

// Admins always hear about store activity; the product's seller too when it is someone else.
function notifyStaff(sellerId, payload, { exclude } = {}) {
  let ids;
  try {
    ids = new Set(all("SELECT id FROM users WHERE role = 'admin' AND is_blocked = 0").map((r) => r.id));
  } catch (err) {
    console.error('[notify] failed', err);
    return;
  }
  if (sellerId) ids.add(sellerId);
  if (exclude) ids.delete(exclude);
  for (const id of ids) notify(id, payload);
}

module.exports = { notify, notifyStaff };
