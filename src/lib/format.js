'use strict';
const { fromSql } = require('../db');

const TZ = process.env.DISPLAY_TIMEZONE || 'Africa/Cairo';

const ORDER_STATUS = {
  under_review: { label: 'بانتظار مراجعة الدفع', short: 'قيد المراجعة', tone: 'warning', icon: 'fa-solid fa-hourglass-half' },
  payment_rejected: { label: 'تم رفض إيصال الدفع', short: 'الدفع مرفوض', tone: 'danger', icon: 'fa-solid fa-circle-xmark' },
  processing: { label: 'تم تأكيد الدفع — جاري تجهيز الاشتراك', short: 'قيد التجهيز', tone: 'info', icon: 'fa-solid fa-gears' },
  delivered: { label: 'تم تسليم بيانات الاشتراك', short: 'تم التسليم', tone: 'success', icon: 'fa-solid fa-box-open' },
  completed: { label: 'الطلب مكتمل', short: 'مكتمل', tone: 'success', icon: 'fa-solid fa-circle-check' },
  cancelled: { label: 'تم إلغاء الطلب', short: 'ملغي', tone: 'muted', icon: 'fa-solid fa-ban' },
};

const DELIVERY_METHODS = {
  account: { label: 'حساب جاهز (بريد وكلمة مرور)', short: 'حساب جاهز', icon: 'fa-solid fa-user-lock' },
  upgrade: { label: 'ترقية على حسابك الشخصي', short: 'على حسابك', icon: 'fa-solid fa-circle-up' },
  invite: { label: 'دعوة إلى بريدك الإلكتروني', short: 'دعوة بالبريد', icon: 'fa-solid fa-envelope-open-text' },
  code: { label: 'كود تفعيل', short: 'كود تفعيل', icon: 'fa-solid fa-key' },
  link: { label: 'رابط تفعيل', short: 'رابط تفعيل', icon: 'fa-solid fa-link' },
};

const EVENT_META = {
  created: { label: 'تم إنشاء الطلب وإرسال إيصال الدفع', icon: 'fa-solid fa-file-invoice', tone: 'brand' },
  receipt_resubmitted: { label: 'تم إرسال إيصال دفع جديد', icon: 'fa-solid fa-file-arrow-up', tone: 'warning' },
  approved: { label: 'تم تأكيد استلام الدفع', icon: 'fa-solid fa-circle-check', tone: 'success' },
  rejected: { label: 'تم رفض إيصال الدفع', icon: 'fa-solid fa-circle-xmark', tone: 'danger' },
  delivered: { label: 'تم تسليم بيانات الاشتراك', icon: 'fa-solid fa-gift', tone: 'success' },
  delivery_updated: { label: 'تم تحديث بيانات الاشتراك', icon: 'fa-solid fa-pen-to-square', tone: 'brand' },
  completed: { label: 'اكتمل الطلب', icon: 'fa-solid fa-flag-checkered', tone: 'success' },
  cancelled: { label: 'تم إلغاء الطلب', icon: 'fa-solid fa-ban', tone: 'muted' },
  note: { label: 'ملاحظة داخلية', icon: 'fa-solid fa-note-sticky', tone: 'warning' },
};

const ROLES = {
  buyer: { label: 'مشتري', tone: 'muted' },
  seller: { label: 'بائع', tone: 'info' },
  provider: { label: 'منفذ خدمات', tone: 'success' },
  admin: { label: 'مدير', tone: 'brand' },
};

// MTS Agency service requests.
const SERVICE_STATUS = {
  pending: { label: 'بانتظار مراجعة الفريق', short: 'طلب جديد', tone: 'warning', icon: 'fa-solid fa-inbox' },
  in_progress: { label: 'قيد التنفيذ', short: 'قيد التنفيذ', tone: 'info', icon: 'fa-solid fa-person-digging' },
  delivered: { label: 'تم التسليم — بانتظار مراجعة العميل', short: 'تم التسليم', tone: 'success', icon: 'fa-solid fa-box-open' },
  revision: { label: 'مطلوب تعديلات', short: 'تعديلات مطلوبة', tone: 'warning', icon: 'fa-solid fa-rotate' },
  completed: { label: 'مكتمل', short: 'مكتمل', tone: 'success', icon: 'fa-solid fa-circle-check' },
  cancelled: { label: 'ملغي', short: 'ملغي', tone: 'muted', icon: 'fa-solid fa-ban' },
};

const SERVICE_EVENTS = {
  created: { label: 'تم إرسال الطلب', icon: 'fa-solid fa-paper-plane', tone: 'brand' },
  assigned: { label: 'بدأ العمل على الطلب', icon: 'fa-solid fa-user-check', tone: 'info' },
  reassigned: { label: 'تم تغيير منفذ الطلب', icon: 'fa-solid fa-people-arrows', tone: 'info' },
  delivery: { label: 'تسليم', icon: 'fa-solid fa-gift', tone: 'success' },
  revision: { label: 'طلب تعديلات', icon: 'fa-solid fa-rotate', tone: 'warning' },
  completed: { label: 'اكتمل الطلب', icon: 'fa-solid fa-flag-checkered', tone: 'success' },
  cancelled: { label: 'تم إلغاء الطلب', icon: 'fa-solid fa-ban', tone: 'muted' },
  message: { label: 'رسالة', icon: 'fa-regular fa-comment', tone: 'brand' },
  note: { label: 'ملاحظة داخلية', icon: 'fa-solid fa-note-sticky', tone: 'warning' },
};

const BUDGETS = {
  under_100: 'أقل من 100$',
  '100_300': 'من 100$ إلى 300$',
  '300_1000': 'من 300$ إلى 1,000$',
  over_1000: 'أكثر من 1,000$',
  flexible: 'غير محددة — أنتظر عرض السعر',
};

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  return fromSql(v);
}

function fmtDate(v, { time = false } = {}) {
  const d = toDate(v);
  if (!d) return '';
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
    timeZone: TZ,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    ...(time ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(d);
}

function fmtDateTime(v) {
  return fmtDate(v, { time: true });
}

function zoneParts(date, tz = TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

// Milliseconds the zone is ahead of UTC at `date`.
function tzOffsetMs(date, tz = TZ) {
  const p = zoneParts(date, tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

// "YYYY-MM-DDTHH:MM" wall-clock time in the store timezone -> Date (UTC instant).
function zonedLocalToUtc(local, tz = TZ) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(local || ''));
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let ts = guess - tzOffsetMs(new Date(guess), tz);
  ts = guess - tzOffsetMs(new Date(ts), tz);
  return new Date(ts);
}

// Date/SQL value -> "YYYY-MM-DDTHH:MM" in the store timezone, for <input type="datetime-local">.
function zonedLocal(v, tz = TZ) {
  const d = toDate(v);
  if (!d) return '';
  const p = zoneParts(d, tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// yyyy-mm-dd in the store timezone, for <input type="date">.
function isoDay(v) {
  const d = toDate(v);
  if (!d) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function plural(n, one, two, few, many) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}

function timeAgo(v) {
  const d = toDate(v);
  if (!d) return '';
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 45) return 'الآن';
  const min = Math.round(sec / 60);
  if (min < 60) return 'منذ ' + plural(min, 'دقيقة', 'دقيقتين', 'دقائق', 'دقيقة');
  const hr = Math.round(min / 60);
  if (hr < 24) return 'منذ ' + plural(hr, 'ساعة', 'ساعتين', 'ساعات', 'ساعة');
  const day = Math.round(hr / 24);
  if (day < 30) return 'منذ ' + plural(day, 'يوم', 'يومين', 'أيام', 'يوماً');
  return fmtDate(d);
}

function daysLeft(v) {
  const d = toDate(v);
  if (!d) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

function durationLabel(days) {
  if (!days) return 'مدى الحياة';
  if (days % 365 === 0) {
    const y = days / 365;
    return y === 1 ? 'سنة' : y === 2 ? 'سنتان' : `${y} سنوات`;
  }
  if (days % 30 === 0) {
    const m = days / 30;
    if (m === 1) return 'شهر';
    if (m === 2) return 'شهران';
    if (m <= 10) return `${m} أشهر`;
    return `${m} شهراً`;
  }
  if (days === 7) return 'أسبوع';
  return plural(days, 'يوم', 'يومان', 'أيام', 'يوماً');
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9؀-ۿ]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function initials(name) {
  // Skip the Arabic definite article so "أحمد المشتري" becomes "أم", not "أا".
  const parts = String(name || '؟')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => (p.length > 3 && p.startsWith('ال') ? p.slice(2) : p));
  if (!parts.length) return '؟';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// "5 أيام", "15 يوماً"…
function daysText(n) {
  const d = Math.max(0, Math.round(Number(n) || 0));
  if (d === 0) return 'أقل من يوم';
  return plural(d, 'يوم واحد', 'يومان', 'أيام', 'يوماً');
}

function parseJson(s, fallback) {
  if (s == null || s === '') return fallback;
  try {
    const v = JSON.parse(s);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function discountPercent(price, oldPrice) {
  if (!oldPrice || oldPrice <= price) return 0;
  return Math.round(((oldPrice - price) / oldPrice) * 100);
}

// Attachments and links on service requests.
function fileIcon(mime) {
  const m = String(mime || '');
  if (m.startsWith('image/vnd.adobe') || m === 'application/postscript') return 'fa-solid fa-palette';
  if (m.startsWith('image/')) return 'fa-solid fa-file-image';
  if (m === 'application/pdf') return 'fa-solid fa-file-pdf';
  if (m.includes('wordprocessingml')) return 'fa-solid fa-file-word';
  if (m.includes('spreadsheetml')) return 'fa-solid fa-file-excel';
  if (m.includes('presentationml')) return 'fa-solid fa-file-powerpoint';
  if (m.startsWith('video/')) return 'fa-solid fa-file-video';
  if (m.startsWith('audio/')) return 'fa-solid fa-file-audio';
  return 'fa-solid fa-file-zipper';
}

function fileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

// "drive.google.com/file/d/…" style label for a stored link.
function linkLabel(href) {
  try {
    const u = new URL(href);
    const rest = (u.pathname + u.search).replace(/\/$/, '');
    return u.hostname.replace(/^www\./, '') + (rest.length > 28 ? `${rest.slice(0, 26)}…` : rest);
  } catch {
    return String(href || '');
  }
}

function maskEmail(email) {
  const [u, d] = String(email || '').split('@');
  if (!d) return email;
  return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***') + '@' + d;
}

module.exports = {
  TZ,
  ORDER_STATUS,
  DELIVERY_METHODS,
  EVENT_META,
  ROLES,
  SERVICE_STATUS,
  SERVICE_EVENTS,
  BUDGETS,
  toDate,
  fmtDate,
  fmtDateTime,
  isoDay,
  zonedLocalToUtc,
  zonedLocal,
  timeAgo,
  daysLeft,
  daysText,
  durationLabel,
  slugify,
  initials,
  parseJson,
  discountPercent,
  maskEmail,
  fileIcon,
  fileSize,
  linkLabel,
};
