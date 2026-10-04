/* Order pages: refresh automatically when the order status changes elsewhere. */
(function () {
  'use strict';
  const el = document.querySelector('[data-order-poll]');
  if (!el) return;
  const code = el.dataset.orderPoll;
  const status = el.dataset.status;
  const staff = el.hasAttribute('data-staff');
  const watched = staff ? ['under_review', 'payment_rejected', 'processing'] : ['under_review', 'processing', 'payment_rejected'];
  if (!watched.includes(status)) return;

  // Never reload over something the user is typing.
  let dirty = false;
  document.addEventListener('input', () => (dirty = true));
  document.addEventListener('change', () => (dirty = true));

  let timer = null;
  async function check() {
    if (document.hidden) return;
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(code)}/status`, { headers: { 'X-Requested-With': 'fetch' } });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.status || data.status === status) return;
      clearInterval(timer);
      if (dirty) {
        window.toast && window.toast('تم تحديث حالة الطلب — حدّث الصفحة لرؤية آخر التغييرات', 'info', 9000);
      } else {
        window.location.reload();
      }
    } catch {
      /* retry on next tick */
    }
  }
  timer = setInterval(check, 20000);
  document.addEventListener('visibilitychange', () => !document.hidden && check());
})();
