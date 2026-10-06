'use strict';
// Migration v4: the shop's own wording, rewritten in plain human Arabic (no diacritics, no em dashes).
// Text that still matches an old default or seed is replaced with the new wording; anything the admin wrote
// is kept, and only loses Arabic diacritics and em dashes in descriptive fields. Orders, reviews, messages
// and other records people wrote are never touched. Product titles keep their "Brand — Plan" dash because
// the storefront splits titles on it.

// Generated from git history: every past default/seed wording of these texts.
const SETTINGS = {
  "announcement": {
    "from": [
      "⚡ تسليم سريع للاشتراكات بعد تأكيد الدفع — ادفع عبر بنك فلسطين، جوال باي، بال باي أو فودافون كاش"
    ],
    "to": "ادفع من بنك فلسطين أو جوال باي أو بال باي أو فودافون كاش، واستلم اشتراكك في حسابك بعد تأكيد التحويل"
  },
  "hero_title": {
    "from": [
      "كل اشتراكاتك الرقمية… في مكان واحد"
    ],
    "to": "اشتراكاتك العالمية… بالشيكل أو الجنيه"
  },
  "hero_subtitle": {
    "from": [
      "اشتراكات الذكاء الاصطناعي والتصميم والترفيه والإنتاجية بأسعار منافسة، دفع محلي سهل وتسليم سريع مع متابعة مباشرة عبر واتساب."
    ],
    "to": "ChatGPT وCanva وCapCut وNetflix وغيرها، تدفع ثمنها من بنك فلسطين أو جوال باي أو بال باي أو فودافون كاش، وتصلك بيانات الاشتراك في حسابك بعد تأكيد التحويل."
  },
  "checkout_note": {
    "from": [
      "بعد إرسال الطلب يقوم فريقنا بمراجعة إيصال التحويل، وسيصلك إشعار فور تأكيد الدفع وتسليم بيانات الاشتراك داخل حسابك."
    ],
    "to": "نراجع إيصالك بأنفسنا، وعندما نؤكد الدفع تجد بيانات اشتراكك في صفحة الطلب ويصلك إشعار بذلك."
  }
};

const SERVICES = {
  "web-development": {
    "summary": {
      "from": [
        "مواقع ومتاجر سريعة ومتجاوبة تحوّل الزوار إلى عملاء، من الفكرة حتى الإطلاق."
      ],
      "to": "مواقع ومتاجر تفتح بسرعة على الجوال، من الفكرة حتى يوم الإطلاق. المتجر الذي تتصفحه الآن من صنعنا."
    },
    "brief_hint": {
      "from": [
        "نوع الموقع (تعريفي، متجر، منصة…)، عدد الصفحات والأقسام، أمثلة لمواقع تعجبك، والمحتوى المتوفر لديك."
      ],
      "to": "اكتب نوع الموقع (تعريفي أو متجر أو منصة)، وعدد الصفحات تقريبا، وروابط مواقع تعجبك، وما عندك من نصوص وصور."
    }
  },
  "branding-design": {
    "summary": {
      "from": [
        "شعارات وهويات بصرية وتصاميم تسويقية تعكس قيمة علامتك وتبقى في الذاكرة."
      ],
      "to": "شعار وألوان وخطوط ثابتة تعرف بها علامتك، وتصاميم جاهزة للنشر والطباعة."
    },
    "brief_hint": {
      "from": [
        "اسم العلامة ونشاطها، الجمهور المستهدف، الألوان أو الأساليب المفضلة، والتصاميم المطلوبة ومقاساتها."
      ],
      "to": "اكتب اسم العلامة ونشاطها، ومن هم زبائنك، والألوان التي تحبها أو لا تريدها، والتصاميم التي تحتاجها ومقاساتها."
    }
  },
  "digital-marketing": {
    "summary": {
      "from": [
        "حملات إعلانية مدروسة تصل لجمهورك المستهدف وتحقق أفضل عائد على ميزانيتك."
      ],
      "to": "حملات ممولة نحدد جمهورها ونتابع أرقامها معك، فتعرف أين ذهبت ميزانيتك."
    },
    "brief_hint": {
      "from": [
        "المنتج أو الخدمة المراد تسويقها، الهدف من الحملة، الجمهور والمنطقة المستهدفة، والميزانية الإعلانية."
      ],
      "to": "اكتب ما تريد تسويقه، وهدفك من الحملة (مبيعات أو رسائل أو متابعون)، والمدن أو الدول التي تستهدفها، وميزانيتك الإعلانية."
    }
  },
  "video-production": {
    "summary": {
      "from": [
        "تصوير ومونتاج وموشن جرافيك لمحتوى احترافي يرفع تفاعل جمهورك."
      ],
      "to": "تصوير ومونتاج وموشن جرافيك لإعلاناتك ومحتواك على السوشيال ميديا."
    },
    "brief_hint": {
      "from": [
        "نوع الفيديو (إعلان، موشن، مونتاج…)، المدة المطلوبة، المنصة التي سيُنشر عليها، وأمثلة مرجعية."
      ],
      "to": "اكتب نوع الفيديو (إعلان أو موشن أو مونتاج)، ومدته، والمنصة التي سينشر عليها، وأرفق أمثلة أعجبتك."
    }
  },
  "social-media": {
    "summary": {
      "from": [
        "خطة محتوى ونشر وإدارة كاملة لحساباتك مع تقارير أداء واضحة."
      ],
      "to": "نخطط المحتوى وننشره ونتابع التفاعل على حساباتك، مع تقارير أداء تفهمها من أول قراءة."
    },
    "brief_hint": {
      "from": [
        "روابط حساباتك، عدد المنشورات المطلوبة شهرياً، طبيعة نشاطك، وأهدافك من الإدارة."
      ],
      "to": "ضع روابط حساباتك، وعدد المنشورات التي تريدها في الشهر، واكتب عن نشاطك وما تنتظره من إدارة الصفحات."
    }
  },
  "tech-training": {
    "summary": {
      "from": [
        "برامج تدريب عملية بإشراف مختصين تؤهل المتدربين لسوق العمل."
      ],
      "to": "تدريب عملي على أدوات العمل الرقمي، يقدمه فريق يستخدمها في مشاريع حقيقية كل يوم."
    },
    "brief_hint": {
      "from": [
        "المجال المطلوب، عدد المتدربين ومستواهم، المدة المناسبة، وهل التدريب حضوري أم عن بُعد."
      ],
      "to": "اكتب المجال، وعدد المتدربين ومستواهم، والمدة المناسبة لكم، وهل تفضلون التدريب حضوريا أم أونلاين."
    }
  }
};

// Seeded payment-method text that used a dash.
const PAYMENT_TEXT = [
  ['جوال باي — Jawwal Pay', 'جوال باي (Jawwal Pay)'],
  ['بال باي — PalPay', 'بال باي (PalPay)'],
  ['بنك فلسطين — Bank of Palestine', 'بنك فلسطين (Bank of Palestine)'],
  ['نظام الدفع الفوري iBURAQ — تحويل إلى حساب بنكي', 'نظام الدفع الفوري iBURAQ، تحويل إلى حساب بنكي'],
];

// Seeded sample-product phrases rewritten (substring replace, so a product the admin rewrote is left alone).
const PRODUCT_TEXT = [
  ['perplexity-pro-1-year', 'features', '\u0628\u062D\u062B \u0627\u062D\u062A\u0631\u0627\u0641\u064A \u0628\u062D\u062F\u0648\u062F \u0627\u0633\u062A\u062E\u062F\u0627\u0645 \u0645\u0631\u062A\u0641\u0639\u0629', '\u0628\u062D\u062B Pro \u0628\u062D\u062F\u0648\u062F \u0627\u0633\u062A\u062E\u062F\u0627\u0645 \u0623\u0639\u0644\u0649'],
  ['elevenlabs-creator', 'features', '\u0627\u0633\u062A\u0646\u0633\u0627\u062E \u0627\u0644\u0635\u0648\u062A \u0627\u0644\u0627\u062D\u062A\u0631\u0627\u0641\u064A', '\u0627\u0633\u062A\u0646\u0633\u0627\u062E \u0635\u0648\u062A\u0643 \u0628\u062F\u0642\u0629 \u0639\u0627\u0644\u064A\u0629 (Professional Voice Cloning)'],
  ['capcut-pro', 'title', 'CapCut Pro \u2014 \u0645\u0648\u0646\u062A\u0627\u062C \u0627\u062D\u062A\u0631\u0627\u0641\u064A', 'CapCut Pro \u2014 \u0645\u0648\u0646\u062A\u0627\u062C \u0627\u0644\u0641\u064A\u062F\u064A\u0648'],
  ['capcut-pro', 'description', '\u062D\u0631\u0651\u0631 \u0641\u064A\u062F\u064A\u0648\u0647\u0627\u062A\u0643 \u0628\u0627\u062D\u062A\u0631\u0627\u0641\u064A\u0629 \u0645\u0639 \u062C\u0645\u064A\u0639 \u0645\u0632\u0627\u064A\u0627', '\u062D\u0631\u0631 \u0641\u064A\u062F\u064A\u0648\u0647\u0627\u062A\u0643 \u0628\u0643\u0644 \u0645\u0632\u0627\u064A\u0627'],
];

const MARKS = /[\u064B-\u0652\u0670]/g;
const unmark = (s) => s.replace(MARKS, '');
const undash = (s) => unmark(s).replace(/\s*\u2014\s*/g, '، ');

// Per table: columns that only lose diacritics, and descriptive columns that also lose em dashes.
const CLEANUP = {
  products: { key: 'id', marks: ['title', 'badge', 'delivery_time', 'buyer_input_label', 'buyer_input_placeholder'], text: ['short_description', 'description', 'features', 'activation_steps', 'warranty', 'region_note'] },
  product_plans: { key: 'id', marks: ['name'], text: [] },
  categories: { key: 'id', marks: ['name'], text: ['description'] },
  platforms: { key: 'id', marks: ['name'], text: ['description'] },
  services: { key: 'id', marks: ['name'], text: ['summary', 'brief_hint'] },
  payment_methods: { key: 'id', marks: ['name', 'sender_account_label'], text: ['subtitle', 'details', 'instructions'] },
};
const SETTING_TEXT = ['store_tagline', 'announcement', 'hero_title', 'hero_subtitle', 'checkout_note'];

function apply(db) {
  const setting = db.prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?');
  for (const [key, { from, to }] of Object.entries(SETTINGS)) for (const old of from) setting.run(to, key, old);

  for (const [slug, fields] of Object.entries(SERVICES)) {
    for (const [col, { from, to }] of Object.entries(fields)) {
      const stmt = db.prepare(`UPDATE services SET ${col} = ? WHERE slug = ? AND ${col} = ?`);
      for (const old of from) stmt.run(to, slug, old);
    }
  }

  const pay = db.prepare('UPDATE payment_methods SET name = replace(name, ?, ?), details = replace(details, ?, ?)');
  for (const [a, b] of PAYMENT_TEXT) pay.run(a, b, a, b);

  for (const [slug, col, a, b] of PRODUCT_TEXT) db.prepare(`UPDATE products SET ${col} = replace(${col}, ?, ?) WHERE slug = ?`).run(a, b, slug);

  for (const [table, { key, marks, text }] of Object.entries(CLEANUP)) {
    const cols = [...marks, ...text];
    for (const row of db.prepare(`SELECT ${key}, ${cols.join(', ')} FROM ${table}`).all()) {
      const next = {};
      for (const c of marks) if (typeof row[c] === 'string' && unmark(row[c]) !== row[c]) next[c] = unmark(row[c]);
      for (const c of text) if (typeof row[c] === 'string' && undash(row[c]) !== row[c]) next[c] = undash(row[c]);
      const changed = Object.keys(next);
      if (!changed.length) continue;
      db.prepare(`UPDATE ${table} SET ${changed.map((c) => `${c} = ?`).join(', ')} WHERE ${key} = ?`).run(...changed.map((c) => next[c]), row[key]);
    }
  }

  const tidy = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  for (const row of db.prepare(`SELECT key, value FROM settings WHERE key IN (${SETTING_TEXT.map(() => '?').join(', ')})`).all(...SETTING_TEXT)) {
    if (typeof row.value === 'string' && undash(row.value) !== row.value) tidy.run(undash(row.value), row.key);
  }
}

module.exports = { apply, SETTINGS, SERVICES };
