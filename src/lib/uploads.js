'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');

const PUBLIC_DIR = path.join(config.uploadDir, 'public');
const RECEIPTS_DIR = path.join(config.uploadDir, 'private', 'receipts');
const SERVICE_DIR = path.join(config.uploadDir, 'private', 'services');
for (const dir of [PUBLIC_DIR, RECEIPTS_DIR, SERVICE_DIR]) fs.mkdirSync(dir, { recursive: true });

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/vnd.rar': '.rar',
  'application/x-7z-compressed': '.7z',
  'image/vnd.adobe.photoshop': '.psd',
  'application/postscript': '.eps',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
};

// Office files are ZIP containers; their own extension is kept so they open in the right app.
const OFFICE_TYPES = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const GENERIC_TYPES = ['application/octet-stream', ''];
const RECEIPT_TYPES = [...IMAGE_TYPES, 'image/heic', 'image/heif', 'application/pdf'];
// Briefs, messages and deliveries of service requests (design files, documents, archives, media).
const SERVICE_TYPES = [
  ...RECEIPT_TYPES,
  'application/zip',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'image/vnd.adobe.photoshop',
  'application/postscript',
  'video/mp4',
  'video/quicktime',
  'audio/mpeg',
  'audio/wav',
];
const SERVICE_FILE_MB = 25;

// Detect the real type from the file signature instead of trusting the browser.
function sniff(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(16);
  try {
    fs.readSync(fd, buf, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (['heic', 'heix', 'hevc', 'heim', 'heis'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1', 'heif'].includes(brand)) return 'image/heif';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  if (buf[0] === 0x50 && buf[1] === 0x4b && [0x03, 0x05].includes(buf[2]) && [0x04, 0x06].includes(buf[3])) return 'application/zip';
  if (buf.toString('ascii', 0, 6) === 'Rar!\x1a\x07') return 'application/vnd.rar';
  if (buf.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return 'application/x-7z-compressed';
  if (buf.toString('ascii', 0, 4) === '8BPS') return 'image/vnd.adobe.photoshop';
  if (buf.toString('ascii', 0, 4) === '%!PS' || buf.subarray(0, 4).equals(Buffer.from([0xc5, 0xd0, 0xd3, 0xc6]))) return 'application/postscript';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  // MP3: an ID3 tag, or a bare MPEG Layer III frame header.
  if (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x06) === 0x02 && (buf[2] & 0xf0) !== 0xf0)) {
    return 'audio/mpeg';
  }
  return null;
}

class UploadError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.expose = true;
  }
}

function makeUploader({ dir, types, maxMb, sub = '' }) {
  const target = path.join(dir, sub);
  fs.mkdirSync(target, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: target,
      filename: (req, file, cb) => cb(null, crypto.randomUUID() + (MIME_EXT[file.mimetype] || '.bin')),
    }),
    limits: { fileSize: maxMb * 1024 * 1024, files: 1, fields: 120, fieldSize: 64 * 1024 },
    // Browsers label unknown types (e.g. HEIC on some systems) as octet-stream; the signature check decides.
    fileFilter: (req, file, cb) => {
      if (types.includes(file.mimetype) || GENERIC_TYPES.includes(file.mimetype)) return cb(null, true);
      cb(new UploadError('نوع الملف غير مدعوم. المسموح: ' + types.map((t) => MIME_EXT[t].slice(1).toUpperCase()).join('، ')));
    },
  });
}

/**
 * Wrap a multer single-file middleware so errors become friendly 400s and
 * the stored file is verified by its signature (and renamed to the true extension).
 */
function single(uploader, field, types) {
  const mw = uploader.single(field);
  return (req, res, next) => {
    mw(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          const msg = err.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف أكبر من الحد المسموح' : 'تعذّر رفع الملف، حاول مرة أخرى';
          return next(new UploadError(msg));
        }
        return next(err);
      }
      if (!req.file) return next();
      const real = sniff(req.file.path);
      if (!real || !types.includes(real)) {
        fs.rm(req.file.path, { force: true }, () => {});
        return next(new UploadError('الملف المرفوع تالف أو ليس صورة/ملف PDF صالحاً'));
      }
      const ext = MIME_EXT[real];
      if (path.extname(req.file.path) !== ext) {
        const renamed = req.file.path.replace(/\.[^.]+$/, ext);
        fs.renameSync(req.file.path, renamed);
        req.file.path = renamed;
        req.file.filename = path.basename(renamed);
      }
      req.file.realType = real;
      next();
    });
  };
}

const receiptUploader = makeUploader({ dir: RECEIPTS_DIR, types: RECEIPT_TYPES, maxMb: 8 });
const imageUploaders = {};
function imageUpload(sub, field = 'image') {
  imageUploaders[sub] = imageUploaders[sub] || makeUploader({ dir: PUBLIC_DIR, types: IMAGE_TYPES, maxMb: 4, sub });
  return single(imageUploaders[sub], field, IMAGE_TYPES);
}

const receiptUpload = (field = 'receipt') => single(receiptUploader, field, RECEIPT_TYPES);

// Client file names are shown back to people: keep the base name only, without control characters.
function safeName(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim();
  return (base || 'file').slice(-120);
}

const serviceUploader = multer({
  storage: multer.diskStorage({
    destination: SERVICE_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + '.bin'),
  }),
  limits: { fileSize: SERVICE_FILE_MB * 1024 * 1024, files: 10, fields: 120, fieldSize: 64 * 1024 },
  // Design and archive formats arrive with all sorts of declared types; the signature check below decides.
  defParamCharset: 'utf8',
});

/**
 * Up to `max` attachments in `field`, each verified by its signature. Any bad file rejects the whole
 * submission and nothing stays on disk.
 */
function serviceFiles(field = 'files', max = 6) {
  const mw = serviceUploader.array(field, max);
  return (req, res, next) => {
    mw(req, res, (err) => {
      const drop = () => (req.files || []).forEach(discard);
      if (err) {
        drop();
        if (err instanceof multer.MulterError) {
          const msg =
            err.code === 'LIMIT_FILE_SIZE'
              ? `حجم الملف أكبر من ${SERVICE_FILE_MB} ميجابايت — أرسل الملفات الكبيرة كرابط`
              : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
                ? `يمكنك إرفاق ${max} ملفات كحد أقصى في المرة الواحدة`
                : 'تعذّر رفع الملفات، حاول مرة أخرى';
          return next(new UploadError(msg));
        }
        return next(err);
      }
      req.files = (req.files || []).filter((f) => f.size > 0 || discard(f));
      for (const f of req.files) {
        const real = sniff(f.path);
        if (!real || !SERVICE_TYPES.includes(real)) {
          drop();
          return next(new UploadError(`الملف «${safeName(f.originalname)}» غير مدعوم. المسموح: صور، PDF، ملفات Office، ZIP/RAR، PSD، فيديو وصوت`));
        }
        const original = safeName(f.originalname);
        const officeExt = real === 'application/zip' ? path.extname(original).toLowerCase() : '';
        const ext = OFFICE_TYPES[officeExt] ? officeExt : MIME_EXT[real];
        const renamed = f.path.replace(/\.[^.]+$/, ext);
        fs.renameSync(f.path, renamed);
        f.path = renamed;
        f.filename = path.basename(renamed);
        f.originalname = original;
        f.realType = OFFICE_TYPES[officeExt] || real;
      }
      next();
    });
  };
}

// Public URL for a file stored under uploads/public/<sub>/.
const publicUrl = (sub, filename) => `/uploads/${sub}/${filename}`;

function removePublic(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const file = path.join(PUBLIC_DIR, url.slice('/uploads/'.length));
  if (file.startsWith(PUBLIC_DIR + path.sep)) fs.rm(file, { force: true }, () => {});
}

function discard(file) {
  if (file && file.path) fs.rm(file.path, { force: true }, () => {});
}

module.exports = {
  PUBLIC_DIR,
  RECEIPTS_DIR,
  SERVICE_DIR,
  SERVICE_FILE_MB,
  UploadError,
  receiptUpload,
  imageUpload,
  serviceFiles,
  publicUrl,
  removePublic,
  discard,
};
