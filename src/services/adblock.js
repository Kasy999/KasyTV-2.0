/**
 * Client-side ad blocker.
 *
 * What a web app can actually block (and this does):
 *  1. Network guard: fetch() and XMLHttpRequest of the app – and of a same-origin Lampa – refuse requests to ad /
 *     tracking hosts (built-in list + own rules in AdBlock-style "||host^", plain hosts or "/path/" substrings).
 *  2. HLS ad breaks: VOD playlists lose segments between #EXT-X-CUE-OUT / #EXT-X-CUE-IN (also SCTE-35 DATERANGE,
 *     Apple interstitials) and segments served from ad hosts. Live playlists can't drop segments (the media
 *     sequence would break), so ad breaks there are muted and covered (see player/engine.js).
 *  3. Images (logos, banners) from blocked hosts are not loaded.
 * Ads inside cross-origin iframes (YouTube embed, remote Lampa) are out of reach of any web page.
 */
import { store } from '../core/store.js';
import { bus } from '../core/events.js';

export const DEFAULT_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com', 'googletagmanager.com',
  'googletagservices.com', 'adservice.google.com', 'imasdk.googleapis.com', 'pagead2.googlesyndication.com',
  'amazon-adsystem.com', 'adnxs.com', 'adsrvr.org', 'adform.net', 'adition.com', 'criteo.com', 'criteo.net',
  'taboola.com', 'outbrain.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com',
  'smartadserver.com', 'serving-sys.com', 'innovid.com', 'springserve.com', 'spotxchange.com', 'spotx.tv',
  'tremorhub.com', 'teads.tv', 'fwmrm.net', 'freewheel.tv', 'moatads.com', 'scorecardresearch.com', 'quantserve.com',
  'yieldmo.com', 'unrulymedia.com', 'adcolony.com', 'applovin.com', 'unityads.unity3d.com', 'inmobi.com',
  'mgid.com', 'adriver.ru', 'an.yandex.ru', 'mc.yandex.ru', 'yandexadexchange.net', 'adfox.ru', 'betweendigital.com',
  'hotjar.com', 'mixpanel.com', 'branch.io', 'appsflyer.com', 'adjust.com', 'onesignal.com', 'popads.net',
  'propellerads.com', 'exoclick.com', 'juicyads.com', 'trafficjunky.net', 'adsterra.com', 'hilltopads.net',
];

let hostSet = new Set(DEFAULT_HOSTS);
let substrings = [];
let enabled = true;
let blockedCount = 0;

function compile() {
  enabled = store.get('blocker.enabled');
  hostSet = new Set(DEFAULT_HOSTS);
  substrings = [];
  const raw = store.get('blocker.customRules') || '';
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('!') || line.startsWith('#')) continue;
    if (line.startsWith('@@')) continue; // exceptions are not supported – ignore rather than block
    let m = /^\|\|([a-z0-9.-]+)\^?$/i.exec(line);
    if (m) {
      hostSet.add(m[1].toLowerCase());
      continue;
    }
    m = /^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9.-]+)$/i.exec(line); // hosts-file lines
    if (m) {
      hostSet.add(m[1].toLowerCase());
      continue;
    }
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(line)) {
      hostSet.add(line.toLowerCase());
      continue;
    }
    substrings.push(line.toLowerCase());
  }
}

function hostBlocked(host) {
  host = host.toLowerCase();
  // match host and every parent domain: a.b.example.com → b.example.com → example.com
  let h = host;
  for (;;) {
    if (hostSet.has(h)) return true;
    const dot = h.indexOf('.');
    if (dot < 0 || h.indexOf('.', dot + 1) < 0) return false;
    h = h.substring(dot + 1);
  }
}

/** true when the URL must not be requested. */
export function isBlocked(url) {
  if (!enabled || !url) return false;
  let u;
  try {
    u = new URL(url, location.href);
  } catch {
    return false;
  }
  if (u.origin === location.origin) return false;
  if (hostBlocked(u.hostname)) return true;
  if (substrings.length) {
    const s = u.href.toLowerCase();
    for (const sub of substrings) if (s.includes(sub)) return true;
  }
  return false;
}

function count(url) {
  blockedCount++;
  bus.emit('adblock:blocked', { url, total: blockedCount });
}

export function blockedTotal() {
  return blockedCount;
}

/** Wraps fetch / XHR / Image of a window (the app itself, or a same-origin iframe). */
export function guardWindow(win) {
  if (!win || win.__kasyGuard) return;
  win.__kasyGuard = true;
  const origFetch = win.fetch;
  if (origFetch) {
    win.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input && input.url;
      if (isBlocked(url)) {
        count(url);
        return Promise.reject(new TypeError('Kasy TV Werbeblocker: ' + url));
      }
      return origFetch.call(this, input, init);
    };
  }
  const XHR = win.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__kasyBlocked = isBlocked(url) ? url : null;
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      if (this.__kasyBlocked) {
        count(this.__kasyBlocked);
        const self = this;
        setTimeout(() => {
          try {
            self.abort();
          } catch {
            /* ignore */
          }
          if (self.onerror) self.onerror(new ProgressEvent('error'));
          self.dispatchEvent(new ProgressEvent('error'));
        }, 0);
        return;
      }
      return send.apply(this, arguments);
    };
  }
  const desc = Object.getOwnPropertyDescriptor(win.HTMLImageElement.prototype, 'src');
  if (desc && desc.set) {
    Object.defineProperty(win.HTMLImageElement.prototype, 'src', {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        return desc.get.call(this);
      },
      set(v) {
        if (isBlocked(v)) {
          count(v);
          return;
        }
        desc.set.call(this, v);
      },
    });
  }
}

// ---------------- HLS ad breaks ----------------

const CUE_OUT = /^#EXT-X-CUE-OUT(?!-CONT)|^#EXT-X-SCTE35:.*CUE-OUT|^#EXT-OATCLS-SCTE35|^#EXT-X-DATERANGE:.*(SCTE35-OUT|CLASS="com\.apple\.hls\.interstitial")/i;
const CUE_IN = /^#EXT-X-CUE-IN|^#EXT-X-SCTE35:.*CUE-IN|^#EXT-X-DATERANGE:.*SCTE35-IN/i;
const CUE_CONT = /^#EXT-X-CUE-OUT-CONT/i;

/** true for media playlists that are complete (VOD / EVENT ended) – only those may lose segments. */
export function isVodPlaylist(text) {
  return /#EXT-X-ENDLIST/.test(text) || /#EXT-X-PLAYLIST-TYPE:\s*VOD/i.test(text);
}

/**
 * Removes ad breaks from a VOD media playlist. Returns { text, removed, seconds }.
 * Segments of a break are replaced by one #EXT-X-DISCONTINUITY, so decoders reset cleanly.
 */
export function filterVodPlaylist(text, baseUrl) {
  if (!store.get('blocker.enabled') || !store.get('blocker.hlsAdFilter')) return { text, removed: 0, seconds: 0 };
  if (!/#EXTINF/.test(text) || !isVodPlaylist(text)) return { text, removed: 0, seconds: 0 };
  const lines = text.split(/\r?\n/);
  const out = [];
  let inAd = false;
  let pending = []; // tags belonging to the next segment
  let removed = 0;
  let seconds = 0;
  let lastWasGap = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (CUE_OUT.test(line)) {
      inAd = true;
      continue;
    }
    if (CUE_IN.test(line)) {
      inAd = false;
      continue;
    }
    if (CUE_CONT.test(line)) continue;
    if (line.startsWith('#')) {
      // Header / global tags go straight through; per-segment tags wait for their URI.
      if (/^#EXT(INF|-X-BYTERANGE|-X-PROGRAM-DATE-TIME|-X-DISCONTINUITY$|-X-GAP)/.test(line)) pending.push(line);
      else out.push(line);
      continue;
    }
    // segment URI
    let abs = line;
    try {
      abs = new URL(line, baseUrl).toString();
    } catch {
      /* keep */
    }
    const adSegment = inAd || isBlocked(abs);
    if (adSegment) {
      removed++;
      const inf = pending.find((p) => p.startsWith('#EXTINF'));
      if (inf) seconds += parseFloat(inf.substring(8)) || 0;
      pending = [];
      if (!lastWasGap) {
        out.push('#EXT-X-DISCONTINUITY');
        lastWasGap = true;
      }
      continue;
    }
    if (lastWasGap) pending = pending.filter((p) => p !== '#EXT-X-DISCONTINUITY');
    out.push(...pending, line);
    pending = [];
    lastWasGap = false;
  }
  if (!removed) return { text, removed: 0, seconds: 0 };
  return { text: out.join('\n') + '\n', removed, seconds: Math.round(seconds) };
}

/** Whether the tags of a (live) fragment mark an ad break. hls.js gives tagList as [[tag, value], …]. */
export function fragmentIsAd(tagList, state) {
  if (!tagList) return state.inAd;
  for (const t of tagList) {
    const line = '#' + t[0] + (t[1] !== undefined ? ':' + t[1] : '');
    if (CUE_OUT.test(line) || CUE_CONT.test(line)) state.inAd = true;
    if (CUE_IN.test(line)) state.inAd = false;
  }
  return state.inAd;
}

export function initAdblock() {
  compile();
  store.subscribe((path) => {
    if (path === '*' || path.startsWith('blocker')) compile();
  });
  guardWindow(window);
}
