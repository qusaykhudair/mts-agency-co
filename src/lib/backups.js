'use strict';
// Backups of the store's data: the SQLite database and every uploaded file (receipts, service files, images).
// - A full backup downloads as one .tar.gz holding store.db (a consistent snapshot), uploads/… and
//   manifest.json. Any archive tool opens it; restoring on another server is extracting it into the data folder.
// - Once a day the server keeps a snapshot of the database next to it (the last 7) for a quick roll-back.
// - When the admin turns it on, that daily snapshot is also e-mailed to the store's address, so a copy lives
//   outside the hosting company.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable } = require('stream');
const config = require('../config');
const { db, get } = require('../db');
const { isoDay, zonedLocal } = require('./format');

const KEEP_DAYS = 7;
const EMAIL_LIMIT = 18 * 1024 * 1024; // Gmail takes 25 MB per message; attachments grow by a third in base64.
const dir = () => path.join(config.dataDir, 'backups');
// Days and times in the store's time zone, as the admin reads them.
const day = (d = new Date()) => isoDay(d);

/** Writes a consistent copy of the database to `file` (VACUUM INTO also leaves out the WAL). */
function snapshot(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

/** The daily snapshots kept on the server, newest first. */
function list() {
  if (!fs.existsSync(dir())) return [];
  return fs
    .readdirSync(dir())
    .filter((f) => /^store-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .reverse()
    .map((name) => ({ name, day: name.slice(6, 16), size: fs.statSync(path.join(dir(), name)).size }));
}

/** The path of one daily snapshot by name, or null for anything that is not one. */
function dailyFile(name) {
  if (!/^store-\d{4}-\d{2}-\d{2}\.db$/.test(String(name))) return null;
  const file = path.join(dir(), name);
  return fs.existsSync(file) ? file : null;
}

/** Takes today's snapshot if there is none yet and drops the oldest beyond KEEP_DAYS. Returns it when taken. */
function daily(now = new Date()) {
  const file = path.join(dir(), `store-${day(now)}.db`);
  if (fs.existsSync(file)) return null;
  snapshot(file);
  for (const old of list().slice(KEEP_DAYS)) fs.rmSync(path.join(dir(), old.name), { force: true });
  return file;
}

// Every file under the uploads folder, with its path inside the archive.
function uploads() {
  const root = config.uploadDir;
  const out = [];
  const walk = (folder) => {
    if (!fs.existsSync(folder)) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const stat = fs.statSync(full);
        out.push({ name: `uploads/${path.relative(root, full).split(path.sep).join('/')}`, path: full, size: stat.size, mtime: stat.mtimeMs });
      }
    }
  };
  walk(root);
  return out;
}

const COUNTS = { users: 'users', orders: 'orders', products: 'products', service_requests: 'service_requests', invoices: 'invoices' };

function counts() {
  const out = {};
  for (const [key, table] of Object.entries(COUNTS)) {
    try {
      out[key] = get(`SELECT COUNT(*) AS n FROM ${table}`).n;
    } catch {
      out[key] = 0;
    }
  }
  return out;
}

/** What a full backup holds right now, for the admin page. */
function summary() {
  const files = uploads();
  // Recent writes sit in the -wal file until SQLite folds them into the database, so both count.
  let dbSize = 0;
  for (const file of [config.dbFile, `${config.dbFile}-wal`]) {
    try {
      dbSize += fs.statSync(file).size;
    } catch {
      // Not written yet.
    }
  }
  return { counts: counts(), files: files.length, filesSize: files.reduce((n, f) => n + f.size, 0), dbSize };
}

// One tar header (ustar). Names longer than 100 bytes are split at a slash into prefix and name.
function header(name, size, mtime) {
  const buf = Buffer.alloc(512, 0);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  const octal = (n, width) => `${Math.floor(n).toString(8).padStart(width - 1, '0')}\0`;
  buf.write(base, 0, 100, 'utf8');
  buf.write('0000644\0', 100);
  buf.write('0000000\0', 108);
  buf.write('0000000\0', 116);
  buf.write(octal(size, 12), 124);
  buf.write(octal(mtime / 1000, 12), 136);
  buf.write('        ', 148);
  buf.write('0', 156);
  buf.write('ustar\0', 257);
  buf.write('00', 263);
  buf.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return buf;
}

async function* tar(entries) {
  for (const e of entries) {
    yield header(e.name, e.size, e.mtime);
    if (e.buffer) yield e.buffer;
    else for await (const chunk of fs.createReadStream(e.path)) yield chunk;
    const pad = (512 - (e.size % 512)) % 512;
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(1024);
}

/**
 * The full backup as a gzip stream, plus its file name. The database snapshot goes through a temporary file that
 * is read into memory and removed at once, so nothing is left behind whatever happens to the download.
 */
function full(now = new Date()) {
  const tmp = path.join(os.tmpdir(), `mts-backup-${crypto.randomBytes(6).toString('hex')}.db`);
  let database;
  try {
    snapshot(tmp);
    database = fs.readFileSync(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const files = uploads();
  const manifest = Buffer.from(
    JSON.stringify(
      {
        app: 'MTS Store',
        createdAt: now.toISOString(),
        version: config.commit || 'dev',
        schemaVersion: get('PRAGMA user_version').user_version,
        counts: counts(),
        files: files.length,
        restore: 'Stop the app, extract this archive into the data folder (DATA_DIR) so store.db and uploads/ sit there, then start it again.',
      },
      null,
      2,
    ),
  );
  const entries = [
    { name: 'manifest.json', buffer: manifest, size: manifest.length, mtime: now.getTime() },
    { name: 'store.db', buffer: database, size: database.length, mtime: now.getTime() },
    ...files,
  ];
  const stream = Readable.from(tar(entries)).pipe(zlib.createGzip({ level: 6 }));
  const stamp = zonedLocal(now).replace('T', '-').replace(':', '');
  return { stream, filename: `mts-backup-${stamp}.tar.gz` };
}

/**
 * E-mails today's database snapshot (gzip) to `to`, when backups by e-mail are on. Called by the hourly jobs:
 * sends at most once a day. Resolves to the mail result, or null when there was nothing to send.
 */
async function emailDaily({ to, now = new Date(), storeName = 'MTS Store' } = {}) {
  const settings = require('./settings');
  if (settings.get('backup_email') !== '1' || !to) return null;
  if (settings.get('backup_email_last') === day(now)) return null;
  const mail = require('./mail');
  if (!mail.isConfigured()) return null;
  const file = path.join(dir(), `store-${day(now)}.db`);
  if (!fs.existsSync(file)) daily(now);
  const content = zlib.gzipSync(fs.readFileSync(file), { level: 9 });
  if (content.length > EMAIL_LIMIT) {
    console.warn(`[backups] the database is too big to e-mail (${Math.round(content.length / 1048576)} MB); download a full backup instead.`);
    settings.set({ backup_email_last: day(now) });
    return { ok: false, error: 'too big' };
  }
  const c = counts();
  const sent = await mail.send({
    to,
    subject: `نسخة احتياطية من قاعدة بيانات ${storeName}: ${day(now)}`,
    text: [
      `هذه نسخة اليوم من قاعدة بيانات ${storeName}، في المرفق.`,
      `فيها ${c.users} حسابا و${c.orders} طلبا و${c.invoices} فاتورة.`,
      '',
      'لا تحتاج أن تفعل شيئا بها. احتفظ بها في بريدك، فهي تنفعك إذا تعطلت الاستضافة أو فقدت البيانات.',
      'الإيصالات والملفات المرفوعة ليست فيها: نزلها من صفحة النسخ الاحتياطي في لوحة الإدارة.',
    ].join('\n'),
    attachments: [{ filename: `store-${day(now)}.db.gz`, content, contentType: 'application/gzip' }],
    kind: 'backup',
  });
  if (sent.ok) settings.set({ backup_email_last: day(now) });
  return sent;
}

module.exports = { snapshot, list, daily, dailyFile, full, summary, emailDaily, header, KEEP_DAYS };
