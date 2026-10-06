'use strict';
const { DELIVERY_METHODS } = require('./format');

const HOW_TO_BUY = [
  { icon: 'fa-solid fa-hand-pointer', title: 'اختر اشتراكك', text: 'بجانب كل باقة سعرها ومدتها بعملتك، فتعرف ما ستدفعه قبل أن تبدأ.' },
  { icon: 'fa-solid fa-building-columns', title: 'حول المبلغ', text: 'اختر بنك فلسطين أو جوال باي أو بال باي أو فودافون كاش، فيظهر لك رقم الحساب والمبلغ بعملة الطريقة التي اخترتها.' },
  { icon: 'fa-solid fa-file-arrow-up', title: 'أرفق الإيصال', text: 'اكتب اسمك ورقم الحساب الذي حولت منه وارفع صورة الإيصال. هذا كل ما نحتاجه منك.' },
  { icon: 'fa-solid fa-gift', title: 'استلم اشتراكك', text: 'بعد أن نتأكد من التحويل تظهر بيانات اشتراكك في صفحة طلبك، ويصلك إشعار بذلك.' },
];

const TRUST = [
  { icon: 'fa-solid fa-shield-halved', title: 'مراجعة يدوية للتحويل', text: 'شخص من فريقنا يتحقق من كل إيصال' },
  { icon: 'fa-solid fa-bolt', title: 'تسليم بعد التأكيد', text: 'ووقته المتوقع مكتوب في صفحة كل اشتراك' },
  { icon: 'fa-solid fa-medal', title: 'ضمان طوال المدة', text: 'إذا تعطل الاشتراك نصلحه أو نستبدله' },
  { icon: 'fa-brands fa-whatsapp', title: 'دعم على واتساب', text: 'اسألنا قبل أن تدفع، وبعد أن تستلم' },
];

const STORE_FAQ = [
  {
    q: 'كيف أشتري اشتراكا؟',
    a: 'اختر الاشتراك والباقة وسجل دخولك، ثم اختر طريقة الدفع وحول المبلغ الظاهر لك. بعدها اكتب اسمك ورقم الحساب الذي حولت منه وارفع صورة الإيصال. عندما نتأكد من التحويل تجد بيانات اشتراكك في صفحة طلبك.',
  },
  {
    q: 'كيف أدفع؟',
    a: 'بتحويل بنكي إلى حسابنا في بنك فلسطين، أو من محفظة جوال باي أو بال باي إلى رقم الآيبان عبر خدمة iBURAQ، أو بتحويل فودافون كاش من مصر. عندما تختار الطريقة يظهر لك رقم الحساب والمبلغ بعملتها.',
  },
  {
    q: 'متى أستلم الاشتراك بعد الدفع؟',
    a: 'نبدأ التسليم عندما نتأكد من وصول التحويل. لكل اشتراك وقت تسليم مكتوب في صفحته، وأغلب الطلبات تصل خلال دقائق وبعضها يأخذ ساعات قليلة.',
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
    q: 'هل أرى الأسعار بالشيكل أو الجنيه؟',
    a: 'نعم، غير العملة من أعلى الصفحة. وعند الدفع يظهر المبلغ بعملة الطريقة التي اخترتها، فلا تحتاج أن تحسب التحويل بنفسك.',
  },
];

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
      a: 'من بنك فلسطين، أو من جوال باي أو بال باي عبر خدمة iBURAQ، أو بفودافون كاش. تختار الطريقة فيظهر لك المبلغ ورقم الحساب، ثم ترفق صورة الإيصال.',
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

module.exports = { HOW_TO_BUY, TRUST, STORE_FAQ, SERVICES, CLIENTS, productFaq };
