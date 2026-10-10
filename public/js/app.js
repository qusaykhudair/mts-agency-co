/* MTS Store — global UI behaviours (no build step, plain ES2020). */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const setCookie = (name, value, days) => {
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${days * 86400}; samesite=lax`;
  };

  /* ---------- Toasts ---------- */
  const ICONS = { success: 'fa-circle-check', error: 'fa-circle-exclamation', info: 'fa-circle-info' };
  function toast(message, type = 'success', ms = 4200) {
    const box = $('#toasts');
    if (!box || !message) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = `<i class="fa-solid ${ICONS[type] || ICONS.info}"></i><span>${esc(message)}</span>`;
    box.appendChild(el);
    setTimeout(() => {
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 300);
    }, ms);
  }
  window.toast = toast;

  const flash = $('#flashData');
  if (flash) toast(flash.dataset.message, flash.dataset.type === 'error' ? 'error' : 'success');

  /* ---------- Theme ---------- */
  const root = document.documentElement;
  const systemDark = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = () => root.dataset.theme === 'dark' || (!root.dataset.theme && systemDark());
  function syncThemeIcon() {
    $$('[data-theme-icon]').forEach((i) => {
      i.className = isDark() ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    });
  }
  syncThemeIcon();
  $$('[data-theme-toggle]').forEach((btn) =>
    on(btn, 'click', () => {
      const next = isDark() ? 'light' : 'dark';
      root.dataset.theme = next;
      setCookie('mts_theme', next, 365);
      syncThemeIcon();
      document.dispatchEvent(new CustomEvent('mts:theme', { detail: next }));
    }),
  );

  /* ---------- Sidebar ---------- */
  const sidebar = $('#sidebar');
  const backdrop = $('.sidebar-backdrop');
  function setSidebar(open) {
    if (!sidebar) return;
    sidebar.classList.toggle('is-open', open);
    backdrop && backdrop.classList.toggle('is-open', open);
    document.body.style.overflow = open && window.innerWidth < 1200 ? 'hidden' : '';
  }
  $$('[data-sidebar-open]').forEach((b) => on(b, 'click', () => setSidebar(true)));
  $$('[data-sidebar-close]').forEach((b) => on(b, 'click', () => setSidebar(false)));

  /* ---------- Topbar shadow ---------- */
  const topbar = $('[data-topbar]');
  const onScroll = () => topbar && topbar.classList.toggle('is-scrolled', window.scrollY > 8);
  on(window, 'scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- Announcement ---------- */
  const ann = $('[data-announce]');
  on($('[data-announce-close]'), 'click', () => {
    setCookie('mts_ann', ann.dataset.announce, 30);
    ann.remove();
  });

  /* ---------- Dropdowns ---------- */
  function closeDropdowns(except) {
    $$('[data-dd].is-open').forEach((d) => d !== except && d.classList.remove('is-open'));
  }
  $$('[data-dd]').forEach((dd) => {
    on($('[data-dd-toggle]', dd), 'click', (e) => {
      e.stopPropagation();
      const open = !dd.classList.contains('is-open');
      closeDropdowns(dd);
      dd.classList.toggle('is-open', open);
      if (open && dd.hasAttribute('data-notif')) loadNotifications(dd);
    });
  });
  on(document, 'click', (e) => {
    if (!e.target.closest('[data-dd]')) closeDropdowns();
  });
  on(document, 'keydown', (e) => {
    if (e.key === 'Escape') {
      closeDropdowns();
      setSidebar(false);
    }
  });

  /* ---------- Notifications ---------- */
  const bellCount = () => $$('[data-notif-count]');
  function setUnread(n) {
    bellCount().forEach((el) => {
      el.textContent = n > 99 ? '99+' : n;
      el.hidden = !n;
    });
  }
  async function loadNotifications(dd) {
    const list = $('[data-notif-list]', dd);
    try {
      const res = await fetch('/api/notifications', { headers: { 'X-Requested-With': 'fetch' } });
      const data = await res.json();
      if (!data.ok) throw new Error();
      setUnread(data.unread);
      list.innerHTML = data.items.length
        ? data.items
            .map(
              (n) => `<a class="notif${n.read ? '' : ' is-unread'}" href="${esc(n.link || '/account/notifications')}" data-notif-id="${n.id}">
                <span class="ic ${esc(n.tone || '')}"><i class="${esc(n.icon || 'fa-solid fa-bell')}"></i></span>
                <div class="grow"><b>${esc(n.title)}</b>${n.body ? `<p>${esc(n.body)}</p>` : ''}<time>${esc(n.ago)}</time></div></a>`,
            )
            .join('')
        : '<div class="notif-empty"><i class="fa-regular fa-bell" style="font-size:22px;display:block;margin-bottom:6px"></i>لا توجد إشعارات بعد</div>';
    } catch {
      list.innerHTML = '<div class="notif-empty">تعذر تحميل الإشعارات</div>';
    }
  }
  on(document, 'click', (e) => {
    const item = e.target.closest('[data-notif-id]');
    if (item) postJson('/api/notifications/read', { id: Number(item.dataset.notifId) }, true);
  });
  on($('[data-notif-readall]'), 'click', async (e) => {
    e.stopPropagation();
    await postJson('/api/notifications/read', {});
    setUnread(0);
    $$('[data-notif-list] .is-unread').forEach((n) => n.classList.remove('is-unread'));
  });

  function postJson(url, body, keepalive) {
    return fetch(url, {
      method: 'POST',
      keepalive: !!keepalive,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify(body || {}),
    }).catch(() => null);
  }

  // Poll for new notifications so buyers and staff see updates without refreshing.
  if (bellCount().length) {
    let lastId = null;
    const pulse = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch('/api/pulse', { headers: { 'X-Requested-With': 'fetch' } });
        if (!res.ok) return;
        const data = await res.json();
        setUnread(data.unread);
        if (data.latest) {
          if (lastId !== null && data.latest.id > lastId) {
            toast(data.latest.title, data.latest.tone === 'danger' ? 'error' : 'info', 6000);
          }
          lastId = data.latest.id;
        } else if (lastId === null) {
          lastId = 0;
        }
        if (typeof data.pendingOrders === 'number') {
          $$('.sb-link[href="/seller/orders"] .sb-count, .bottom-nav a[href="/seller/orders"] .bn-dot').forEach((el) => {
            el.textContent = data.pendingOrders;
          });
        }
      } catch {
        /* offline — try again later */
      }
    };
    pulse();
    setInterval(pulse, 40000);
    on(document, 'visibilitychange', () => !document.hidden && pulse());
  }

  /* ---------- Live search ---------- */
  const searchForm = $('[data-search]');
  on($('[data-search-toggle]'), 'click', () => {
    searchForm.classList.toggle('is-open');
    if (searchForm.classList.contains('is-open')) $('input', searchForm).focus();
  });
  if (searchForm) {
    const input = $('[data-search-input]', searchForm);
    const pop = $('[data-search-pop]', searchForm);
    let timer = null;
    let active = -1;
    let seq = 0;
    const close = () => {
      pop.hidden = true;
      active = -1;
    };
    const items = () => $$('.sp-item', pop);
    on(input, 'input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) return close();
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          const res = await fetch('/api/search?q=' + encodeURIComponent(q), { headers: { 'X-Requested-With': 'fetch' } });
          const data = await res.json();
          if (my !== seq) return;
          pop.innerHTML = data.items.length
            ? data.items
                .map(
                  (p) => `<a class="sp-item" href="${esc(p.url)}"><img src="${esc(p.logo)}" alt=""><span><b>${esc(p.title)}</b><small>${esc(p.platform)}</small></span><span class="money">${p.from ? '<small class="muted">من </small>' : ''}${esc(p.price)}</span></a>`,
                )
                .join('') + `<a class="sp-all" href="/store/products?q=${encodeURIComponent(q)}">عرض كل النتائج (${data.total})</a>`
            : `<div class="sp-empty">لا توجد نتائج لـ «${esc(q)}»</div>`;
          pop.hidden = false;
          active = -1;
        } catch {
          close();
        }
      }, 220);
    });
    on(input, 'keydown', (e) => {
      const list = items();
      if (pop.hidden || !list.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
        list.forEach((el, i) => el.classList.toggle('is-active', i === active));
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        window.location.href = list[active].href;
      } else if (e.key === 'Escape') close();
    });
    on(document, 'click', (e) => {
      if (!e.target.closest('[data-search]')) close();
    });
  }

  /* ---------- Clipboard ---------- */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through to the legacy path */
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
  on(document, 'click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    e.preventDefault();
    const ok = await copyText(btn.dataset.copy);
    if (!ok) return toast('تعذر النسخ، انسخ النص يدويا', 'error');
    const html = btn.innerHTML;
    btn.classList.add('is-copied');
    btn.innerHTML = '<i class="fa-solid fa-check"></i>' + (btn.textContent.trim() ? ' تم النسخ' : '');
    setTimeout(() => {
      btn.classList.remove('is-copied');
      btn.innerHTML = html;
    }, 1600);
  });

  // Reveal masked secrets (e.g. delivered passwords).
  on(document, 'click', (e) => {
    const btn = e.target.closest('[data-reveal]');
    if (!btn) return;
    const v = btn.parentElement.querySelector('[data-secret]');
    if (!v) return;
    const shown = v.dataset.shown === '1';
    v.textContent = shown ? '••••••••' : v.dataset.secret;
    v.classList.toggle('masked', shown);
    v.dataset.shown = shown ? '0' : '1';
    btn.innerHTML = shown ? '<i class="fa-regular fa-eye"></i>' : '<i class="fa-regular fa-eye-slash"></i>';
  });

  // Show / hide password fields.
  on(document, 'click', (e) => {
    const btn = e.target.closest('[data-pw-toggle]');
    if (!btn) return;
    const input = btn.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.innerHTML = show ? '<i class="fa-regular fa-eye-slash"></i>' : '<i class="fa-regular fa-eye"></i>';
  });

  /* ---------- Small helpers ---------- */
  on(document, 'click', (e) => {
    const t = e.target.closest('[data-toggle-target]');
    if (t) {
      const target = $(t.dataset.toggleTarget);
      if (target) {
        target.hidden = !target.hidden;
        if (!target.hidden) {
          const f = target.querySelector('textarea, input');
          f && f.focus();
        }
      }
    }
    const fill = e.target.closest('[data-fill]');
    if (fill) {
      const target = $(fill.dataset.fill);
      if (target) {
        target.value = fill.dataset.value;
        target.focus();
      }
    }
  });
  $$('form[data-autosubmit] select, select[data-autosubmit-field]').forEach((s) => on(s, 'change', () => s.form.submit()));

  /* ---------- Horizontal carousels ---------- */
  $$('[data-hscroll]').forEach((wrap) => {
    const track = $('[data-hs-track]', wrap);
    const prev = $('[data-hs-prev]', wrap);
    const next = $('[data-hs-next]', wrap);
    if (!track) return;
    const rtl = getComputedStyle(track).direction === 'rtl';
    const step = () => Math.max(track.clientWidth * 0.85, 220);
    const update = () => {
      const max = track.scrollWidth - track.clientWidth;
      const pos = Math.abs(track.scrollLeft);
      if (prev) prev.disabled = pos <= 4;
      if (next) next.disabled = pos >= max - 4;
    };
    on(prev, 'click', () => track.scrollBy({ left: rtl ? step() : -step(), behavior: 'smooth' }));
    on(next, 'click', () => track.scrollBy({ left: rtl ? -step() : step(), behavior: 'smooth' }));
    on(track, 'scroll', update, { passive: true });
    on(window, 'resize', update);
    update();
  });

  /* ---------- Countdowns ---------- */
  const timers = $$('[data-countdown]');
  if (timers.length) {
    const pad = (n) => String(n).padStart(2, '0');
    const tick = () => {
      const now = Date.now();
      timers.forEach((el) => {
        const left = Math.max(0, new Date(el.dataset.countdown).getTime() - now);
        const d = Math.floor(left / 86400000);
        const h = Math.floor((left % 86400000) / 3600000);
        const m = Math.floor((left % 3600000) / 60000);
        const s = Math.floor((left % 60000) / 1000);
        if (!left) {
          el.textContent = 'انتهى العرض';
          return;
        }
        if (el.hasAttribute('data-compact')) {
          el.textContent = (d ? `${d}d ` : '') + `${pad(h)}:${pad(m)}:${pad(s)}`;
        } else {
          el.innerHTML = (d ? `<span>${d}ي</span>` : '') + `<span>${pad(h)}</span><span>${pad(m)}</span><span>${pad(s)}</span>`;
        }
      });
    };
    tick();
    setInterval(tick, 1000);
  }

  /* ---------- Dialogs ---------- */
  const imageDialog = $('#imageDialog');
  on(document, 'click', (e) => {
    const link = e.target.closest('[data-lightbox]');
    if (link && imageDialog && imageDialog.showModal) {
      e.preventDefault();
      $('[data-image-target]', imageDialog).src = link.dataset.lightbox;
      $('[data-image-open]', imageDialog).href = link.dataset.lightbox;
      imageDialog.showModal();
    }
    const close = e.target.closest('[data-dialog-close]');
    if (close) close.closest('dialog').close();
  });
  on(imageDialog, 'click', (e) => {
    if (e.target === imageDialog) imageDialog.close();
  });

  const confirmDialog = $('#confirmDialog');
  // Resolves with { ok, value } — value is the prompt text when the form asks for one.
  function confirmAction(form) {
    return new Promise((resolve) => {
      if (!confirmDialog || !confirmDialog.showModal) {
        const ok = window.confirm(form.dataset.confirm || 'هل أنت متأكد؟');
        let value = '';
        if (ok && form.dataset.prompt) value = window.prompt(form.dataset.prompt) || '';
        return resolve({ ok, value });
      }
      $('[data-confirm-title]', confirmDialog).textContent = form.dataset.confirmTitle || 'تأكيد الإجراء';
      $('[data-confirm-text]', confirmDialog).textContent = form.dataset.confirm || 'هل أنت متأكد؟';
      const okBtn = $('[data-confirm-ok]', confirmDialog);
      okBtn.className = 'btn ' + (form.hasAttribute('data-confirm-danger') ? 'btn-danger' : 'btn-primary');
      const promptBox = $('[data-confirm-prompt]', confirmDialog);
      const input = $('[data-confirm-input]', confirmDialog);
      const needPrompt = !!form.dataset.prompt;
      const optional = form.hasAttribute('data-prompt-optional');
      promptBox.hidden = !needPrompt;
      promptBox.classList.remove('has-error');
      input.value = '';
      if (needPrompt) $('[data-confirm-prompt-label]', confirmDialog).textContent = form.dataset.prompt;
      const onClose = () => {
        confirmDialog.removeEventListener('close', onClose);
        resolve({ ok: confirmDialog.returnValue === 'ok', value: input.value.trim() });
      };
      const guard = (e) => {
        if (needPrompt && !optional && !input.value.trim()) {
          e.preventDefault();
          promptBox.classList.add('has-error');
          input.focus();
        }
      };
      okBtn.onclick = guard;
      confirmDialog.addEventListener('close', onClose);
      confirmDialog.returnValue = '';
      confirmDialog.showModal();
      if (needPrompt) setTimeout(() => input.focus(), 50);
    });
  }

  // Styled confirm for page scripts: await window.mtsConfirm('…') -> true/false.
  window.mtsConfirm = (text, { title, danger } = {}) => {
    const el = document.createElement('form');
    el.dataset.confirm = text;
    if (title) el.dataset.confirmTitle = title;
    if (danger) el.setAttribute('data-confirm-danger', '');
    return confirmAction(el).then((r) => r.ok);
  };

  /* ---------- Forms (AJAX + confirm) ---------- */
  function clearErrors(form) {
    $$('.field.has-error', form).forEach((f) => f.classList.remove('has-error'));
  }
  function fieldFor(form, name) {
    const input = form.querySelector(`[name="${CSS.escape(name)}"]`) || form.querySelector(`[data-field="${CSS.escape(name)}"]`);
    return input ? input.closest('.field') || input.parentElement : null;
  }
  function showErrors(form, errors) {
    let first = null;
    Object.entries(errors || {}).forEach(([name, msg]) => {
      const field = fieldFor(form, name);
      if (!field) return;
      field.classList.add('has-error');
      let box = field.querySelector('.field-error');
      if (!box) {
        box = document.createElement('span');
        box.className = 'field-error';
        field.appendChild(box);
      }
      box.textContent = msg;
      first = first || field;
    });
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  on(document, 'input', (e) => {
    const field = e.target.closest && e.target.closest('.field.has-error');
    if (field) field.classList.remove('has-error');
  });
  on(document, 'change', (e) => {
    const field = e.target.closest && e.target.closest('.field.has-error');
    if (field) field.classList.remove('has-error');
  });

  function send(form, submitter, extra) {
    const btn = submitter || form.querySelector('[type="submit"]');
    const data = new FormData(form);
    if (submitter && submitter.name) data.append(submitter.name, submitter.value);
    Object.entries(extra || {}).forEach(([k, v]) => data.set(k, v));
    const progress = $('[data-upload-progress]', form) || (form.id && $(`[data-upload-progress][data-for="${form.id}"]`));
    const hasFile = Array.from(data.values()).some((v) => v instanceof File && v.size > 0);
    clearErrors(form);
    btn && btn.classList.add('is-loading');
    form.dispatchEvent(new CustomEvent('mts:submitting'));

    const xhr = new XMLHttpRequest();
    xhr.open((form.getAttribute('method') || 'POST').toUpperCase(), form.getAttribute('action') || window.location.pathname);
    xhr.setRequestHeader('X-Requested-With', 'fetch');
    xhr.setRequestHeader('Accept', 'application/json');
    if (progress && hasFile) {
      progress.hidden = false;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) progress.firstElementChild.style.width = Math.round((e.loaded / e.total) * 100) + '%';
      };
    }
    const done = () => {
      btn && btn.classList.remove('is-loading');
      if (progress) {
        progress.hidden = true;
        progress.firstElementChild.style.width = '0%';
      }
    };
    xhr.onload = () => {
      let res = null;
      try {
        res = JSON.parse(xhr.responseText);
      } catch {
        res = null;
      }
      if (!res) {
        done();
        return toast(xhr.status === 413 ? 'حجم الملف كبير جدا' : 'حدث خطأ غير متوقع، حاول مرة أخرى', 'error');
      }
      if (res.ok) {
        if (res.redirect) return void (window.location.href = res.redirect);
        if (res.reload) return void window.location.reload();
        done();
        if (res.message) toast(res.message, 'success');
        form.dispatchEvent(new CustomEvent('mts:success', { detail: res }));
        return;
      }
      done();
      showErrors(form, res.errors);
      if (res.message) toast(res.message, 'error');
      else if (res.errors) toast(Object.values(res.errors)[0], 'error');
      form.dispatchEvent(new CustomEvent('mts:error', { detail: res }));
      if (res.redirect) setTimeout(() => (window.location.href = res.redirect), 900);
    };
    xhr.onerror = () => {
      done();
      toast('تعذر الاتصال بالخادم، تحقق من الإنترنت وحاول مجددا', 'error');
    };
    // Only upload forms are multipart; everything else goes URL-encoded.
    const multipart = (form.getAttribute('enctype') || '').includes('multipart');
    xhr.send(multipart ? data : new URLSearchParams(data));
  }

  // Bubble phase: page scripts can validate on the form itself first and cancel with preventDefault().
  on(
    document,
    'submit',
    async (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement) || e.defaultPrevented) return;
      const needsConfirm = form.hasAttribute('data-confirm') && !form.dataset.confirmed;
      const ajax = form.hasAttribute('data-ajax');
      if (!needsConfirm && !ajax) return;
      e.preventDefault();
      const submitter = e.submitter;
      let extra = null;
      if (needsConfirm) {
        const r = await confirmAction(form);
        if (!r.ok) return;
        if (form.dataset.prompt) extra = { [form.dataset.promptName || 'reason']: r.value };
      }
      if (ajax) return send(form, submitter, extra);
      form.dataset.confirmed = '1';
      if (extra) {
        Object.entries(extra).forEach(([k, v]) => {
          const h = document.createElement('input');
          h.type = 'hidden';
          h.name = k;
          h.value = v;
          form.appendChild(h);
        });
      }
      form.submit();
    },
  );

  /* ---------- File uploader (receipt) ---------- */
  const MAX_MB = 8;
  const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'application/pdf'];
  $$('[data-uploader]').forEach((box) => {
    const input = $('input[type="file"]', box);
    const empty = $('[data-up-empty]', box);
    const preview = $('[data-up-preview]', box);
    const img = $('[data-up-img]', box);
    const fileIcon = $('[data-up-file]', box);
    let url = null;
    const reset = () => {
      input.value = '';
      box.classList.remove('has-file');
      empty.hidden = false;
      preview.hidden = true;
      if (url) URL.revokeObjectURL(url);
      url = null;
    };
    const show = (file) => {
      if (!file) return reset();
      const lower = file.name.toLowerCase();
      const okType = TYPES.includes(file.type) || /\.(heic|heif)$/.test(lower);
      if (!okType) {
        reset();
        return toast('الملف يجب أن يكون صورة (JPG, PNG, WEBP) أو PDF', 'error');
      }
      if (file.size > MAX_MB * 1024 * 1024) {
        reset();
        return toast(`حجم الملف أكبر من ${MAX_MB} ميجابايت`, 'error');
      }
      box.classList.add('has-file');
      const field = box.closest('.field');
      field && field.classList.remove('has-error');
      empty.hidden = true;
      preview.hidden = false;
      $('[data-up-name]', box).textContent = file.name;
      $('[data-up-size]', box).textContent = (file.size / 1024 / 1024).toFixed(2) + ' MB';
      if (url) URL.revokeObjectURL(url);
      const isImg = /^image\/(jpeg|png|webp|gif)$/.test(file.type);
      if (isImg) {
        url = URL.createObjectURL(file);
        img.src = url;
      }
      img.hidden = !isImg;
      fileIcon.hidden = isImg;
      box.dispatchEvent(new CustomEvent('mts:file', { bubbles: true }));
    };
    on(input, 'change', () => show(input.files[0]));
    on($('[data-up-clear]', box), 'click', (e) => {
      e.preventDefault();
      reset();
      input.click();
    });
    ['dragenter', 'dragover'].forEach((ev) =>
      on(box, ev, (e) => {
        e.preventDefault();
        box.classList.add('is-drag');
      }),
    );
    ['dragleave', 'drop'].forEach((ev) => on(box, ev, () => box.classList.remove('is-drag')));
    on(box, 'drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer && e.dataTransfer.files[0];
      if (!file) return;
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
      } catch {
        return toast('اسحب الملف غير مدعوم في هذا المتصفح، اضغط لاختياره', 'error');
      }
      show(file);
    });
    // Reset the "has-file" pointer guard when the form is re-rendered by the browser cache.
    if (input.files && input.files[0]) show(input.files[0]);
  });
})();
