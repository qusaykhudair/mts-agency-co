/* "Continue with Google" in Google's sign-in popup (Google Identity Services token client). It needs only the
 * site's JavaScript origin in Google Console. When Google's script did not load, the link's own redirect flow
 * is used instead, and a blocked popup falls back to it too.
 * Inside the browsers built into apps like Instagram, Facebook and TikTok, Google refuses every sign-in
 * ("Access blocked", disallowed_useragent). There the button says so and offers to open the page in the phone's
 * own browser, where it works. */
(() => {
  'use strict';
  const btn = document.querySelector('a.g-btn[data-client-id]');
  if (!btn) return;
  let client = null;

  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  // An app's own browser: named in the user agent, "; wv)" (Android WebView), or on iPhone a browser without
  // "Safari/" in its name (Safari, Chrome, Firefox and the Safari sheets apps open all carry it).
  const inApp =
    !navigator.standalone && (/FBAN|FBAV|FB_IAB|FB4A|Instagram|Snapchat|musical_ly|BytedanceWebview|TikTok|\bLine\/|LinkedInApp|; wv\)/i.test(ua) || (ios && !/Safari\//.test(ua)));

  function copyLink(url) {
    const done = () => window.toast && window.toast('نسخنا الرابط، الصقه في Safari أو Chrome', 'success');
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(url).then(done, () => copyOld(url, done));
    return copyOld(url, done);
  }
  // App browsers often have no clipboard API.
  function copyOld(url, done) {
    const area = document.createElement('textarea');
    area.value = url;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    if (ok) done();
    else window.prompt('انسخ هذا الرابط وافتحه في Safari أو Chrome:', url);
  }

  function explainInApp() {
    const here = window.location.href;
    const browser = ios ? 'Safari' : android ? 'Chrome' : 'المتصفح';
    // Android opens Chrome through an intent; iPhone opens Safari through its x-safari- address.
    const outside = android
      ? `intent://${window.location.host}${window.location.pathname}${window.location.search}#Intent;scheme=${window.location.protocol.replace(':', '')};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(here)};end`
      : ios
        ? `x-safari-${here}`
        : here;
    const box = document.createElement('div');
    box.className = 'alert alert-warning g-inapp';
    box.setAttribute('role', 'note');
    box.innerHTML =
      '<i class="fa-solid fa-circle-info" aria-hidden="true"></i><div class="grow">' +
      `<p>Google لا يسمح بتسجيل الدخول بحسابه من داخل تطبيقات مثل Instagram وFacebook. افتح الصفحة في ${browser} وسجل من هناك، أو سجل الآن بالبريد وكلمة المرور.</p>` +
      `<div class="g-inapp-actions"><a class="btn btn-primary btn-sm" data-open-outside>افتح في ${browser}</a><button class="btn btn-soft btn-sm" type="button" data-copy-link>انسخ الرابط</button></div>` +
      (ios ? '<p class="help">إن لم يفتح، اضغط على النقاط الثلاث في أعلى الشاشة ثم «فتح في المتصفح».</p>' : '') +
      '</div>';
    box.querySelector('[data-open-outside]').href = outside;
    box.querySelector('[data-copy-link]').addEventListener('click', () => copyLink(here));
    btn.insertAdjacentElement('afterend', box);
    return box;
  }

  // Said at once, so nobody walks into Google's "Access blocked" page.
  const inAppNote = inApp ? explainInApp() : null;

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
    if (inAppNote) {
      event.preventDefault();
      inAppNote.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      inAppNote.querySelector('[data-open-outside]').focus();
      return;
    }
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
