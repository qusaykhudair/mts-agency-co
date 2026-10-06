/* Service requests: multi-file attachments and the per-service writing hint. */
(() => {
  'use strict';
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const toast = (msg, type) => (window.toast ? window.toast(msg, type) : window.alert(msg));
  const ALLOWED = /\.(jpe?g|png|webp|gif|heic|heif|pdf|zip|rar|7z|docx|xlsx|pptx|psd|ai|eps|mp4|mov|mp3|wav)$/i;
  const size = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

  /* ---------- Attachments ---------- */
  $$('[data-files]').forEach((box) => {
    const input = $('input[type="file"]', box);
    const list = $('[data-files-list]', box);
    const max = Number(box.dataset.max) || 6;
    const maxMb = Number(box.dataset.maxMb) || 25;
    let files = [];
    let managed = true;
    try {
      new DataTransfer();
    } catch {
      managed = false; // very old browsers: keep the native multi-file input as is
    }

    const render = () => {
      list.textContent = '';
      files.forEach((file, i) => {
        const li = document.createElement('li');
        li.innerHTML = '<i class="fa-regular fa-file"></i><span class="grow"><b></b><small></small></span><button class="icon-btn" type="button" aria-label="إزالة الملف"><i class="fa-solid fa-xmark"></i></button>';
        li.querySelector('b').textContent = file.name;
        li.querySelector('small').textContent = size(file.size);
        li.querySelector('button').addEventListener('click', () => {
          files.splice(i, 1);
          sync();
        });
        list.appendChild(li);
      });
      box.classList.toggle('has-files', files.length > 0);
    };
    const sync = () => {
      if (managed) {
        const dt = new DataTransfer();
        files.forEach((f) => dt.items.add(f));
        input.files = dt.files;
      }
      render();
    };
    const add = (incoming) => {
      for (const file of Array.from(incoming || [])) {
        if (!ALLOWED.test(file.name)) {
          toast(`الملف «${file.name}» غير مدعوم`, 'error');
          continue;
        }
        if (file.size > maxMb * 1024 * 1024) {
          toast(`حجم «${file.name}» أكبر من ${maxMb} ميجابايت. أرسله كرابط`, 'error');
          continue;
        }
        if (files.some((f) => f.name === file.name && f.size === file.size)) continue;
        if (files.length >= max) {
          toast(`يمكنك إرفاق ${max} ملفات كحد أقصى`, 'error');
          break;
        }
        files.push(file);
      }
      sync();
    };

    input.addEventListener('change', () => {
      if (!managed) {
        files = Array.from(input.files);
        return render();
      }
      add(input.files);
    });
    ['dragenter', 'dragover'].forEach((ev) =>
      box.addEventListener(ev, (e) => {
        e.preventDefault();
        box.classList.add('is-drag');
      }),
    );
    ['dragleave', 'drop'].forEach((ev) => box.addEventListener(ev, () => box.classList.remove('is-drag')));
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      if (managed && e.dataTransfer) add(e.dataTransfer.files);
    });
  });

  /* ---------- What to write for the chosen service ---------- */
  const hintBox = $('[data-hint-box]');
  if (hintBox) {
    const update = () => {
      const picked = $('input[name="service_id"]:checked');
      const text = picked ? picked.dataset.hint : '';
      $('[data-hint-text]', hintBox).textContent = text || '';
      hintBox.hidden = !text;
    };
    $$('input[name="service_id"]').forEach((radio) => radio.addEventListener('change', update));
    update();
  }
})();
