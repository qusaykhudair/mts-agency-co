/* WhatsApp number input with a searchable country-code picker. Needs window.MTS_COUNTRIES. */
(function () {
  'use strict';

  const COUNTRIES = window.MTS_COUNTRIES || [];
  const PRIORITY = ['PS', 'PS972', 'EG', 'SA', 'JO', 'AE', 'KW', 'QA', 'BH', 'OM', 'IQ', 'SY', 'LB', 'LY', 'TN', 'DZ', 'MA', 'SD', 'YE', 'MR', 'SO', 'DJ', 'KM', 'TR'];
  const byKey = new Map(COUNTRIES.map((c) => [c.k, c]));
  // Longest dial codes first so "+970" wins over "+97".
  const byDial = COUNTRIES.slice().sort((a, b) => b.dial.length - a.dial.length);
  const latin = (s) =>
    String(s || '')
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  const norm = (s) => latin(s).toLowerCase().replace(/[\s()+-]/g, '');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const flagClass = (c) => 'fi fi-' + c.iso.toLowerCase();

  document.querySelectorAll('[data-phone-input]').forEach((wrap) => {
    const toggle = wrap.querySelector('[data-pi-toggle]');
    const flag = wrap.querySelector('[data-pi-flag]');
    const dialEl = wrap.querySelector('[data-pi-dial]');
    const number = wrap.querySelector('[data-pi-number]');
    const hidden = wrap.querySelector('[data-pi-country]');
    const pop = wrap.querySelector('[data-pi-pop]');
    const search = wrap.querySelector('[data-pi-search]');
    const list = wrap.querySelector('[data-pi-list]');
    const field = wrap.closest('.field');
    const preview = field && field.querySelector('[data-pi-preview]');
    let current = byKey.get(hidden.value) || byKey.get('PS') || COUNTRIES[0];
    let active = -1;

    function updatePreview() {
      if (!preview) return;
      const digits = latin(number.value).replace(/\D/g, '').replace(/^0+/, '');
      preview.innerHTML = digits ? `سيتم حفظ رقمك هكذا: <bdi dir="ltr">${esc(current.dial)} ${esc(digits)}</bdi>` : '';
    }

    function select(c, focusNumber) {
      if (!c) return;
      current = c;
      hidden.value = c.k;
      flag.className = flagClass(c);
      dialEl.textContent = c.dial;
      close();
      updatePreview();
      if (focusNumber) number.focus();
    }

    function render(q) {
      const term = norm(q);
      const matches = COUNTRIES.filter((c) => !term || norm(c.ar).includes(term) || norm(c.en).includes(term) || c.dial.replace('+', '').startsWith(term.replace(/^00/, '')) || c.iso.toLowerCase() === term);
      let html = '';
      let sepDone = !!term;
      matches.forEach((c, i) => {
        if (!sepDone && !PRIORITY.includes(c.k) && i > 0) {
          html += '<li class="pi-sep" aria-hidden="true"></li>';
          sepDone = true;
        }
        html += `<li role="option" data-k="${esc(c.k)}" class="${c.k === current.k ? 'is-active' : ''}"><span class="${flagClass(c)}"></span><span>${esc(c.ar)}</span><span class="dial">${esc(c.dial)}</span></li>`;
      });
      list.innerHTML = html || '<li class="muted" style="cursor:default">لا توجد نتائج</li>';
      active = -1;
    }

    function open() {
      pop.hidden = false;
      search.value = '';
      render('');
      const sel = list.querySelector('.is-active');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
      setTimeout(() => search.focus(), 10);
    }
    function close() {
      pop.hidden = true;
    }

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      pop.hidden ? open() : close();
    });
    search.addEventListener('input', () => render(search.value));
    search.addEventListener('keydown', (e) => {
      const items = Array.from(list.querySelectorAll('li[data-k]'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((li, i) => li.classList.toggle('is-active', i === active));
        items[active].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const li = items[active >= 0 ? active : 0];
        if (li) select(byKey.get(li.dataset.k), true);
      } else if (e.key === 'Escape') {
        close();
        toggle.focus();
      }
    });
    list.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-k]');
      if (li) select(byKey.get(li.dataset.k), true);
    });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) close();
    });

    // Typing/pasting a full international number switches the country automatically.
    number.addEventListener('input', () => {
      let v = latin(number.value).replace(/[^\d+\s-]/g, '');
      const intl = /^\s*(\+|00)/.test(v);
      if (intl) {
        const digits = v.replace(/\D/g, '').replace(/^00/, '');
        const match = byDial.find((c) => digits.startsWith(c.dial.slice(1)) && digits.length > c.dial.length);
        if (match) {
          const keep = current.dial === match.dial ? current : match;
          select(keep, false);
          v = digits.slice(match.dial.length - 1);
        }
      }
      if (v !== number.value) number.value = v;
      updatePreview();
    });

    select(current, false);
  });
})();
