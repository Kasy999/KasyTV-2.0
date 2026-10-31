/**
 * Lampa as web module.
 *
 * The Lampa page is downloaded and written into a same-origin frame (srcdoc) with a <base> pointing to its server
 * and a hook in front of Lampa's own scripts – the same technique as the Smart-TV version (lampa-boot.js):
 *  - Lampa fills the whole screen (no Kasy navigation or toolbar),
 *  - Back pressed twice quickly / held, or Lampa's "exit?" question → leaves Lampa (previous Kasy view),
 *  - trailers open in Kasy's player.
 * If the Lampa server doesn't allow the download (CORS), Lampa runs as a plain iframe without the hook.
 * The frame stays alive while switching tabs, so Lampa keeps its state.
 */
import { h, icon } from '../core/dom.js';
import { store } from '../core/store.js';
import { inputMode } from '../core/input-mode.js';
import { back as routerBack } from '../core/router.js';
import { isMixedContent } from '../core/util.js';
import { toast } from '../components/toast.js';
import { youtubeId } from '../services/segments.js';
import { playYouTube } from '../player/player.js';

let host = null;
let frame = null;
let loadedUrl = null;
let mode = null; // 'hooked' | 'plain'

const MIRROR = 'https://yumata.github.io/lampa/';
let mirrorNotice = false;

function lampaUrl() {
  if (store.get('lampa.source') === 'local') return new URL('./lampa/', location.href).href;
  let u = (store.get('lampa.url') || '').trim();
  if (!u) return MIRROR;
  if (!/^https?:\/\//i.test(u)) u = (location.protocol === 'https:' ? 'https://' : 'http://') + u;
  u = u.endsWith('/') || /\.html?$/i.test(u) ? u : u + '/';
  // An HTTPS app can't embed an HTTP page – use the official HTTPS build instead of opening a new tab.
  if (isMixedContent(u)) {
    if (!mirrorNotice) {
      mirrorNotice = true;
      toast('HTTP-Adresse von Lampa ist in der HTTPS-App gesperrt – nutze den offiziellen HTTPS-Build', { duration: 4500 });
    }
    return MIRROR;
  }
  return u;
}

/** Leaves the full-screen Lampa: back to the previous Kasy view (start view if Lampa was opened first). */
function exitToNav() {
  if (frame) frame.blur();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  routerBack();
}

/** Installed into Lampa's window before its scripts run. */
window.__kasyLampaHook = function (win) {
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
  // Trailers → Kasy's player.
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

export async function lampaView() {
  const url = lampaUrl();
  if (!host) {
    host = h('div.lampa-host');
    // Small exit button for touch screens (no Back key on iPhone/iPad).
    host.appendChild(h('button.lampa-exit', { type: 'button', 'aria-label': 'Lampa verlassen', title: 'Lampa verlassen', onClick: () => exitToNav() }, icon('back')));
    document.body.appendChild(host);
  }
  const enterFrame = () => {
    if (!frame) return;
    frame.focus();
    try {
      frame.contentWindow.focus();
    } catch {
      /* cross-origin */
    }
  };
  if (!frame || loadedUrl !== url) {
    if (frame) frame.remove();
    frame = await buildFrame(url);
    loadedUrl = url;
    host.insertBefore(frame, host.firstChild);
  }
  host.classList.add('active');
  document.documentElement.classList.add('lampa-open');
  // TV / desktop: real full screen of the device (no browser bars). Silently ignored where not allowed.
  if (inputMode.isTV() && document.documentElement.requestFullscreen && !document.fullscreenElement) {
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }
  if (inputMode.isTV()) toast('Zurück zweimal schnell oder gedrückt halten → Lampa verlassen', { duration: 3500, iconName: 'remote' });
  setTimeout(enterFrame, 300);
  return {
    unmount() {
      host.classList.remove('active');
      document.documentElement.classList.remove('lampa-open');
      if (frame) frame.blur();
    },
  };
}
