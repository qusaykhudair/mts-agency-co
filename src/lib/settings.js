'use strict';
const { all, run, tx } = require('../db');

const DEFAULTS = {
  store_name: 'MTS Store',
  store_tagline: 'متجر الاشتراكات الرقمية',
  whatsapp_number: '+201093525956',
  support_email: 'mts.agency.co@gmail.com',
  facebook_url: 'https://www.facebook.com/mts.agency.co',
  instagram_url: 'https://www.instagram.com/mts.agency.co/',
  announcement: 'ادفع بسهولة عبر فودافون كاش، انستا باي، أو بالبطاقات البنكية وطرق الدفع العالمية واستلم اشتراكك فوراً',
  // "…" splits the store headline: the part after it shows on its own highlighted line.
  hero_title: 'اشتراكاتك الرقمية المفضلة… بالجنيه والدولار',
  hero_subtitle: 'ChatGPT وCanva وCapCut وNetflix وغيرها، ادفع بالجنيه عبر فودافون كاش وانستا باي أو بالدولار عبر طرق الدفع العالمية، وتصلك بيانات الاشتراك في حسابك بعد تأكيد التحويل.',
  checkout_note: 'نراجع إيصالك بأنفسنا، وعندما نؤكد الدفع تجد بيانات اشتراكك في صفحة الطلب ويصلك إشعار بذلك.',

  // Home Page texts
  home_hero_title: 'اشترك في أدواتك الرقمية المفضلة بدون بطاقة دولية',
  home_hero_subtitle: 'ChatGPT وClaude وCanva وCapCut وغيرها من المنصات العالمية. ادفع بسهولة عبر فودافون كاش أو انستا باي أو بطرق الدفع العالمية، وتصلك بيانات الاشتراك في حسابك بعد تأكيد التحويل.',
  home_hero_badge: 'بدون بطاقة دولية',
  home_search_placeholder: 'ابحث، مثلا: ChatGPT Plus',
  home_feature_1: 'دفع محلي بفودافون كاش وانستا باي أو بالدولار عالمياً',
  home_feature_2: 'إيصالك يراجعه شخص من فريقنا بعناية',
  home_feature_3: 'ضمان كامل طوال مدة الاشتراك',
  home_platforms_title: 'اشتراكات أصلية من أفضل المنصات العالمية',
  home_popular_title: 'الأكثر طلبا',
  home_services_label: 'خدمات MTS Agency',
  home_services_title: 'الفريق الذي بنى هذا المتجر يعمل على مشروعك',
  home_services_desc: 'اكتب ما تحتاجه وأرفق ملفاتك، وتابع العمل مع من ينفذه حتى تستلمه في حسابك.',
  home_steps_title: 'ثلاث خطوات من الاختيار إلى الاستلام',
  home_step1_title: 'اختر الاشتراك والباقة',
  home_step1_desc: 'قارن الباقات وأسعارها بعملتك، ثم اضغط «اشتر الآن».',
  home_step2_title: 'حول وارفع الإيصال',
  home_step2_desc: 'من فودافون كاش أو انستا باي أو بالبطاقات البنكية وطرق الدفع العالمية. رقم الحساب أو المحفظة والمبلغ يظهران لك جاهزين للنسخ.',
  home_step3_title: 'استلم اشتراكك',
  home_step3_desc: 'نتحقق من التحويل، ثم تظهر بيانات اشتراكك في صفحة طلبك ويصلك إشعار.',
  home_clients_title: 'عملنا مع هؤلاء وساعدناهم في نجاح مشاريعهم',
  home_reviews_title: 'آراء وتقييمات العملاء',
  home_reviews_desc: 'تجارب حقيقية من عملاء اشتروا واستخدموا خدماتنا واشتراكاتنا.',

  // Store Page & Trust texts
  store_trust_1_title: 'مراجعة يدوية للتحويل',
  store_trust_1_desc: 'شخص من فريقنا يتحقق من كل إيصال',
  store_trust_2_title: 'تسليم بعد التأكيد',
  store_trust_2_desc: 'ووقته المتوقع مكتوب في صفحة كل اشتراك',
  store_trust_3_title: 'ضمان طوال المدة',
  store_trust_3_desc: 'إذا تعطل الاشتراك نصلحه أو نستبدله',
  store_trust_4_title: 'دعم على واتساب',
  store_trust_4_desc: 'اسألنا قبل أن تدفع، وبعد أن تستلم',

  // Footer & General texts
  footer_about: 'نوفر اشتراكات المنصات العالمية بالدفع المحلي بالجنيه أو بالدولار عالمياً. ولأصحاب المشاريع نبني المواقع ونصمم الهويات وندير الحملات الإعلانية.',
  store_address: 'جسر السويس، القاهرة، مصر',
  footer_copyright: 'جميع الحقوق محفوظة',

  // FAQ texts
  faq_how_to_buy_q: 'كيف أشتري اشتراكا؟',
  faq_how_to_buy_a: 'اختر الاشتراك والباقة وسجل دخولك، ثم اختر طريقة الدفع وحول المبلغ الظاهر لك. بعدها اكتب اسمك ورقم الحساب الذي حولت منه وارفع صورة الإيصال. عندما نتأكد من التحويل تجد بيانات اشتراكك في صفحة طلبك.',
  faq_pay_q: 'كيف أدفع؟',
  faq_pay_a: 'يمكنك الدفع من داخل مصر عبر فودافون كاش أو انستا باي أو التحويل البنكي، ومن جميع أنحاء العالم بالدولار عبر البطاقات البنكية وطرق الدفع العالمية المعتمدة. عندما تختار الطريقة يظهر لك رقم الحساب والمبلغ بوضوح.',
  faq_delivery_q: 'متى أستلم الاشتراك بعد الدفع؟',
  faq_delivery_a: 'نبدأ التسليم عندما نتأكد من وصول التحويل. لكل اشتراك وقت تسليم مكتوب في صفحته، وأغلب الطلبات تصل خلال دقائق وبعضها يأخذ ساعات قليلة.',
  faq_currency_q: 'هل أرى الأسعار بالجنيه أو الدولار؟',
  faq_currency_a: 'نعم، يمكنك تغيير العملة من أعلى الصفحة بين الجنيه والدولار. وعند الدفع يظهر المبلغ بعملة الطريقة التي اخترتها، فلا تحتاج أن تحسب التحويل بنفسك.',
  google_client_id: '',
  // Ownership codes from Google Search Console and Bing Webmaster Tools (the "HTML tag" method).
  google_site_verification: '',
  bing_site_verification: '',
  // '1' = e-mail the daily database snapshot to the store's address; the day it last went out.
  backup_email: '0',
  backup_email_last: '',
  // Google Drive copies of the invoices: the folders and the register the store made there (JSON of ids),
  // a random id that marks this store's files, and the last time everything was uploaded.
  drive_folders: '',
  drive_instance: '',
  drive_synced_at: '',
  auto_complete_days: '3',
  // Delivered service requests the client never answered are closed after this many days.
  service_auto_complete_days: '7',
  max_quantity: '10',
  default_currency: '',
  // Sellers may confirm/reject payments for their products ('0' = only the admin can).
  sellers_can_approve: '1',
  // "Become a seller" applications: open or closed, an optional automatic closing time (UTC) and
  // the message shown while closed.
  seller_applications_open: '1',
  seller_applications_until: '',
  seller_applications_note: '',
  // MTS keeps this percentage of every seller sale; "sale" = of the sale price, "profit" = of the
  // sale price minus the seller's original price.
  commission_rate: '20',
  commission_basis: 'sale',
  // Every seller pays this monthly fee. Unpaid sellers lose their dashboard (and their products leave
  // the store) once the grace days after the paid period have passed, while enforcement is on.
  seller_fee_amount: '5',
  seller_fee_currency: 'USD',
  seller_fee_grace_days: '3',
  seller_fee_enforce: '1',
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

// "Become a seller" takes applications only while the admin keeps it open (and before its closing time).
function sellerApplicationsOpen(now = new Date()) {
  if (get('seller_applications_open') !== '1') return false;
  const until = get('seller_applications_until');
  if (!until) return true;
  const t = Date.parse(String(until).replace(' ', 'T') + 'Z');
  return Number.isNaN(t) || now.getTime() < t;
}

module.exports = { DEFAULTS, get, getAll, set, load, sellerApplicationsOpen };
