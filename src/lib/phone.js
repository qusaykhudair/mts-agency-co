'use strict';
const { parsePhoneNumberFromString } = require('libphonenumber-js/max');
const { toLatinDigits } = require('./money');
const COUNTRIES = require('../data/countries.json');

const byKey = new Map(COUNTRIES.map((c) => [c.k, c]));

function country(key) {
  return byKey.get(key) || null;
}

/**
 * Validate a WhatsApp number typed as a national number for the chosen country.
 * Accepts Arabic-Indic digits, spaces, dashes, a leading trunk "0", or a full
 * international number (+970… / 00970…) as long as it matches the chosen code.
 */
function normalizeWhatsapp(countryKey, raw) {
  const c = country(countryKey);
  if (!c) return { error: 'اختر رمز الدولة الخاص برقم الواتساب' };
  const input = toLatinDigits(typeof raw === 'string' ? raw : '').trim();
  if (!input) return { error: 'رقم الواتساب مطلوب للتواصل معك بخصوص طلباتك' };

  const dialDigits = c.dial.slice(1);
  let digits = input.replace(/\D/g, '');
  const international = /^\s*(\+|00)/.test(input);
  if (international) {
    if (input.trim().startsWith('00')) digits = digits.slice(2);
    if (!digits.startsWith(dialDigits)) {
      return { error: `الرقم المُدخل لا يتطابق مع رمز الدولة المختار (${c.dial})` };
    }
    digits = digits.slice(dialDigits.length);
  }
  digits = digits.replace(/^0+/, '');
  if (digits.length < 4 || digits.length > 14) return { error: 'رقم الواتساب غير صحيح، تأكد من عدد الأرقام' };

  const parsed = parsePhoneNumberFromString(c.dial + digits);
  if (!parsed || !parsed.isValid()) {
    return { error: `رقم الواتساب غير صالح لـ ${c.ar} (${c.dial})` };
  }
  return {
    country: c.k,
    dial: c.dial,
    number: parsed.nationalNumber,
    e164: parsed.number,
    display: parsed.formatInternational(),
  };
}

// Same as normalizeWhatsapp but the country is inferred from a full international number.
function fromInternational(raw) {
  const input = toLatinDigits(typeof raw === 'string' ? raw : '').trim();
  const parsed = parsePhoneNumberFromString(input.startsWith('+') ? input : '+' + input.replace(/^00/, ''));
  if (!parsed) return { error: 'رقم دولي غير صالح' };
  let key = parsed.country === 'IL' ? 'PS972' : parsed.country;
  if (!key || !byKey.has(key)) {
    const match = COUNTRIES.find((c) => c.dial === '+' + parsed.countryCallingCode);
    key = match && match.k;
  }
  return normalizeWhatsapp(key, parsed.number);
}

function displayWhatsapp(e164) {
  if (!e164) return '';
  const p = parsePhoneNumberFromString(e164);
  return p ? p.formatInternational() : e164;
}

// wa.me link with an optional pre-filled message.
function waLink(e164, text) {
  const digits = String(e164 || '').replace(/\D/g, '');
  if (!digits) return '';
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

module.exports = { COUNTRIES, country, normalizeWhatsapp, fromInternational, displayWhatsapp, waLink };
