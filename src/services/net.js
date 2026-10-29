/**
 * Network helpers: timeouts, CORS-proxy fallback and readable error messages.
 *
 * Browsers only let a web app read other servers when they send CORS headers. Many IPTV providers don't.
 * Options for the user: upload the playlist file (no network involved), or set a proxy
 * (Einstellungen → IPTV → CORS-Proxy), e.g. `node tools/serve.mjs` of this project, or the old
 * smarttv/tools/kasy-server.ps1 – both offer /proxy?url=…
 */
import { store } from '../core/store.js';
import { isMixedContent } from '../core/util.js';

export class NetError extends Error {
  constructor(message, { status = 0, cors = false, mixed = false } = {}) {
    super(message);
    this.status = status;
    this.cors = cors;
    this.mixed = mixed;
  }
}

export function proxied(url) {
  const tpl = (store.get('iptv.corsProxy') || '').trim();
  if (!tpl) return null;
  if (tpl.includes('{url}')) return tpl.replace('{url}', encodeURIComponent(url));
  return tpl + (tpl.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(url);
}

export async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Fetches text; on a CORS/network failure retries through the configured proxy. */
export async function fetchText(url, { timeout = 30000, useProxy = true } = {}) {
  let res;
  try {
    res = await fetchWithTimeout(url, { cache: 'no-store' }, timeout);
  } catch (e) {
    const viaProxy = useProxy ? proxied(url) : null;
    if (viaProxy) {
      try {
        res = await fetchWithTimeout(viaProxy, { cache: 'no-store' }, timeout);
      } catch {
        throw explain(url, e);
      }
    } else throw explain(url, e);
  }
  if (!res.ok) throw new NetError(`Server antwortet mit HTTP ${res.status}`, { status: res.status });
  const buf = await res.arrayBuffer();
  return { buffer: buf, finalUrl: res.url || url };
}

function explain(url, e) {
  if (e && e.name === 'AbortError') return new NetError('Zeitüberschreitung – der Server antwortet nicht.');
  if (isMixedContent(url)) {
    return new NetError(
      'Die App läuft über HTTPS, die Adresse ist HTTP – der Browser blockiert das (Mixed Content). Playlist-Datei hochladen, HTTPS-Adresse nutzen oder einen CORS-Proxy eintragen.',
      { mixed: true },
    );
  }
  return new NetError(
    'Abruf blockiert (CORS) oder Server nicht erreichbar. Tipp: Playlist als Datei hochladen oder unter Einstellungen → IPTV einen CORS-Proxy eintragen.',
    { cors: true },
  );
}
