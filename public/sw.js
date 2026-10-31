/*
 * Kasy TV service worker.
 *
 *  - App shell: everything listed in precache-manifest.js (written by the build) is cached on install, so the
 *    app starts offline from the homescreen. Without the manifest (dev server / unbuilt) it works network-first.
 *  - Navigations: network first with a short timeout, cached index.html as fallback.
 *  - Same-origin assets + pinned CDN libraries (hls.js, mpegts.js, fonts): cache first, refreshed in background.
 *  - Video streams, playlists, Jellyfin API and Range requests are never cached (too large, always live).
 */
/* global self, caches, importScripts, fetch, URL, Response */
'use strict';

var PRECACHE = { version: 'dev', files: [] };
try {
  importScripts('./precache-manifest.js');
  if (self.__KASY_PRECACHE) PRECACHE = self.__KASY_PRECACHE;
} catch (e) {
  /* dev mode: no manifest */
}
var DEV = PRECACHE.version === 'dev';
var SHELL = 'kasy-shell-' + PRECACHE.version;
var RUNTIME = 'kasy-runtime-v1';
var IMAGES = 'kasy-images-v1';
var MAX_IMAGES = 400;

var CDN_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'fonts.gstatic.com', 'fonts.googleapis.com', 'www.youtube.com'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(SHELL)
      .then(function (cache) {
        if (DEV) return cache.addAll(['./', './index.html', './manifest.json']).catch(function () {});
        // addAll fails completely on one bad file – add one by one instead.
        return Promise.all(
          PRECACHE.files.map(function (f) {
            return cache.add(new Request(f, { cache: 'reload' })).catch(function () {});
          }),
        );
      })
      .then(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (k) {
            if (k.indexOf('kasy-shell-') === 0 && k !== SHELL) return caches.delete(k);
            return null;
          }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type === 'CLEAR_RUNTIME') {
    caches.delete(RUNTIME);
    caches.delete(IMAGES);
  }
});

function isStreamLike(url, request) {
  if (request.headers.has('range')) return true;
  var p = url.pathname.toLowerCase();
  return /\.(m3u8?|ts|m4s|mp4|mkv|webm|mov|avi|aac|mp3|vtt|srt|xml|gz)$/.test(p) ||
    p.indexOf('/videos/') >= 0 || p.indexOf('/audio/') >= 0 || p.indexOf('/sessions/') >= 0 ||
    p.indexOf('/users/') >= 0 || p.indexOf('/proxy') >= 0 || p.indexOf('/api/') >= 0;
}

function timeout(ms, promise) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
    promise.then(function (r) { clearTimeout(t); resolve(r); }, function (e) { clearTimeout(t); reject(e); });
  });
}

function networkFirst(request, cacheName, ms) {
  return timeout(ms, fetch(request))
    .then(function (resp) {
      if (resp && resp.ok) {
        var copy = resp.clone();
        caches.open(cacheName).then(function (c) { c.put(request, copy); });
      }
      return resp;
    })
    .catch(function () {
      return caches.match(request, { ignoreSearch: true }).then(function (hit) {
        return hit || caches.match('./index.html') || caches.match('./');
      });
    });
}

function cacheFirst(request, cacheName) {
  return caches.match(request).then(function (hit) {
    var refresh = fetch(request)
      .then(function (resp) {
        if (resp && (resp.ok || resp.type === 'opaque')) {
          var copy = resp.clone();
          caches.open(cacheName).then(function (c) { c.put(request, copy); });
        }
        return resp;
      })
      .catch(function () { return hit; });
    return hit || refresh;
  });
}

function trimImages() {
  caches.open(IMAGES).then(function (cache) {
    cache.keys().then(function (keys) {
      if (keys.length <= MAX_IMAGES) return;
      for (var i = 0; i < keys.length - MAX_IMAGES; i++) cache.delete(keys[i]);
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  var sameOrigin = url.origin === self.location.origin;

  if (request.mode === 'navigate') {
    if (!sameOrigin) return;
    event.respondWith(networkFirst(request, SHELL, 3500));
    return;
  }

  if (sameOrigin) {
    if (isStreamLike(url, request) && url.pathname.indexOf('/vendor/') < 0) return;
    if (DEV) {
      event.respondWith(networkFirst(request, RUNTIME, 6000));
      return;
    }
    event.respondWith(cacheFirst(request, url.pathname.indexOf('/lampa/') >= 0 ? RUNTIME : SHELL));
    return;
  }

  if (CDN_HOSTS.indexOf(url.hostname) >= 0 && /\.(js|css|woff2?|ttf)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request, RUNTIME));
    return;
  }

  // Posters and channel logos: cached so HOME and the channel list look right offline / load fast on TV sticks.
  if (request.destination === 'image' && !isStreamLike(url, request)) {
    event.respondWith(
      cacheFirst(request, IMAGES).then(function (r) {
        trimImages();
        return r || Response.error();
      }),
    );
  }
});
