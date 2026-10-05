'use strict';
// First-run data: currencies, payment methods, settings, the admin account and a demo catalogue.
// Everything here is editable later from the seller dashboard.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { get, run, tx, toSql } = require('./db');
const config = require('./config');
const { hashPassword, verifyPassword, endAllSessions } = require('./lib/auth');
const { fromInternational } = require('./lib/phone');
const settings = require('./lib/settings');
const { SERVICES } = require('./lib/content');

const IBAN = 'PS21PALS045230568550993100000';

const CURRENCIES = [
  { code: 'USD', name: 'دولار أمريكي', symbol: '$', rate: 1, decimals: 2, is_base: 1, sort_order: 1 },
  { code: 'ILS', name: 'شيكل', symbol: '₪', rate: 3.1, decimals: 0, is_base: 0, sort_order: 2 },
  { code: 'EGP', name: 'جنيه مصري', symbol: 'ج.م', rate: 53, decimals: 0, is_base: 0, sort_order: 3 },
];

const PAYMENT_METHODS = [
  {
    name: 'بنك فلسطين',
    subtitle: 'تحويل بنكي مباشر إلى الحساب',
    type: 'bank',
    icon: 'fa-solid fa-building-columns',
    color: '#0F766E',
    currency_code: 'ILS',
    details: [
      { label: 'البنك', value: 'بنك فلسطين — Bank of Palestine', copy: false },
      { label: 'رقم الحساب', value: '3056855', copy: true },
      { label: 'اسم صاحب الحساب', value: 'قصي خضير', copy: true },
      { label: 'رقم الآيبان (IBAN)', value: IBAN, copy: true },
    ],
    instructions: [
      'حوّل المبلغ المطلوب إلى رقم الحساب الموضح عبر تطبيق بنك فلسطين أو من أي فرع.',
      'عند التحويل من بنك آخر استخدم رقم الآيبان (IBAN).',
      'التقط صورة واضحة لإيصال التحويل تُظهر المبلغ والتاريخ واسم المستفيد.',
    ],
    sender_account_label: 'رقم الحساب الذي حوّلت منه',
  },
  {
    name: 'جوال باي — Jawwal Pay',
    subtitle: 'من المحفظة إلى الآيبان عبر خدمة iBURAQ',
    type: 'wallet',
    icon: 'fa-solid fa-mobile-screen-button',
    color: '#16A34A',
    currency_code: 'ILS',
    details: [
      { label: 'طريقة التحويل', value: 'نظام الدفع الفوري iBURAQ — تحويل إلى حساب بنكي', copy: false },
      { label: 'رقم الآيبان (IBAN)', value: IBAN, copy: true },
      { label: 'اسم المستفيد', value: 'قصي خضير', copy: true },
      { label: 'البنك المستفيد', value: 'بنك فلسطين', copy: false },
    ],
    instructions: [
      'افتح تطبيق جوال باي واختر التحويل إلى حساب بنكي عبر خدمة الدفع الفوري iBURAQ.',
      'أدخل رقم الآيبان الموضح وتأكد أن اسم المستفيد: قصي خضير.',
      'أرسل المبلغ المطلوب ثم التقط صورة لشاشة نجاح العملية.',
    ],
    sender_account_label: 'رقم محفظة جوال باي التي حوّلت منها',
  },
  {
    name: 'بال باي — PalPay',
    subtitle: 'من المحفظة إلى الآيبان عبر خدمة iBURAQ',
    type: 'wallet',
    icon: 'fa-solid fa-wallet',
    color: '#2563EB',
    currency_code: 'ILS',
    details: [
      { label: 'طريقة التحويل', value: 'نظام الدفع الفوري iBURAQ — تحويل إلى حساب بنكي', copy: false },
      { label: 'رقم الآيبان (IBAN)', value: IBAN, copy: true },
      { label: 'اسم المستفيد', value: 'قصي خضير', copy: true },
      { label: 'البنك المستفيد', value: 'بنك فلسطين', copy: false },
    ],
    instructions: [
      'افتح تطبيق بال باي واختر التحويل إلى حساب بنكي عبر خدمة الدفع الفوري iBURAQ.',
      'أدخل رقم الآيبان الموضح وتأكد أن اسم المستفيد: قصي خضير.',
      'أرسل المبلغ المطلوب ثم التقط صورة لشاشة نجاح العملية.',
    ],
    sender_account_label: 'رقم محفظة بال باي التي حوّلت منها',
  },
  {
    name: 'فودافون كاش',
    subtitle: 'تحويل إلى محفظة فودافون كاش (مصر)',
    type: 'wallet',
    icon: 'fa-solid fa-money-bill-transfer',
    color: '#E60000',
    currency_code: 'EGP',
    details: [
      { label: 'رقم فودافون كاش', value: '01093525956', copy: true },
      { label: 'اسم صاحب المحفظة', value: 'شيماء ... ز ... ق', copy: false },
    ],
    instructions: [
      'حوّل المبلغ المطلوب إلى رقم فودافون كاش الموضح من محفظتك أو من أي منفذ يقدّم الخدمة.',
      'تأكد قبل التأكيد أن اسم المستلم الظاهر: شيماء ... ز ... ق',
      'التقط صورة لرسالة أو إيصال التحويل وأرفقها في النموذج.',
    ],
    sender_account_label: 'رقم المحفظة الذي حوّلت منه',
  },
];

const CATEGORIES = [
  ['ai', 'الذكاء الاصطناعي', 'fa-solid fa-robot', 'أدوات الذكاء الاصطناعي للكتابة والبرمجة والبحث وتوليد الصور والصوت.'],
  ['design', 'التصميم والمونتاج', 'fa-solid fa-palette', 'برامج التصميم الجرافيكي ومونتاج الفيديو والمحتوى الإبداعي.'],
  ['streaming', 'الأفلام والمسلسلات', 'fa-solid fa-tv', 'منصات البث والترفيه بجودة عالية وبدون إعلانات.'],
  ['music', 'الموسيقى والصوتيات', 'fa-solid fa-headphones', 'استمع لملايين الأغاني والبودكاست بدون إعلانات.'],
  ['productivity', 'الإنتاجية والعمل', 'fa-solid fa-briefcase', 'أدوات العمل والتنظيم والتواصل المهني.'],
  ['education', 'التعليم واللغات', 'fa-solid fa-graduation-cap', 'تعلّم اللغات والمهارات والدورات المعتمدة.'],
  ['security', 'الحماية و VPN', 'fa-solid fa-shield-halved', 'تصفّح آمن وخصوصية كاملة على جميع أجهزتك.'],
  ['gaming', 'الألعاب', 'fa-solid fa-gamepad', 'اشتراكات منصات الألعاب ومزايا اللاعبين.'],
];

// slug, name, category, color1, color2, featured
const PLATFORMS = [
  ['chatgpt', 'ChatGPT', 'ai', '#10A37F', '#0A6B53', 1],
  ['claude', 'Claude', 'ai', '#E08A6B', '#B8532F', 1],
  ['canva', 'Canva', 'design', '#00C4CC', '#7D2AE8', 1],
  ['capcut', 'CapCut', 'design', '#2E2E33', '#050506', 1],
  ['gemini', 'Google Gemini', 'ai', '#4C8DF6', '#8E5BD8', 1],
  ['netflix', 'Netflix', 'streaming', '#E50914', '#7A0208', 1],
  ['spotify', 'Spotify', 'music', '#1ED760', '#0F8A3B', 1],
  ['youtube', 'YouTube Premium', 'streaming', '#FF2D2D', '#B30000', 1],
  ['adobe', 'Adobe', 'design', '#FF3B30', '#B40D00', 1],
  ['microsoft-365', 'Microsoft 365', 'productivity', '#2B88D8', '#0B4F99', 1],
  ['shahid', 'Shahid', 'streaming', '#22C55E', '#0F7A3C', 1],
  ['perplexity', 'Perplexity', 'ai', '#22B8C8', '#106F7B', 1],
  ['cursor', 'Cursor', 'ai', '#3A3A40', '#0B0B0E', 1],
  ['duolingo', 'Duolingo', 'education', '#6BD617', '#3C9A00', 1],
  ['grammarly', 'Grammarly', 'productivity', '#15C39A', '#027E6F', 1],
  ['linkedin', 'LinkedIn Premium', 'productivity', '#1477D4', '#004182', 1],
  ['midjourney', 'Midjourney', 'ai', '#334155', '#0F172A', 0],
  ['elevenlabs', 'ElevenLabs', 'ai', '#3F3F46', '#09090B', 0],
  ['figma', 'Figma', 'design', '#A259FF', '#F24E1E', 0],
  ['freepik', 'Freepik', 'design', '#2F86F6', '#0B4FB5', 0],
  ['anghami', 'Anghami', 'music', '#A93BF5', '#5B1AA8', 0],
  ['notion', 'Notion', 'productivity', '#3D3D3D', '#111111', 0],
  ['coursera', 'Coursera', 'education', '#2A73E8', '#0041A8', 0],
  ['udemy', 'Udemy', 'education', '#B45CF5', '#5624D0', 0],
  ['nordvpn', 'NordVPN', 'security', '#4D8BFF', '#1E4FCC', 0],
  ['expressvpn', 'ExpressVPN', 'security', '#E5484F', '#A51C24', 0],
  ['surfshark', 'Surfshark', 'security', '#22C7C7', '#0F7F86', 0],
  ['xbox', 'Xbox Game Pass', 'gaming', '#1DA81D', '#0B5A0B', 0],
  ['playstation', 'PlayStation Plus', 'gaming', '#1A7FE0', '#00307A', 0],
  ['discord', 'Discord Nitro', 'gaming', '#6D78F7', '#3C45C5', 0],
];

const usd = (n) => Math.round(n * 100);
const days = (n) => toSql(new Date(Date.now() + n * 86400000));

const DELIVERY_SENTENCE = {
  upgrade: 'تتم الترقية على حسابك الشخصي مباشرة دون الحاجة لبطاقة ائتمان، ونرسل لك تأكيد التفعيل وأي خطوات لازمة.',
  account: 'نسلّمك حساباً جاهزاً مفعّلاً بالاشتراك (البريد وكلمة المرور) مع تعليمات الاستخدام.',
  invite: 'نرسل دعوة الانضمام إلى بريدك الإلكتروني، وكل ما عليك هو قبول الدعوة لتفعيل المزايا فوراً.',
  code: 'نرسل لك كود التفعيل الأصلي مع خطوات استرداده خطوة بخطوة.',
  link: 'نرسل لك رابط تفعيل خاصاً بك، تفتحه من حسابك ويتم تفعيل الاشتراك مباشرة.',
};

// slug, platform, title, delivery, time, badge, featured, offerDays, input [label, placeholder], about, features[], plans[[name, days, price, old]]
const PRODUCTS = [
  ['chatgpt-plus', 'chatgpt', 'ChatGPT Plus — ترقية على حسابك', 'upgrade', 'خلال 30 دقيقة', 'الأكثر مبيعاً', 1, 0,
    ['البريد الإلكتروني لحسابك في ChatGPT', 'example@gmail.com'],
    'اشتراك ChatGPT Plus يمنحك وصولاً أوسع لأحدث نماذج OpenAI مع حدود استخدام أعلى، وإنشاء الصور، وتحليل الملفات والبيانات، ووضع الصوت المتقدم.',
    ['وصول إلى أحدث نماذج GPT بحدود استخدام أعلى', 'إنشاء الصور وتحليل الملفات والجداول', 'البحث في الويب ووضع الصوت المتقدم', 'إنشاء GPTs مخصصة وتنظيم المشاريع', 'محادثاتك وإعداداتك تبقى كما هي'],
    [['شهر', 30, 12, 20], ['3 أشهر', 90, 34, 60]]],
  ['chatgpt-plus-ready-account', 'chatgpt', 'ChatGPT Plus — حساب جاهز', 'account', 'خلال ساعة', 'سعر اقتصادي', 0, 0, null,
    'حساب ChatGPT جديد مفعّل عليه اشتراك Plus جاهز للاستخدام فوراً، مناسب لمن يريد البدء مباشرة دون ربط بحسابه الحالي.',
    ['حساب جديد مفعّل باشتراك Plus', 'تسليم البريد وكلمة المرور داخل صفحة الطلب', 'إمكانية تغيير كلمة المرور بعد الاستلام', 'دعم فني طوال مدة الاشتراك'],
    [['شهر', 30, 9, 20]]],
  ['claude-pro', 'claude', 'Claude Pro — ترقية على حسابك', 'upgrade', 'خلال 30 دقيقة', 'جديد', 1, 0,
    ['البريد الإلكتروني لحسابك في Claude', 'example@gmail.com'],
    'Claude Pro من Anthropic مساعدك الذكي للكتابة والبرمجة وتحليل المستندات الطويلة، مع حدود استخدام أعلى بكثير من الخطة المجانية.',
    ['حدود استخدام أعلى بعدة أضعاف', 'الوصول إلى أحدث نماذج Claude', 'المشاريع (Projects) لتنظيم ملفاتك ومحادثاتك', 'ممتاز للبرمجة والكتابة وتحليل الملفات الطويلة'],
    [['شهر', 30, 14, 20], ['3 أشهر', 90, 40, 60]]],
  ['google-ai-pro-12-months', 'gemini', 'Google AI Pro (Gemini) — سنة كاملة', 'link', 'خلال 15 دقيقة', 'عرض محدود', 1, 6,
    ['بريد حساب Google (Gmail) المراد تفعيله', 'example@gmail.com'],
    'اشتراك Google AI Pro لمدة سنة كاملة على حساب Google الخاص بك: Gemini بقدرات متقدمة مع مساحة تخزين سحابية كبيرة ومزايا الذكاء الاصطناعي داخل تطبيقات Google.',
    ['Gemini بقدرات متقدمة وحدود أعلى', 'مساحة 2TB لـ Drive وGmail والصور', 'Gemini داخل Gmail وDocs وتطبيقات Google', 'NotebookLM بحدود استخدام أعلى', 'مشاركة المساحة مع أفراد العائلة'],
    [['12 شهراً', 365, 25, 240]]],
  ['perplexity-pro-1-year', 'perplexity', 'Perplexity Pro — سنة كاملة', 'code', 'خلال ساعة', null, 0, 0,
    ['البريد الإلكتروني لحسابك في Perplexity', 'example@gmail.com'],
    'محرك بحث ذكي يجيبك بمصادر موثّقة، مع إمكانية اختيار أقوى النماذج ورفع الملفات وتحليلها.',
    ['بحث احترافي بحدود استخدام مرتفعة', 'اختيار النموذج المفضل لديك', 'رفع الملفات والصور وتحليلها', 'إجابات مدعومة بالمصادر'],
    [['سنة', 365, 18, 200]]],
  ['cursor-pro', 'cursor', 'Cursor Pro — محرر الأكواد الذكي', 'upgrade', 'خلال ساعة', null, 0, 0,
    ['البريد الإلكتروني لحسابك في Cursor', 'example@gmail.com'],
    'محرر أكواد مبني على الذكاء الاصطناعي يساعدك على كتابة الكود وفهمه وتعديله بسرعة كبيرة.',
    ['إكمال تلقائي ذكي للأكواد', 'وكيل برمجي ينفّذ المهام داخل مشروعك', 'حدود استخدام أعلى للنماذج المتقدمة', 'يدعم جميع لغات البرمجة الشائعة'],
    [['شهر', 30, 14, 20]]],
  ['midjourney-standard', 'midjourney', 'Midjourney Standard — توليد الصور', 'upgrade', 'خلال ساعتين', null, 0, 0,
    ['البريد أو اسم المستخدم المرتبط بحسابك في Midjourney', 'username'],
    'أقوى أدوات توليد الصور الفنية بالذكاء الاصطناعي لصنّاع المحتوى والمصممين.',
    ['توليد صور بجودة فنية عالية', 'وضع Relax غير محدود', 'استخدام تجاري للصور', 'أدوات التعديل والتكبير'],
    [['شهر', 30, 22, 30]]],
  ['elevenlabs-creator', 'elevenlabs', 'ElevenLabs Creator — تحويل النص إلى صوت', 'upgrade', 'خلال ساعة', null, 0, 0,
    ['البريد الإلكتروني لحسابك في ElevenLabs', 'example@gmail.com'],
    'أصوات واقعية بالذكاء الاصطناعي بعدة لغات منها العربية، مثالية للفيديوهات والبودكاست والإعلانات.',
    ['أصوات طبيعية بالعربية والإنجليزية', 'استنساخ الصوت الاحترافي', 'رصيد أحرف شهري أكبر', 'ترخيص استخدام تجاري'],
    [['شهر', 30, 15, 22]]],
  ['canva-pro', 'canva', 'Canva Pro — عضوية فريق', 'invite', 'خلال 15 دقيقة', 'الأكثر مبيعاً', 1, 4,
    ['البريد الإلكتروني لحسابك في Canva', 'example@gmail.com'],
    'افتح جميع مزايا Canva Pro: ملايين العناصر والصور والقوالب المميزة، وإزالة الخلفيات، وأدوات Magic Studio بالذكاء الاصطناعي.',
    ['أكثر من 100 مليون صورة وعنصر وقالب مميز', 'إزالة الخلفية بنقرة واحدة', 'تغيير مقاس التصاميم Magic Resize', 'أدوات Magic Studio بالذكاء الاصطناعي', 'مجموعة الهوية البصرية والخطوط الخاصة'],
    [['شهر', 30, 2.5, 5], ['6 أشهر', 180, 9, 30], ['سنة', 365, 15, 120]]],
  ['capcut-pro', 'capcut', 'CapCut Pro — مونتاج احترافي', 'upgrade', 'خلال 30 دقيقة', 'رائج', 1, 0,
    ['البريد أو رقم الهاتف المسجّل في CapCut', 'example@gmail.com'],
    'حرّر فيديوهاتك باحترافية مع جميع مزايا CapCut Pro على الجوال والكمبيوتر: مؤثرات وانتقالات حصرية وأدوات ذكاء اصطناعي وتصدير بجودة عالية.',
    ['جميع المؤثرات والفلاتر والانتقالات المميزة', 'إزالة الخلفية والترجمة التلقائية للفيديو', 'تصدير حتى جودة 4K', 'مساحة سحابية لمشاريعك', 'يعمل على الجوال والكمبيوتر'],
    [['شهر', 30, 6, 10], ['سنة', 365, 45, 90]]],
  ['adobe-creative-cloud-all-apps', 'adobe', 'Adobe Creative Cloud — جميع التطبيقات', 'invite', 'خلال ساعتين', null, 1, 0,
    ['البريد الإلكتروني لحسابك في Adobe', 'example@gmail.com'],
    'أكثر من 20 تطبيقاً من Adobe مثل Photoshop وIllustrator وPremiere Pro وAfter Effects مع مزايا Firefly للذكاء الاصطناعي.',
    ['Photoshop وIllustrator وInDesign', 'Premiere Pro وAfter Effects', 'رصيد Firefly للذكاء الاصطناعي', 'مساحة تخزين سحابية'],
    [['شهر', 30, 15, 60], ['3 أشهر', 90, 40, 180]]],
  ['freepik-premium', 'freepik', 'Freepik Premium', 'upgrade', 'خلال ساعة', null, 0, 0,
    ['البريد الإلكتروني لحسابك في Freepik', 'example@gmail.com'],
    'تحميل غير محدود تقريباً من ملايين الصور والفيكتورات والقوالب المميزة بترخيص تجاري.',
    ['ملايين الموارد المميزة', 'تحميل بدون إسناد', 'ترخيص استخدام تجاري', 'أدوات الذكاء الاصطناعي من Freepik'],
    [['شهر', 30, 6, 12]]],
  ['netflix-premium-4k', 'netflix', 'Netflix Premium — جودة 4K', 'account', 'خلال ساعة', null, 1, 0, null,
    'استمتع بمكتبة Netflix الضخمة من الأفلام والمسلسلات والوثائقيات بأعلى جودة على جميع أجهزتك.',
    ['جودة 4K Ultra HD وHDR', 'مشاهدة على التلفاز والجوال والكمبيوتر', 'محتوى عربي وعالمي متجدد', 'تحميل الحلقات للمشاهدة دون اتصال'],
    [['شهر', 30, 6, 10], ['3 أشهر', 90, 16, 30]]],
  ['shahid-vip', 'shahid', 'Shahid VIP', 'account', 'خلال ساعة', null, 1, 0, null,
    'تابع أقوى المسلسلات والبرامج العربية الحصرية قبل عرضها، بدون إعلانات وبجودة عالية.',
    ['مسلسلات وبرامج عربية حصرية', 'مشاهدة بدون إعلانات', 'بث مباشر لقنوات MBC', 'على جميع الأجهزة'],
    [['شهر', 30, 4, 6], ['سنة', 365, 35, 60]]],
  ['youtube-premium', 'youtube', 'YouTube Premium', 'invite', 'خلال ساعة', null, 1, 0,
    ['بريد Gmail لحسابك على YouTube', 'example@gmail.com'],
    'يوتيوب بدون إعلانات مع التشغيل في الخلفية وتنزيل الفيديوهات، ومعه YouTube Music Premium.',
    ['فيديوهات بدون إعلانات', 'التشغيل في الخلفية وعند قفل الشاشة', 'تنزيل الفيديوهات للمشاهدة دون إنترنت', 'YouTube Music Premium مشمول'],
    [['شهر', 30, 3, 6], ['سنة', 365, 28, 72]]],
  ['spotify-premium', 'spotify', 'Spotify Premium', 'upgrade', 'خلال ساعة', null, 1, 0,
    ['البريد الإلكتروني لحسابك في Spotify', 'example@gmail.com'],
    'استمع لملايين الأغاني والبودكاست بدون إعلانات وبأعلى جودة صوت، مع إمكانية التحميل والاستماع دون اتصال.',
    ['بدون إعلانات', 'تحميل الأغاني والاستماع دون إنترنت', 'تخطي غير محدود للأغاني', 'جودة صوت عالية'],
    [['شهر', 30, 3, 6], ['6 أشهر', 180, 16, 36], ['سنة', 365, 30, 72]]],
  ['anghami-plus', 'anghami', 'Anghami Plus', 'account', 'خلال ساعة', null, 0, 0, null,
    'أكبر مكتبة للموسيقى العربية والعالمية بدون إعلانات مع التحميل والاستماع دون اتصال.',
    ['موسيقى عربية وعالمية بدون إعلانات', 'تحميل غير محدود', 'كلمات الأغاني', 'جودة صوت عالية'],
    [['سنة', 365, 20, 40]]],
  ['microsoft-365-family', 'microsoft-365', 'Microsoft 365 Family — سنة', 'invite', 'خلال ساعتين', null, 1, 0,
    ['بريد حساب Microsoft (Outlook / Hotmail)', 'example@outlook.com'],
    'تطبيقات Office الأصلية بأحدث الإصدارات مع مساحة تخزين سحابية كبيرة على OneDrive.',
    ['Word وExcel وPowerPoint وOutlook', 'مساحة 1TB على OneDrive', 'يعمل على Windows وMac والجوال', 'تحديثات مستمرة ومزايا الذكاء الاصطناعي المتاحة في الخطة'],
    [['سنة', 365, 25, 100]]],
  ['notion-plus', 'notion', 'Notion Plus — سنة', 'upgrade', 'خلال ساعتين', null, 0, 0,
    ['البريد الإلكتروني لمساحة Notion الخاصة بك', 'example@gmail.com'],
    'نظّم ملاحظاتك ومشاريعك وفريقك في مساحة عمل واحدة مع مزايا Plus غير المحدودة.',
    ['صفحات وكتل غير محدودة', 'رفع ملفات بلا حدود', 'سجل تعديلات أطول', 'مشاركة مع الضيوف'],
    [['سنة', 365, 40, 120]]],
  ['grammarly-pro', 'grammarly', 'Grammarly Pro', 'account', 'خلال ساعة', null, 0, 0, null,
    'مساعد الكتابة الأشهر لتصحيح القواعد وتحسين الأسلوب وإعادة الصياغة باللغة الإنجليزية.',
    ['تصحيح متقدم للقواعد والإملاء', 'إعادة صياغة الجمل وتحسين الأسلوب', 'كشف الانتحال', 'يعمل في المتصفح وWord'],
    [['شهر', 30, 7, 30], ['سنة', 365, 50, 144]]],
  ['linkedin-premium-career', 'linkedin', 'LinkedIn Premium Career', 'link', 'خلال ساعتين', null, 0, 0,
    ['البريد الإلكتروني لحسابك في LinkedIn', 'example@gmail.com'],
    'عزّز فرصك المهنية مع رسائل InMail ومعرفة من شاهد ملفك ومقارنتك بالمتقدمين للوظائف.',
    ['رسائل InMail لمسؤولي التوظيف', 'معرفة من شاهد ملفك الشخصي', 'مقارنة نفسك بالمتقدمين', 'دورات LinkedIn Learning'],
    [['3 أشهر', 90, 25, 90]]],
  ['duolingo-super', 'duolingo', 'Duolingo Super — سنة', 'invite', 'خلال ساعة', null, 1, 0,
    ['اسم المستخدم أو البريد في Duolingo', 'username'],
    'تعلّم اللغات بلا انقطاع: بدون إعلانات، قلوب غير محدودة، ومراجعة الأخطاء.',
    ['بدون إعلانات', 'قلوب غير محدودة', 'مراجعة الأخطاء والتمارين المخصصة', 'تحديات أسبوعية'],
    [['سنة', 365, 15, 85]]],
  ['coursera-plus', 'coursera', 'Coursera Plus — سنة', 'upgrade', 'خلال ساعتين', null, 0, 0,
    ['البريد الإلكتروني لحسابك في Coursera', 'example@gmail.com'],
    'وصول إلى آلاف الدورات والشهادات المهنية من أفضل الجامعات والشركات العالمية.',
    ['أكثر من 7000 دورة وبرنامج', 'شهادات مهنية من Google وMeta وIBM', 'شهادات إتمام قابلة للمشاركة', 'تعلّم بالسرعة التي تناسبك'],
    [['سنة', 365, 70, 399]]],
  ['nordvpn-1-year', 'nordvpn', 'NordVPN — حماية وخصوصية', 'account', 'خلال ساعة', null, 0, 0, null,
    'تصفّح بأمان وخصوصية تامة مع آلاف الخوادم حول العالم وسرعات عالية.',
    ['آلاف الخوادم في عشرات الدول', 'تشفير قوي وحماية من التتبع', 'حتى 10 أجهزة', 'حظر الإعلانات والمواقع الضارة'],
    [['سنة', 365, 20, 60]]],
  ['xbox-game-pass-ultimate', 'xbox', 'Xbox Game Pass Ultimate', 'code', 'خلال 30 دقيقة', null, 0, 0, null,
    'مئات الألعاب على Xbox والكمبيوتر والسحابة مع اللعب الجماعي أونلاين.',
    ['مئات الألعاب عالية الجودة', 'ألعاب جديدة يوم إطلاقها', 'اللعب السحابي', 'اللعب الجماعي أونلاين'],
    [['شهر', 30, 13, 20]]],
  ['playstation-plus-essential', 'playstation', 'PlayStation Plus Essential', 'code', 'خلال 30 دقيقة', null, 0, 0, null,
    'العب أونلاين مع أصدقائك واحصل على ألعاب شهرية مجانية وخصومات حصرية.',
    ['اللعب الجماعي أونلاين', 'ألعاب شهرية مجانية', 'خصومات حصرية في المتجر', 'تخزين سحابي لحفظ الألعاب'],
    [['3 أشهر', 90, 25, 30]]],
  ['discord-nitro', 'discord', 'Discord Nitro', 'link', 'خلال ساعة', null, 0, 0,
    ['اسم المستخدم في Discord', 'username'],
    'ارفع مستوى تجربتك على Discord مع رفع ملفات أكبر وبث بجودة عالية وتعزيزات للسيرفرات.',
    ['رفع ملفات بحجم أكبر', 'بث بجودة HD', 'تعزيزان للسيرفر', 'إيموجي وملصقات مخصصة في كل مكان'],
    [['شهر', 30, 6, 10], ['سنة', 365, 55, 100]]],
];

const ACTIVATION_STEPS = {
  upgrade: ['اختر الباقة وأدخل بريد حسابك أثناء الطلب.', 'حوّل المبلغ وأرفق صورة الإيصال.', 'بعد تأكيد الدفع نفعّل الاشتراك على حسابك ونبلغك فوراً.', 'سجّل الدخول إلى حسابك واستمتع بالمزايا.'],
  account: ['اختر الباقة وأكمل الطلب.', 'حوّل المبلغ وأرفق صورة الإيصال.', 'بعد تأكيد الدفع تظهر بيانات الحساب في صفحة طلبك.', 'سجّل الدخول بالبيانات المستلمة وابدأ الاستخدام.'],
  invite: ['أدخل بريدك الإلكتروني أثناء الطلب.', 'حوّل المبلغ وأرفق صورة الإيصال.', 'بعد تأكيد الدفع تصلك دعوة الانضمام على بريدك.', 'اقبل الدعوة لتفعيل المزايا مباشرة.'],
  code: ['اختر الباقة وأكمل الطلب.', 'حوّل المبلغ وأرفق صورة الإيصال.', 'بعد تأكيد الدفع يظهر كود التفعيل في صفحة طلبك.', 'استرد الكود من حسابك في المنصة.'],
  link: ['أدخل البيانات المطلوبة أثناء الطلب.', 'حوّل المبلغ وأرفق صورة الإيصال.', 'بعد تأكيد الدفع يصلك رابط التفعيل في صفحة طلبك.', 'افتح الرابط وأنت مسجّل دخولك لتفعيل الاشتراك.'],
};

/**
 * Creates the admin account from ADMIN_EMAIL / ADMIN_PASSWORD. Runs on every start but never
 * promotes an existing account: anyone can register an e-mail, so promotion is left to an admin
 * in the dashboard. The built-in fallback address is only used for a brand-new database.
 */
async function ensureAdmin() {
  const firstAdmin = get("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const email = config.admin.email || (firstAdmin ? '' : 'admin@mts.store');
  if (!email) return firstAdmin.id;

  const existing = get('SELECT id, role, password_hash, last_login_at FROM users WHERE email = ?', email);
  if (existing) {
    if (existing.role !== 'admin') {
      if (!config.admin.resetPassword) {
        console.warn(`[seed] ADMIN_EMAIL (${email}) belongs to an existing non-admin account; it was NOT promoted. Grant the role from /seller/users or set ADMIN_RESET_PASSWORD.`);
      }
    } else if (
      config.admin.password &&
      !existing.last_login_at &&
      !(existing.password_hash && (await verifyPassword(config.admin.password, existing.password_hash)))
    ) {
      // Created before ADMIN_PASSWORD was set (random password) and never used: adopt the configured password.
      run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(config.admin.password), existing.id);
      console.log(`[seed] ADMIN_PASSWORD applied to the admin account ${email} (it had never signed in).`);
    }
    return firstAdmin ? firstAdmin.id : null;
  }
  // An admin already exists: only add another one when the operator supplied its password.
  if (firstAdmin && !config.admin.password && !config.admin.resetPassword) {
    console.warn(`[seed] ADMIN_EMAIL (${email}) has no account and ADMIN_PASSWORD is empty; no new admin was created.`);
    return firstAdmin.id;
  }
  let password = config.admin.password || config.admin.resetPassword;
  let generated = false;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url');
    generated = true;
  }
  const wa = fromInternational(config.admin.whatsapp || settings.get('whatsapp_number'));
  const waFields = wa.error ? {} : wa;
  const info = run(
    `INSERT INTO users (name, email, password_hash, role, store_name, wa_country, wa_dial, wa_number, wa_e164)
     VALUES (?, ?, ?, 'admin', ?, ?, ?, ?, ?)`,
    config.admin.name,
    email,
    await hashPassword(password),
    'MTS Store',
    waFields.country,
    waFields.dial,
    waFields.number,
    waFields.e164,
  );
  if (generated) {
    const file = path.join(config.dataDir, 'admin-initial-password.txt');
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, `Admin email: ${email}\nAdmin password: ${password}\n`, { mode: 0o600 });
    console.log(`[seed] Admin account created (${email}). Initial password saved to ${file}`);
    if (config.onRailway) console.log('[seed] On Railway: set the ADMIN_RESET_PASSWORD variable to choose the admin password, then remove it.');
  } else {
    console.log(`[seed] Admin account created (${email}).`);
  }
  return Number(info.lastInsertRowid);
}

function seedCurrenciesAndPayments() {
  if (!get('SELECT code FROM currencies LIMIT 1')) {
    for (const c of CURRENCIES) {
      run('INSERT INTO currencies (code, name, symbol, rate, decimals, is_base, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)', c.code, c.name, c.symbol, c.rate, c.decimals, c.is_base, c.sort_order);
    }
  }
  if (!get('SELECT id FROM payment_methods LIMIT 1')) {
    PAYMENT_METHODS.forEach((m, i) => {
      run(
        `INSERT INTO payment_methods (name, subtitle, type, icon, color, currency_code, details, instructions, sender_account_label, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.name,
        m.subtitle,
        m.type,
        m.icon,
        m.color,
        m.currency_code,
        JSON.stringify(m.details),
        m.instructions.join('\n'),
        m.sender_account_label,
        i + 1,
      );
    });
  }
}

function seedCatalog(sellerId) {
  if (get('SELECT id FROM categories LIMIT 1')) return;
  const catIds = {};
  CATEGORIES.forEach(([slug, name, icon, description], i) => {
    catIds[slug] = Number(run('INSERT INTO categories (name, slug, icon, description, sort_order) VALUES (?, ?, ?, ?, ?)', name, slug, icon, description, i + 1).lastInsertRowid);
  });
  const platIds = {};
  PLATFORMS.forEach(([slug, name, cat, c1, c2, featured], i) => {
    platIds[slug] = {
      id: Number(
        run(
          'INSERT INTO platforms (name, slug, category_id, logo_url, color1, color2, is_featured, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          name,
          slug,
          catIds[cat],
          `/static/img/platforms/${slug}.svg`,
          c1,
          c2,
          featured,
          i + 1,
        ).lastInsertRowid,
      ),
      cat,
    };
  });
  // Insert oldest first so "newest" ordering follows the list order.
  PRODUCTS.forEach(([slug, plat, title, delivery, time, badge, featured, offerDays, input, about, features, plans], i) => {
    const created = toSql(new Date(Date.now() - (PRODUCTS.length - i) * 3600000));
    const description = `${about}\n\n${DELIVERY_SENTENCE[delivery]} يمكنك متابعة حالة طلبك لحظة بلحظة من لوحة المشتري، وتصلك بيانات الاشتراك داخل صفحة الطلب مع إمكانية نسخها بسهولة.`;
    const pid = Number(
      run(
        `INSERT INTO products (seller_id, category_id, platform_id, title, slug, short_description, description, features, activation_steps,
           badge, delivery_method, delivery_time, warranty, region_note, buyer_input_label, buyer_input_placeholder, offer_ends_at,
           is_featured, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sellerId,
        catIds[platIds[plat].cat],
        platIds[plat].id,
        title,
        slug,
        about,
        description,
        JSON.stringify(features),
        JSON.stringify(ACTIVATION_STEPS[delivery]),
        badge,
        delivery,
        time,
        'ضمان طوال مدة الاشتراك',
        'يعمل في جميع الدول',
        input ? input[0] : null,
        input ? input[1] : null,
        offerDays ? days(offerDays) : null,
        featured,
        created,
        created,
      ).lastInsertRowid,
    );
    plans.forEach(([name, d, price, old], j) => {
      run('INSERT INTO product_plans (product_id, name, duration_days, price, old_price, sort_order) VALUES (?, ?, ?, ?, ?, ?)', pid, name, d, usd(price), old ? usd(old) : null, j + 1);
    });
  });
}

// ADMIN_RESET_PASSWORD gives the admin a new password at startup (for hosts where the initial password file
// cannot be read, or when the password is forgotten). Existing sessions of that account are signed out.
async function applyAdminPasswordReset() {
  const password = config.admin.resetPassword;
  if (!password) return;
  if (password.length < 8 || password.length > 128) {
    console.warn('[seed] ADMIN_RESET_PASSWORD must be 8–128 characters; the password was NOT changed.');
    return;
  }
  // The ADMIN_EMAIL account wins (promoted to admin if it was a regular account); otherwise the first admin.
  const admin =
    (config.admin.email && get('SELECT id, email, role FROM users WHERE email = ?', config.admin.email)) ||
    get("SELECT id, email, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  if (!admin) return;
  run(
    "UPDATE users SET password_hash = ?, role = 'admin', store_name = COALESCE(store_name, 'MTS Store'), is_blocked = 0 WHERE id = ?",
    await hashPassword(password),
    admin.id,
  );
  endAllSessions(admin.id);
  const promoted = admin.role !== 'admin' ? ' and the account is now an admin' : '';
  console.warn(`[seed] Admin password for ${admin.email} was reset from ADMIN_RESET_PASSWORD${promoted}. Remove this variable now.`);
}

// The agency's own services (not demo data), added once; the admin edits them afterwards.
function seedServices() {
  if (get('SELECT id FROM services LIMIT 1')) return;
  SERVICES.forEach((s, i) => {
    run('INSERT INTO services (name, slug, icon, summary, brief_hint, sort_order) VALUES (?, ?, ?, ?, ?, ?)', s.title, s.slug, s.icon, s.text, s.hint, i + 1);
  });
}

async function seed() {
  seedCurrenciesAndPayments();
  seedServices();
  const adminId = await ensureAdmin();
  await applyAdminPasswordReset();
  if (config.seedDemo) {
    const sellerId = adminId || (get("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1") || {}).id;
    if (sellerId) tx(() => seedCatalog(sellerId));
  }
}

module.exports = { seed };
