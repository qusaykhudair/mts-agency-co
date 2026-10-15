/* Print page: fit the invoice on one A4 page once the fonts are in, then open the print dialog. */
(function () {
  'use strict';
  const auto = document.currentScript && document.currentScript.dataset.autoprint === '1';
  const sheet = document.querySelector('[data-inv-sheet]');
  const fit = () => window.MTSInvoice && window.MTSInvoice.fit(sheet);
  const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  fit();
  fonts.then(() => {
    fit();
    document.documentElement.dataset.invReady = '1';
    if (auto) setTimeout(() => window.print(), 200);
  });
  window.addEventListener('beforeprint', fit);
})();
