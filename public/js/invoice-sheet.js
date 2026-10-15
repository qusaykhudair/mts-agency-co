/* Invoice sheet: one renderer for the editor's live preview (browser) and the print page (Node),
   so what you see is exactly what prints. Plain ES2020, no dependencies.
   Amounts are integer minor units (x100) of the invoice's own currency. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MTSInvoice = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // One of these is ticked on every invoice; all of them print as a grid of boxes.
  const SERVICES = [
    { key: 'design', ar: 'تصميم', en: 'Design' },
    { key: 'video', ar: 'مونتاج', en: 'Video editing' },
    { key: 'development', ar: 'برمجة', en: 'Development' },
    { key: 'marketing', ar: 'تسويق', en: 'Marketing' },
    { key: 'social', ar: 'إدارة صفحات سوشيال ميديا', en: 'Social media management' },
    { key: 'subscriptions', ar: 'بيع اشتراكات', en: 'Subscriptions' },
    { key: 'training', ar: 'كورس / تدريب خاص', en: 'Course / private training' },
  ];

  const TEXT = {
    ar: {
      invoice: 'فاتورة',
      number: 'رقم الفاتورة',
      numberPending: 'يظهر بعد الحفظ',
      issued: 'تاريخ الإصدار',
      billedTo: 'صادرة إلى',
      total: 'المبلغ الإجمالي',
      paid: 'المدفوع',
      remaining: 'المتبقي',
      dueOn: 'موعد سداد المتبقي',
      transfer: 'بيانات التحويل',
      method: 'طريقة التحويل',
      paidOn: 'يوم وتاريخ التحويل',
      purpose: 'الغرض من التحويل',
      services: 'نوع الخدمة',
      note: 'ملاحظة',
      email: 'البريد',
      whatsapp: 'واتساب',
      website: 'الموقع',
      clientPending: 'اسم العميل',
      stamp: { paid: 'مدفوعة', partial: 'مدفوعة جزئيا', unpaid: 'غير مدفوعة' },
      stampRemaining: 'المتبقي',
    },
    en: {
      invoice: 'Invoice',
      number: 'Invoice no.',
      numberPending: 'Assigned on save',
      issued: 'Issue date',
      billedTo: 'Billed to',
      total: 'Total amount',
      paid: 'Paid',
      remaining: 'Balance due',
      dueOn: 'Balance due by',
      transfer: 'Payment details',
      method: 'Payment method',
      paidOn: 'Payment date',
      purpose: 'Payment for',
      services: 'Service type',
      note: 'Note',
      email: 'Email',
      whatsapp: 'WhatsApp',
      website: 'Website',
      clientPending: 'Client name',
      stamp: { paid: 'Paid', partial: 'Partially paid', unpaid: 'Unpaid' },
      stampRemaining: 'Balance',
    },
  };

  // Names the site already uses where the CLDR default reads differently.
  const COUNTRY_NAMES = { PS: { ar: 'فلسطين', en: 'Palestine' } };
  const CURRENCY_NAMES_EN = { ILS: 'Shekel' };

  const langOf = (lang) => (lang === 'en' ? 'en' : 'ar');

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  /* ---------- Search ---------- */
  // One spelling for search: lower case, no diacritics or tatweel, ا for أ/إ/آ, ي for ى, ه for ة,
  // Latin digits for Arabic-Indic ones.
  // Built from code points so the source holds no invisible combining marks.
  const cp = (code) => String.fromCharCode(code);
  const SEARCH_RE = {
    indic: new RegExp(`[${cp(0x0660)}-${cp(0x0669)}]`, 'g'),
    persian: new RegExp(`[${cp(0x06f0)}-${cp(0x06f9)}]`, 'g'),
    // Harakat, superscript alef and tatweel.
    marks: new RegExp(`[${cp(0x064b)}-${cp(0x065f)}${cp(0x0670)}${cp(0x0640)}]`, 'g'),
    // Alef with hamza above/below, alef with madda, alef wasla.
    alef: new RegExp(`[${cp(0x0623)}${cp(0x0625)}${cp(0x0622)}${cp(0x0671)}]`, 'g'),
    maqsura: new RegExp(cp(0x0649), 'g'),
    marbuta: new RegExp(cp(0x0629), 'g'),
  };
  function normalize(text) {
    return String(text == null ? '' : text)
      .replace(SEARCH_RE.indic, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(SEARCH_RE.persian, (d) => String(d.charCodeAt(0) - 0x06f0))
      .toLowerCase()
      .replace(SEARCH_RE.marks, '')
      .replace(SEARCH_RE.alef, cp(0x0627))
      .replace(SEARCH_RE.maqsura, cp(0x064a))
      .replace(SEARCH_RE.marbuta, cp(0x0647))
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ---------- Money ---------- */
  // Whole amounts without decimals (1,500), fractions with exactly two (1,500.50). Latin digits.
  function formatNumber(minor) {
    const m = Math.round(Number(minor) || 0);
    const abs = Math.abs(m);
    const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const frac = abs % 100;
    return (m < 0 ? '-' : '') + whole + (frac ? '.' + String(frac).padStart(2, '0') : '');
  }

  // Arabic invoices use the symbol the site shows ($, ₪, ج.م); English ones the ISO code.
  function currencyMark(cur, lang) {
    if (!cur) return '';
    return langOf(lang) === 'ar' ? cur.symbol || cur.code : cur.code;
  }

  function amountText(minor, cur, lang) {
    return `${formatNumber(minor)} ${currencyMark(cur, lang)}`.trim();
  }

  function amountHtml(minor, cur, lang) {
    return `<span class="inv-amt"><bdi dir="ltr" class="inv-num">${esc(formatNumber(minor))}</bdi> <span class="inv-cur">${esc(currencyMark(cur, lang))}</span></span>`;
  }

  const displayNames = {};
  function intlName(type, code, lang) {
    const key = `${type}:${lang}`;
    try {
      if (!displayNames[key]) displayNames[key] = new Intl.DisplayNames([lang], { type });
      return displayNames[key].of(code) || code;
    } catch (e) {
      return code;
    }
  }

  function currencyName(cur, lang) {
    if (!cur) return '';
    if (langOf(lang) === 'ar') return cur.name || intlName('currency', cur.code, 'ar');
    return CURRENCY_NAMES_EN[cur.code] || intlName('currency', cur.code, 'en');
  }

  /* ---------- Countries ---------- */
  function countryName(code, lang) {
    if (!code) return '';
    const l = langOf(lang);
    if (COUNTRY_NAMES[code]) return COUNTRY_NAMES[code][l];
    return intlName('region', code, l);
  }

  /* ---------- Dates (YYYY-MM-DD, calendar days, no time zone shifts) ---------- */
  function parseDay(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? d : null;
  }

  // "الخميس، 15 أكتوبر 2026" / "Thursday, 15 October 2026"; weekday:false drops the day name.
  function dayLabel(value, lang, { weekday = true } = {}) {
    const d = parseDay(value);
    if (!d) return '';
    const locale = langOf(lang) === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn';
    return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...(weekday ? { weekday: 'long' } : {}), day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  }

  /* ---------- Status ---------- */
  // Computed, never stored: paid when nothing is left, unpaid when nothing was paid, partial otherwise.
  // A missing "paid" (invoices saved before the field existed) means paid in full.
  function computeStatus(total, paid) {
    const t = Math.max(0, Math.round(Number(total) || 0));
    const raw = paid === null || paid === undefined || paid === '' ? t : Math.round(Number(paid) || 0);
    const p = Math.min(Math.max(0, raw), t);
    const remaining = t - p;
    // A total of 0 only exists while the editor is still empty: nothing has been paid yet.
    return { total: t, paid: p, remaining, status: t === 0 ? 'unpaid' : remaining === 0 ? 'paid' : p > 0 ? 'partial' : 'unpaid' };
  }

  /* ---------- Layout ---------- */
  // A first guess at how tight the page must be; the browser then measures and tightens further.
  function fitTier(inv, st) {
    const lang = langOf(inv.lang);
    const text = (s) => String(s || '');
    const purpose = text(inv.purpose);
    const weight =
      purpose.length + (purpose.split('\n').length - 1) * 60 + text(inv.note).length + text(st && st['footer_' + lang]).length + text(st && st['tagline_' + lang]).length;
    return weight > 1500 ? 3 : weight > 800 ? 2 : 1;
  }

  const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.4 8.6l3 3 6.2-7.2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /**
   * inv: { number, issued_on, lang, client_name, client_contact, client_country, currency: {code, symbol, name},
   *        total, paid, method, paid_on, due_on, purpose, service, note }
   * st:  { name, tagline_ar, tagline_en, footer_ar, footer_en, email, whatsapp, website, logo }
   */
  function render(inv, st, opts) {
    const lang = langOf(inv.lang);
    const t = TEXT[lang];
    const s = st || {};
    const o = opts || {};
    const cur = inv.currency || { code: '', symbol: '' };
    const { total, paid, remaining, status } = computeStatus(inv.total, inv.paid);
    const tier = o.tier || fitTier(inv, s);
    const tagline = s['tagline_' + lang] || '';
    const footer = s['footer_' + lang] || '';
    const country = countryName(inv.client_country, lang);
    const contact = String(inv.client_contact || '').trim();
    const sub = [country ? `<span>${esc(country)}</span>` : '', contact ? `<bdi dir="ltr">${esc(contact)}</bdi>` : ''].filter(Boolean).join('<span class="inv-dot" aria-hidden="true"> · </span>');
    const services = SERVICES.map((sv) => {
      const on = sv.key === inv.service;
      return `<li class="${on ? 'is-on' : ''}"><span class="inv-box">${on ? CHECK : ''}</span><span>${esc(sv[lang])}</span></li>`;
    }).join('');
    const cols = Math.ceil(SERVICES.length / Math.ceil(SERVICES.length / 4));
    const due = remaining > 0 && parseDay(inv.due_on) ? dayLabel(inv.due_on, lang, { weekday: false }) : '';
    const contacts = [
      s.email ? `<li><span class="inv-k">${esc(t.email)}</span> <bdi dir="ltr">${esc(s.email)}</bdi></li>` : '',
      s.whatsapp ? `<li><span class="inv-k">${esc(t.whatsapp)}</span> <bdi dir="ltr">${esc(s.whatsapp)}</bdi></li>` : '',
      s.website ? `<li><span class="inv-k">${esc(t.website)}</span> <bdi dir="ltr">${esc(s.website)}</bdi></li>` : '',
    ].join('');
    const number = inv.number ? `<bdi dir="ltr">${esc(inv.number)}</bdi>` : `<span class="inv-pending">${esc(t.numberPending)}</span>`;
    const clientName = String(inv.client_name || '').trim();

    return (
      `<article class="inv-sheet inv-fit-${tier} inv-is-${status}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}" lang="${lang}" data-inv-sheet data-tier="${tier}">` +
      `<header class="inv-head">` +
      `<div class="inv-brand">${s.logo ? `<img class="inv-logo" src="${esc(s.logo)}" alt="">` : ''}<div><p class="inv-brand-name">${esc(s.name || '')}</p>${tagline ? `<p class="inv-brand-tag">${esc(tagline)}</p>` : ''}</div></div>` +
      `<div class="inv-title"><h1>${esc(t.invoice)}</h1><dl class="inv-meta"><div><dt>${esc(t.number)}</dt><dd>${number}</dd></div><div><dt>${esc(t.issued)}</dt><dd>${esc(dayLabel(inv.issued_on, lang, { weekday: false }))}</dd></div></dl></div>` +
      `</header>` +
      `<section class="inv-party">` +
      `<div class="inv-to"><h2 class="inv-label">${esc(t.billedTo)}</h2><p class="inv-client">${clientName ? `<bdi>${esc(clientName)}</bdi>` : `<span class="inv-pending">${esc(t.clientPending)}</span>`}</p>${sub ? `<p class="inv-sub">${sub}</p>` : ''}</div>` +
      `<div class="inv-stamp inv-stamp-${status}"><span class="inv-stamp-main">${esc(t.stamp[status])}</span>${status === 'partial' ? `<span class="inv-stamp-sub">${esc(t.stampRemaining)} ${amountHtml(remaining, cur, lang)}</span>` : ''}</div>` +
      `</section>` +
      `<section class="inv-amounts">` +
      `<div class="inv-total"><span class="inv-label">${esc(t.total)}</span><span class="inv-total-value">${amountHtml(total, cur, lang)}</span><span class="inv-cur-name">${esc(currencyName(cur, lang))}${cur.code ? ` <bdi dir="ltr">(${esc(cur.code)})</bdi>` : ''}</span></div>` +
      `<dl class="inv-split">` +
      `<div><dt>${esc(t.paid)}</dt><dd>${amountHtml(paid, cur, lang)}</dd></div>` +
      `<div class="${remaining > 0 ? 'is-due' : ''}"><dt>${esc(t.remaining)}</dt><dd>${amountHtml(remaining, cur, lang)}</dd></div>` +
      (due ? `<div class="inv-due"><dt>${esc(t.dueOn)}</dt><dd>${esc(due)}</dd></div>` : '') +
      `</dl>` +
      `</section>` +
      // Payment details never print on an unpaid invoice.
      (status !== 'unpaid' && (inv.method || inv.paid_on)
        ? `<section class="inv-transfer"><h2 class="inv-label">${esc(t.transfer)}</h2><dl class="inv-kv">` +
          (inv.method ? `<div><dt>${esc(t.method)}</dt><dd><bdi>${esc(inv.method)}</bdi></dd></div>` : '') +
          (parseDay(inv.paid_on) ? `<div><dt>${esc(t.paidOn)}</dt><dd>${esc(dayLabel(inv.paid_on, lang))}</dd></div>` : '') +
          `</dl></section>`
        : '') +
      (String(inv.purpose || '').trim() ? `<section class="inv-purpose"><h2 class="inv-label">${esc(t.purpose)}</h2><p class="inv-text" dir="auto">${esc(String(inv.purpose).trim())}</p></section>` : '') +
      `<section class="inv-services"><h2 class="inv-label">${esc(t.services)}</h2><ul class="inv-svc" style="--cols:${cols}">${services}</ul></section>` +
      `<footer class="inv-foot">` +
      (footer ? `<p class="inv-closing" dir="auto">${esc(footer)}</p>` : '') +
      (String(inv.note || '').trim() ? `<p class="inv-note"><span class="inv-k">${esc(t.note)}</span> <bdi>${esc(String(inv.note).trim())}</bdi></p>` : '') +
      (contacts ? `<ul class="inv-contacts">${contacts}</ul>` : '') +
      `</footer>` +
      `</article>`
    );
  }

  // Browser only: the loosest type that still fits one A4 page. Returns { tier, overflow }.
  function fit(sheet) {
    if (!sheet) return { tier: 1, overflow: false };
    for (let tier = 1; tier <= 3; tier++) {
      sheet.classList.remove('inv-fit-1', 'inv-fit-2', 'inv-fit-3');
      sheet.classList.add('inv-fit-' + tier);
      if (sheet.scrollHeight <= sheet.clientHeight + 1) return { tier, overflow: false };
    }
    return { tier: 3, overflow: true };
  }

  return { SERVICES, TEXT, esc, normalize, formatNumber, amountText, amountHtml, currencyName, countryName, parseDay, dayLabel, computeStatus, fitTier, render, fit };
});
