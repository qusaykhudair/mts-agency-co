/* "Continue with Google" via Google Identity Services. The ID token is verified on the server. */
(function () {
  'use strict';
  const el = document.querySelector('[data-google-btn]');
  if (!el) return;
  let tries = 0;

  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    return t === 'dark' || (!t && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  };

  function render() {
    el.innerHTML = '';
    window.google.accounts.id.renderButton(el, {
      type: 'standard',
      theme: isDark() ? 'filled_black' : 'outline',
      size: 'large',
      text: el.dataset.text || 'continue_with',
      shape: 'pill',
      logo_alignment: 'left',
      width: Math.min(400, Math.max(240, Math.round(el.clientWidth || 320))),
      locale: 'ar',
    });
  }

  async function onCredential(response) {
    el.style.opacity = '0.6';
    el.style.pointerEvents = 'none';
    try {
      const res = await fetch('/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify({ credential: response.credential, next: el.dataset.next || '' }),
      });
      const data = await res.json();
      if (data.ok && data.redirect) {
        window.location.href = data.redirect;
        return;
      }
      window.toast && window.toast(data.message || 'تعذّر تسجيل الدخول عبر Google', 'error');
    } catch {
      window.toast && window.toast('تعذّر الاتصال بالخادم، حاول مرة أخرى', 'error');
    }
    el.style.opacity = '';
    el.style.pointerEvents = '';
  }

  function init() {
    if (!(window.google && window.google.accounts && window.google.accounts.id)) {
      if (++tries > 60) {
        el.innerHTML = '<p class="help center">تعذّر تحميل زر Google، تحقق من اتصالك بالإنترنت.</p>';
        return;
      }
      setTimeout(init, 100);
      return;
    }
    window.google.accounts.id.initialize({
      client_id: el.dataset.clientId,
      callback: onCredential,
      ux_mode: 'popup',
      context: el.dataset.text === 'signup_with' ? 'signup' : 'signin',
      cancel_on_tap_outside: true,
    });
    render();
    document.addEventListener('mts:theme', render);
  }
  init();
})();
