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
      { label: 'البنك', value: 'بنك فلسطين (Bank of Palestine)', copy: false },
      { label: 'رقم الحساب', value: '3056855', copy: true },
      { label: 'اسم صاحب الحساب', value: 'قصي خضير', copy: true },
      { label: 'رقم الآيبان (IBAN)', value: IBAN, copy: true },
    ],
    instructions: [
      'حول المبلغ المطلوب إلى رقم الحساب الموضح عبر تطبيق بنك فلسطين أو من أي فرع.',
      'عند التحويل من بنك آخر استخدم رقم الآيبان (IBAN).',
      'التقط صورة واضحة لإيصال التحويل تظهر المبلغ والتاريخ واسم المستفيد.',
    ],
    sender_account_label: 'رقم الحساب الذي حولت منه',
  },
  {
    name: 'جوال باي (Jawwal Pay)',
    subtitle: 'من المحفظة إلى الآيبان عبر خدمة iBURAQ',
    type: 'wallet',
    icon: 'fa-solid fa-mobile-screen-button',
    color: '#16A34A',
    currency_code: 'ILS',
    details: [
      { label: 'طريقة التحويل', value: 'نظام الدفع الفوري iBURAQ، تحويل إلى حساب بنكي', copy: false },
      { label: 'رقم الآيبان (IBAN)', value: IBAN, copy: true },
      { label: 'اسم المستفيد', value: 'قصي خضير', copy: true },
      { label: 'البنك المستفيد', value: 'بنك فلسطين', copy: false },
    ],
    instructions: [
      'افتح تطبيق جوال باي واختر التحويل إلى حساب بنكي عبر خدمة الدفع الفوري iBURAQ.',
      'أدخل رقم الآيبان الموضح وتأكد أن اسم المستفيد: قصي خضير.',
      'أرسل المبلغ المطلوب ثم التقط صورة لشاشة نجاح العملية.',
    ],
    sender_account_label: 'رقم محفظة جوال باي التي حولت منها',
  },
  {
    name: 'بال باي (PalPay)',
    subtitle: 'من المحفظة إلى الآيبان عبر خدمة iBURAQ',
    type: 'wallet',
    icon: 'fa-solid fa-wallet',
    color: '#2563EB',
    currency_code: 'ILS',
    details: [
      { label: 'طريقة التحويل', value: 'نظام الدفع الفوري iBURAQ، تحويل إلى حساب بنكي', copy: false },
      { label: 'رقم الآيبان (IBAN)', value: IBAN, copy: true },
      { label: 'اسم المستفيد', value: 'قصي خضير', copy: true },
      { label: 'البنك المستفيد', value: 'بنك فلسطين', copy: false },
    ],
    instructions: [
      'افتح تطبيق بال باي واختر التحويل إلى حساب بنكي عبر خدمة الدفع الفوري iBURAQ.',
      'أدخل رقم الآيبان الموضح وتأكد أن اسم المستفيد: قصي خضير.',
      'أرسل المبلغ المطلوب ثم التقط صورة لشاشة نجاح العملية.',
    ],
    sender_account_label: 'رقم محفظة بال باي التي حولت منها',
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
      'حول المبلغ المطلوب إلى رقم فودافون كاش الموضح من محفظتك أو من أي منفذ يقدم الخدمة.',
      'تأكد قبل التأكيد أن اسم المستلم الظاهر: شيماء ... ز ... ق',
      'التقط صورة لرسالة أو إيصال التحويل وأرفقها في النموذج.',
    ],
    sender_account_label: 'رقم المحفظة الذي حولت منه',
  },
];

const CATEGORIES = [
  ['ai', 'الذكاء الاصطناعي', 'fa-solid fa-robot', 'أدوات الذكاء الاصطناعي للكتابة والبرمجة والبحث وتوليد الصور والصوت.'],
  ['design', 'التصميم والمونتاج', 'fa-solid fa-palette', 'برامج التصميم الجرافيكي ومونتاج الفيديو والمحتوى الإبداعي.'],
  ['streaming', 'الأفلام والمسلسلات', 'fa-solid fa-tv', 'منصات البث والترفيه بجودة عالية وبدون إعلانات.'],
  ['music', 'الموسيقى والصوتيات', 'fa-solid fa-headphones', 'استمع لملايين الأغاني والبودكاست بدون إعلانات.'],
  ['productivity', 'الإنتاجية والعمل', 'fa-solid fa-briefcase', 'أدوات العمل والتنظيم والتواصل المهني.'],
  ['education', 'التعليم واللغات', 'fa-solid fa-graduation-cap', 'تعلم اللغات والمهارات والدورات المعتمدة.'],
  ['security', 'الحماية و VPN', 'fa-solid fa-shield-halved', 'تصفح آمن وخصوصية كاملة على جميع أجهزتك.'],
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
  upgrade: 'نفعل الاشتراك على حسابك نفسه، فلا تحتاج حسابا جديدا ولا بطاقة ائتمان، ونكتب لك في صفحة طلبك عندما ننتهي.',
  account: 'نسلمك حسابا جاهزا مفعلا عليه الاشتراك، وتجد البريد وكلمة المرور وتعليمات الاستخدام في صفحة طلبك.',
  invite: 'نرسل دعوة إلى بريدك الإلكتروني، تقبلها فتعمل المزايا على حسابك مباشرة.',
  code: 'نرسل لك كود تفعيل أصليا مع طريقة استرداده، ويظهر في صفحة طلبك.',
  link: 'نرسل لك رابط تفعيل خاصا بك، تفتحه وأنت مسجل في حسابك فيتفعل الاشتراك.',
};
// Closes every product description, after the delivery sentence.
const DESCRIPTION_TAIL = 'تتابع طلبك من حسابك، وتنسخ البيانات من صفحة الطلب بضغطة.';

// slug, platform, title, delivery, time, badge, featured, offerDays, input [label, placeholder], about, features[], plans[[name, days, price, old]]
const PRODUCTS = [
  ['chatgpt-plus', 'chatgpt', 'ChatGPT Plus — ترقية على حسابك', 'upgrade', 'خلال 30 دقيقة', 'الأكثر مبيعا', 1, 0,
    ['البريد الإلكتروني لحسابك في ChatGPT', 'example@gmail.com'],
    'اشتراك Plus على حسابك نفسه في ChatGPT، فتبقى محادثاتك وGPTs التي صنعتها كما هي. تحصل على حدود أعلى بكثير لأحدث نماذج OpenAI ونماذج التفكير، وتنشئ الصور، وترفع ملفاتك وجداولك ليحللها لك.',
    ['حدود أعلى لأحدث نماذج OpenAI ونماذج التفكير', 'إنشاء الصور وتعديلها داخل المحادثة', 'تحليل الملفات والجداول وملفات PDF', 'الوضع الصوتي المتقدم والبحث في الويب', 'البحث المعمق (Deep Research) بعدد مرات شهري محدد', 'المشاريع (Projects) وإنشاء GPTs خاصة بك'],
    [['شهر', 30, 12, 20], ['3 أشهر', 90, 34, 60]]],
  ['chatgpt-plus-ready-account', 'chatgpt', 'ChatGPT Plus — حساب جاهز', 'account', 'خلال ساعة', 'سعر اقتصادي', 0, 0, null,
    'حساب ChatGPT جديد مفعل عليه Plus، تستلم بريده وكلمة مروره وتبدأ في الحال. يناسبك إن كنت لا تريد ربط الاشتراك بحسابك الحالي.',
    ['حساب جديد مفعل عليه ChatGPT Plus', 'البريد وكلمة المرور في صفحة طلبك', 'تستطيع تغيير كلمة المرور بعد الاستلام', 'دعم على واتساب طوال مدة الاشتراك'],
    [['شهر', 30, 9, 20]]],
  ['claude-pro', 'claude', 'Claude Pro — ترقية على حسابك', 'upgrade', 'خلال 30 دقيقة', 'جديد', 1, 0,
    ['البريد الإلكتروني لحسابك في Claude', 'example@gmail.com'],
    'Claude Pro على حسابك في Claude: استخدام أكثر بخمسة أضعاف على الأقل من الخطة المجانية، ومعه Claude Code للبرمجة من الطرفية ومحرر الكود. يفيدك في الكتابة الطويلة وتحليل الملفات الكبيرة والعمل على مشاريعك البرمجية.',
    ['استخدام أكثر بخمسة أضعاف على الأقل من الخطة المجانية', 'Claude Code للبرمجة من الطرفية ومحرر الكود', 'المشاريع (Projects) لتنظيم ملفاتك ومحادثاتك', 'ميزة البحث (Research) في الويب ومصادرك', 'الوصول إلى أحدث نماذج Claude'],
    [['شهر', 30, 14, 20], ['3 أشهر', 90, 40, 60]]],
  ['google-ai-pro-12-months', 'gemini', 'Google AI Pro (Gemini) — سنة كاملة', 'link', 'خلال 15 دقيقة', 'عرض محدود', 1, 6,
    ['بريد حساب Google (Gmail) المراد تفعيله', 'example@gmail.com'],
    'سنة كاملة من Google AI Pro على حساب Google الخاص بك: حدود أعلى في تطبيق Gemini، وDeep Research للبحث الطويل، وGemini داخل Gmail وDocs، ومساحة تخزين ضخمة لـ Drive وGmail والصور تشاركها مع عائلتك.',
    ['حدود استخدام أعلى في تطبيق Gemini', 'Deep Research لتقارير بحثية مفصلة', 'Gemini داخل Gmail وDocs وتطبيقات Google', 'مساحة تخزين ضخمة لـ Drive وGmail والصور', 'مشاركة الخطة مع حتى 5 من أفراد عائلتك'],
    [['12 شهرا', 365, 25, 240]]],
  ['perplexity-pro-1-year', 'perplexity', 'Perplexity Pro — سنة كاملة', 'code', 'خلال ساعة', null, 0, 0,
    ['البريد الإلكتروني لحسابك في Perplexity', 'example@gmail.com'],
    'محرك بحث يكتب لك الإجابة ويضع بجانبها روابط مصادرها، فتتحقق بنفسك. ومع Pro تختار النموذج الذي تريده من نماذج أكبر الشركات، وترفع ملفاتك ليقرأها ويجيبك منها.',
    ['بحث Pro بحدود استخدام أعلى', 'اختيار النموذج المفضل لديك', 'رفع ملفات PDF والمستندات والصور وتحليلها', 'إجابات تذكر مصادرها'],
    [['سنة', 365, 18, 200]]],
  ['cursor-pro', 'cursor', 'Cursor Pro — محرر الأكواد الذكي', 'upgrade', 'خلال ساعة', null, 0, 0,
    ['البريد الإلكتروني لحسابك في Cursor', 'example@gmail.com'],
    'محرر أكواد مبني على VS Code، يكمل كودك ويفهم مشروعك كله. مع Pro يصبح الإكمال التلقائي بلا حدود، وتحصل على حدود أعلى لوكيل البرمجة الذي ينفذ المهام داخل مشروعك.',
    ['إكمال تلقائي (Tab) بلا حدود', 'وكيل برمجة (Agent) بحدود أعلى ينفذ المهام داخل مشروعك', 'يفهم مشروعك كاملا ويعدل عدة ملفات معا', 'إضافاتك واختصاراتك من VS Code تعمل كما هي'],
    [['شهر', 30, 14, 20]]],
  ['midjourney-standard', 'midjourney', 'Midjourney Standard — توليد الصور', 'upgrade', 'خلال ساعتين', null, 0, 0,
    ['البريد أو اسم المستخدم المرتبط بحسابك في Midjourney', 'username'],
    'خطة Standard في Midjourney: 15 ساعة شهريا في الوضع السريع، وصور بلا حدود في وضع Relax. وتستخدم الصور تجاريا ما دامت إيرادات شركتك السنوية أقل من مليون دولار، حسب شروط Midjourney. صورك في هذه الخطة تظهر في معرض Midjourney العام.',
    ['15 ساعة شهريا في الوضع السريع', 'صور بلا حدود في وضع Relax', 'استخدام تجاري للصور حسب شروط Midjourney', 'أدوات التعديل والتكبير وتوليد الفيديو'],
    [['شهر', 30, 22, 30]]],
  ['elevenlabs-creator', 'elevenlabs', 'ElevenLabs Creator — تحويل النص إلى صوت', 'upgrade', 'خلال ساعة', null, 0, 0,
    ['البريد الإلكتروني لحسابك في ElevenLabs', 'example@gmail.com'],
    'حول نصك إلى صوت طبيعي بعشرات اللغات منها العربية، أو استنسخ صوتك واجعله يقرأ نصوصك. يفيدك في فيديوهات يوتيوب والبودكاست والإعلانات، ومعه ترخيص تجاري.',
    ['أصوات طبيعية بالعربية والإنجليزية وعشرات اللغات', 'استنساخ صوتك بدقة عالية (Professional Voice Cloning)', 'رصيد شهري أكبر من الخطط الأقل', 'ترخيص استخدام تجاري'],
    [['شهر', 30, 15, 22]]],
  ['canva-pro', 'canva', 'Canva Pro — عضوية فريق', 'invite', 'خلال 15 دقيقة', 'الأكثر مبيعا', 1, 4,
    ['البريد الإلكتروني لحسابك في Canva', 'example@gmail.com'],
    'تنضم إلى فريق Canva Pro ببريدك، فتعمل المزايا على حسابك وتبقى تصاميمك فيه. تحصل على أكثر من 100 مليون صورة وعنصر وقالب مميز، وإزالة الخلفية بضغطة، وأدوات Magic Studio.',
    ['أكثر من 100 مليون صورة وفيديو وعنصر وقالب مميز', 'إزالة الخلفية بضغطة واحدة', 'تغيير مقاس التصميم لكل منصة (Magic Resize)', 'أدوات Magic Studio بالذكاء الاصطناعي', 'Brand Kit يحفظ ألوانك وخطوطك وشعارك'],
    [['شهر', 30, 2.5, 5], ['6 أشهر', 180, 9, 30], ['سنة', 365, 15, 120]]],
  ['capcut-pro', 'capcut', 'CapCut Pro — مونتاج الفيديو', 'upgrade', 'خلال 30 دقيقة', 'رائج', 1, 0,
    ['البريد أو رقم الهاتف المسجل في CapCut', 'example@gmail.com'],
    'كل مزايا CapCut Pro على حسابك، على الجوال والكمبيوتر والمتصفح: تصدير بدقة 4K بلا علامة مائية، وأدوات الذكاء الاصطناعي مثل الترجمة التلقائية وإزالة الخلفية، ومساحة سحابية تتزامن فيها مشاريعك بين أجهزتك.',
    ['تصدير بدقة 4K بدون علامة مائية', 'المؤثرات والفلاتر والانتقالات المدفوعة', 'ترجمة تلقائية وإزالة خلفية الفيديو', 'مساحة سحابية لمشاريعك تتزامن بين أجهزتك', 'يعمل على الجوال والكمبيوتر والمتصفح'],
    [['شهر', 30, 6, 10], ['سنة', 365, 45, 90]]],
  ['adobe-creative-cloud-all-apps', 'adobe', 'Adobe Creative Cloud — جميع التطبيقات', 'invite', 'خلال ساعتين', null, 1, 0,
    ['البريد الإلكتروني لحسابك في Adobe', 'example@gmail.com'],
    'أكثر من 20 تطبيقا من Adobe بدعوة إلى بريدك، منها Photoshop وIllustrator وPremiere Pro وAfter Effects، ومعها رصيد Firefly لتوليد الصور وتعديلها بالذكاء الاصطناعي.',
    ['Photoshop وIllustrator وInDesign وLightroom', 'Premiere Pro وAfter Effects وAudition', 'رصيد Firefly للذكاء الاصطناعي', 'خطوط Adobe Fonts ومساحة تخزين سحابية'],
    [['شهر', 30, 15, 60], ['3 أشهر', 90, 40, 180]]],
  ['freepik-premium', 'freepik', 'Freepik Premium', 'upgrade', 'خلال ساعة', null, 0, 0,
    ['البريد الإلكتروني لحسابك في Freepik', 'example@gmail.com'],
    'ملايين الصور والفيكتورات وملفات PSD والقوالب المميزة، تنزلها وتستخدمها في أعمالك وأعمال عملائك بترخيص تجاري، دون أن تذكر المصدر.',
    ['تحميل الملفات المميزة بحد يومي مرتفع', 'ترخيص استخدام تجاري', 'بدون الحاجة لذكر المصدر', 'رصيد شهري لأدوات الذكاء الاصطناعي من Freepik'],
    [['شهر', 30, 6, 12]]],
  ['netflix-premium-4k', 'netflix', 'Netflix Premium — جودة 4K', 'account', 'خلال ساعة', null, 1, 0, null,
    'حساب Netflix Premium جاهز: أفلام ومسلسلات ووثائقيات بدقة 4K وصورة HDR على التلفاز والجوال والكمبيوتر، مع محتوى عربي وعالمي يضاف باستمرار.',
    ['دقة 4K Ultra HD وصورة HDR', 'على التلفاز والجوال والكمبيوتر', 'محتوى عربي وعالمي يضاف باستمرار', 'تحميل الحلقات لتشاهدها دون إنترنت'],
    [['شهر', 30, 6, 10], ['3 أشهر', 90, 16, 30]]],
  ['shahid-vip', 'shahid', 'Shahid VIP', 'account', 'خلال ساعة', null, 1, 0, null,
    'حساب Shahid VIP جاهز: مسلسلات وبرامج عربية حصرية تشاهدها قبل عرضها على التلفزيون، بدون إعلانات، مع البث المباشر لقنوات MBC.',
    ['مسلسلات وبرامج عربية حصرية قبل عرضها على التلفزيون', 'مشاهدة بدون إعلانات', 'بث مباشر لقنوات MBC', 'على الجوال والتلفاز الذكي والكمبيوتر'],
    [['شهر', 30, 4, 6], ['سنة', 365, 35, 60]]],
  ['youtube-premium', 'youtube', 'YouTube Premium', 'invite', 'خلال ساعة', null, 1, 0,
    ['بريد Gmail لحسابك على YouTube', 'example@gmail.com'],
    'يوتيوب بلا إعلانات على حسابك في Gmail: الفيديو يكمل في الخلفية وأنت في تطبيق آخر أو مع قفل الشاشة، وتنزل الفيديوهات لتشاهدها دون إنترنت، ومعه YouTube Music Premium.',
    ['فيديوهات بدون إعلانات', 'التشغيل في الخلفية ومع قفل الشاشة', 'تنزيل الفيديوهات للمشاهدة دون إنترنت', 'YouTube Music Premium مشمول'],
    [['شهر', 30, 3, 6], ['سنة', 365, 28, 72]]],
  ['spotify-premium', 'spotify', 'Spotify Premium', 'upgrade', 'خلال ساعة', null, 1, 0,
    ['البريد الإلكتروني لحسابك في Spotify', 'example@gmail.com'],
    'Spotify Premium على حسابك نفسه، فتبقى قوائمك ومكتبتك كما هي: موسيقى وبودكاست بلا إعلانات، وتنزيل للاستماع دون إنترنت، وتخطي ما تشاء من الأغاني.',
    ['بدون إعلانات', 'تنزيل الأغاني والبودكاست للاستماع دون إنترنت', 'تخطي غير محدود وتشغيل الأغنية التي تختارها', 'جودة صوت أعلى'],
    [['شهر', 30, 3, 6], ['6 أشهر', 180, 16, 36], ['سنة', 365, 30, 72]]],
  ['anghami-plus', 'anghami', 'Anghami Plus', 'account', 'خلال ساعة', null, 0, 0, null,
    'حساب Anghami Plus جاهز: موسيقى عربية وعالمية بلا إعلانات، تنزلها وتسمعها دون إنترنت، مع كلمات الأغاني وجودة صوت أعلى.',
    ['موسيقى عربية وعالمية بدون إعلانات', 'تحميل غير محدود للاستماع دون إنترنت', 'كلمات الأغاني أثناء التشغيل', 'جودة صوت أعلى'],
    [['سنة', 365, 20, 40]]],
  ['microsoft-365-family', 'microsoft-365', 'Microsoft 365 Family — سنة', 'invite', 'خلال ساعتين', null, 1, 0,
    ['بريد حساب Microsoft (Outlook / Hotmail)', 'example@outlook.com'],
    'دعوة إلى خطة Microsoft 365 Family على حساب Microsoft الخاص بك: Word وExcel وPowerPoint وOutlook بأحدث إصدار على الكمبيوتر والجوال، ومساحة 1TB لك وحدك على OneDrive.',
    ['Word وExcel وPowerPoint وOutlook', 'مساحة 1TB خاصة بك على OneDrive', 'على Windows وMac والجوال', 'مزايا Copilot المتاحة في الخطة'],
    [['سنة', 365, 25, 100]]],
  ['notion-plus', 'notion', 'Notion Plus — سنة', 'upgrade', 'خلال ساعتين', null, 0, 0,
    ['البريد الإلكتروني لمساحة Notion الخاصة بك', 'example@gmail.com'],
    'Notion Plus لمساحة عملك: صفحات وكتل بلا حدود لك ولفريقك، ورفع ملفات بلا حدود، وسجل تعديلات 30 يوما ترجع إليه إن حذفت شيئا بالخطأ.',
    ['صفحات وكتل بلا حدود', 'رفع ملفات بلا حدود', 'سجل تعديلات 30 يوما', 'دعوة حتى 100 ضيف'],
    [['سنة', 365, 40, 120]]],
  ['grammarly-pro', 'grammarly', 'Grammarly Pro', 'account', 'خلال ساعة', null, 0, 0, null,
    'حساب Grammarly Pro جاهز يصحح كتابتك بالإنجليزية في المتصفح وWord وGoogle Docs: القواعد والإملاء، وإعادة صياغة الجمل كاملة، وضبط النبرة حسب من تكتب له.',
    ['تصحيح متقدم للقواعد والإملاء والترقيم', 'إعادة صياغة جمل كاملة', 'ضبط النبرة والوضوح', 'فحص الانتحال', 'يعمل في المتصفح وWord وGoogle Docs'],
    [['شهر', 30, 7, 30], ['سنة', 365, 50, 144]]],
  ['linkedin-premium-career', 'linkedin', 'LinkedIn Premium Career', 'link', 'خلال ساعتين', null, 0, 0,
    ['البريد الإلكتروني لحسابك في LinkedIn', 'example@gmail.com'],
    'LinkedIn Premium Career على حسابك: ترى من زار ملفك، وتراسل مسؤولي التوظيف برسائل InMail، وتعرف موقعك بين المتقدمين على الوظيفة نفسها.',
    ['رسائل InMail شهرية لمسؤولي التوظيف', 'من شاهد ملفك خلال آخر 365 يوما', 'مقارنتك بالمتقدمين للوظيفة', 'دورات LinkedIn Learning'],
    [['3 أشهر', 90, 25, 90]]],
  ['duolingo-super', 'duolingo', 'Duolingo Super — سنة', 'invite', 'خلال ساعة', null, 1, 0,
    ['اسم المستخدم أو البريد في Duolingo', 'username'],
    'Super Duolingo على حسابك لسنة: دروس بلا إعلانات، وقلوب أو طاقة غير محدودة فلا يوقفك الخطأ، وتمارين تراجع أخطاءك أنت، ودروس تأخذها دون إنترنت.',
    ['بدون إعلانات', 'قلوب أو طاقة غير محدودة', 'مراجعة الأخطاء وتمارين مخصصة لك', 'دروس دون إنترنت'],
    [['سنة', 365, 15, 85]]],
  ['coursera-plus', 'coursera', 'Coursera Plus — سنة', 'upgrade', 'خلال ساعتين', null, 0, 0,
    ['البريد الإلكتروني لحسابك في Coursera', 'example@gmail.com'],
    'سنة من Coursera Plus: آلاف الدورات والشهادات المهنية من جامعات وشركات مثل Google وMeta وIBM، تدرسها بالسرعة التي تناسبك وتأخذ شهادة عن كل ما تكمله.',
    ['آلاف الدورات والبرامج', 'شهادات مهنية من Google وMeta وIBM', 'شهادة إتمام تشاركها على LinkedIn', 'تتعلم بالسرعة التي تناسبك'],
    [['سنة', 365, 70, 399]]],
  ['nordvpn-1-year', 'nordvpn', 'NordVPN — حماية وخصوصية', 'account', 'خلال ساعة', null, 0, 0, null,
    'حساب NordVPN جاهز لسنة: يشفر اتصالك على الشبكات العامة ويخفي عنوانك، مع آلاف الخوادم في أكثر من 100 دولة، ويعمل على 10 أجهزة في الوقت نفسه.',
    ['آلاف الخوادم في أكثر من 100 دولة', 'تشفير قوي وحماية من التتبع', 'حتى 10 أجهزة في الوقت نفسه', 'حظر الإعلانات والمواقع الضارة (Threat Protection)'],
    [['سنة', 365, 20, 60]]],
  ['xbox-game-pass-ultimate', 'xbox', 'Xbox Game Pass Ultimate', 'code', 'خلال 30 دقيقة', null, 0, 0, null,
    'كود Xbox Game Pass Ultimate لشهر: مئات الألعاب على Xbox والكمبيوتر والسحابة، وألعاب Xbox الجديدة يوم إطلاقها، ومعها EA Play واللعب الجماعي أونلاين.',
    ['مئات الألعاب على Xbox والكمبيوتر', 'ألعاب Xbox الجديدة يوم إطلاقها', 'EA Play وUbisoft+ Classics مشمولة', 'اللعب السحابي واللعب الجماعي أونلاين'],
    [['شهر', 30, 13, 20]]],
  ['playstation-plus-essential', 'playstation', 'PlayStation Plus Essential', 'code', 'خلال 30 دقيقة', null, 0, 0, null,
    'كود PlayStation Plus Essential لثلاثة أشهر: اللعب الجماعي أونلاين، وألعاب تضاف إلى مكتبتك كل شهر ما دام اشتراكك فعالا، وخصومات خاصة في متجر PlayStation.',
    ['اللعب الجماعي أونلاين', 'ألعاب شهرية تضاف إلى مكتبتك', 'خصومات خاصة في المتجر', 'تخزين سحابي لملفات الحفظ'],
    [['3 أشهر', 90, 25, 30]]],
  ['discord-nitro', 'discord', 'Discord Nitro', 'link', 'خلال ساعة', null, 0, 0,
    ['اسم المستخدم في Discord', 'username'],
    'Discord Nitro على حسابك: ترفع ملفات أكبر بكثير، وتبث شاشتك بدقة عالية، وتستخدم الإيموجي والملصقات في كل سيرفر، ومعه تعزيزان لسيرفرك المفضل.',
    ['رفع ملفات أكبر بكثير من الحساب المجاني', 'بث الشاشة بدقة HD وأعلى', 'تعزيزان (Boosts) للسيرفر', 'إيموجي وملصقات مخصصة في كل مكان'],
    [['شهر', 30, 6, 10], ['سنة', 365, 55, 100]]],
];

const ACTIVATION_STEPS = {
  upgrade: ['اختر الباقة واكتب بريد حسابك عند الطلب.', 'حول المبلغ وأرفق صورة الإيصال.', 'بعد تأكيد الدفع نفعل الاشتراك على حسابك ونبلغك.', 'ادخل إلى حسابك وستجد المزايا مفعلة.'],
  account: ['اختر الباقة وأكمل الطلب.', 'حول المبلغ وأرفق صورة الإيصال.', 'بعد تأكيد الدفع تظهر بيانات الحساب في صفحة طلبك.', 'ادخل بالبيانات التي استلمتها وابدأ الاستخدام.'],
  invite: ['اكتب بريدك الإلكتروني عند الطلب.', 'حول المبلغ وأرفق صورة الإيصال.', 'بعد تأكيد الدفع تصلك دعوة الانضمام على بريدك.', 'اقبل الدعوة فتعمل المزايا على حسابك.'],
  code: ['اختر الباقة وأكمل الطلب.', 'حول المبلغ وأرفق صورة الإيصال.', 'بعد تأكيد الدفع يظهر كود التفعيل في صفحة طلبك.', 'استرد الكود من حسابك في المنصة.'],
  link: ['اكتب البيانات المطلوبة عند الطلب.', 'حول المبلغ وأرفق صورة الإيصال.', 'بعد تأكيد الدفع يصلك رابط التفعيل في صفحة طلبك.', 'افتح الرابط وأنت مسجل دخولك ليتفعل الاشتراك.'],
};

// "Does it work in my country?" Products whose region matters say so; the rest get the default.
const DEFAULT_REGION_NOTE = 'يعمل على حسابك من أي بلد تتوفر فيه الخدمة';
const REGION_NOTES = {
  'netflix-premium-4k': 'يعمل في أغلب الدول، ومكتبة الأفلام والمسلسلات تختلف من بلد لآخر',
  'youtube-premium': 'Google تطلب أن يكون أفراد المجموعة العائلية في بلد واحد، فاسألنا قبل الطلب إن كان حسابك من بلد آخر',
  'xbox-game-pass-ultimate': 'أكواد Xbox قد ترتبط بمنطقة معينة، فاسألنا عن منطقة الكود قبل الطلب',
  'playstation-plus-essential': 'الكود يعمل على حسابات PlayStation من منطقته فقط، فاسألنا عن منطقته قبل الطلب',
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
    const description = `${about}\n\n${DELIVERY_SENTENCE[delivery]} ${DESCRIPTION_TAIL}`;
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
        REGION_NOTES[slug] || DEFAULT_REGION_NOTE,
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
