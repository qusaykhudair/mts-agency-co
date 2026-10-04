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
