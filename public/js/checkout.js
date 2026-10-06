/* Checkout: payment method details, amount in the method's currency, progress steps. */
(function () {
  'use strict';
  const form = document.querySelector('[data-checkout]');
  if (!form) return;

  const radios = Array.from(form.querySelectorAll('[data-pm-radio]'));
  const panels = Array.from(form.querySelectorAll('[data-pm-details]'));
  const senderLabel = form.querySelector('[data-sender-label]');
  const payLine = form.querySelector('[data-pay-line]');
  const payAmount = form.querySelector('[data-pay-amount]');
  const step = (name) => document.querySelector(`[data-co-step="${name}"]`);

  function setStep(name, state) {
    const el = step(name);
    if (!el) return;
    el.classList.toggle('is-active', state === 'active');
    el.classList.toggle('is-done', state === 'done');
    const b = el.querySelector('b');
    if (b && state === 'done') b.innerHTML = '<i class="fa-solid fa-check"></i>';
  }

  function choose(radio, scroll) {
    panels.forEach((p) => (p.hidden = p.dataset.pmDetails !== radio.value));
    if (senderLabel && radio.dataset.senderLabel) senderLabel.textContent = radio.dataset.senderLabel;
    if (payLine) {
      payLine.hidden = false;
      payAmount.textContent = radio.dataset.payText;
    }
    setStep('pay', 'done');
    setStep('proof', 'active');
    const field = radio.closest('.field');
    field && field.classList.remove('has-error');
    if (scroll) {
      const panel = panels.find((p) => !p.hidden);
      if (panel && window.innerWidth < 1024) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  radios.forEach((r) => r.addEventListener('change', () => choose(r, true)));
  const preselected = radios.find((r) => r.checked) || (radios.length === 1 ? radios[0] : null);
  if (preselected) {
    preselected.checked = true;
    choose(preselected, false);
  }

  // Quick client-side checks before uploading (the server validates everything again).
  // Runs on the form (target phase) before the global AJAX handler on document.
  form.addEventListener(
    'submit',
    (e) => {
      const problems = [];
      if (!radios.some((r) => r.checked)) problems.push(['payment_method_id', 'اختر طريقة الدفع التي حولت من خلالها']);
      const file = form.querySelector('input[name="receipt"]');
      if (file && !file.files.length) problems.push(['receipt', 'أرفق صورة إيصال التحويل']);
      const agree = form.querySelector('input[name="agree"]');
      if (agree && !agree.checked) problems.push(['agree', 'يجب تأكيد صحة بيانات التحويل والموافقة على الشروط']);
      ['sender_name', 'sender_account', 'buyer_input'].forEach((n) => {
        const input = form.querySelector(`[name="${n}"]`);
        if (input && input.value.trim().length < 3) problems.push([n, 'هذا الحقل مطلوب']);
      });
      if (!problems.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      problems.forEach(([name, msg]) => {
        const input = form.querySelector(`[name="${name}"]`);
        const field = input && input.closest('.field');
        if (!field) return;
        field.classList.add('has-error');
        const box = field.querySelector('.field-error');
        if (box) box.textContent = msg;
      });
      const first = form.querySelector('.field.has-error');
      first && first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.toast && window.toast(problems[0][1], 'error');
    },
  );

  form.addEventListener('mts:file', () => setStep('proof', 'active'));
})();
