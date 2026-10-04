/* MTS Agency — brand homepage interactions (top navigation, mobile menu, product tabs). */
(() => {
  'use strict';

  /* ---------- Top navigation ---------- */
  const nav = document.querySelector('[data-snav]');
  if (nav) {
    const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    const toggle = nav.querySelector('[data-snav-toggle]');
    const sheet = nav.querySelector('[data-snav-sheet]');
    if (toggle && sheet) {
      const setOpen = (open) => {
        sheet.hidden = !open;
        nav.classList.toggle('is-open', open);
        toggle.setAttribute('aria-expanded', String(open));
        const icon = toggle.querySelector('i');
        if (icon) icon.className = open ? 'fa-solid fa-xmark' : 'fa-solid fa-bars';
      };
      toggle.addEventListener('click', () => setOpen(sheet.hidden));
      sheet.addEventListener('click', (e) => {
        if (e.target.closest('a')) setOpen(false);
      });
      document.addEventListener('click', (e) => {
        if (!sheet.hidden && !nav.contains(e.target)) setOpen(false);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !sheet.hidden) {
          setOpen(false);
          toggle.focus();
        }
      });
      window.addEventListener('resize', () => {
        if (!sheet.hidden && window.innerWidth >= 1024) setOpen(false);
      });
    }
  }

  /* ---------- Product tabs ---------- */
  document.querySelectorAll('.h-tabs[role="tablist"]').forEach((list) => {
    const section = list.closest('section') || document;
    const tabs = Array.from(list.querySelectorAll('[data-tab]'));
    const select = (tab, focus) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.classList.toggle('is-on', on);
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
      });
      section.querySelectorAll('[data-tab-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.tabPanel !== tab.dataset.tab;
      });
      if (focus) tab.focus();
    };
    tabs.forEach((tab, i) => {
      const panel = section.querySelector(`[data-tab-panel="${tab.dataset.tab}"]`);
      if (panel) {
        tab.id = tab.id || `h-tab-${tab.dataset.tab}`;
        panel.id = panel.id || `h-panel-${tab.dataset.tab}`;
        tab.setAttribute('aria-controls', panel.id);
        panel.setAttribute('aria-labelledby', tab.id);
      }
      tab.tabIndex = tab.classList.contains('is-on') ? 0 : -1;
      tab.addEventListener('click', () => select(tab, false));
      tab.addEventListener('keydown', (e) => {
        // Arrow keys follow the visual (right-to-left) order.
        const step = { ArrowLeft: 1, ArrowRight: -1 }[e.key];
        if (!step) return;
        e.preventDefault();
        select(tabs[(i + step + tabs.length) % tabs.length], true);
      });
    });
  });
})();
