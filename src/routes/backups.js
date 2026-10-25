'use strict';
// Backups page in the admin dashboard: download everything, the daily database snapshots, the switch that
// e-mails the daily snapshot (lib/backups.js), and the invoice copies in Google Drive (lib/invoice-backup.js).
const express = require('express');
const config = require('../config');
const settings = require('../lib/settings');
const backups = require('../lib/backups');
const invoiceBackup = require('../lib/invoice-backup');
const invoices = require('../lib/invoices');
const mail = require('../lib/mail');
const { bool } = require('../lib/util');
const { requireAdmin } = require('../middleware');

const router = express.Router();

router.use('/backups', requireAdmin, (req, res, next) => {
  res.locals.nav = 'seller';
  res.locals.noindex = true;
  res.locals.active = 'admin-backups';
  next();
});

// Where the daily copy goes: the store's support address, else the admin's.
const backupTo = () => settings.get('support_email') || config.admin.email;

// What stopped the invoice copies and how to fix it, in the admin's words.
function driveProblem(h) {
  const project = h.project ? `?project=${h.project}` : '';
  switch (h.reason) {
    case 'api-disabled':
      return {
        title: 'واجهة Google Drive API متوقفة في مشروع Google Cloud',
        fix: 'افتح صفحة Google Drive API بنفس حساب Google الذي أنشأت به المشروع واضغط Enable، ثم انتظر دقيقتين واضغط «ارفع الآن».',
        link: `https://console.cloud.google.com/apis/library/drive.googleapis.com${project}`,
        linkText: 'فتح صفحة Google Drive API',
      };
    case 'scope':
      return {
        title: 'حساب Google لم يسمح للمتجر بحفظ الملفات في Drive',
        fix: 'شغل npm run drive-auth على جهازك، وفي شاشة Google حدد خانة Google Drive. ضع الرمز الجديد في DRIVE_REFRESH_TOKEN على Railway.',
      };
    case 'revoked':
      return {
        title: 'انتهى ربط Google Drive أو ألغي',
        fix: 'شغل npm run drive-auth على جهازك وضع الرمز الجديد في DRIVE_REFRESH_TOKEN على Railway. إن كان التطبيق في Google Cloud على وضع Testing فالرمز ينتهي بعد 7 أيام، فانشره أولا.',
      };
    case 'client':
      return {
        title: 'قيمة GMAIL_CLIENT_ID أو GMAIL_CLIENT_SECRET غير صحيحة',
        fix: 'Drive يستخدم عميل البريد نفسه. انسخ القيمتين من جديد من صفحة Credentials في Google Cloud وضعهما في Railway.',
        link: `https://console.cloud.google.com/apis/credentials${project}`,
        linkText: 'فتح صفحة Credentials',
      };
    case 'storage':
      return { title: 'مساحة Google Drive ممتلئة', fix: 'احذف من Drive ملفات لا تحتاجها أو زد المساحة، ثم اضغط «ارفع الآن».' };
    case 'no-chrome':
      return {
        title: 'Chromium غير موجود على السيرفر',
        fix: 'به تتحول الفاتورة إلى PDF. على Railway يثبته ملف railpack.json مع النشر التالي، وعلى أي سيرفر آخر ثبت Chrome أو Chromium. حتى ذلك الحين يحفظ سجل الفواتير في Drive بيانات كل فاتورة.',
      };
    case 'chrome':
      return { title: 'Chromium لم يستطع تحويل الفاتورة إلى PDF', fix: 'غالبا ينقصه شيء على السيرفر، والسبب كما وصلنا في التفاصيل بالأسفل. نعيد المحاولة وحدنا كل 15 دقيقة.' };
    case 'quota':
      return { title: 'Google طلب التمهل قليلا', fix: 'نعيد المحاولة وحدنا بعد دقائق.' };
    case 'network':
      return { title: 'لا نصل إلى Google الآن', fix: 'غالبا انقطاع مؤقت، ونعيد المحاولة وحدنا كل 5 دقائق.' };
    default:
      return { title: 'Google Drive رفض الرفع', fix: 'السبب كما وصلنا مكتوب في التفاصيل بالأسفل.' };
  }
}

function driveInfo() {
  const r = invoiceBackup.report();
  return { ...r, folderName: `فواتير ${invoices.invoiceSettings().name}`, problem: r.state === 'failed' ? driveProblem(r.health) : null };
}

router.get('/backups', (req, res) => {
  res.render('seller/backups', {
    pageTitle: 'النسخ الاحتياطي',
    summary: backups.summary(),
    daily: backups.list(),
    emailOn: settings.get('backup_email') === '1',
    emailTo: backupTo(),
    emailLast: settings.get('backup_email_last'),
    mailReady: mail.isConfigured(),
    keep: backups.KEEP_DAYS,
    drive: driveInfo(),
  });
});

router.get('/backups/download', (req, res) => {
  const { stream, filename } = backups.full();
  res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
  stream.on('error', (err) => {
    console.error('[backups] full backup failed', err);
    res.destroy(err);
  });
  stream.pipe(res);
});

router.get('/backups/daily/:name', (req, res, next) => {
  const file = backups.dailyFile(req.params.name);
  if (!file) return next();
  res.set({ 'Cache-Control': 'no-store' });
  res.download(file, req.params.name);
});

router.post('/backups/email', async (req, res) => {
  const on = bool(req.body.on);
  settings.set({ backup_email: on ? '1' : '0', backup_email_last: '' });
  if (!on) return res.reply({ ok: true, message: 'أوقفنا إرسال النسخة اليومية بالبريد', reload: true });
  // The first copy goes out now, so the admin sees it arrive.
  const sent = await backups.emailDaily({ to: backupTo(), storeName: settings.get('store_name') });
  if (sent && sent.ok) return res.reply({ ok: true, message: `أرسلنا أول نسخة إلى ${backupTo()}، وتصلك نسخة كل يوم`, reload: true });
  req.flash('error', mail.isConfigured() ? 'شغلنا النسخة اليومية، لكن أول رسالة لم ترسل. راجع بطاقة البريد في الإعدادات' : 'شغلنا النسخة اليومية، وستبدأ عندما يعمل البريد');
  res.reply({ ok: true, reload: true });
});

// Uploads the invoices waiting for Drive now. A few take seconds; a long first upload goes on in the background.
router.post('/backups/drive/sync', async (req, res) => {
  if (invoiceBackup.status() === 'off') return res.reply({ ok: false, message: 'اربط Google Drive أولا بالخطوات المكتوبة في البطاقة' });
  if (invoiceBackup.status() === 'paused') return res.reply({ ok: false, message: 'الرفع إلى Drive يعمل على السيرفر فقط، وهو متوقف في هذا التشغيل' });
  let wait;
  const finished = await Promise.race([invoiceBackup.sync().then(() => true), new Promise((resolve) => (wait = setTimeout(resolve, 20000, false)))]);
  clearTimeout(wait);
  if (!finished) return res.reply({ ok: true, message: 'الرفع مستمر، فحدث الصفحة بعد قليل لترى ما وصل', reload: true });
  if (invoiceBackup.status() === 'ready' && !invoiceBackup.counts().pending) return res.reply({ ok: true, message: 'كل الفواتير محفوظة في Google Drive', reload: true });
  req.flash('error', invoiceBackup.status() === 'failed' ? 'لم يكتمل الرفع. السبب وطريقة الإصلاح في بطاقة Google Drive' : 'بعض الفواتير لم ترفع بعد. التفاصيل في بطاقة Google Drive');
  res.reply({ ok: true, reload: true });
});

// Today's snapshot, taken now (the hourly jobs take one each day anyway).
router.post('/backups/snapshot', (req, res) => {
  if (!backups.daily()) return res.reply({ ok: true, message: 'نسخة اليوم موجودة بالفعل', reload: true });
  res.reply({ ok: true, message: 'أخذنا نسخة اليوم من قاعدة البيانات', reload: true });
});

module.exports = router;
