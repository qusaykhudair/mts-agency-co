'use strict';
// MTS Agency service requests: a client describes a job, the service team (admins and providers) picks it
// up, talks to the client on the request and delivers links/files through the platform for approval.
const { get, all, run, tx, toSql } = require('../db');
const { notify } = require('./notify');
const settings = require('./settings');
const { parseJson } = require('./format');
const { isAdmin, isProvider } = require('./auth');

class ServiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

const OPEN_STATUSES = ['pending', 'in_progress', 'delivered', 'revision'];
const MAX_OPEN_PER_CLIENT = 5;

const SELECT = `
  SELECT r.*, c.name AS client_name, c.email AS client_email, c.wa_e164 AS client_whatsapp, c.avatar_url AS client_avatar,
         a.name AS assignee_name, a.role AS assignee_role, a.wa_e164 AS assignee_whatsapp,
         s.icon AS service_icon, s.slug AS service_slug
  FROM service_requests r
  JOIN users c ON c.id = r.user_id
  LEFT JOIN users a ON a.id = r.assigned_to
  LEFT JOIN services s ON s.id = r.service_id`;

const decorate = (r) => (r ? { ...r, links: parseJson(r.links, []) } : null);

function byCode(code) {
  return decorate(get(`${SELECT} WHERE r.code = ?`, String(code || '').trim().toUpperCase()));
}

/** Paged list; `where` items use the "r" (request), "c" (client) and "a" (assignee) aliases. */
function list({ where = [], params = [], order = 'r.updated_at DESC, r.id DESC', limit = 20, offset = 0 } = {}) {
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get(
    `SELECT COUNT(*) AS n FROM service_requests r JOIN users c ON c.id = r.user_id LEFT JOIN users a ON a.id = r.assigned_to ${w}`,
    ...params,
  ).n;
  return { total, items: all(`${SELECT} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset).map(decorate) };
}

function countsByStatus(where = [], params = []) {
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return Object.fromEntries(all(`SELECT r.status, COUNT(*) AS n FROM service_requests r ${w} GROUP BY r.status`, ...params).map((x) => [x.status, x.n]));
}

/* ---------- Who may do what ---------- */

// The client, admins, the assigned provider — and every provider while a new request waits unassigned.
function canView(user, r) {
  if (!user || !r) return false;
  if (r.user_id === user.id || isAdmin(user)) return true;
  return isProvider(user) && (r.assigned_to === user.id || (r.status === 'pending' && !r.assigned_to));
}

// Working on a request as the team (messages, notes, deliveries): admins, or the provider it is assigned to.
const canWork = (user, r) => !!user && !!r && (isAdmin(user) || (isProvider(user) && r.assigned_to === user.id));

// A provider may pick up a new, unassigned request — never their own.
const canTake = (user, r) => isProvider(user) && r.status === 'pending' && !r.assigned_to && r.user_id !== user.id;

const canDeliver = (user, r) => canWork(user, r) && ['in_progress', 'revision', 'delivered'].includes(r.status);

/* ---------- Timeline ---------- */

function addEvent(requestId, userId, type, { body = null, links = [], internal = false } = {}) {
  const id = Number(
    run(
      'INSERT INTO service_events (request_id, user_id, type, body, links, is_internal) VALUES (?, ?, ?, ?, ?, ?)',
      requestId,
      userId || null,
      type,
      body || null,
      JSON.stringify(links || []),
      internal ? 1 : 0,
    ).lastInsertRowid,
  );
  run("UPDATE service_requests SET updated_at = datetime('now') WHERE id = ?", requestId);
  return id;
}

function saveFiles(requestId, eventId, userId, files) {
  for (const f of files || []) {
    run(
      'INSERT INTO service_files (request_id, event_id, user_id, file_name, original_name, mime, size) VALUES (?, ?, ?, ?, ?, ?, ?)',
      requestId,
      eventId,
      userId,
      f.filename,
      f.originalname,
      f.realType,
      f.size,
    );
  }
}

/** Events (messages, deliveries, status changes) with their links and files, oldest first. */
function thread(r, { internal = false } = {}) {
  const events = all(
    `SELECT e.*, u.name AS author_name, u.role AS author_role, u.avatar_url AS author_avatar
     FROM service_events e LEFT JOIN users u ON u.id = e.user_id
     WHERE e.request_id = ? ${internal ? '' : 'AND e.is_internal = 0'} ORDER BY e.id`,
    r.id,
  );
  const files = new Map();
  for (const f of all('SELECT * FROM service_files WHERE request_id = ? ORDER BY id', r.id)) {
    if (!files.has(f.event_id)) files.set(f.event_id, []);
    files.get(f.event_id).push(f);
  }
  return events.map((e) => ({ ...e, links: parseJson(e.links, []), files: files.get(e.id) || [] }));
}

/* ---------- Notifications ---------- */

const pathFor = (role, r) =>
  role === 'admin' ? `/seller/service-requests/${r.code}` : role === 'provider' ? `/provider/requests/${r.code}` : `/account/services/${r.code}`;

const excerpt = (text, n = 120) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s || null;
};

function notifyClient(r, payload) {
  notify(r.user_id, { ...payload, link: pathFor('buyer', r) });
}

// Admins always; the assigned provider; every provider when a request enters the open pool.
function notifyTeam(r, payload, { pool = false, exclude = null } = {}) {
  let rows = [];
  try {
    rows = all(
      `SELECT id, role FROM users WHERE is_blocked = 0 AND (role = 'admin' OR id = ?${pool ? " OR role = 'provider'" : ''})`,
      r.assigned_to || 0,
    );
  } catch (err) {
    console.error('[services] notify failed', err);
  }
  for (const u of rows) {
    if (u.id !== exclude && u.id !== r.user_id) notify(u.id, { ...payload, link: pathFor(u.role, r) });
  }
}

/* ---------- Lifecycle ---------- */

function openCount(userId) {
  return get(`SELECT COUNT(*) AS n FROM service_requests WHERE user_id = ? AND status IN ('pending', 'in_progress', 'revision')`, userId).n;
}

function create({ user, service, title, details, budget, deadline, links, files }) {
  if (openCount(user.id) >= MAX_OPEN_PER_CLIENT) {
    throw new ServiceError(`لديك ${MAX_OPEN_PER_CLIENT} طلبات خدمة مفتوحة بالفعل. تابعها أولاً أو تواصل معنا عبر واتساب.`);
  }
  const r = tx(() => {
    const id = Number(
      run(
        'INSERT INTO service_requests (user_id, service_id, service_name, title, details, budget, deadline, links) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        user.id,
        service.id,
        service.name,
        title,
        details,
        budget || null,
        deadline || null,
        JSON.stringify(links || []),
      ).lastInsertRowid,
    );
    const code = `SRV-${10000 + id}`;
    run('UPDATE service_requests SET code = ? WHERE id = ?', code, id);
    saveFiles(id, addEvent(id, user.id, 'created'), user.id, files);
    return byCode(code);
  });
  notifyTeam(r, { title: `طلب خدمة جديد ${r.code}`, body: `${r.service_name}: ${r.title}`, icon: 'fa-solid fa-briefcase', tone: 'brand' }, { pool: true, exclude: user.id });
  return r;
}

function assignTo(r, actor, member, { claim = false } = {}) {
  const first = !r.assigned_to;
  tx(() => {
    const changed = run(
      `UPDATE service_requests SET assigned_to = ?, assigned_at = datetime('now'), updated_at = datetime('now'),
         status = CASE status WHEN 'pending' THEN 'in_progress' ELSE status END
       WHERE id = ? AND status IN ('pending', 'in_progress', 'delivered', 'revision')${claim ? ' AND assigned_to IS NULL' : ''}`,
      member.id,
      r.id,
    ).changes;
    if (!changed) throw new ServiceError(claim ? 'سبقك منفذ آخر إلى هذا الطلب' : 'لا يمكن تعيين منفذ لهذا الطلب', 409);
    addEvent(r.id, actor.id, first ? 'assigned' : 'reassigned', { body: `المنفذ: ${member.name}` });
  });
  if (member.id !== actor.id) {
    notify(member.id, { title: `تم إسناد طلب الخدمة ${r.code} إليك`, body: `${r.service_name}: ${r.title}`, link: pathFor(member.role, r), icon: 'fa-solid fa-user-check', tone: 'info' });
  }
  if (first) notifyClient(r, { title: `بدأ فريقنا العمل على طلبك ${r.code}`, body: r.title, icon: 'fa-solid fa-person-digging', tone: 'info' });
  if (claim) notifyTeam(r, { title: `${member.name} استلم طلب الخدمة ${r.code}`, body: r.title, icon: 'fa-solid fa-user-check', tone: 'info' }, { exclude: member.id });
  return byCode(r.code);
}

/** Admin assigns (or re-assigns) a request to a provider or another admin. */
function assign(r, actor, memberId) {
  if (!OPEN_STATUSES.includes(r.status)) throw new ServiceError('لا يمكن تعيين منفذ لطلب مكتمل أو ملغي');
  const member = get("SELECT id, name, role FROM users WHERE id = ? AND role IN ('provider', 'admin') AND is_blocked = 0", memberId);
  if (!member) throw new ServiceError('اختر منفذاً من فريق الخدمات');
  if (member.id === r.user_id) throw new ServiceError('لا يمكن إسناد الطلب إلى صاحبه');
  if (member.id === r.assigned_to) return r;
  return assignTo(r, actor, member);
}

/** A provider picks up a new request from the open pool. */
function take(r, provider) {
  if (!canTake(provider, r)) throw new ServiceError('هذا الطلب لم يعد متاحاً للاستلام', 409);
  return assignTo(r, provider, provider, { claim: true });
}

function message(r, actor, { body, files }) {
  if (r.status === 'cancelled') throw new ServiceError('الطلب ملغي ولا يمكن إرسال رسائل عليه');
  tx(() => saveFiles(r.id, addEvent(r.id, actor.id, 'message', { body }), actor.id, files));
  const preview = excerpt(body) || 'مرفقات جديدة';
  if (actor.id === r.user_id) {
    notifyTeam(r, { title: `رسالة جديدة من العميل على ${r.code}`, body: preview, icon: 'fa-regular fa-comment-dots', tone: 'brand' }, { exclude: actor.id });
  } else {
    notifyClient(r, { title: `رسالة جديدة من فريق MTS بخصوص طلبك ${r.code}`, body: preview, icon: 'fa-regular fa-comment-dots', tone: 'brand' });
  }
}

function note(r, actor, body) {
  addEvent(r.id, actor.id, 'note', { body, internal: true });
}

function deliver(r, actor, { body, links, files }) {
  if (!['in_progress', 'revision', 'delivered'].includes(r.status)) throw new ServiceError('لا يمكن التسليم في حالة الطلب الحالية');
  if (!links.length && !files.length) throw new ServiceError('أضف رابطاً أو ملفاً واحداً على الأقل للتسليم');
  tx(() => {
    saveFiles(r.id, addEvent(r.id, actor.id, 'delivery', { body, links }), actor.id, files);
    run("UPDATE service_requests SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?", r.id);
  });
  notifyClient(r, { title: `تم تسليم طلبك ${r.code} 🎉`, body: 'راجع التسليم ثم اعتمده أو اطلب تعديلات', icon: 'fa-solid fa-gift', tone: 'success' });
  return byCode(r.code);
}

function requestRevision(r, actor, { body, files }) {
  if (r.status !== 'delivered') throw new ServiceError('يمكنك طلب التعديلات بعد استلام التسليم');
  tx(() => {
    saveFiles(r.id, addEvent(r.id, actor.id, 'revision', { body }), actor.id, files);
    run("UPDATE service_requests SET status = 'revision', updated_at = datetime('now') WHERE id = ?", r.id);
  });
  notifyTeam(r, { title: `طلب العميل تعديلات على ${r.code}`, body: excerpt(body), icon: 'fa-solid fa-rotate', tone: 'warning' }, { exclude: actor.id });
}

/** Close a delivered request: the client approves, an admin closes it, or the grace period ends. */
function complete(r, actor, { auto = false } = {}) {
  if (r.status !== 'delivered') throw new ServiceError('يكتمل الطلب بعد التسليم فقط');
  const byClient = !!actor && actor.id === r.user_id;
  const days = Number(settings.get('service_auto_complete_days')) || 7;
  const reason = byClient ? 'اعتمد العميل التسليم' : auto ? `أُغلق تلقائياً بعد ${days} أيام من التسليم دون ملاحظات` : 'أغلقت الإدارة الطلب';
  tx(() => {
    run("UPDATE service_requests SET status = 'completed', completed_at = datetime('now') WHERE id = ?", r.id);
    addEvent(r.id, actor ? actor.id : null, 'completed', { body: reason });
  });
  if (byClient) {
    notifyTeam(r, { title: `اعتمد العميل تسليم الطلب ${r.code} ✅`, body: r.title, icon: 'fa-solid fa-flag-checkered', tone: 'success' }, { exclude: actor.id });
  } else {
    notifyClient(r, { title: `اكتمل طلبك ${r.code}`, body: reason, icon: 'fa-solid fa-flag-checkered', tone: 'success' });
  }
}

function cancel(r, actor, reason) {
  if (!OPEN_STATUSES.includes(r.status)) throw new ServiceError('لا يمكن إلغاء هذا الطلب');
  const byClient = actor.id === r.user_id;
  if (byClient && r.status !== 'pending') throw new ServiceError('بدأ الفريق العمل على طلبك، تواصل معنا لإلغائه');
  tx(() => {
    run("UPDATE service_requests SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = ? WHERE id = ?", reason, r.id);
    addEvent(r.id, actor.id, 'cancelled', { body: reason });
  });
  if (byClient) notifyTeam(r, { title: `ألغى العميل طلب الخدمة ${r.code}`, body: reason, icon: 'fa-solid fa-ban', tone: 'muted' }, { exclude: actor.id });
  else {
    notifyClient(r, { title: `تم إلغاء طلبك ${r.code}`, body: reason, icon: 'fa-solid fa-ban', tone: 'muted' });
    if (r.assigned_to && r.assigned_to !== actor.id) {
      notify(r.assigned_to, { title: `تم إلغاء طلب الخدمة ${r.code}`, body: reason, link: pathFor(r.assignee_role, r), icon: 'fa-solid fa-ban', tone: 'muted' });
    }
  }
}

function autoComplete() {
  const days = Math.max(1, Number(settings.get('service_auto_complete_days')) || 7);
  const due = all("SELECT code FROM service_requests WHERE status = 'delivered' AND delivered_at <= ?", toSql(new Date(Date.now() - days * 86400000)));
  for (const { code } of due) {
    const r = byCode(code);
    if (r && r.status === 'delivered') complete(r, null, { auto: true });
  }
  return due.length;
}

/** The file row behind /files/services/:name when `user` may see it. */
function fileFor(user, fileName) {
  const f = get(
    `SELECT f.*, r.code, e.is_internal FROM service_files f
     JOIN service_requests r ON r.id = f.request_id LEFT JOIN service_events e ON e.id = f.event_id
     WHERE f.file_name = ?`,
    fileName,
  );
  if (!f) return null;
  const r = byCode(f.code);
  if (!canView(user, r)) return null;
  if (f.is_internal && !canWork(user, r)) return null;
  return f;
}

module.exports = {
  ServiceError,
  OPEN_STATUSES,
  MAX_OPEN_PER_CLIENT,
  byCode,
  list,
  countsByStatus,
  canView,
  canWork,
  canTake,
  canDeliver,
  thread,
  create,
  assign,
  take,
  message,
  note,
  deliver,
  requestRevision,
  complete,
  cancel,
  autoComplete,
  fileFor,
};
