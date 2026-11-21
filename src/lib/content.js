'use strict';
const { DELIVERY_METHODS } = require('./format');

function getHowToBuy(s = {}) {
  return [
    { icon: 'fa-solid fa-hand-pointer', title: s.home_step1_title || 'اختر اشتراكك', text: s.home_step1_desc || 'بجانب كل باقة سعرها ومدتها بعملتك، فتعرف ما ستدفعه قبل أن تبدأ.' },
    { icon: 'fa-solid fa-building-columns', title: s.home_step2_title || 'حول المبلغ', text: s.home_step2_desc || 'اختر فودافون كاش أو انستا باي أو البطاقات البنكية وطرق الدفع العالمية، فيظهر لك رقم الحساب أو المحفظة والمبلغ بدقة.' },
    { icon: 'fa-solid fa-file-arrow-up', title: 'أرفق الإيصال', text: 'اكتب اسمك ورقم الحساب أو المحفظة الذي حولت منه وارفع صورة الإيصال. هذا كل ما نحتاجه منك.' },
    { icon: 'fa-solid fa-gift', title: s.home_step3_title || 'استلم اشتراكك', text: s.home_step3_desc || 'بعد أن نتأكد من التحويل تظهر بيانات اشتراكك في صفحة طلبك، ويصلك إشعار بذلك.' },
  ];
}

function getTrust(s = {}) {
  return [
    { icon: 'fa-solid fa-shield-halved', title: s.store_trust_1_title || 'مراجعة يدوية للتحويل', text: s.store_trust_1_desc || 'شخص من فريقنا يتحقق من كل إيصال' },
    { icon: 'fa-solid fa-bolt', title: s.store_trust_2_title || 'تسليم بعد التأكيد', text: s.store_trust_2_desc || 'ووقته المتوقع مكتوب في صفحة كل اشتراك' },
    { icon: 'fa-solid fa-medal', title: s.store_trust_3_title || 'ضمان طوال المدة', text: s.store_trust_3_desc || 'إذا تعطل الاشتراك نصلحه أو نستبدله' },
    { icon: 'fa-brands fa-whatsapp', title: s.store_trust_4_title || 'دعم على واتساب', text: s.store_trust_4_desc || 'اسألنا قبل أن تدفع، وبعد أن تستلم' },
  ];
}

function getStoreFaq(s = {}) {
  return [
    {
      q: s.faq_how_to_buy_q || 'كيف أشتري اشتراكا؟',
      a: s.faq_how_to_buy_a || 'اختر الاشتراك والباقة وسجل دخولك، ثم اختر طريقة الدفع وحول المبلغ الظاهر لك. بعدها اكتب اسمك ورقم الحساب أو المحفظة الذي حولت منه وارفع صورة الإيصال. عندما نتأكد من التحويل تجد بيانات اشتراكك في صفحة طلبك.',
    },
    {
      q: s.faq_pay_q || 'كيف أدفع؟',
      a: s.faq_pay_a || 'يمكنك الدفع من داخل مصر عبر فودافون كاش أو انستا باي أو التحويل البنكي، ومن جميع أنحاء العالم بالدولار عبر البطاقات البنكية وطرق الدفع العالمية المعتمدة. عندما تختار الطريقة يظهر لك رقم الحساب والمبلغ بوضوح.',
    },
    {
      q: s.faq_delivery_q || 'متى أستلم الاشتراك بعد الدفع؟',
      a: s.faq_delivery_a || 'نبدأ التسليم عندما نتأكد من وصول التحويل. لكل اشتراك وقت تسليم مكتوب في صفحته، وأغلب الطلبات تصل خلال دقائق وبعضها يأخذ ساعات قليلة.',
    },
    {
      q: 'كيف أعرف أنكم استلمتم التحويل؟',
      a: 'تتغير حالة طلبك إلى «تم تأكيد الدفع» ويصلك إشعار في حسابك، وكل خطوة بعدها تراها في صفحة الطلب.',
    },
    {
      q: 'ماذا لو رفضتم الإيصال؟',
      a: 'نكتب لك سبب الرفض في صفحة الطلب، وترفع إيصالا صحيحا من الصفحة نفسها دون أن تبدأ طلبا جديدا.',
    },
    {
      q: 'لماذا تطلبون رقم الواتساب عند التسجيل؟',
      a: 'لأنه أسرع طريق نصل به إليك إذا احتجنا معلومة عن طلبك، أو حدث في اشتراكك ما يجب أن تعرفه.',
    },
    {
      q: s.faq_currency_q || 'هل أرى الأسعار بالجنيه أو الدولار؟',
      a: s.faq_currency_a || 'نعم، يمكنك تغيير العملة من أعلى الصفحة بين الجنيه والدولار. وعند الدفع يظهر المبلغ بعملة الطريقة التي اخترتها، فلا تحتاج أن تحسب التحويل بنفسك.',
    },
  ];
}

const HOW_TO_BUY = getHowToBuy();
const TRUST = getTrust();
const STORE_FAQ = getStoreFaq();

// MTS Agency services: the starting list for the "services" table (editable from the admin dashboard).
const SERVICES = [
  {
    slug: 'web-development',
    icon: 'fa-solid fa-code',
    title: 'تصميم وبرمجة المواقع',
    text: 'مواقع ومتاجر تفتح بسرعة على الجوال، من الفكرة حتى يوم الإطلاق. المتجر الذي تتصفحه الآن من صنعنا.',
    hint: 'اكتب نوع الموقع (تعريفي أو متجر أو منصة)، وعدد الصفحات تقريبا، وروابط مواقع تعجبك، وما عندك من نصوص وصور.',
  },
  {
    slug: 'branding-design',
    icon: 'fa-solid fa-pen-ruler',
    title: 'الهوية والتصميم الجرافيكي',
    text: 'شعار وألوان وخطوط ثابتة تعرف بها علامتك، وتصاميم جاهزة للنشر والطباعة.',
    hint: 'اكتب اسم العلامة ونشاطها، ومن هم زبائنك، والألوان التي تحبها أو لا تريدها، والتصاميم التي تحتاجها ومقاساتها.',
  },
  {
    slug: 'digital-marketing',
    icon: 'fa-solid fa-bullseye',
    title: 'التسويق الإلكتروني',
    text: 'حملات ممولة نحدد جمهورها ونتابع أرقامها معك، فتعرف أين ذهبت ميزانيتك.',
    hint: 'اكتب ما تريد تسويقه، وهدفك من الحملة (مبيعات أو رسائل أو متابعون)، والمدن أو الدول التي تستهدفها، وميزانيتك الإعلانية.',
  },
  {
    slug: 'video-production',
    icon: 'fa-solid fa-clapperboard',
    title: 'الإنتاج المرئي',
    text: 'تصوير ومونتاج وموشن جرافيك لإعلاناتك ومحتواك على السوشيال ميديا.',
    hint: 'اكتب نوع الفيديو (إعلان أو موشن أو مونتاج)، ومدته، والمنصة التي سينشر عليها، وأرفق أمثلة أعجبتك.',
  },
  {
    slug: 'social-media',
    icon: 'fa-solid fa-hashtag',
    title: 'إدارة صفحات التواصل',
    text: 'نخطط المحتوى وننشره ونتابع التفاعل على حساباتك، مع تقارير أداء تفهمها من أول قراءة.',
    hint: 'ضع روابط حساباتك، وعدد المنشورات التي تريدها في الشهر، واكتب عن نشاطك وما تنتظره من إدارة الصفحات.',
  },
  {
    slug: 'tech-training',
    icon: 'fa-solid fa-chalkboard-user',
    title: 'التدريب التقني',
    text: 'تدريب عملي على أدوات العمل الرقمي، يقدمه فريق يستخدمها في مشاريع حقيقية كل يوم.',
    hint: 'اكتب المجال، وعدد المتدربين ومستواهم، والمدة المناسبة لكم، وهل تفضلون التدريب حضوريا أم أونلاين.',
  },
];

// Real agency clients (logos in public/img/clients).
const CLIENTS = [
  { name: 'Lingo Bridge Academy', logo: 'lingo-bridge', url: 'https://lingobridgeacademy.net' },
  { name: 'أبو محمد، غزة', logo: 'abo-mohammed', url: 'https://sites.google.com/view/abo-mohammed-gaza' },
  { name: 'د. بسنت خالد', logo: 'dr-bassant', url: 'https://www.facebook.com/p/%D8%AF%D8%A8%D8%B3%D9%86%D8%AA-%D8%AE%D8%A7%D9%84%D8%AF-%D9%84%D9%84%D8%B9%D9%84%D8%A7%D8%AC-%D8%A7%D9%84%D8%B7%D8%A8%D9%8A%D8%B9%D9%8A-%D9%88-%D8%A7%D9%84%D8%AA%D8%BA%D8%B0%D9%8A%D8%A9-%D8%A7%D9%84%D8%B9%D9%84%D8%A7%D8%AC%D9%8A%D8%A9-61558935457432/' },
  { name: 'مخبز سنابل غزة', logo: 'sanabel-gaza' },
  { name: 'مروة الدسوقي', logo: 'marwa-desouky', url: 'https://www.facebook.com/Educator.marwa.eldesokey' },
  { name: 'منصة القمة التعليمية', logo: 'top-edu', url: 'https://sites.google.com/view/top-edu-platform/' },
  { name: 'Qusay Khudair', logo: 'qusay-khudair', url: 'https://eng-qusay-khudair.framer.website' },
  { name: 'سنتر العمدة', logo: 'al-omda' },
  { name: 'مكتب أركان', logo: 'arkan-office' },
  { name: 'ديكورست ميدو', logo: 'decorest-medo' },
];

function productFaq(p, settings) {
  const method = DELIVERY_METHODS[p.delivery_method] || DELIVERY_METHODS.account;
  const items = [
    {
      q: `متى أستلم ${p.title}؟`,
      a: `عادة ${p.delivery_time || 'في وقت قصير'} بعد تأكيد الدفع، وطريقة التسليم: ${method.label}. ستجد البيانات في صفحة طلبك ويصلك إشعار.`,
    },
    {
      q: 'كيف أدفع ثمن هذا الاشتراك؟',
      a: 'عبر فودافون كاش أو انستا باي للمشترين من مصر، أو بالدولار عبر البطاقات البنكية وطرق الدفع العالمية. تختار الطريقة فيظهر لك المبلغ ورقم الحساب أو المحفظة، ثم ترفق صورة الإيصال.',
    },
    {
      q: 'ماذا أحتاج لتفعيل الاشتراك؟',
      a: p.buyer_input_label
        ? `سنطلب منك عند إتمام الطلب: ${p.buyer_input_label}. لن نستخدمه إلا لتفعيل اشتراكك.`
        : 'لا شيء من جهتك. بعد تأكيد الدفع نضع كل ما يلزم في صفحة طلبك.',
    },
  ];
  if (p.warranty) {
    items.push({ q: 'هل على الاشتراك ضمان؟', a: `${p.warranty}. إذا واجهتك مشكلة راسلنا على واتساب ${settings.whatsapp_number} ونحلها معك.` });
  }
  if (p.region_note) items.push({ q: 'هل يعمل الاشتراك في بلدي؟', a: `${p.region_note}.` });
  return items;
}

module.exports = { HOW_TO_BUY, TRUST, STORE_FAQ, SERVICES, CLIENTS, productFaq, getHowToBuy, getTrust, getStoreFaq };
