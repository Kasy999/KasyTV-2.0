/**
 * EPG (XMLTV) – streaming parser (plain or .gz, hundreds of MB) and per-playlist programme store.
 * Port of XmltvParser.kt / xmltv.js: the download is read chunk by chunk, only programmes of channels that are in
 * the playlist and inside the time window (archive days back … 2 days ahead) are kept.
 *
 * Sources: the url-tvg / x-tvg-url of the playlist plus an EPG address set per source in the settings.
 * Programmes are matched to channels by tvg-id, then by (normalised) tvg-name / channel name.
 */
import { db } from '../core/db.js';
import { store } from '../core/store.js';
import { bus } from '../core/events.js';
import { loadLib } from '../core/loader.js';
import { proxied } from './net.js';
import { hashString, isMixedContent } from '../core/util.js';
import { getPlaylist, getSources } from './iptv.js';

const DAY = 86400000;
const KEY = (sourceId) => 'epg.' + sourceId;
const memo = new Map(); // sourceId -> { programs: { channelId: [[start, stop, title, desc, cat]] }, updatedAt, count }
const loading = new Map(); // sourceId -> Promise

const NON_ALNUM = /[^a-z0-9а-яё]/g;
// Quality tags only as separate words ("ZDF HD" → zdf), never inside a name ("ZDF" must not lose its "f").
const QUALITY = /(^|[^a-z0-9а-яё])(uhd|fhd|hd|sd|4k|hevc|h265|h264|50fps|orig|\+1)(?=$|[^a-z0-9а-яё])/g;

/**
 * Comparable form of a channel name or XMLTV id: "Das Erste HD" / "DasErste.de" / "3sat.de@SD" / "3sat (720p)"
 * → "daserste" / "3sat". Drops iptv-org feed suffixes (@SD), bracketed notes, a 2-letter country ending and
 * quality tags.
 */
export function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/@[^@]*$/, '')
    .replace(/\s*[([][^)\]]*[)\]]/g, ' ')
    .trim()
    .replace(/\.[a-z]{2}$/, '')
    .replace(QUALITY, '$1')
    .replace(QUALITY, '$1')
    .replace(NON_ALNUM, '');
}

/** Match keys of a name: normalised, plus without generic words ("BR Fernsehen" ↔ "BR", "Bibel TV" ↔ "Bibel"). */
export function nameKeys(name) {
  const keys = new Set();
  const a = normalizeName(name);
  if (a) keys.add(a);
  const stripped = String(name || '').replace(/@[^@]*$/, '').replace(/\b(fernsehen|television|tv|channel|kanal|sender)\b/gi, ' ');
  const b = normalizeName(stripped);
  if (b && b.length >= 2) keys.add(b);
  return keys;
}

/** XMLTV id without the iptv-org feed suffix ("3sat.de@SD" → "3sat.de"), lower case. */
function baseId(id) {
  return String(id || '').toLowerCase().replace(/@[^@]*$/, '').trim();
}

/** Free EPG mirrored by the GitHub workflow next to the app (./epg/<id>.xml.gz, same origin → no CORS). */
export const MIRRORS = [
  { value: 'de', label: 'Deutschland' },
  { value: 'at', label: 'Österreich' },
  { value: 'ch', label: 'Schweiz' },
];
export function mirrorUrl(id) {
  return new URL(`./epg/${id}.xml.gz`, location.href).href;
}

/**
 * EPG addresses from playlists (url-tvg) that the provider doesn't let web apps load (CORS) are mirrored by
 * the GitHub workflow as well: one file per address in epg-urls/ → ./epg/m3u/<hash>.xml.gz on the app's origin.
 */
export function m3uMirrorId(url) {
  return hashString(String(url).trim());
}
export function m3uMirrorUrl(url) {
  return new URL(`./epg/m3u/${m3uMirrorId(url)}.xml.gz`, location.href).href;
}

/** GitHub page that adds an EPG address to the mirror (one commit, the workflow does the rest). */
export function mirrorRegisterLink(url) {
  const m = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname || '');
  const repo = (location.pathname || '').split('/').filter(Boolean)[0];
  if (!m || !repo) return null;
  const q = new URLSearchParams({ filename: `epg-urls/${m3uMirrorId(url)}.txt`, value: String(url).trim() + '\n' });
  return `https://github.com/${m[1]}/${repo}/new/main?${q}`;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] !== undefined ? ENTITIES[e.toLowerCase()] : m;
  });
}

/** XMLTV time "yyyyMMddHHmmss +ZZZZ" (offset and seconds optional) → epoch ms. */
export function parseTime(v) {
  if (!v || v.length < 12) return 0;
  v = v.trim();
  let ms = Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(8, 10), +v.slice(10, 12), v.length >= 14 && /\d/.test(v[12]) ? +v.slice(12, 14) : 0);
  const sp = v.indexOf(' ');
  const tz = sp >= 0 ? v.slice(sp + 1).trim() : '';
  if (tz.length >= 5 && (tz[0] === '+' || tz[0] === '-')) {
    const off = +tz.slice(1, 3) * 3600000 + +tz.slice(3, 5) * 60000;
    ms -= tz[0] === '-' ? -off : off;
  }
  return ms;
}

function attr(tag, name) {
  const m = new RegExp('\\s' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')').exec(tag);
  return m ? decodeEntities(m[2] !== undefined ? m[2] : m[3]) : null;
}

function elementText(block, name) {
  const open = block.indexOf('<' + name);
  if (open < 0) return null;
  const gt = block.indexOf('>', open);
  if (gt < 0 || block[gt - 1] === '/') return null;
  const close = block.indexOf('</' + name + '>', gt);
  if (close < 0) return null;
  let text = block.slice(gt + 1, close);
  if (text.includes('<![CDATA[')) text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeEntities(text.trim());
}

/** Incremental XMLTV parser: feed(text) chunk by chunk, then finish(). */
export class XmltvParser {
  constructor(filter) {
    this.filter = filter; // { fromMs, toMs, acceptChannel(id, displayNames) }
    this.buf = '';
    this.programs = {};
    this.channelNames = {};
    this.accepted = {};
    this.count = 0;
  }

  feed(text) {
    const buf = this.buf + text;
    let pos = 0;
    let p = buf.indexOf('<programme', 0);
    let c = buf.indexOf('<channel', 0);
    for (;;) {
      if (p >= 0 && p < pos) p = buf.indexOf('<programme', pos);
      if (c >= 0 && c < pos) c = buf.indexOf('<channel', pos);
      if (p < 0 && c < 0) {
        pos = Math.max(pos, buf.length - 16); // a tag may be split between chunks
        break;
      }
      const isProgramme = !(c >= 0 && (p < 0 || c < p));
      const start = isProgramme ? p : c;
      const closeTag = isProgramme ? '</programme>' : '</channel>';
      const end = buf.indexOf(closeTag, start);
      if (end < 0) {
        const gt = buf.indexOf('>', start);
        if (gt > 0 && buf[gt - 1] === '/') {
          pos = gt + 1;
          continue;
        }
        pos = start;
        break;
      }
      const block = buf.slice(start, end);
      if (isProgramme) this.programme(block);
      else this.channel(block);
      pos = end + closeTag.length;
    }
    this.buf = buf.slice(pos);
  }

  channel(block) {
    const id = attr(block.slice(0, block.indexOf('>') + 1), 'id');
    if (!id) return;
    const names = this.channelNames[id] || (this.channelNames[id] = []);
    const re = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
    let m;
    while ((m = re.exec(block)) !== null) {
      const name = decodeEntities(m[1].trim());
      if (name) names.push(name);
    }
  }

  programme(block) {
    const tag = block.slice(0, block.indexOf('>') + 1);
    const ch = attr(tag, 'channel');
    if (!ch) return;
    const start = parseTime(attr(tag, 'start'));
    let stop = parseTime(attr(tag, 'stop'));
    if (stop <= start) stop = start + 30 * 60000;
    const f = this.filter;
    if (stop < f.fromMs || start > f.toMs) return;
    let ok = this.accepted[ch];
    if (ok === undefined) ok = this.accepted[ch] = f.acceptChannel(ch, this.channelNames[ch] || []);
    if (!ok || !ok.length) return;
    const entry = [start, stop, elementText(block, 'title') || '—', elementText(block, 'desc') || null, elementText(block, 'category') || null];
    for (const target of ok) (this.programs[target] || (this.programs[target] = [])).push(entry);
    this.count++;
  }

  finish() {
    for (const k of Object.keys(this.programs)) {
      const list = this.programs[k].sort((a, b) => a[0] - b[0]);
      const cleaned = [];
      for (const e of list) if (!cleaned.length || e[0] >= cleaned[cleaned.length - 1][0] + 1) cleaned.push(e);
      this.programs[k] = cleaned;
    }
    return { programs: this.programs, count: this.count };
  }
}

// ---------------------------------------------------------------- download

/**
 * Opens an EPG address. Tries in turn: directly, the HTTPS variant of an HTTP address (HTTPS app), the
 * configured proxy, and the Kasy mirror of this address (epg-urls/ in the repository).
 * → { res, via: 'direct' | 'https' | 'proxy' | 'mirror' }
 */
async function openStream(url, { mirror = false } = {}) {
  const tries = [];
  if (!isMixedContent(url)) tries.push(['direct', url]);
  else tries.push(['https', url.replace(/^http:/i, 'https:')]);
  const p = proxied(url);
  if (p) tries.push(['proxy', p]);
  if (mirror) tries.push(['mirror', m3uMirrorUrl(url)]);
  let last = null;
  for (const [via, u] of tries) {
    try {
      const res = await fetch(u, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (!res.body || !res.body.getReader) throw new Error('Browser kann das EPG nicht stückweise lesen');
      return { res, via };
    } catch (e) {
      last = via === 'mirror' ? new Error('noch nicht im Kasy-Spiegel') : e;
    }
  }
  const blocked = !last || /fetch|network|cors|load failed/i.test(last.message) || last.message === 'noch nicht im Kasy-Spiegel';
  const err = new Error(blocked ? 'Der Anbieter erlaubt Web-Apps den Abruf nicht (CORS)' : 'EPG: ' + last.message);
  err.blocked = blocked;
  throw err;
}

/** Reads a response as text chunks, gunzipping .gz on the fly (DecompressionStream or pako). */
async function readText(res, onChunk, onProgress) {
  const reader = res.body.getReader();
  let first = await reader.read();
  if (first.done) return;
  const head = first.value;
  const gz = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  let received = head.length;
  onProgress(received);

  if (gz && typeof DecompressionStream === 'function') {
    const src = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(head);
      },
      async pull(ctrl) {
        const r = await reader.read();
        if (r.done) ctrl.close();
        else {
          received += r.value.length;
          onProgress(received);
          ctrl.enqueue(r.value);
        }
      },
    });
    const textReader = src.pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const r = await textReader.read();
      if (r.done) break;
      onChunk(r.value);
    }
    return;
  }

  const decoder = new TextDecoder('utf-8');
  let inflate = null;
  if (gz) {
    const pako = await loadLib('pako');
    inflate = new pako.Inflate();
    inflate.onData = (out) => onChunk(decoder.decode(out, { stream: true }));
  }
  const handle = (chunk) => {
    if (inflate) {
      inflate.push(chunk, false);
      if (inflate.err) throw new Error('gzip: ' + inflate.msg);
    } else onChunk(decoder.decode(chunk, { stream: true }));
  };
  handle(head);
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    received += r.value.length;
    onProgress(received);
    handle(r.value);
  }
  if (inflate) inflate.push(new Uint8Array(0), true);
  const rest = decoder.decode();
  if (rest) onChunk(rest);
}

function sourceEpgUrls(source, playlist) {
  const own = (source.epgUrl || '').split(/[\s,]+/).filter(Boolean);
  return own.length ? own : (playlist.epgUrls || []).slice(0, 3);
}

function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
}

function mirrorUrls() {
  const m = store.get('iptv.epgMirror');
  return m && m !== 'off' ? [mirrorUrl(m)] : [];
}

/** Downloads the EPG of a playlist source and stores it. */
export async function refreshEpg(sourceId) {
  if (loading.has(sourceId)) return loading.get(sourceId);
  const job = (async () => {
    const source = getSources().find((s) => s.id === sourceId);
    const playlist = await getPlaylist(sourceId);
    if (!source || !playlist) throw new Error('Keine Senderliste');
    const primary = sourceEpgUrls(source, playlist);
    const mirrors = mirrorUrls();
    if (!primary.length && !mirrors.length) throw new Error('Die Playlist enthält keine EPG-Adresse (url-tvg). Unter Einstellungen → IPTV-Quellen eine EPG-Adresse oder das freie Kasy-EPG wählen.');

    // Matching tables: tvg-id → channels, normalised names → channels
    const byId = new Map();
    const byBaseId = new Map();
    const byName = new Map();
    let maxDays = 0;
    const add = (map, k, v) => (map.get(k) || map.set(k, []).get(k)).push(v);
    for (const ch of playlist.channels) {
      if (ch.tvgId) {
        add(byId, ch.tvgId, ch.id);
        add(byBaseId, baseId(ch.tvgId), ch.id);
        for (const k of nameKeys(ch.tvgId)) add(byName, k, ch.id);
      }
      for (const n of [ch.tvgName, ch.name]) for (const k of nameKeys(n)) add(byName, k, ch.id);
      if (ch.catchup && ch.catchup.days > maxDays) maxDays = ch.catchup.days;
    }
    const now = Date.now();
    const filter = {
      fromMs: now - Math.min(Math.max(maxDays, 1), 14) * DAY - DAY / 2,
      toMs: now + 2 * DAY,
      acceptChannel(id, names) {
        const out = new Set(byId.get(id) || byBaseId.get(baseId(id)) || []);
        if (!out.size) {
          for (const n of [id, ...names]) for (const k of nameKeys(n)) for (const x of byName.get(k) || []) out.add(x);
        }
        return Array.from(out);
      },
    };

    const parser = new XmltvParser(filter);
    let lastError = null;
    const used = [];
    const via = {};
    const blocked = [];
    const tryUrls = async (urls, { mirror = false } = {}) => {
      for (const url of urls) {
        try {
          const o = await openStream(url, { mirror });
          await readText(o.res, (t) => parser.feed(t), (bytes) => bus.emit('epg:progress', { sourceId, bytes, url }));
          used.push(url);
          via[url] = o.via;
        } catch (e) {
          lastError = e;
          if (mirror && e.blocked) blocked.push(url);
          console.warn('[epg]', url, e.message);
        }
      }
    };
    // EPG of the playlist (url-tvg) or the address set for the source.
    await tryUrls(primary, { mirror: true });
    // Provider EPG missing or blocked (CORS) → free mirrored EPG; also when it matched almost no channel.
    let primaryFailed = primary.length > 0 && !used.length;
    if (mirrors.length && (!used.length || Object.keys(parser.programs).length < Math.min(5, playlist.channels.length))) {
      await tryUrls(mirrors.filter((m) => !used.includes(m)));
    }
    if (!used.length && blocked.length) {
      const err = new Error(`Das EPG der Playlist (${hostOf(blocked[0])}) sperrt Web-Apps (CORS). Unter Einstellungen → IPTV-Quellen → „EPG der Playlist freischalten“ einmalig für den Kasy-Spiegel freigeben.`);
      err.blocked = blocked;
      throw err;
    }
    if (!used.length) throw lastError || new Error('EPG nicht ladbar');
    const { programs, count } = parser.finish();
    const data = {
      programs,
      count,
      channels: Object.keys(programs).length,
      total: playlist.channels.length,
      sources: used,
      via,
      primary,
      blocked,
      primaryFailed: primaryFailed ? (lastError && lastError.message) || 'nicht ladbar' : null,
      updatedAt: Date.now(),
    };
    await db.set(KEY(sourceId), data);
    memo.set(sourceId, data);
    bus.emit('epg:changed', { sourceId });
    return data;
  })();
  loading.set(sourceId, job);
  try {
    const d = await job;
    errors.delete(sourceId);
    return d;
  } catch (e) {
    errors.set(sourceId, e);
    bus.emit('epg:error', { sourceId, error: e });
    throw e;
  } finally {
    loading.delete(sourceId);
  }
}

/** Last load error of a source (with .blocked = addresses the provider doesn't let web apps load). */
export function epgError(sourceId) {
  return errors.get(sourceId) || null;
}

/** EPG addresses of a source: own setting, otherwise url-tvg of the playlist. */
export async function playlistEpgUrls(sourceId) {
  const source = getSources().find((s) => s.id === sourceId);
  const playlist = await getPlaylist(sourceId);
  return source && playlist ? sourceEpgUrls(source, playlist) : [];
}

/** EPG of a source from memory/IndexedDB; loads in the background when missing or older than 12 h. */
export async function getEpg(sourceId, { autoRefresh = true } = {}) {
  let data = memo.get(sourceId);
  if (!data) {
    data = (await db.get(KEY(sourceId))) || null;
    if (data) memo.set(sourceId, data);
  }
  const stale = !data || !data.channels || Date.now() - data.updatedAt > 12 * 3600e3;
  if (autoRefresh && stale && navigator.onLine) {
    const p = refreshEpg(sourceId).catch((e) => {
      bus.emit('epg:error', { sourceId, message: e.message });
      return null;
    });
    if (!data || !data.channels) data = (await p) || data;
  }
  return data;
}

const errors = new Map();

export function epgStatus(sourceId) {
  return memo.get(sourceId) || null;
}

export async function clearEpg(sourceId) {
  memo.delete(sourceId);
  await db.del(KEY(sourceId));
}

function shiftMs(channel) {
  return ((channel.tvgShiftHours || 0) + (store.get('iptv.epgShift') || 0)) * 3600000;
}

/** Programmes of a channel as objects (time shift applied). */
export function programmesFor(epg, channel) {
  if (!epg || !channel) return [];
  const list = epg.programs[channel.id];
  if (!list) return [];
  const shift = shiftMs(channel);
  return list.map(([start, stop, title, desc, cat]) => ({ start: start + shift, stop: stop + shift, title, desc, cat }));
}

/** { now, next, progress } of a channel. */
export function nowNext(epg, channel, t = Date.now()) {
  const list = programmesFor(epg, channel);
  let lo = 0;
  let hi = list.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= t) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const now = idx >= 0 && list[idx].stop > t ? list[idx] : null;
  const next = list[idx + 1] || null;
  return { now, next, progress: now ? (t - now.start) / (now.stop - now.start) : 0 };
}

export function formatHm(ts) {
  return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}
