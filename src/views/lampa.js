/**
 * Lampa as web module.
 *
 * The Lampa page is downloaded and written into a same-origin frame (srcdoc) with a <base> pointing to its server
 * and a hook in front of Lampa's own scripts – the same technique as the Smart-TV version (lampa-boot.js):
 *  - the app's ad blocker guards Lampa's fetch/XHR/images,
 *  - Back pressed twice quickly / held, or Lampa's "exit?" question → back to Kasy's navigation,
 *  - trailers open in Kasy's YouTube player (with SponsorBlock).
 * If the Lampa server doesn't allow the download (CORS), Lampa runs as a plain iframe without the hook.
 * The frame stays alive while switching tabs, so Lampa keeps its state.
 */
import { h, icon } from '../core/dom.js';
import { store } from '../core/store.js';
import { focus, focusFirst } from '../core/focus.js';
import { inputMode } from '../core/input-mode.js';
import { navigate } from '../core/router.js';
import { isMixedContent } from '../core/util.js';
import { toast } from '../components/toast.js';
import { emptyState } from '../components/cards.js';
import { guardWindow } from '../services/adblock.js';
import { youtubeId } from '../services/sponsorblock.js';
import { playYouTube } from '../player/player.js';

let host = null;
let frame = null;
let loadedUrl = null;
let mode = null; // 'hooked' | 'plain'

function lampaUrl() {
  if (store.get('lampa.source') === 'local') return new URL('./lampa/', location.href).href;
  let u = (store.get('lampa.url') || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.endsWith('/') || /\.html?$/i.test(u) ? u : u + '/';
}

function exitToNav() {
  const first = document.querySelector('.nav .nav-item.active') || document.querySelector('.nav .nav-item');
  if (frame) frame.blur();
  if (first) focus(first);
}

/** Installed into Lampa's window before its scripts run. */
window.__kasyLampaHook = function (win) {
  guardWindow(win);
  let lastBack = 0;
  let held = false;
  const isBack = (e) => e.keyCode === 10009 || e.keyCode === 461 || e.key === 'GoBack' || e.key === 'BrowserBack';
  win.addEventListener(
    'keydown',
    (e) => {
      if (!isBack(e) && !(e.keyCode === 27 && e.repeat)) return;
      if (e.repeat) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!held) {
          held = true;
          exitToNav();
        }
        return;
      }
      held = false;
      const now = Date.now();
      if (now - lastBack < 700) {
        e.preventDefault();
        e.stopImmediatePropagation();
        exitToNav();
      }
      lastBack = now;
    },
    true,
  );
  const whenReady = (test, fn, tries = 300) => {
    let n = 0;
    const t = setInterval(() => {
      let ok = false;
      try {
        ok = test();
      } catch {
        ok = false;
      }
      if (ok) {
        clearInterval(t);
        fn();
      } else if (++n > tries) clearInterval(t);
    }, 400);
  };
  // Lampa's "exit the app?" → back to the navigation instead.
  whenReady(
    () => win.Lampa && win.Lampa.Select && win.Lampa.Lang,
    () => {
      const L = win.Lampa;
      const original = L.Select.show;
      L.Select.show = function (params) {
        try {
          if (params && params.title === L.Lang.translate('title_out')) {
            if (typeof params.onBack === 'function') params.onBack();
            exitToNav();
            return undefined;
          }
        } catch {
          /* ignore */
        }
        return original.apply(this, arguments);
      };
    },
  );
  // Trailers → Kasy's YouTube player with SponsorBlock.
  whenReady(
    () => win.Lampa && win.Lampa.YouTube && typeof win.Lampa.YouTube.play === 'function',
    () => {
      win.Lampa.YouTube.play = (id) => playYouTube(String(id), { title: 'Trailer' });
    },
    150,
  );
  whenReady(
    () => win.Lampa && win.Lampa.Player && typeof win.Lampa.Player.play === 'function',
    () => {
      const original = win.Lampa.Player.play;
      win.Lampa.Player.play = function (data) {
        const id = data && data.url ? youtubeId(String(data.url)) : null;
        if (id) {
          playYouTube(id, { title: data.title || 'YouTube' });
          return undefined;
        }
        return original.apply(this, arguments);
      };
    },
  );
};

async function buildFrame(url) {
  const f = h('iframe.lampa-frame', {
    title: 'Lampa',
    allow: 'autoplay; fullscreen; picture-in-picture; encrypted-media',
    allowfullscreen: true,
    referrerpolicy: 'no-referrer-when-downgrade',
    data: { focus: true },
  });
  mode = 'plain';
  try {
    const res = await fetch(url.endsWith('/') ? url + 'index.html' : url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let html = await res.text();
    if (!/<html|<script/i.test(html)) throw new Error('kein HTML');
    const base = new URL('.', res.url || url).href;
    const inject = `<base href="${base}"><script>try{parent.__kasyLampaHook(window)}catch(e){}</script>`;
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + inject) : inject + html;
    f.srcdoc = html;
    mode = 'hooked';
  } catch (e) {
    console.info('[lampa] ohne Hook (', e.message, ') – normales iframe');
    f.src = url;
  }
  return f;
}

export async function lampaView(el) {
  const url = lampaUrl();
  const toolbar = h(
    'div.lampa-bar',
    { data: { focusGroup: true } },
    h('span.lampa-title', icon('lamp'), 'Lampa'),
    h('span.lampa-mode.muted'),
    h('span.spacer'),
    h('button.icon-btn.small', { type: 'button', data: { focus: true }, title: 'Lampa bedienen', 'aria-label': 'In Lampa wechseln', onClick: () => enterFrame() }, icon('down')),
    h('button.icon-btn.small', { type: 'button', data: { focus: true }, title: 'Neu laden', 'aria-label': 'Neu laden', onClick: () => reload() }, icon('refresh')),
    h('button.icon-btn.small', { type: 'button', data: { focus: true }, title: 'In neuem Tab öffnen', 'aria-label': 'In neuem Tab öffnen', onClick: () => window.open(url, '_blank', 'noopener') }, icon('external')),
    h('button.icon-btn.small', { type: 'button', data: { focus: true }, title: 'Lampa-Einstellungen', 'aria-label': 'Einstellungen', onClick: () => navigate('/settings/lampa') }, icon('settings')),
  );
  el.append(toolbar);

  if (!url) {
    el.append(emptyState({ iconName: 'lamp', title: 'Keine Lampa-Adresse', text: 'Unter Einstellungen → Lampa die Adresse eintragen (z. B. lampa.mx oder ein eigener Lampa/Wampa-Server).' }));
    return null;
  }
  if (isMixedContent(url)) {
    el.append(
      emptyState({
        iconName: 'info',
        title: 'Lampa über HTTP',
        text: 'Diese App läuft über HTTPS – der Browser lädt die HTTP-Adresse von Lampa nicht im Rahmen. Eine HTTPS-Adresse eintragen, Lampa lokal mitliefern (Quelle „Lokal“) oder in einem neuen Tab öffnen.',
        actions: [h('button.btn.primary', { type: 'button', data: { focus: true }, onClick: () => window.open(url, '_blank', 'noopener') }, icon('external'), h('span.btn-label', 'In neuem Tab öffnen'))],
      }),
    );
    return null;
  }

  if (!host) {
    host = h('div.lampa-host');
    document.querySelector('.content').appendChild(host);
  }
  const reload = async () => {
    if (frame) frame.remove();
    frame = await buildFrame(url);
    loadedUrl = url;
    host.replaceChildren(frame);
    toolbar.querySelector('.lampa-mode').textContent = mode === 'hooked' ? 'integriert · Werbeblocker aktiv' : 'eingebettet';
  };
  const enterFrame = () => {
    if (!frame) return;
    frame.focus();
    try {
      frame.contentWindow.focus();
    } catch {
      /* cross-origin */
    }
  };
  if (!frame || loadedUrl !== url) await reload();
  else toolbar.querySelector('.lampa-mode').textContent = mode === 'hooked' ? 'integriert · Werbeblocker aktiv' : 'eingebettet';
  host.classList.add('active');
  const hint = inputMode.isTV() ? 'Zurück zweimal schnell oder gedrückt halten → Navigation' : null;
  if (hint) toast(hint, { duration: 3500, iconName: 'remote' });
  if (inputMode.isTV()) setTimeout(enterFrame, 300);
  else focusFirst(toolbar);
  return {
    unmount() {
      host.classList.remove('active');
    },
  };
}
