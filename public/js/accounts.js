/* Accounts pages: the seller fee payment form and the admin "record a fee payment" form. */
(function () {
  'use strict';

  /* ---------- Seller fee: payment method details and amounts per number of months ---------- */
  const payForm = document.querySelector('[data-fee-pay]');
  if (payForm) {
    const months = payForm.querySelector('[data-fee-months]');
    const senderLabel = payForm.querySelector('[data-sender-label-target]');
    const fmt = (n, decimals) => Number(n).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : decimals, maximumFractionDigits: decimals });
    const showAmounts = () => {
      const m = months ? months.value : '1';
      payForm.querySelectorAll('[data-fee-amounts]').forEach((el) => {
        const amounts = JSON.parse(el.dataset.feeAmounts || '{}');
        const amt = el.querySelector('.amt');
        if (amt && amounts[m] !== undefined) amt.textContent = fmt(amounts[m], 2);
      });
    };
    const showDetails = () => {
      const picked = payForm.querySelector('[data-pm-radio]:checked');
      payForm.querySelectorAll('[data-pm-details]').forEach((box) => {
        box.hidden = !picked || box.dataset.pmDetails !== picked.value;
      });
      if (picked && senderLabel && picked.dataset.senderLabel) {
        senderLabel.firstChild.textContent = picked.dataset.senderLabel + ' ';
      }
    };
    months && months.addEventListener('change', showAmounts);
    payForm.querySelectorAll('[data-pm-radio]').forEach((r) => r.addEventListener('change', showDetails));
    showAmounts();
    showDetails();
  }

  /* ---------- Admin: a fee paid from the balance or waived has no amount to type ---------- */
  document.querySelectorAll('[data-fee-form]').forEach((form) => {
    const method = form.querySelector('[data-fee-method]');
    const sync = () => {
      const needsAmount = ['transfer', 'cash'].includes(method.value);
      form.querySelectorAll('[data-fee-amount]').forEach((f) => (f.hidden = !needsAmount));
    };
    method.addEventListener('change', sync);
    sync();
  });
})();
