/* Back from Google: hand the ID token (URL fragment) to the server, which verifies it and signs the visitor in. */
(() => {
  'use strict';
  const box = document.querySelector('[data-gcb]');
  if (!box) return;
  const params = new URLSearchParams(window.location.hash.slice(1));
  // The token must not linger in the address bar or the history.
  window.history.replaceState(null, '', window.location.pathname);

  const fail = (message) => {
    box.classList.add('is-error');
    box.querySelector('[data-gcb-text]').textContent = message;
    box.querySelector('[data-gcb-retry]').hidden = false;
  };

  const token = params.get('id_token');
  if (!token) {
    return fail(params.get('error') === 'access_denied' ? 'تم إلغاء تسجيل الدخول عبر Google.' : 'تعذّر تسجيل الدخول عبر Google، حاول مرة أخرى.');
  }
  fetch('/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Accept: 'application/json' },
    body: JSON.stringify({ credential: token, state: params.get('state') || '' }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.ok && data.redirect) return window.location.replace(data.redirect);
      fail(data.message || 'تعذّر تسجيل الدخول عبر Google، حاول مرة أخرى.');
    })
    .catch(() => fail('تعذّر الاتصال بالخادم، تحقق من الإنترنت وحاول مرة أخرى.'));
})();
