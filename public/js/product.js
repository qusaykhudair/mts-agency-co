/* Product page: plan selection, quantity, live total in the display currency. */
(function () {
  'use strict';
  const box = document.querySelector('[data-buybox]');
  if (!box) return;

  const rate = Number(box.dataset.rate) || 1;
  const decimals = Number(box.dataset.decimals) || 0;
  const symbol = box.dataset.symbol || '';
  const qty = box.querySelector('[data-qty]');
  const totalEl = box.querySelector('[data-total]');
  const savingEl = box.querySelector('[data-saving]');
  const mirror = document.querySelector('[data-total-mirror]');
  const stockNote = box.querySelector('[data-stock-note]');
  const submit = box.querySelector('[type="submit"]');
  const maxQty = Number(qty.max) || 10;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Mirrors src/lib/money.js: convert from base minor units and round up to the currency precision.
  const ceilTo = (v, d) => {
    const f = 10 ** d;
    return Math.ceil(Number((v * f).toFixed(6))) / f;
  };
  const num = (minor) => {
    const v = ceilTo((minor / 100) * rate, decimals);
    const whole = Number.isInteger(Number(v.toFixed(decimals)));
    return v.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : decimals, maximumFractionDigits: decimals });
  };
  const html = (minor) => `<span class="money"><bdi class="amt">${num(minor)}</bdi> <span class="cur">${esc(symbol)}</span></span>`;
  const selected = () => box.querySelector('input[name="plan"]:checked');

  function update() {
    const r = selected();
    if (!r) return;
    const stock = r.dataset.stock === '' ? Infinity : Number(r.dataset.stock);
    let q = Math.min(maxQty, Math.max(1, parseInt(qty.value, 10) || 1));
    if (q > stock) q = Math.max(1, stock);
    if (String(q) !== qty.value) qty.value = q;
    const price = Number(r.dataset.price);
    const old = Number(r.dataset.old) || 0;
    totalEl.innerHTML = html(price * q);
    if (mirror) mirror.innerHTML = totalEl.innerHTML;
    savingEl.textContent = old > price ? `وفّرت ${num((old - price) * q)} ${symbol}` : q > 1 ? `${q} × ${num(price)} ${symbol}` : '';
    if (stockNote) {
      stockNote.hidden = !(stock !== Infinity && stock <= 10);
      stockNote.innerHTML = `<i class="fa-solid fa-fire" style="color:var(--sale)"></i> متبقٍ ${stock} فقط من هذه الباقة`;
    }
    if (submit) submit.disabled = stock <= 0;
  }

  box.addEventListener('change', (e) => {
    if (e.target.name === 'plan' || e.target === qty) update();
  });
  qty.addEventListener('input', update);
  box.querySelectorAll('[data-qty-step]').forEach((btn) =>
    btn.addEventListener('click', () => {
      qty.value = (parseInt(qty.value, 10) || 1) + Number(btn.dataset.qtyStep);
      update();
    }),
  );
  update();

  // Sticky buy bar on small screens while the buy box is off-screen.
  const bar = document.querySelector('[data-mobile-buybar]');
  if (bar && 'IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => bar.classList.toggle('is-visible', !entry.isIntersecting), { threshold: 0 }).observe(box);
  }
  const jump = document.querySelector('[data-scroll-buybox]');
  jump &&
    jump.addEventListener('click', (e) => {
      e.preventDefault();
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
})();
