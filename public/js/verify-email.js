/* E-mail verification page: digits-only code box that submits itself at 6 digits, and a resend button
 * that counts down until another code may be requested. */
(() => {
  'use strict';
  const form = document.querySelector('[data-verify-form]');
  const input = document.querySelector('[data-code-input]');
  const resend = document.querySelector('[data-resend]');
  const resendForm = document.querySelector('[data-resend-form]');

  // Arabic-Indic and Persian digits become 0-9; anything else is dropped.
  const digits = (value) =>
    String(value)
      .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660)
      .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x06f0)
      .replace(/\D/g, '')
      .slice(0, 6);

  if (input && form) {
    let sentFor = '';
    input.addEventListener('input', () => {
      const clean = digits(input.value);
      if (clean !== input.value) input.value = clean;
      if (clean.length === 6 && clean !== sentFor) {
        sentFor = clean;
        form.requestSubmit();
      }
    });
    // Wrong code: select it so the next digits typed replace it.
    form.addEventListener('mts:error', () => {
      sentFor = '';
      input.focus();
      input.select();
    });
  }

  if (resend) {
    const label = resend.dataset.label || resend.textContent;
    let timer = null;
    const tick = (left) => {
      clearTimeout(timer);
      if (left > 0) {
        resend.disabled = true;
        resend.textContent = `${label} (${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')})`;
        timer = setTimeout(() => tick(left - 1), 1000);
      } else {
        resend.disabled = false;
        resend.textContent = label;
      }
    };
    tick(Number(resend.dataset.wait) || 0);
    if (resendForm) {
      resendForm.addEventListener('mts:success', (e) => {
        if (resendForm.hasAttribute('data-reload')) return window.location.reload();
        tick(Number(e.detail && e.detail.wait) || 60);
        if (input) input.focus();
      });
    }
  }
})();
