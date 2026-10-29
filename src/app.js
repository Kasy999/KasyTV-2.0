/** App shell: navigation (side rail on TV/tablet/desktop, tab bar on phones), view outlet, overlay roots. */
import { h, icon } from './core/dom.js';
import { store } from './core/store.js';
import { bus } from './core/events.js';
import { router, navigate, defineRoute } from './core/router.js';
import { inputMode } from './core/input-mode.js';
import { formatClock } from './core/util.js';
import { initToasts, toast } from './components/toast.js';
import { initDialogs } from './components/dialog.js';

import { homeView } from './views/home.js';
import { liveView } from './views/live.js';
import { libraryView, libraryDetailView, libraryBrowseView } from './views/library.js';
import { lampaView } from './views/lampa.js';
import { youtubeView, youtubeSearchView, youtubeWatchView, youtubeChannelView } from './views/youtube.js';
import { settingsView } from './views/settings.js';

const NAV = [
  { path: '/home', label: 'Start', icon: 'home' },
  { path: '/live', label: 'Live-TV', icon: 'tv', module: 'live' },
  { path: '/library', label: 'Videothek', icon: 'film', module: 'library' },
  { path: '/lampa', label: 'Lampa', icon: 'lamp', module: 'lampa' },
  { path: '/youtube', label: 'YouTube', icon: 'youtube', module: 'youtube' },
  { path: '/settings', label: 'Einstellungen', icon: 'settings' },
];

export function mountApp(root) {
  const nav = h('nav.nav', { 'aria-label': 'Navigation', data: { focusGroup: true, focusRegion: true } });
  const outlet = h('main.outlet', { id: 'main' });
  const banner = h('div.banner-slot');
  const clock = h('div.nav-clock');
  root.replaceChildren(
    h('div.shell', nav, h('div.content', { data: { focusRegion: true } }, banner, outlet)),
    h('div.dialog-root'),
    h('div.toast-root', { 'aria-live': 'polite' }),
  );
  initDialogs(root.querySelector('.dialog-root'));
  initToasts(root.querySelector('.toast-root'));

  const renderNav = () => {
    const mods = store.get('ui.modules');
    const items = NAV.filter((n) => !n.module || mods[n.module]);
    nav.replaceChildren(
      h('div.nav-brand', h('img', { src: './icons/icon-192.png', alt: '' }), h('span', 'Kasy TV')),
      h(
        'div.nav-items',
        items.map((n) =>
          h(
            'a.nav-item',
            {
              href: '#' + n.path,
              data: { focus: true, path: n.path },
              onClick: (e) => {
                e.preventDefault();
                navigate(n.path);
              },
            },
            icon(n.icon),
            h('span.nav-label', n.label),
          ),
        ),
      ),
      clock,
      h(
        'button.nav-mode',
        {
          type: 'button',
          data: { focus: true },
          title: 'Bedienung: Touch / Fernbedienung',
          onClick: () => {
            const next = inputMode.isTV() ? 'touch' : 'tv';
            store.set('ui.inputMode', next);
            toast(next === 'tv' ? 'Fernbedienungs-Modus (D-Pad) aktiv' : 'Touch-Modus aktiv', { iconName: next === 'tv' ? 'remote' : 'touch' });
          },
        },
        icon(inputMode.isTV() ? 'remote' : 'touch'),
        h('span.nav-label', inputMode.isTV() ? 'Fernbedienung' : 'Touch'),
      ),
    );
    markActive();
  };
  const markActive = () => {
    const p = router.path || '';
    for (const a of nav.querySelectorAll('.nav-item')) {
      const active = p === a.dataset.path || p.startsWith(a.dataset.path + '/');
      a.classList.toggle('active', active);
      if (active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  };
  const tick = () => (clock.textContent = store.get('ui.showClock') ? formatClock() : '');
  tick();
  setInterval(tick, 15000);

  renderNav();
  store.subscribe((path) => {
    if (path === '*' || path.startsWith('ui')) {
      renderNav();
      tick();
    }
  });
  bus.on('inputmode', renderNav);
  bus.on('route', markActive);

  defineRoute('/home', homeView);
  defineRoute('/live', liveView);
  defineRoute('/library', libraryView);
  defineRoute('/library/view/:id', libraryBrowseView);
  defineRoute('/library/item/:id', libraryDetailView);
  defineRoute('/lampa', lampaView);
  defineRoute('/youtube', youtubeView);
  defineRoute('/youtube/search', youtubeSearchView);
  defineRoute('/youtube/watch/:id', youtubeWatchView);
  defineRoute('/youtube/channel/:id', youtubeChannelView);
  defineRoute('/settings/:section?', settingsView);

  const start = store.get('ui.startView') || 'home';
  router.start(outlet, '/' + start);
  document.documentElement.classList.toggle('route-lampa', false);
  bus.on('route', ({ path }) => document.documentElement.classList.toggle('route-lampa', path === '/lampa'));

  return { banner };
}

/** Thin banner above the view (update available, backup reminder …). */
export function showBanner(slot, { text, actionLabel, onAction, iconName = 'info', dismissible = true }) {
  const el = h(
    'div.banner',
    icon(iconName),
    h('span.banner-text', text),
    actionLabel ? h('button.btn.small.primary', { type: 'button', data: { focus: true }, onClick: () => onAction(el) }, h('span.btn-label', actionLabel)) : null,
    dismissible ? h('button.icon-btn.small', { type: 'button', data: { focus: true }, 'aria-label': 'Ausblenden', onClick: () => el.remove() }, icon('close')) : null,
  );
  slot.appendChild(el);
  return el;
}
