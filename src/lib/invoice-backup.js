'use strict';
// A PDF copy of every invoice in the admin's Google Drive, so the invoices outlive any trouble with the server or
// the database. Each invoice prints through headless Chrome exactly like the print page and goes to
// «فواتير <name>/<year>/<number> - <client>.pdf». Editing an invoice uploads a new version of the same file (Drive
// keeps the earlier ones for good), a deleted invoice's file moves to «فواتير محذوفة», and «سجل الفواتير.xlsx»
// lists them all. Uploads run in the background a few seconds after each change, and again until they succeed.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { get, all, run } = require('../db');
const settings = require('./settings');
const invoices = require('./invoices');
const drive = require('./google-drive');
const pdf = require('./pdf');
const xlsx = require('./xlsx');
const { zonedLocal } = require('./format');
const { reasonOf: googleReason } = require('./mail');

const PDF = 'application/pdf';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const REGISTER = 'سجل الفواتير.xlsx';
const BATCH = 20;
const MINUTE = 60000;
// Problems someone has to fix in Google Cloud, Railway or the Drive itself. Anything else may pass on its own.
const NEEDS_FIX = new Set(['api-disabled', 'scope', 'revoked', 'client', 'storage', 'no-chrome', 'chrome']);

const { sheet } = invoices;
const health = { status: 'unknown', reason: null, error: null, project: null, account: null, checkedAt: null };
let timer = null;
let running = null;
let again = false;
let renderer = null;
// Tests run the uploads themselves; the timers would race them on a busy machine.
let manual = false;
let lastRegister = null;
// Folders already seen in Drive since the server started.
const known = new Set();

/* ---------- Health ---------- */
function reasonOf(err) {
  if (err.code === 'NO_CHROME') return 'no-chrome';
  // Chrome itself failed (a library missing on the server, a crash): every invoice would fail the same way.
  if (err.printing) return 'chrome';
  if (/storageQuotaExceeded|storage quota has been exceeded/i.test(`${err.reason || ''} ${err.message || ''}`)) return 'storage';
  return googleReason(err);
}

const scrub = (text) =>
  [config.mail.gmail.clientSecret, config.drive.refreshToken].filter(Boolean).reduce((s, secret) => s.split(secret).join('***'), String(text || '')).slice(0, 300);

function markFailed(err) {
  Object.assign(health, { status: 'failed', reason: reasonOf(err), error: scrub(err.message), project: err.project || drive.projectNumber() });
}

// Linked and allowed to upload here (see config.drive.enabled).
const active = () => drive.isConfigured() && config.drive.enabled;

// For /healthz and the dashboard: "off" until DRIVE_REFRESH_TOKEN is set, "paused" on a copy that must not upload,
// then "checking", "ready" or "failed".
function status() {
  if (!drive.isConfigured()) return 'off';
  if (!config.drive.enabled) return 'paused';
  return { ready: 'ready', failed: 'failed' }[health.status] || 'checking';
}

function counts() {
  const r = get('SELECT COUNT(*) AS total, TOTAL(drive_done >= drive_rev) AS done, TOTAL(drive_error IS NOT NULL AND drive_done < drive_rev) AS failing FROM invoices');
  return { total: r.total, done: r.done, pending: r.total - r.done, failing: r.failing };
}

/* ---------- Folders ---------- */
// The random id on this store's files. A fresh database gets a new one, so it never writes over the files of
// the invoices it lost (numbers start again from 1); a restored copy keeps it and finds its files again.
function instance() {
  let id = settings.get('drive_instance');
  if (!id) {
    id = crypto.randomUUID();
    settings.set({ drive_instance: id });
  }
  return id;
}

function folders() {
  try {
    return JSON.parse(settings.get('drive_folders') || '{}') || {};
  } catch {
    return {};
  }
}
const saveFolders = (patch) => settings.set({ drive_folders: JSON.stringify({ ...folders(), ...patch }) });

// The saved folder while it still exists, else the one the store made before (found by its labels), else a new one.
async function folder(key, name, parent, labels) {
  const id = folders()[key];
  if (id && (known.has(id) || (await drive.file(id)))) {
    known.add(id);
    return id;
  }
  const made = (await drive.findByLabels(labels, { folder: true }))[0] || (await drive.createFolder(name, parent, labels));
  known.add(made.id);
  saveFolders({ [key]: made.id });
  return made.id;
}

const rootFolder = () => folder('root', `فواتير ${invoices.invoiceSettings().name}`, null, { mts: 'invoices' });
const yearFolder = async (year) => folder(`y${year}`, String(year), await rootFolder(), { mts: 'invoices-year', mtsYear: String(year) });
const removedFolder = async () => folder('removed', 'فواتير محذوفة', await rootFolder(), { mts: 'invoices-removed' });

/* ---------- The PDF ---------- */
let assets = null;

// The print page's stylesheet, the site's fonts, the logo and the fitting script, all inside one file: Chrome
// prints it with nothing else to load (a page opened from disk may not load fonts from other files).
function printAssets() {
  if (assets) return assets;
  const pub = path.join(config.root, 'public');
  const read = (rel) => fs.readFileSync(path.join(pub, rel));
  const dataUri = (rel, type) => `data:${type};base64,${read(rel).toString('base64')}`;
  const fonts = read('css/store.css')
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^@font-face\s*\{[^}]*IBM Plex Sans Arabic/.test(line))
    .map((line) => line.replace(/url\(\/static\/(fonts\/[^)?]+)(\?[^)]*)?\)/, (m, file) => `url(${dataUri(file, 'font/woff2')})`));
  assets = {
    fonts: fonts.length,
    css: `${fonts.join('\n')}\n${read('css/invoice.css').toString('utf8')}`,
    logo: dataUri('img/logo-wordmark.png', 'image/png'),
    scripts: ['js/invoice-sheet.js', 'js/invoice-print.js'].map((f) => read(f).toString('utf8').replace(/<\/script/gi, '<\\/script')),
  };
  return assets;
}

/** The invoice as one self-contained HTML page, laid out exactly like the print page. */
function printable(inv) {
  const a = printAssets();
  const body = sheet.render(invoices.sheetData(inv), { ...invoices.invoiceSettings(), logo: a.logo });
  return (
    `<!DOCTYPE html><html lang="${inv.lang}" dir="${inv.lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">` +
    `<title>${sheet.esc(`${inv.number} - ${inv.client_name}`)}</title><style>${a.css}</style></head>` +
    `<body class="inv-print-page"><main class="inv-print-wrap">${body}</main>` +
    a.scripts.map((s) => `<script data-autoprint="0">${s}</script>`).join('') +
    `</body></html>`
  );
}

// "MTS-2026-0001 - شركة النخبة.pdf", the name the print page gives its PDF.
const fileName = (inv) => `${`${inv.number} - ${inv.client_name}`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150)}.pdf`;

async function toPdf(html) {
  try {
    return await (renderer ? renderer(html) : pdf.fromHtml(html));
  } catch (err) {
    if (err.code !== 'NO_CHROME') err.printing = true;
    throw err;
  }
}

/* ---------- Uploads ---------- */
async function uploadInvoice(inv) {
  const data = await toPdf(printable(inv));
  const name = fileName(inv);
  const labels = { mtsStore: instance(), mtsInvoice: inv.number };
  let existing = inv.drive_file_id ? await drive.file(inv.drive_file_id) : null;
  // A copy uploaded before the store could note its id (an answer lost on the way, or an older copy of the database).
  if (!existing) existing = (await drive.findByLabels(labels))[0] || null;
  if (!existing) return (await drive.upload({ name, mimeType: PDF, data, parents: [await yearFolder(inv.year)], labels })).id;
  await drive.upload({ id: existing.id, name, mimeType: PDF, data, keepRevision: true });
  // An invoice that came back (a restored database) leaves the deleted folder.
  const parents = existing.parents || [];
  if (folders().removed && parents.includes(folders().removed)) await drive.move(existing.id, await yearFolder(inv.year), parents.join(','));
  return existing.id;
}

// Files of deleted invoices move to «فواتير محذوفة»; they never leave the Drive.
async function moveRemoved() {
  for (const r of all('SELECT * FROM drive_removed WHERE moved_at IS NULL AND file_id IS NOT NULL ORDER BY id')) {
    const f = await drive.file(r.file_id);
    if (f) {
      const to = await removedFolder();
      const parents = f.parents || [];
      if (!parents.includes(to)) await drive.move(r.file_id, to, parents.join(','));
    }
    run("UPDATE drive_removed SET moved_at = datetime('now') WHERE id = ?", r.id);
  }
}

// New and edited invoices, oldest first and the ones that failed before last. Returns how many went up.
async function uploadBatch() {
  let uploaded = 0;
  for (const { id } of all('SELECT id FROM invoices WHERE drive_done < drive_rev ORDER BY drive_error IS NOT NULL, id LIMIT ?', BATCH)) {
    const inv = invoices.byId(id);
    if (!inv) continue;
    try {
      const fileId = await uploadInvoice(inv);
      uploaded++;
      const saved = run('UPDATE invoices SET drive_file_id = ?, drive_done = MAX(drive_done, ?), drive_error = NULL WHERE id = ?', fileId, inv.drive_rev, id);
      // Deleted while it was uploading: the file follows the other deleted invoices, in this same run.
      if (!saved.changes) {
        run('UPDATE drive_removed SET file_id = ? WHERE number = ? AND file_id IS NULL', fileId, inv.number);
        again = true;
      }
    } catch (err) {
      const reason = reasonOf(err);
      // Trouble with the account, the connection or the server stops the run: the rest would fail the same way.
      if (NEEDS_FIX.has(reason) || reason === 'network' || reason === 'quota') throw err;
      // A folder that went missing in the meantime is looked up again on the next try.
      if (err.status === 404) known.clear();
      run('UPDATE invoices SET drive_error = ? WHERE id = ?', scrub(err.message), id);
      console.error(`[drive] invoice ${inv.number} was not uploaded: ${scrub(err.message)}`);
    }
  }
  return uploaded;
}

/* ---------- The register ---------- */
const STATUS = { paid: 'مدفوعة', partial: 'مدفوعة جزئيا', unpaid: 'غير مدفوعة' };
const stamp = (v) => zonedLocal(v).replace('T', ' ');
const head = (titles) => titles.map((v) => ({ v, s: 'head' }));

function registerSheets() {
  const name = invoices.invoiceSettings().name;
  const services = Object.fromEntries(sheet.SERVICES.map((s) => [s.key, s.ar]));
  const rows = all('SELECT i.*, r.code AS project_code FROM invoices i LEFT JOIN service_requests r ON r.id = i.project_id ORDER BY i.year, i.seq').map((inv) => {
    const st = sheet.computeStatus(inv.total, inv.paid);
    return [
      inv.number,
      inv.issued_on,
      inv.client_name,
      inv.client_contact || '',
      inv.client_country ? sheet.countryName(inv.client_country, 'ar') : '',
      services[inv.service] || inv.service,
      inv.currency,
      st.total / 100,
      st.paid / 100,
      st.remaining / 100,
      STATUS[st.status],
      inv.method || '',
      inv.paid_on || '',
      st.remaining > 0 ? inv.due_on || '' : '',
      inv.purpose || '',
      inv.note || '',
      inv.project_code || '',
      stamp(inv.updated_at),
      inv.drive_file_id ? { f: `HYPERLINK("${drive.fileUrl(inv.drive_file_id)}","فتح")`, v: 'فتح', s: 'link' } : '',
    ];
  });
  const totals = invoices.totals(invoices.parseFilters({}));
  const removed = all('SELECT * FROM drive_removed ORDER BY id');
  return [
    {
      name: 'الفواتير',
      freeze: 1,
      widths: [16, 13, 28, 22, 14, 18, 8, 13, 13, 13, 13, 16, 13, 14, 48, 30, 12, 17, 9],
      rows: [
        head(['رقم الفاتورة', 'تاريخ الإصدار', 'العميل', 'التواصل', 'الدولة', 'الخدمة', 'العملة', 'الإجمالي', 'المدفوع', 'المتبقي', 'الحالة', 'طريقة التحويل', 'تاريخ التحويل', 'تاريخ الاستحقاق', 'الوصف', 'ملاحظة', 'المشروع', 'آخر تعديل', 'ملف PDF']),
        ...rows,
      ],
    },
    {
      name: 'الملخص',
      widths: [16, 14, 16, 16, 16],
      rows: [
        [{ v: `سجل فواتير ${name}`, s: 'title' }],
        [{ v: `آخر تحديث ${stamp(new Date())}`, s: 'muted' }],
        [],
        head(['العملة', 'عدد الفواتير', 'الإجمالي', 'المدفوع', 'المتبقي']),
        ...totals.map((t) => [t.currency, { v: t.count, s: 'int' }, t.total / 100, t.paid / 100, t.remaining / 100]),
      ],
    },
    {
      name: 'المحذوفة',
      freeze: 1,
      widths: [16, 28, 8, 13, 13, 17],
      rows: [
        head(['رقم الفاتورة', 'العميل', 'العملة', 'الإجمالي', 'تاريخ الإصدار', 'تاريخ الحذف']),
        ...removed.map((r) => [r.number, r.client_name, r.currency, r.total / 100, r.issued_on, stamp(r.removed_at)]),
      ],
    },
  ];
}

// Changes whenever a row of the register would.
const registerState = () =>
  JSON.stringify(get('SELECT COUNT(*) AS n, MAX(updated_at) AS u, TOTAL(drive_done) AS d, (SELECT COUNT(*) FROM drive_removed) AS r FROM invoices'));

async function uploadRegister() {
  const state = registerState();
  const data = xlsx.build(registerSheets());
  const labels = { mtsStore: instance(), mts: 'register' };
  let existing = folders().register ? await drive.file(folders().register) : null;
  if (!existing) existing = (await drive.findByLabels(labels))[0] || null;
  const f = existing
    ? await drive.upload({ id: existing.id, name: REGISTER, mimeType: XLSX, data })
    : await drive.upload({ name: REGISTER, mimeType: XLSX, data, parents: [await rootFolder()], labels });
  saveFolders({ register: f.id });
  lastRegister = state;
}

/* ---------- Running ---------- */
async function work() {
  try {
    const me = await drive.about();
    health.account = (me.user && me.user.emailAddress) || null;
    await rootFolder();
    await moveRemoved();
    let blocked = null;
    if (counts().pending && !renderer && !pdf.available()) {
      blocked = Object.assign(new Error('Chrome or Chromium is not installed on this server, so the invoices cannot become PDF files'), { code: 'NO_CHROME' });
    } else {
      let uploaded;
      do uploaded = await uploadBatch();
      while (uploaded && counts().pending);
    }
    // The register keeps every invoice's details even while the PDF files wait.
    if (!folders().register || registerState() !== lastRegister) await uploadRegister();
    if (blocked) throw blocked;
    Object.assign(health, { status: 'ready', reason: null, error: null, project: null });
    if (!counts().pending) settings.set({ drive_synced_at: new Date().toISOString() });
  } catch (err) {
    markFailed(err);
    console.warn(`[drive] invoice copies stopped (${health.reason}): ${health.error}`);
  }
  health.checkedAt = new Date();
}

/** Uploads everything waiting, now. Resolves when done; a call during a run makes that run go once more. */
function sync() {
  if (!active()) return Promise.resolve(status());
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await work();
    } while (again && health.status === 'ready');
    return status();
  })().finally(() => {
    running = null;
  });
  return running;
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await sync();
    const wait = health.status === 'failed' ? (NEEDS_FIX.has(health.reason) ? 15 * MINUTE : 5 * MINUTE) : counts().pending ? MINUTE : 60 * MINUTE;
    schedule(wait);
  }, ms);
  timer.unref();
}

// At start-up: a first run shortly after, then hourly (sooner while something waits or fails).
function start() {
  if (active() && !timer && !manual) schedule(5000);
}

// After an invoice is saved or deleted. Several quick changes make one run.
function kick() {
  if (!active() || manual) return;
  if (running) again = true;
  else schedule(3000);
}

// For the backups page.
function report() {
  const f = folders();
  return {
    state: status(),
    health,
    counts: counts(),
    folderUrl: f.root ? drive.folderUrl(f.root) : null,
    registerUrl: f.register ? drive.fileUrl(f.register) : null,
    syncedAt: settings.get('drive_synced_at') || null,
    chrome: Boolean(renderer) || pdf.available(),
    failing: all('SELECT id, number, client_name, drive_error FROM invoices WHERE drive_error IS NOT NULL AND drive_done < drive_rev ORDER BY id LIMIT 5'),
  };
}

// No more runs until start() or kick() (tests, and a server shutting down).
function stop() {
  clearTimeout(timer);
  timer = null;
}

// Tests: print with this function instead of Chrome; run uploads only through sync(); forget the timers,
// folders and last check.
function useRenderer(fn) {
  renderer = fn;
}
function useManualRuns(on = true) {
  manual = on;
  if (on) stop();
}
function reset() {
  stop();
  known.clear();
  lastRegister = null;
  Object.assign(health, { status: 'unknown', reason: null, error: null, project: null, account: null, checkedAt: null });
}

module.exports = { REGISTER, NEEDS_FIX, health, status, counts, report, printable, fileName, registerSheets, sync, start, stop, kick, reasonOf, useRenderer, useManualRuns, reset };
