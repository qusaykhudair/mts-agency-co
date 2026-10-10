'use strict';
// Sends a sample verification e-mail to check the mail setup: npm run mail-test -- you@example.com
const to = (process.argv[2] || '').trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
  console.error('اكتب البريد الذي تريد التجربة عليه: npm run mail-test -- you@example.com');
  process.exit(1);
}

const db = require('../src/db');
db.migrate();
const mail = require('../src/lib/mail');
const { message } = require('../src/lib/email-verify');

(async () => {
  console.log(`طريقة الإرسال: ${mail.transportName()}`);
  if (!mail.isConfigured()) {
    console.error('البريد غير مضبوط بعد. املأ قيم GMAIL_ في ملف .env (أو قيم SMTP_) ثم أعد المحاولة.');
    process.exit(1);
  }
  const msg = await message({ name: 'صديقنا', email: to }, '123456');
  msg.subject = `رسالة تجربة: ${msg.subject}`;
  const result = await mail.send(msg);
  if (!result.ok) {
    console.error(`لم نتمكن من الإرسال: ${result.error}`);
    process.exit(1);
  }
  console.log(`أرسلنا رسالة تجربة إلى ${to}. افتح بريدك وتأكد أنها وصلت وشكلها سليم.`);
})();
