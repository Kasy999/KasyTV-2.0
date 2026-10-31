/**
 * Lampa as web module.
 *
 * The Lampa page is downloaded and loaded into a same-origin frame (blob: URL) with a <base> pointing to its server
 * and a hook in front of Lampa's own scripts – the same technique as the Smart-TV version (lampa-boot.js):
 *  - Lampa fills the whole content area next to (TV) / above (phone) the Kasy navigation, without overlapping it,
 *  - a blob: URL, not srcdoc: Lampa's index.html has no doctype and relies on quirks mode (it sets sizes like
 *    style.width = 449 without "px"); srcdoc documents are always in standards mode, so all areas stayed 0 px wide,
 *  - history.pushState/replaceState are patched: in the blob frame Lampa's URLs (other origin) would throw a
 *    SecurityError ("Script error"); the state is kept, only the URL is dropped,
 *  - Back pressed twice quickly / held, or Lampa's "exit?" question → focus goes to the Kasy navigation,
 *  - trailers open in Kasy's player.
 * If the Lampa server doesn't allow the download (CORS), Lampa runs as a plain iframe without the hook.
 * The frame stays alive while switching tabs, so Lampa keeps its state.
 */
import { h, icon } from '../core/dom.js';
import { store } from '../core/store.js';
import { inputMode } from '../core/input-mode.js';
import { focus } from '../core/focus.js';
import { isMixedContent } from '../core/util.js';
import { toast } from '../components/toast.js';
import { youtubeId } from '../services/segments.js';
import { playYouTube } from '../player/player.js';

let host = null;
let frame = null;
let loadedUrl = null;
let mode = null; // 'hooked' | 'plain'
let blobUrl = null;

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

/** Remote: leaves Lampa's controls – the focus goes to the Kasy navigation (Lampa keeps running). */
function exitToNav() {
  if (frame) frame.blur();
  const item = document.querySelector('.nav .nav-item.active') || document.querySelector('.nav .nav-item');
  if (item) focus(item);
}

/** Lampa calls pushState with URLs of its own server – not allowed in the blob frame. Keep state, drop URL. */
function patchHistory(win) {
  const hist = win.history;
  ['pushState', 'replaceState'].forEach((name) => {
    const original = hist[name];
    hist[name] = function (state, title, url) {
      try {
        return original.call(this, state, title, url);
      } catch {
        try {
          return original.call(this, state, title);
        } catch {
          return undefined;
        }
      }
    };
  });
}

/** Installed into Lampa's window before its scripts run. */
window.__kasyLampaHook = function (win) {
  patchHistory(win);
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
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    f.src = blobUrl;
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
    // Inside the content area: sits next to / above the navigation and never covers it.
    document.querySelector('.content').appendChild(host);
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
    host.replaceChildren(frame);
  }
  host.classList.add('active');
  document.documentElement.classList.add('lampa-open');
  // TV / stick: real full screen of the device (no browser bars). Silently ignored where not allowed.
  if (inputMode.isTV() && document.documentElement.requestFullscreen && !document.fullscreenElement) {
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }
  if (inputMode.isTV()) toast('Zurück zweimal schnell oder gedrückt halten → Navigation', { duration: 3500, iconName: 'remote' });
  setTimeout(enterFrame, 300);
  return {
    unmount() {
      host.classList.remove('active');
      document.documentElement.classList.remove('lampa-open');
      if (frame) frame.blur();
    },
  };
}
