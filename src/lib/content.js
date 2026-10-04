'use strict';
const { DELIVERY_METHODS } = require('./format');

const HOW_TO_BUY = [
  { icon: 'fa-solid fa-hand-pointer', title: 'اختر اشتراكك', text: 'تصفّح المنصات واختر الاشتراك والباقة والمدة المناسبة لك.' },
  { icon: 'fa-solid fa-building-columns', title: 'حوّل المبلغ', text: 'اختر طريقة الدفع (بنك فلسطين، جوال باي، بال باي أو فودافون كاش) لتظهر لك تفاصيل الحساب والمبلغ بدقة.' },
  { icon: 'fa-solid fa-file-arrow-up', title: 'أرفق الإيصال', text: 'أدخل اسمك ورقم الحساب الذي حوّلت منه وارفع صورة إيصال التحويل، ثم أرسل الطلب.' },
  { icon: 'fa-solid fa-gift', title: 'استلم اشتراكك', text: 'نراجع الإيصال ونؤكد الدفع، ثم تصلك بيانات الاشتراك في صفحة طلبك مع إشعار فوري.' },
];

const TRUST = [
  { icon: 'fa-solid fa-shield-halved', title: 'دفع آمن وموثّق', text: 'كل عملية تُراجع يدوياً قبل التأكيد' },
  { icon: 'fa-solid fa-bolt', title: 'تسليم سريع', text: 'معظم الطلبات خلال دقائق من التأكيد' },
  { icon: 'fa-solid fa-medal', title: 'ضمان طوال المدة', text: 'دعم واستبدال عند أي مشكلة' },
  { icon: 'fa-brands fa-whatsapp', title: 'دعم عبر واتساب', text: 'فريقنا معك قبل الشراء وبعده' },
];

const STORE_FAQ = [
  {
    q: 'كيف أشتري اشتراكاً من المتجر؟',
    a: 'اختر الاشتراك والباقة المناسبة، ثم سجّل دخولك واختر طريقة الدفع وحوّل المبلغ المطلوب. بعدها أدخل اسمك ورقم الحساب الذي حوّلت منه وأرفق صورة الإيصال. بعد مراجعة الإيصال وتأكيد الدفع تصلك بيانات الاشتراك في صفحة الطلب مع إشعار فوري.',
  },
  {
    q: 'ما هي طرق الدفع المتاحة؟',
    a: 'التحويل البنكي إلى حسابنا في بنك فلسطين، أو التحويل من محفظة جوال باي أو بال باي إلى رقم الآيبان عبر خدمة الدفع الفوري iBURAQ، أو التحويل عبر فودافون كاش. عند اختيار أي طريقة تظهر لك تفاصيل الحساب والمبلغ المطلوب بعملة تلك الطريقة.',
  },
  {
    q: 'متى أستلم الاشتراك بعد الدفع؟',
    a: 'يبدأ التسليم فور تأكيد الدفع، ويظهر وقت التسليم المتوقع في صفحة كل منتج. معظم الطلبات تُسلَّم خلال دقائق إلى ساعات قليلة.',
  },
  {
    q: 'كيف أعرف أن الدفع وصل وتم تأكيده؟',
    a: 'تتغير حالة طلبك إلى «تم تأكيد الدفع» ويصلك إشعار داخل حسابك، ويمكنك متابعة كل خطوة من صفحة الطلب في لوحة المشتري.',
  },
  {
    q: 'ماذا يحدث إذا تم رفض إيصال الدفع؟',
    a: 'يظهر لك سبب الرفض في صفحة الطلب، ويمكنك رفع إيصال صحيح من نفس الصفحة مباشرة دون إنشاء طلب جديد.',
  },
  {
    q: 'لماذا تطلبون رقم الواتساب عند التسجيل؟',
    a: 'لنتواصل معك بسرعة عند الحاجة بخصوص طلبك، ولإرسال أي تنبيهات مهمة تتعلق باشتراكك.',
  },
  {
    q: 'هل يمكنني رؤية الأسعار بالشيكل أو الجنيه المصري؟',
    a: 'نعم، يمكنك تغيير عملة العرض من أعلى الصفحة، وعند اختيار طريقة الدفع يظهر المبلغ المطلوب تحويله بعملة تلك الطريقة تلقائياً.',
  },
];

// MTS Agency services (homepage). Quotes are requested over WhatsApp.
const SERVICES = [
  { icon: 'fa-solid fa-code', title: 'تصميم وبرمجة المواقع', text: 'مواقع ومتاجر سريعة ومتجاوبة تحوّل الزوار إلى عملاء، من الفكرة حتى الإطلاق.' },
  { icon: 'fa-solid fa-pen-ruler', title: 'الهوية والتصميم الجرافيكي', text: 'شعارات وهويات بصرية وتصاميم تسويقية تعكس قيمة علامتك وتبقى في الذاكرة.' },
  { icon: 'fa-solid fa-bullseye', title: 'التسويق الإلكتروني', text: 'حملات إعلانية مدروسة تصل لجمهورك المستهدف وتحقق أفضل عائد على ميزانيتك.' },
  { icon: 'fa-solid fa-clapperboard', title: 'الإنتاج المرئي', text: 'تصوير ومونتاج وموشن جرافيك لمحتوى احترافي يرفع تفاعل جمهورك.' },
  { icon: 'fa-solid fa-hashtag', title: 'إدارة صفحات التواصل', text: 'خطة محتوى ونشر وإدارة كاملة لحساباتك مع تقارير أداء واضحة.' },
  { icon: 'fa-solid fa-chalkboard-user', title: 'التدريب التقني', text: 'برامج تدريب عملية بإشراف مختصين تؤهل المتدربين لسوق العمل.' },
];

// Agency figures as published on the MTS Agency site.
const AGENCY_STATS = [
  { value: '+150', label: 'مشروع منجز' },
  { value: '+80', label: 'عميل راضٍ' },
  { value: '+5', label: 'سنوات خبرة' },
  { value: '24/7', label: 'دعم فني' },
];

// Real agency clients (logos in public/img/clients).
const CLIENTS = [
  { name: 'Lingo Bridge Academy', logo: 'lingo-bridge', url: 'https://lingobridgeacademy.net' },
  { name: 'أبو محمد — غزة', logo: 'abo-mohammed', url: 'https://sites.google.com/view/abo-mohammed-gaza' },
  { name: 'د. بسنت خالد', logo: 'dr-bassant', url: 'https://www.facebook.com/p/%D8%AF%D8%A8%D8%B3%D9%86%D8%AA-%D8%AE%D8%A7%D9%84%D8%AF-%D9%84%D9%84%D8%B9%D9%84%D8%A7%D8%AC-%D8%A7%D9%84%D8%B7%D8%A8%D9%8A%D8%B9%D9%8A-%D9%88-%D8%A7%D9%84%D8%AA%D8%BA%D8%B0%D9%8A%D8%A9-%D8%A7%D9%84%D8%B9%D9%84%D8%A7%D8%AC%D9%8A%D8%A9-61558935457432/' },
  { name: 'مخبز سنابل غزة', logo: 'sanabel-gaza' },
  { name: 'مروة الدسوقي', logo: 'marwa-desouky', url: 'https://www.facebook.com/Educator.marwa.eldesokey' },
  { name: 'منصة القمة التعليمية', logo: 'top-edu', url: 'https://sites.google.com/view/top-edu-platform/' },
  { name: 'Qusay Khudair', logo: 'qusay-khudair', url: 'https://eng-qusay-khudair.framer.website' },
  { name: 'سنتر العمدة', logo: 'al-omda' },
  { name: 'مكتب أركان', logo: 'arkan-office' },
  { name: 'ديكورست ميدو', logo: 'decorest-medo' },
];

const WHY_US = [
  { icon: 'fa-solid fa-building-shield', title: 'شركة حقيقية تعرفها', text: 'MTS Agency تعمل منذ أكثر من 5 سنوات في الحلول الرقمية، بعنوان وفريق وأرقام تواصل واضحة.' },
  { icon: 'fa-solid fa-user-check', title: 'كل تحويل يراجعه شخص حقيقي', text: 'نراجع إيصالك يدوياً ونؤكد الدفع، وتتابع حالة طلبك لحظة بلحظة من حسابك.' },
  { icon: 'fa-solid fa-lock', title: 'بيانات اشتراكك لك وحدك', text: 'تظهر البيانات داخل صفحة طلبك الخاصة فقط، ولا تُرسل في رسائل مفتوحة.' },
  { icon: 'fa-solid fa-rotate', title: 'ضمان طوال مدة الاشتراك', text: 'إذا توقف الاشتراك أو واجهتك مشكلة في التفعيل نستبدله أو نعالج المشكلة فوراً.' },
];

function productFaq(p, settings) {
  const method = DELIVERY_METHODS[p.delivery_method] || DELIVERY_METHODS.account;
  const items = [
    {
      q: `متى أستلم ${p.title}؟`,
      a: `بعد تأكيد الدفع يتم التسليم ${p.delivery_time || 'بأسرع وقت'} عادةً بطريقة: ${method.label}. تظهر البيانات في صفحة طلبك مع إشعار فوري.`,
    },
    {
      q: 'ما طرق الدفع المتاحة لهذا المنتج؟',
      a: 'بنك فلسطين، جوال باي، بال باي (عبر خدمة iBURAQ) وفودافون كاش. عند اختيار الطريقة يظهر لك المبلغ وتفاصيل الحساب، ثم ترفق صورة الإيصال.',
    },
    {
      q: 'ماذا أحتاج لتفعيل الاشتراك؟',
      a: p.buyer_input_label
        ? `سنطلب منك أثناء إتمام الطلب: ${p.buyer_input_label}، ونستخدمه فقط لتفعيل اشتراكك.`
        : 'لا تحتاج إلى أي بيانات إضافية؛ نرسل لك كل ما يلزم في صفحة الطلب بعد تأكيد الدفع.',
    },
  ];
  if (p.warranty) {
    items.push({ q: 'هل يوجد ضمان على الاشتراك؟', a: `${p.warranty}. إذا واجهتك أي مشكلة تواصل معنا عبر واتساب ${settings.whatsapp_number} وسنساعدك فوراً.` });
  }
  if (p.region_note) items.push({ q: 'هل يعمل الاشتراك في بلدي؟', a: `${p.region_note}.` });
  return items;
}

module.exports = { HOW_TO_BUY, TRUST, STORE_FAQ, SERVICES, AGENCY_STATS, CLIENTS, WHY_US, productFaq };
