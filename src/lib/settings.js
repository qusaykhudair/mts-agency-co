'use strict';
const { all, run, tx } = require('../db');
const config = require('../config');

const DEFAULTS = {
  store_name: 'MTS Store',
  store_tagline: 'متجر الاشتراكات الرقمية',
  whatsapp_number: '+201093525956',
  support_email: 'mts.agency.co@gmail.com',
  facebook_url: 'https://www.facebook.com/mts.agency.co',
  instagram_url: 'https://www.instagram.com/mts.agency.co/',
  announcement: 'ادفع من بنك فلسطين أو جوال باي أو بال باي أو فودافون كاش، واستلم اشتراكك في حسابك بعد تأكيد التحويل',
  // "…" splits the store headline: the part after it shows on its own highlighted line.
  hero_title: 'اشتراكاتك العالمية… بالشيكل أو الجنيه',
  hero_subtitle: 'ChatGPT وCanva وCapCut وNetflix وغيرها، تدفع ثمنها من بنك فلسطين أو جوال باي أو بال باي أو فودافون كاش، وتصلك بيانات الاشتراك في حسابك بعد تأكيد التحويل.',
  checkout_note: 'نراجع إيصالك بأنفسنا، وعندما نؤكد الدفع تجد بيانات اشتراكك في صفحة الطلب ويصلك إشعار بذلك.',
  google_client_id: '',
  auto_complete_days: '3',
  // Delivered service requests the client never answered are closed after this many days.
  service_auto_complete_days: '7',
  max_quantity: '10',
  default_currency: '',
  // Sellers may confirm/reject payments for their products ('0' = only the admin can).
  sellers_can_approve: '1',
};

let cache = null;

function load() {
  cache = { ...DEFAULTS };
  for (const row of all('SELECT key, value FROM settings')) cache[row.key] = row.value ?? '';
  return cache;
}

function getAll() {
  return cache || load();
}

function get(key) {
  const s = getAll();
  return s[key] !== undefined ? s[key] : DEFAULTS[key];
}

function set(values) {
  tx(() => {
    for (const [key, value] of Object.entries(values)) {
      run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value == null ? '' : String(value));
    }
  });
  load();
}

// The environment variable wins so a deployment can pin the client id.
function googleClientId() {
  return config.googleClientId || get('google_client_id') || '';
}

module.exports = { DEFAULTS, get, getAll, set, load, googleClientId };
