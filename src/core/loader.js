/**
 * Loads the player libraries on demand: first the copy in ./vendor (from node_modules, cached by the service
 * worker), then a pinned CDN copy. Nothing is loaded until the first stream needs it – keeps startup fast on sticks.
 */
const LIBS = {
  hls: {
    global: 'Hls',
    urls: ['./vendor/hls.min.js', 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js'],
  },
  mpegts: {
    global: 'mpegts',
    urls: ['./vendor/mpegts.js', 'https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js'],
  },
  youtube: {
    global: 'YT',
    urls: ['https://www.youtube.com/iframe_api'],
    ready: () =>
      new Promise((resolve) => {
        if (window.YT && window.YT.Player) return resolve();
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
          if (prev) prev();
          resolve();
        };
      }),
  },
};

const pending = {};

function inject(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(new Error('Laden fehlgeschlagen: ' + src));
    };
    document.head.appendChild(s);
  });
}

export function loadLib(name) {
  const lib = LIBS[name];
  if (!lib) return Promise.reject(new Error('Unbekannte Bibliothek ' + name));
  if (window[lib.global] && (!lib.ready || (window.YT && window.YT.Player))) return Promise.resolve(window[lib.global]);
  if (pending[name]) return pending[name];
  pending[name] = (async () => {
    const readyPromise = lib.ready ? lib.ready() : null;
    let lastErr = null;
    for (const url of lib.urls) {
      try {
        await inject(url);
        if (readyPromise) await readyPromise;
        if (window[lib.global]) return window[lib.global];
      } catch (e) {
        lastErr = e;
      }
    }
    pending[name] = null;
    throw lastErr || new Error(name + ' nicht verfügbar');
  })();
  return pending[name];
}
