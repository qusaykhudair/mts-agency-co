/* "Continue with Google" in Google's sign-in popup (Google Identity Services token client). It needs only the
 * site's JavaScript origin in Google Console. When Google's script did not load, the link's own redirect flow
 * is used instead, and a blocked popup falls back to it too. */
(() => {
  'use strict';
  const btn = document.querySelector('a.g-btn[data-client-id]');
  if (!btn) return;
  let client = null;

  const busy = (on) => {
    btn.classList.toggle('is-busy', on);
    if (on) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
  };
  const fail = (message) => {
    busy(false);
    if (window.toast) window.toast(message, 'error');
  };

  async function signIn(response) {
    if (!response || response.error || !response.access_token) {
      return fail(response && response.error === 'access_denied' ? 'تم إلغاء تسجيل الدخول عبر Google.' : 'تعذر تسجيل الدخول عبر Google، حاول مرة أخرى.');
    }
    busy(true);
    try {
      const res = await fetch('/auth/google/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Accept: 'application/json' },
        body: JSON.stringify({ access_token: response.access_token, next: btn.dataset.next || '' }),
      });
      const data = await res.json();
      if (data.ok && data.redirect) return window.location.assign(data.redirect);
      fail(data.message || 'تعذر تسجيل الدخول عبر Google، حاول مرة أخرى.');
    } catch {
      fail('تعذر الاتصال بالخادم، تحقق من الإنترنت وحاول مرة أخرى.');
    }
  }

  btn.addEventListener('click', (event) => {
    const oauth2 = window.google && window.google.accounts && window.google.accounts.oauth2;
    if (!oauth2) return;
    event.preventDefault();
    client =
      client ||
      oauth2.initTokenClient({
        client_id: btn.dataset.clientId,
        scope: 'openid email profile',
        prompt: 'select_account',
        callback: signIn,
        error_callback: (err) => {
          if (err && err.type === 'popup_failed_to_open') window.location.assign(btn.href);
        },
      });
    client.requestAccessToken();
  });
})();
