/**
 * IPTV repository: playlist sources (URL or uploaded file), parsed channel lists in IndexedDB, favourites,
 * recently watched channels.
 */
import { db } from '../core/db.js';
import { store } from '../core/store.js';
import { bus } from '../core/events.js';
import { uid, decodeText } from '../core/util.js';
import { parseM3u, looksLikeM3u } from './m3u-parser.js';
import { fetchText } from './net.js';

const FAV_KEY = 'iptv.favorites';
const HIST_KEY = 'iptv.history';
const memo = new Map(); // sourceId -> playlist
let favorites = null;
let worker = null;
let workerFailed = false;
let reqId = 0;
const pendingParse = new Map();

function getWorker() {
  if (workerFailed) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./m3u.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pendingParse.get(e.data.id);
      if (!p) return;
      pendingParse.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
    worker.onerror = () => {
      workerFailed = true;
      worker = null;
      for (const [, p] of pendingParse) p.fallback();
      pendingParse.clear();
    };
  } catch {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

/** Parses in a worker (big lists), falling back to the main thread. */
export function parsePlaylist(text, baseUrl) {
  const w = text.length > 200000 ? getWorker() : null;
  if (!w) return Promise.resolve(parseM3u(text, { baseUrl }));
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    pendingParse.set(id, { resolve, reject, fallback: () => resolve(parseM3u(text, { baseUrl })) });
    w.postMessage({ id, text, baseUrl });
  });
}

function sources() {
  return store.get('iptv.sources') || [];
}

export function getSources() {
  return sources();
}

export function getActiveSource() {
  const list = sources();
  const id = store.get('iptv.activeSourceId');
  return list.find((s) => s.id === id) || list[0] || null;
}

export function setActiveSource(id) {
  store.set('iptv.activeSourceId', id);
  bus.emit('iptv:changed', { sourceId: id });
}

async function savePlaylist(source, parsed) {
  if (!parsed.channels.length) {
    if (parsed.isMaster) throw new Error('Das ist ein einzelner HLS-Stream, keine Senderliste. Unter „Einzelnen Stream abspielen“ öffnen.');
    throw new Error('Keine Sender in der Datei gefunden.');
  }
  const playlist = {
    id: source.id,
    channels: parsed.channels,
    groups: parsed.groups,
    epgUrls: parsed.epgUrls,
    updatedAt: Date.now(),
  };
  await db.playlistPut(playlist);
  memo.set(source.id, playlist);
  const list = sources().map((s) => (s.id === source.id ? { ...s, count: parsed.channels.length, groups: parsed.groups.length, updatedAt: playlist.updatedAt, error: null } : s));
  store.set('iptv.sources', list);
  bus.emit('iptv:changed', { sourceId: source.id });
  return playlist;
}

/** Adds a URL source and loads it. */
export async function addUrlSource(name, url) {
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Bitte eine vollständige Adresse mit http:// oder https:// eingeben.');
  const source = { id: uid('src_'), name: name || hostName(url), type: 'url', url, createdAt: Date.now() };
  store.set('iptv.sources', sources().concat(source));
  try {
    await refreshSource(source.id);
  } catch (e) {
    markError(source.id, e.message);
    throw e;
  }
  if (!store.get('iptv.activeSourceId')) setActiveSource(source.id);
  return source;
}

/** Adds an uploaded file (File from <input type=file>). */
export async function addFileSource(file, name) {
  const buffer = await file.arrayBuffer();
  const text = decodeText(buffer);
  if (!looksLikeM3u(text)) throw new Error(`„${file.name}“ ist keine M3U-Playlist.`);
  const parsed = await parsePlaylist(text, null);
  const source = { id: uid('src_'), name: name || file.name.replace(/\.(m3u8?|txt)$/i, ''), type: 'file', fileName: file.name, createdAt: Date.now() };
  store.set('iptv.sources', sources().concat(source));
  await savePlaylist(source, parsed);
  // Keep the raw text so the backup can contain the file (it can't be downloaded again).
  await db.set('iptv.raw.' + source.id, text);
  setActiveSource(source.id);
  return source;
}

/** Replaces the content of an existing file source with a new upload. */
export async function replaceFileSource(id, file) {
  const source = sources().find((s) => s.id === id);
  if (!source) return;
  const text = decodeText(await file.arrayBuffer());
  const parsed = await parsePlaylist(text, null);
  await savePlaylist({ ...source, fileName: file.name }, parsed);
  await db.set('iptv.raw.' + id, text);
}

export async function refreshSource(id) {
  const source = sources().find((s) => s.id === id);
  if (!source) throw new Error('Quelle nicht gefunden');
  if (source.type !== 'url') {
    const raw = await db.get('iptv.raw.' + id);
    if (!raw) throw new Error('Datei-Quelle: bitte die Datei erneut hochladen.');
    return savePlaylist(source, await parsePlaylist(raw, null));
  }
  const { buffer, finalUrl } = await fetchText(source.url);
  const text = decodeText(buffer);
  if (!looksLikeM3u(text)) throw new Error('Die Adresse liefert keine M3U-Playlist.');
  return savePlaylist(source, await parsePlaylist(text, finalUrl));
}

function markError(id, message) {
  store.set('iptv.sources', sources().map((s) => (s.id === id ? { ...s, error: message } : s)));
}

export async function removeSource(id) {
  store.set('iptv.sources', sources().filter((s) => s.id !== id));
  memo.delete(id);
  await db.playlistDel(id);
  await db.del('iptv.raw.' + id);
  if (store.get('iptv.activeSourceId') === id) setActiveSource((sources()[0] || {}).id || null);
  bus.emit('iptv:changed', { sourceId: null });
}

export function setSourceEpg(id, epgUrl) {
  store.set('iptv.sources', sources().map((s) => (s.id === id ? { ...s, epgUrl } : s)));
  bus.emit('iptv:changed', { sourceId: id });
}

export function renameSource(id, name) {
  store.set('iptv.sources', sources().map((s) => (s.id === id ? { ...s, name } : s)));
  bus.emit('iptv:changed', { sourceId: id });
}

/** The parsed playlist of a source (memory → IndexedDB → network). */
async function loadRawPlaylist(id) {
  if (memo.has(id)) return memo.get(id);
  const pl = await db.playlistGet(id);
  if (pl) {
    memo.set(id, pl);
    return pl;
  }
  const source = sources().find((s) => s.id === id);
  if (source && source.type === 'url') return refreshSource(id);
  return null;
}

const archived = new Map(); // id -> { sig, raw, pl }

/**
 * Archive setting of a source: many providers support catch-up although the playlist doesn't say so
 * (no catchup attributes). source.archive = { type: 'auto' | SHIFT | FLUSSONIC | XTREAM | DEFAULT, days, source }
 * forces it for every channel without own catch-up data.
 */
function applyArchive(source, pl) {
  const a = source && source.archive;
  if (!pl || !a || !a.type || a.type === 'auto') return pl;
  const sig = JSON.stringify(a);
  const hit = archived.get(pl.id);
  if (hit && hit.sig === sig && hit.raw === pl) return hit.pl;
  const days = Math.max(1, parseInt(a.days, 10) || 7);
  const channels = pl.channels.map((ch) =>
    ch.catchup && ch.catchup.type !== 'NONE' && ch.catchup.days > 0 ? ch : { ...ch, catchup: { type: a.type, source: a.source || null, days } },
  );
  const out = { ...pl, channels };
  archived.set(pl.id, { sig, raw: pl, pl: out });
  return out;
}

export async function getPlaylist(id) {
  if (!id) return null;
  const pl = await loadRawPlaylist(id);
  return applyArchive(sources().find((s) => s.id === id), pl);
}

export function setSourceArchive(id, archive) {
  store.set('iptv.sources', sources().map((s) => (s.id === id ? { ...s, archive } : s)));
  bus.emit('iptv:changed', { sourceId: id });
}

/** Refreshes URL sources older than the configured interval (in the background). */
export function refreshStale() {
  const hours = store.get('iptv.autoRefreshHours') || 0;
  if (!hours || !navigator.onLine) return;
  for (const s of sources()) {
    if (s.type === 'url' && (!s.updatedAt || Date.now() - s.updatedAt > hours * 3600e3)) {
      refreshSource(s.id).catch((e) => markError(s.id, e.message));
    }
  }
}

export function channelKey(sourceId, ch) {
  return sourceId + '|' + ch.id;
}

// ---- favourites ----
async function loadFavorites() {
  if (!favorites) favorites = new Set((await db.get(FAV_KEY)) || []);
  return favorites;
}

export async function isFavorite(key) {
  return (await loadFavorites()).has(key);
}

export async function toggleFavorite(key) {
  const f = await loadFavorites();
  if (f.has(key)) f.delete(key);
  else f.add(key);
  await db.set(FAV_KEY, Array.from(f));
  bus.emit('iptv:favorites');
  return f.has(key);
}

export async function favoriteKeys() {
  return loadFavorites();
}

// ---- history ----
export async function addHistory(sourceId, ch) {
  const list = ((await db.get(HIST_KEY)) || []).filter((e) => e.key !== channelKey(sourceId, ch));
  list.unshift({ key: channelKey(sourceId, ch), sourceId, channel: slim(ch), at: Date.now() });
  await db.set(HIST_KEY, list.slice(0, 30));
  bus.emit('iptv:history');
}

export async function history() {
  return (await db.get(HIST_KEY)) || [];
}

/** Resolves channel objects for keys (favourites across sources). */
export async function channelsForKeys(keys) {
  const out = [];
  const bySource = new Map();
  for (const k of keys) {
    const i = k.indexOf('|');
    const sid = k.slice(0, i);
    if (!bySource.has(sid)) bySource.set(sid, []);
    bySource.get(sid).push(k.slice(i + 1));
  }
  for (const [sid, ids] of bySource) {
    const pl = await getPlaylist(sid).catch(() => null);
    if (!pl) continue;
    const want = new Set(ids);
    for (const ch of pl.channels) if (want.has(ch.id)) out.push({ sourceId: sid, channel: ch });
  }
  return out;
}

function slim(ch) {
  return { id: ch.id, name: ch.name, url: ch.url, logo: ch.logo, group: ch.group, number: ch.number, kind: ch.kind };
}

function hostName(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'Playlist';
  }
}

/** Filter + sort for the channel list. */
export function selectChannels(playlist, { group = '__all', query = '', favs = null, sort = 'default', sourceId } = {}) {
  if (!playlist) return [];
  let list = playlist.channels;
  if (group === '__favorites') list = list.filter((c) => favs && favs.has(channelKey(sourceId, c)));
  else if (group !== '__all') list = list.filter((c) => c.group === group);
  if (query) {
    const q = query.toLowerCase();
    list = list.filter((c) => c.name.toLowerCase().includes(q) || String(c.number) === q);
  }
  if (sort === 'name') list = list.slice().sort((a, b) => a.name.localeCompare(b.name, 'de'));
  else if (sort === 'number') list = list.slice().sort((a, b) => a.number - b.number);
  return list;
}
