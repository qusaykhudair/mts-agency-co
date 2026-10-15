/* Invoices: the editor (live preview, field errors, printing, duplicate, delete), the settings window
   and the list. Talks to /seller/api/invoices. Needs invoice-sheet.js (window.MTSInvoice). */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const MI = window.MTSInvoice;
  const API = '/seller/api/invoices';
  const toast = (message, type) => window.toast && window.toast(message, type);
  const ask = (text, opts) => (window.mtsConfirm ? window.mtsConfirm(text, opts) : Promise.resolve(window.confirm(text)));
  const FLASH = 'mts.invoiceFlash';

  async function api(method, url, body) {
    try {
      const res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-requested-with': 'fetch' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({ ok: false }));
      return { status: res.status, message: data.message || (res.ok ? '' : 'تعذر الحفظ، حاول مرة أخرى'), ...data };
    } catch (e) {
      return { ok: false, message: 'تعذر الاتصال بالخادم. تأكد من الإنترنت وحاول مرة أخرى' };
    }
  }

  // "١٬٥٠٠٫٥" or "1,500.50" -> 150050 minor units; null when empty, NaN when not an amount.
  function toMinor(value) {
    const s = MI.normalize(value).replace('٫', '.').replace(/[,٬\s]/g, '');
    if (s === '') return null;
    return /^\d+(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : NaN;
  }
  const fromMinor = (m) => (Number.isInteger(m) ? String(m / 100) : '');

  /* ---------- Field errors, announced to screen readers ---------- */
  function clearErrors(scope) {
    $$('.field.has-error', scope).forEach((f) => f.classList.remove('has-error'));
    $$('[aria-invalid="true"]', scope).forEach((el) => el.removeAttribute('aria-invalid'));
    $$('.field-error', scope).forEach((el) => (el.textContent = ''));
  }

  // errors: { field: message }. `idFor(name)` gives the error element id, `inputsFor(name)` the controls.
  function showErrors(errors, { idFor, inputsFor }) {
    const marked = [];
    Object.entries(errors || {}).forEach(([name, message]) => {
      const box = document.getElementById(idFor(name));
      if (box) {
        box.textContent = message;
        const field = box.closest('.field');
        if (field) field.classList.add('has-error');
      }
      const inputs = inputsFor(name);
      inputs.forEach((el) => el.setAttribute('aria-invalid', 'true'));
      if (inputs[0]) marked.push(inputs[0]);
    });
    // Focus the first problem in reading order; its label and message are read out with it.
    const first = marked.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))[0];
    if (first) {
      first.focus({ preventScroll: true });
      first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /* ---------- Settings window (list and editor) ---------- */
  function settingsWindow(onLive) {
    const dialog = $('#invSettings');
    if (!dialog || !dialog.showModal) return;
    const form = $('[data-inv-settings-form]', dialog);
    let saved = JSON.parse($('#invSettingsData').textContent);
    const read = () => {
      const values = { ...saved };
      Array.from(form.elements).forEach((el) => {
        if (el.name) values[el.name] = el.value;
      });
      return values;
    };
    const fill = (values) => {
      Array.from(form.elements).forEach((el) => {
        if (el.name && values[el.name] !== undefined) el.value = values[el.name] || '';
      });
    };
    $$('[data-inv-settings-open]').forEach((btn) =>
      btn.addEventListener('click', () => {
        fill(saved);
        clearErrors(form);
        dialog.showModal();
        const first = $('input', form);
        if (first) first.focus();
      }),
    );
    // The preview follows the window while typing; closing without saving puts it back.
    form.addEventListener('input', () => onLive && onLive(read()));
    dialog.addEventListener('close', () => onLive && onLive(saved));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrors(form);
      const btn = $('[type="submit"]', form);
      btn.disabled = true;
      const res = await api('PUT', `${API}/settings`, read());
      btn.disabled = false;
      if (!res.ok) {
        if (res.errors) showErrors(res.errors, { idFor: (n) => `invs-err-${n}`, inputsFor: (n) => $$(`[name="${n}"]`, form) });
        toast(res.message, 'error');
        return;
      }
      saved = res.settings;
      // The saved values as the server stored them (website without https://, number in +format).
      if (onLive) onLive(saved);
      dialog.close();
      toast(res.message);
    });
  }

  /* ---------- Country combobox (ARIA 1.2 pattern) ---------- */
  function countryCombo(root, codes, pinned, onChange) {
    const input = $('[data-combo-input]', root);
    const hidden = $('[data-combo-value]', root);
    const list = $('[data-combo-list]', root);
    const clear = $('[data-combo-clear]', root);
    const all = codes.map((code) => {
      const ar = MI.countryName(code, 'ar');
      const en = MI.countryName(code, 'en');
      return { code, ar, en, key: MI.normalize(`${ar} ${en} ${code}`) };
    });
    const byCode = new Map(all.map((c) => [c.code, c]));
    const sorted = all.slice().sort((a, b) => a.ar.localeCompare(b.ar, 'ar'));
    const top = pinned.map((c) => byCode.get(c)).filter(Boolean);
    const topSet = new Set(top.map((c) => c.code));
    let options = [];
    let active = -1;

    const nameOf = (code) => (byCode.get(code) ? byCode.get(code).ar : '');
    function setValue(code) {
      hidden.value = code || '';
      input.value = nameOf(code);
      clear.hidden = !code;
    }
    function setActive(i) {
      active = i;
      $$('li[data-code]', list).forEach((li, n) => li.classList.toggle('is-active', n === i));
      const li = $$('li[data-code]', list)[i];
      if (li) {
        input.setAttribute('aria-activedescendant', li.id);
        li.scrollIntoView({ block: 'nearest' });
      } else input.removeAttribute('aria-activedescendant');
    }
    function open(query) {
      const q = MI.normalize(query);
      let items;
      if (!q) items = [...top, null, ...sorted.filter((c) => !topSet.has(c.code))];
      else {
        const hits = sorted.filter((c) => c.key.includes(q));
        // Names that start with the query come first.
        const starts = (c) => MI.normalize(c.ar).startsWith(q) || MI.normalize(c.en).startsWith(q) || c.code.toLowerCase() === q;
        items = [...hits.filter(starts), ...hits.filter((c) => !starts(c))];
      }
      options = items.filter(Boolean);
      list.innerHTML = options.length
        ? items
            .map((c) =>
              c
                ? `<li role="option" id="cc-${c.code}" data-code="${c.code}" aria-selected="${c.code === hidden.value}">${MI.esc(c.ar)} <small lang="en">${MI.esc(c.en)}</small></li>`
                : '<li class="combo-sep" role="presentation"></li>',
            )
            .join('')
        : '<li class="combo-empty" role="option" aria-disabled="true" aria-selected="false">لا توجد دولة بهذا الاسم</li>';
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      const current = options.findIndex((c) => c.code === hidden.value);
      setActive(q ? (options.length ? 0 : -1) : current);
    }
    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    }
    function choose(i) {
      const c = options[i];
      if (!c) return;
      setValue(c.code);
      close();
      onChange();
    }
    input.addEventListener('input', () => open(input.value));
    input.addEventListener('click', () => (list.hidden ? open(input.value === nameOf(hidden.value) ? '' : input.value) : null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (list.hidden) open(input.value === nameOf(hidden.value) ? '' : input.value);
        else setActive(Math.min(active + 1, options.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!list.hidden) setActive(Math.max(active - 1, 0));
      } else if (e.key === 'Enter') {
        if (!list.hidden && active >= 0) {
          e.preventDefault();
          choose(active);
        }
      } else if (e.key === 'Escape') {
        if (!list.hidden) {
          e.preventDefault();
          close();
          input.value = nameOf(hidden.value);
        }
      } else if (e.key === 'Tab' && !list.hidden) {
        if (active >= 0 && input.value !== nameOf(hidden.value)) choose(active);
        else close();
      }
    });
    // Leaving the box keeps an exact name, clears an empty box, and otherwise restores the choice.
    input.addEventListener('blur', () =>
      setTimeout(() => {
        if (root.contains(document.activeElement)) return;
        close();
        const q = MI.normalize(input.value);
        if (!q) {
          if (hidden.value) {
            setValue('');
            onChange();
          }
          return;
        }
        const exact = all.find((c) => MI.normalize(c.ar) === q || MI.normalize(c.en) === q || c.code.toLowerCase() === q);
        if (exact && exact.code !== hidden.value) {
          setValue(exact.code);
          onChange();
        } else input.value = nameOf(hidden.value);
      }, 120),
    );
    list.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-code]');
      if (li) choose(options.findIndex((c) => c.code === li.dataset.code));
    });
    clear.addEventListener('click', () => {
      setValue('');
      input.focus();
      onChange();
    });
    setValue(hidden.value);
    return { setValue };
  }

  /* ---------- Editor ---------- */
  function editor() {
    const form = $('[data-inv-form]');
    if (!form) return;
    const boot = JSON.parse($('#invBoot').textContent);
    const frame = $('[data-inv-frame]');
    const overflow = $('[data-inv-overflow]');
    const alertBox = $('[data-inv-alert]');
    const balance = $('[data-inv-balance]');
    const totalIn = $('#total');
    const paidIn = $('#paid');
    const fullBtn = $('[data-paid-full]');
    const noneBtn = $('[data-paid-none]');
    const paidOnIn = $('#paid_on');
    const paidOnDay = $('[data-paid-on-day]');
    const dueField = $('[data-due-field]');
    const transferHint = $('[data-transfer-hint]');
    const currencies = new Map(boot.currencies.map((c) => [c.code, c]));
    let inv = { id: boot.invoice.id, number: boot.invoice.number };
    let settings = boot.settings;
    let paidFull = false;
    let dirty = false;
    let saving = false;

    const value = (name) => {
      const el = form.elements[name];
      if (!el) return '';
      return String(el.value || '');
    };

    // What the preview draws.
    function sheetData() {
      const total = toMinor(value('total'));
      const paid = toMinor(value('paid'));
      const code = value('currency');
      return {
        number: inv.number,
        issued_on: value('issued_on'),
        lang: value('lang') || 'ar',
        client_name: value('client_name').trim(),
        client_contact: value('client_contact').trim(),
        client_country: value('client_country'),
        currency: currencies.get(code) || { code, symbol: code },
        total: Number.isInteger(total) ? total : 0,
        paid: Number.isInteger(paid) ? paid : 0,
        method: value('method').trim(),
        paid_on: value('paid_on'),
        due_on: value('due_on'),
        purpose: value('purpose'),
        service: value('service'),
        note: value('note'),
      };
    }

    // What the API receives: the fields as typed; the server validates everything.
    function payload() {
      const fields = ['client_name', 'client_contact', 'client_country', 'currency', 'total', 'paid', 'method', 'paid_on', 'due_on', 'purpose', 'service', 'note', 'issued_on', 'lang', 'project_id'];
      return Object.fromEntries(fields.map((f) => [f, value(f)]));
    }

    function scalePreview() {
      const sheet = $('[data-inv-sheet]', frame);
      if (!sheet) return;
      const cs = getComputedStyle(frame);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const s = Math.min(1, (frame.clientWidth - padX) / sheet.offsetWidth);
      frame.style.setProperty('--inv-scale', String(s));
      frame.style.height = `${Math.ceil(sheet.offsetHeight * s + padY)}px`;
    }

    function refreshSide(data) {
      const st = MI.computeStatus(data.total, data.paid);
      const label = { paid: ['badge-success', 'مدفوعة'], partial: ['badge-warning', 'مدفوعة جزئيا'], unpaid: ['badge-muted', 'غير مدفوعة'] }[st.status];
      balance.innerHTML =
        data.total > 0
          ? `<span>المتبقي <b class="${st.remaining > 0 ? 'is-due' : ''}">${MI.amountHtml(st.remaining, data.currency, 'ar')}</b></span><span class="badge ${label[0]}">${label[1]}</span>`
          : '<span class="muted">اكتب المبلغ الإجمالي ليظهر المتبقي وحالة الدفع.</span>';
      const paid = toMinor(paidIn.value);
      const hasPaid = Number.isInteger(paid) && paid > 0;
      $$('[data-req-paid]').forEach((el) => (el.hidden = !hasPaid));
      $('#method').setAttribute('aria-required', String(hasPaid));
      paidOnIn.setAttribute('aria-required', String(hasPaid));
      transferHint.textContent = hasPaid ? '' : 'لا تطبع بيانات التحويل في فاتورة غير مدفوعة';
      dueField.hidden = !(data.total > 0 && st.remaining > 0);
      paidOnDay.textContent = MI.dayLabel(paidOnIn.value, 'ar');
      $$('[data-count-for]').forEach((el) => {
        const field = form.elements[el.dataset.countFor];
        const max = Number(field.getAttribute('maxlength'));
        el.textContent = `${field.value.length} من ${max} حرف`;
        el.classList.toggle('is-near', field.value.length > max * 0.9);
      });
    }

    function render() {
      const data = sheetData();
      frame.innerHTML = MI.render(data, settings);
      const fitted = MI.fit($('[data-inv-sheet]', frame));
      overflow.hidden = !fitted.overflow;
      scalePreview();
      refreshSide(data);
    }

    function setPaidFull(on) {
      paidFull = on;
      fullBtn.setAttribute('aria-pressed', String(on));
    }
    fullBtn.addEventListener('click', () => {
      const total = toMinor(totalIn.value);
      setPaidFull(true);
      if (Number.isInteger(total)) paidIn.value = fromMinor(total);
      changed();
    });
    noneBtn.addEventListener('click', () => {
      setPaidFull(false);
      paidIn.value = '0';
      changed();
    });
    // The paid amount follows the total only while "paid in full" is switched on; a partial payment
    // never changes because the total did.
    totalIn.addEventListener('input', () => {
      if (!paidFull) return;
      const total = toMinor(totalIn.value);
      paidIn.value = Number.isInteger(total) ? fromMinor(total) : '';
    });
    paidIn.addEventListener('input', () => setPaidFull(false));

    function changed() {
      dirty = true;
      render();
    }
    form.addEventListener('input', changed);
    form.addEventListener('change', changed);

    countryCombo($('[data-combo]', form), boot.countries, boot.pinned, changed);

    // A known client fills in their usual contact and country; a project fills in its client.
    const clients = new Map(boot.clients.map((c) => [MI.normalize(c.name), c]));
    $('#client_name').addEventListener('change', (e) => {
      const known = clients.get(MI.normalize(e.target.value));
      if (!known) return;
      if (!value('client_contact') && known.contact) $('#client_contact').value = known.contact;
      if (!value('client_country') && known.country) {
        form.elements.client_country.value = known.country;
        $('[data-combo-input]', form).value = MI.countryName(known.country, 'ar');
        $('[data-combo-clear]', form).hidden = false;
      }
      changed();
    });
    const project = $('[data-project-select]');
    if (project) {
      project.addEventListener('change', () => {
        const opt = project.selectedOptions[0];
        if (opt && opt.dataset.client && !value('client_name').trim()) {
          $('#client_name').value = opt.dataset.client;
          changed();
        }
      });
    }

    function afterSave(saved) {
      const wasNew = !inv.id;
      inv = { id: saved.id, number: saved.number };
      if (wasNew) {
        history.replaceState(null, '', `/seller/invoices/${inv.id}`);
        $('[data-inv-heading]').textContent = `الفاتورة ${inv.number}`;
        $('[data-inv-crumb]').textContent = inv.number;
        $('[data-inv-sub]').textContent = 'رقم الفاتورة ثابت لا يتغير عند التعديل.';
        document.title = document.title.replace(/^[^|]*/, `الفاتورة ${inv.number} `);
        const dup = $('[data-inv-duplicate]');
        dup.href = `/seller/invoices/new?from=${inv.id}`;
        dup.hidden = false;
        $('[data-inv-delete]').hidden = false;
      }
    }

    async function save() {
      if (saving) return false;
      saving = true;
      clearErrors(form);
      alertBox.hidden = true;
      $$('[data-inv-save], .inv-save-bottom').forEach((b) => (b.disabled = true));
      const res = await api(inv.id ? 'PUT' : 'POST', inv.id ? `${API}/${inv.id}` : API, payload());
      $$('[data-inv-save], .inv-save-bottom').forEach((b) => (b.disabled = false));
      saving = false;
      if (!res.ok) {
        if (res.errors) {
          const count = Object.keys(res.errors).length;
          alertBox.textContent = count > 1 ? `لم نحفظ الفاتورة. صحح الحقول المعلمة باللون الأحمر، أولها: ${Object.values(res.errors)[0]}` : `لم نحفظ الفاتورة: ${Object.values(res.errors)[0]}`;
          alertBox.hidden = false;
          showErrors(res.errors, {
            idFor: (n) => `err-${n}`,
            inputsFor: (n) => (n === 'client_country' ? [$('[data-combo-input]', form)] : $$(`[name="${n}"]`, form).filter((el) => el.type !== 'hidden')),
          });
        } else toast(res.message, 'error');
        return false;
      }
      afterSave(res.invoice);
      dirty = false;
      render();
      toast(res.message);
      return true;
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      save();
    });

    /* Printing: only the invoice prints, titled with its number and client (the PDF file name). */
    let savedTitle = null;
    function startPrint() {
      const sheet = $('[data-inv-sheet]', frame);
      if (!sheet) return;
      let host = $('.inv-print-host');
      if (!host) {
        host = document.createElement('div');
        host.className = 'inv-print-host';
        host.setAttribute('aria-hidden', 'true');
        document.body.appendChild(host);
      }
      host.innerHTML = sheet.outerHTML;
      document.body.classList.add('inv-printing');
      if (savedTitle === null) savedTitle = document.title;
      document.title = [inv.number, value('client_name').trim()].filter(Boolean).join(' - ') || 'فاتورة';
    }
    function endPrint() {
      document.body.classList.remove('inv-printing');
      if (savedTitle !== null) document.title = savedTitle;
      savedTitle = null;
    }
    window.addEventListener('beforeprint', startPrint);
    window.addEventListener('afterprint', endPrint);
    $('[data-inv-print]').addEventListener('click', async () => {
      // A new or edited invoice is saved first, so the printed copy has its number and matches the records.
      if (!inv.id || dirty) {
        const ok = await save();
        if (!ok) return;
      }
      startPrint();
      window.print();
    });

    $('[data-inv-delete]').addEventListener('click', async () => {
      if (!inv.id) return;
      const ok = await ask(`حذف الفاتورة ${inv.number}؟ لا يمكن التراجع عن الحذف، ورقمها لن يعطى لفاتورة أخرى.`, { title: 'حذف الفاتورة', danger: true });
      if (!ok) return;
      const res = await api('DELETE', `${API}/${inv.id}`);
      if (!res.ok) return toast(res.message, 'error');
      dirty = false;
      try {
        sessionStorage.setItem(FLASH, res.message);
      } catch (e) {
        /* the list simply shows no message */
      }
      location.href = '/seller/invoices';
    });

    window.addEventListener('beforeunload', (e) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });

    settingsWindow((values) => {
      settings = values;
      render();
    });

    window.addEventListener('resize', scalePreview);
    render();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(render);
  }

  /* ---------- List ---------- */
  function listPage() {
    const filters = $('[data-inv-filters]');
    if (!filters) return;
    const period = $('[data-period-select]', filters);
    const range = $('[data-period-range]', filters);
    period.addEventListener('change', () => {
      range.hidden = period.value !== 'range';
      if (period.value !== 'range') filters.submit();
      else $('#f-from').focus();
    });
    $$('[data-inv-delete-id]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const ok = await ask(`حذف الفاتورة ${btn.dataset.invNumber}؟ لا يمكن التراجع عن الحذف، ورقمها لن يعطى لفاتورة أخرى.`, { title: 'حذف الفاتورة', danger: true });
        if (!ok) return;
        const res = await api('DELETE', `${API}/${btn.dataset.invDeleteId}`);
        if (!res.ok) return toast(res.message, 'error');
        try {
          sessionStorage.setItem(FLASH, res.message);
        } catch (e) {
          /* ignore */
        }
        location.reload();
      }),
    );
    settingsWindow(null);
  }

  try {
    const flash = sessionStorage.getItem(FLASH);
    if (flash) {
      sessionStorage.removeItem(FLASH);
      toast(flash);
    }
  } catch (e) {
    /* storage unavailable */
  }

  editor();
  listPage();
})();
