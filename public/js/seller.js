/* Seller dashboard helpers: repeaters, presets, previews. Also used on order pages. */
(function () {
  'use strict';

  /* ---------- Repeaters (plans, delivery fields, payment details) ---------- */
  document.querySelectorAll('[data-repeater]').forEach((rep) => {
    const list = rep.querySelector('[data-rep-list]');
    const tpl = rep.querySelector('template[data-rep-template]');
    if (!list || !tpl) return;
    const sample = tpl.content.querySelector('[name]');
    const prefix = sample ? sample.getAttribute('name').split('[')[0] : 'items';

    const reindex = () => {
      list.querySelectorAll('[data-rep-row]').forEach((row, i) => {
        row.querySelectorAll('[data-rep-key]').forEach((input) => {
          input.name = `${prefix}[${i}][${input.dataset.repKey}]`;
        });
      });
    };
    const addRow = (values) => {
      const frag = tpl.content.cloneNode(true);
      const row = frag.querySelector('[data-rep-row]');
      if (values) {
        row.querySelectorAll('[data-rep-key]').forEach((input) => {
          const v = values[input.dataset.repKey];
          if (input.type === 'checkbox') input.checked = !!v;
          else if (v !== undefined && v !== null) input.value = v;
        });
      }
      list.appendChild(frag);
      reindex();
      return row;
    };

    rep.addEventListener('click', (e) => {
      if (e.target.closest('[data-rep-add]')) {
        const row = addRow();
        const first = row.querySelector('input:not([type="hidden"]):not([type="checkbox"])');
        first && first.focus();
      }
      const rm = e.target.closest('[data-rep-remove]');
      if (rm) {
        rm.closest('[data-rep-row]').remove();
        reindex();
      }
    });
    rep.setRows = (rows) => {
      list.innerHTML = '';
      (rows.length ? rows : [{}]).forEach((r) => addRow(r));
    };
    reindex();
  });

  // Quick presets that replace the delivery rows.
  document.querySelectorAll('[data-rep-preset]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const rep = btn.closest('form') && btn.closest('form').querySelector('[data-repeater]');
      if (!rep || !rep.setRows) return;
      const hasValues = Array.from(rep.querySelectorAll('[data-rep-key="value"]')).some((i) => i.value.trim());
      const ask = window.mtsConfirm || ((t) => Promise.resolve(window.confirm(t)));
      if (hasValues && !(await ask('سيتم استبدال الحقول الحالية بالقالب المختار. متابعة؟', { title: 'استبدال الحقول' }))) return;
      rep.setRows(JSON.parse(btn.dataset.repPreset));
      const firstEmpty = Array.from(rep.querySelectorAll('[data-rep-key="value"]')).find((i) => !i.value);
      firstEmpty && firstEmpty.focus();
    }),
  );

  /* ---------- Product form: original price + profit = sale price, and how it splits ---------- */
  const calc = document.querySelector('[data-plan-calc]');
  if (calc) {
    const rate = Number(calc.dataset.rate) || 0;
    const basis = calc.dataset.basis === 'profit' ? 'profit' : 'sale';
    const symbol = calc.dataset.symbol || '';
    const decimals = Number(calc.dataset.decimals) || 2;
    let others = [];
    try {
      others = JSON.parse(calc.dataset.currencies || '[]');
    } catch (e) {
      others = [];
    }
    const ownerSelect = document.querySelector('[data-plan-owner]');
    const note = calc.querySelector('[data-plan-commission-note]');
    const isAdminView = !!ownerSelect || calc.dataset.owner === 'admin';
    const ownerRole = () => (ownerSelect && ownerSelect.selectedOptions[0] ? ownerSelect.selectedOptions[0].dataset.role : calc.dataset.owner);
    // "12.5" / "١٢٫٥" -> 1250 minor units; null when empty, NaN when not a number.
    const minor = (v) => {
      const s = String(v || '')
        .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
        .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
        .replace('٫', '.')
        .replace(/[,\s]/g, '');
      if (s === '') return null;
      return /^\d+(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : NaN;
    };
    const num = (m, d = decimals) => {
      const n = m / 100;
      return n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : d, maximumFractionDigits: d });
    };
    const money = (m) => `${num(m)} ${symbol}`;
    const ceilTo = (v, d) => Math.ceil(Number((v * 10 ** d).toFixed(6))) / 10 ** d;
    const equivalents = (m) =>
      others
        .map((c) => {
          const v = ceilTo((m / 100) * c.rate, c.decimals);
          return `${v.toLocaleString('en-US', { maximumFractionDigits: c.decimals })} ${c.symbol}`;
        })
        .join(' · ');
    const span = (text, cls) => {
      const el = document.createElement('span');
      if (cls) el.className = cls;
      el.textContent = text;
      return el;
    };

    const update = (row) => {
      const costInput = row.querySelector('[data-plan-cost]');
      const profitInput = row.querySelector('[data-plan-profit]');
      const current = minor(row.querySelector('[data-plan-current]').value);
      const out = row.querySelector('[data-plan-total]');
      const split = row.querySelector('[data-plan-split]');
      const cost = minor(costInput.value);
      const profit = minor(profitInput.value);
      split.textContent = '';
      split.classList.remove('is-loss');
      let total = null;
      if (Number.isInteger(cost) && Number.isInteger(profit)) total = cost + profit;
      else if (cost === null && profit === null && Number.isInteger(current)) total = current;
      out.textContent = total === null ? '-' : money(total);
      if (total === null) {
        if (Number.isNaN(cost) || Number.isNaN(profit)) split.append(span('اكتب المبلغ بالأرقام فقط، مثل 12 أو 12.5', 'is-loss'));
        return;
      }
      if (cost === null && profit === null) split.append(span('السعر الحالي. اكتب السعر الأصلي والربح لتحديد السعر من جديد.'));
      const knownCost = Number.isInteger(cost) ? cost : null;
      if (ownerRole() !== 'seller') {
        split.append(span(knownCost === null ? 'منتج تابع لـ MTS، بدون عمولة' : `منتج تابع لـ MTS، بدون عمولة · ربح MTS ${money(total - knownCost)}`));
      } else {
        const base = basis === 'profit' && knownCost !== null ? Math.max(0, total - knownCost) : total;
        const commission = Math.round((base * rate) / 100);
        const net = total - commission;
        const you = !isAdminView;
        split.append(span(`عمولة MTS (${rate}%): ${money(commission)}`, 'is-fee'));
        split.append(span(`${you ? 'يصلك' : 'يصل للبائع'}: ${money(net)}`));
        if (knownCost !== null) {
          const left = net - knownCost;
          split.append(span(`${you ? 'صافي ربحك' : 'صافي ربح البائع'}: ${money(left)}`, left < 0 ? 'is-loss' : 'is-net'));
          if (left < 0) split.append(span('السعر لا يغطي السعر الأصلي بعد العمولة، ارفع الربح.', 'is-loss'));
        }
      }
      if (others.length) split.append(span(`يدفع العميل ما يعادل ${equivalents(total)}`, 'muted'));
    };
    const updateAll = () => {
      calc.querySelectorAll('[data-plan]').forEach(update);
      if (note) note.hidden = ownerRole() !== 'seller';
    };

    calc.addEventListener('input', (e) => {
      const row = e.target.closest('[data-plan]');
      if (!row) return;
      // On a plan priced before original prices existed, typing the original price keeps the
      // current sale price by filling in the profit, until the profit is typed by hand.
      if (e.target.matches('[data-plan-cost]')) {
        const profitInput = row.querySelector('[data-plan-profit]');
        const current = minor(row.querySelector('[data-plan-current]').value);
        const cost = minor(e.target.value);
        if (Number.isInteger(current) && (profitInput.value === '' || profitInput.dataset.auto === '1')) {
          if (Number.isInteger(cost) && cost <= current) {
            profitInput.value = num(current - cost, 2).replace(/,/g, '');
            profitInput.dataset.auto = '1';
          } else if (e.target.value === '' && profitInput.dataset.auto === '1') {
            profitInput.value = '';
            delete profitInput.dataset.auto;
          }
        }
      }
      if (e.target.matches('[data-plan-profit]')) delete e.target.dataset.auto;
      update(row);
    });
    // New rows from the repeater.
    calc.addEventListener('click', (e) => {
      if (e.target.closest('[data-rep-add]')) setTimeout(updateAll, 0);
    });
    ownerSelect && ownerSelect.addEventListener('change', updateAll);
    updateAll();
  }

  /* ---------- Product form: platform picks its category ---------- */
  const platformSelect = document.querySelector('[data-platform-select]');
  const categorySelect = document.querySelector('[data-category-select]');
  if (platformSelect && categorySelect) {
    platformSelect.addEventListener('change', () => {
      const opt = platformSelect.selectedOptions[0];
      if (opt && opt.dataset.category) categorySelect.value = opt.dataset.category;
    });
  }

  /* ---------- Image previews ---------- */
  document.querySelectorAll('[data-img-input]').forEach((input) =>
    input.addEventListener('change', () => {
      const thumb = input.closest('.img-uploader') && input.closest('.img-uploader').querySelector('[data-img-preview]');
      const file = input.files[0];
      if (!thumb || !file) return;
      if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
        window.toast && window.toast('اختر صورة JPG أو PNG أو WEBP', 'error');
        input.value = '';
        return;
      }
      if (file.size > 4 * 1024 * 1024) {
        window.toast && window.toast('حجم الصورة يجب ألا يتجاوز 4 ميجابايت', 'error');
        input.value = '';
        return;
      }
      thumb.innerHTML = '';
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.alt = '';
      thumb.appendChild(img);
    }),
  );

  /* ---------- Icon + colour previews ---------- */
  document.querySelectorAll('[data-icon-input]').forEach((input) => {
    const preview = input.parentElement.querySelector('[data-icon-preview]');
    input.addEventListener('input', () => preview && (preview.className = input.value.trim()));
  });
  document.querySelectorAll('input[type="color"]').forEach((input) =>
    input.addEventListener('input', () => {
      const label = input.parentElement.querySelector('.mono');
      if (label) label.textContent = input.value;
      if (input.dataset.color) {
        const form = input.closest('form');
        const c1 = form.querySelector('[data-color="1"]').value;
        const c2 = form.querySelector('[data-color="2"]').value;
        const thumb = form.querySelector('[data-img-preview]');
        if (thumb) thumb.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
      }
    }),
  );
})();
