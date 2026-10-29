/**
 * YouTube without ads: browsing and playback through the Invidious API (open-source YouTube front end).
 *
 *  - Trends, categories, search with suggestions, channels, video details, related videos, captions.
 *  - Streams are proxied by the instance (local=true) and play in the Kasy player – no YouTube ads, plus
 *    SponsorBlock, the app's ad blocker and the subtitle styles. HD via DASH (dash.js) on MSE devices,
 *    HLS for live streams, muxed MP4 as fallback.
 *  - Instance: "auto" picks a healthy public instance with API + CORS from api.invidious.io and switches on
 *    errors; a self-hosted instance (most reliable) can be entered in the settings.
 *  - Subscriptions, watch later and history are stored locally (IndexedDB) – no Google account needed.
 */
import { db } from '../core/db.js';
import { store } from '../core/store.js';
import { bus } from '../core/events.js';
import { youtubeId } from './sponsorblock.js';

export { youtubeId };

const HIST = 'youtube.history';
const SUBS = 'youtube.subscriptions';
const LATER = 'youtube.later';
const FEED_CACHE = 'cache.youtube.feed';
const INSTANCE_KEY = 'kasy.yt.instance';
const DIRECTORY = 'https://api.invidious.io/instances.json?sort_by=health';
const FALLBACK_INSTANCES = ['https://yt.chocolatemoo53.com', 'https://invidious.nerdvpn.de', 'https://inv.nadeko.net', 'https://yewtu.be'];

const bad = new Map(); // instance -> until timestamp
let candidates = null;
let current = null;

function cfg() {
  return store.get('youtube');
}

function region() {
  return cfg().region || 'DE';
}

function clean(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

async function timedFetch(url, ms = 10000, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** List of instances to try, best first. */
async function instanceList() {
  const custom = clean(cfg().instance);
  if (custom && cfg().backend === 'custom') return [custom];
  if (candidates) return candidates;
  let list = [];
  try {
    const res = await timedFetch(DIRECTORY, 8000);
    const data = await res.json();
    list = data
      .filter(([, i]) => i.type === 'https' && i.api && i.cors !== false)
      .map(([, i]) => clean(i.uri));
  } catch {
    /* directory down – use the built-in list */
  }
  for (const f of FALLBACK_INSTANCES) if (!list.includes(f)) list.push(f);
  try {
    const remembered = localStorage.getItem(INSTANCE_KEY);
    if (remembered && list.includes(remembered)) list = [remembered].concat(list.filter((x) => x !== remembered));
  } catch {
    /* ignore */
  }
  if (custom) list.unshift(custom);
  candidates = list;
  return list;
}

function markBad(inst) {
  bad.set(inst, Date.now() + 10 * 60e3);
  if (current === inst) current = null;
}

/** GET an Invidious API path with automatic instance fail-over. */
async function api(path, params = {}) {
  const list = await instanceList();
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
  const qs = q.toString() ? '?' + q : '';
  const ordered = current ? [current].concat(list.filter((x) => x !== current)) : list;
  let lastErr = null;
  for (const inst of ordered) {
    if ((bad.get(inst) || 0) > Date.now() && ordered.length > 1) continue;
    try {
      const res = await timedFetch(`${inst}/api/v1${path}${qs}`, 12000);
      if (res.status === 404) throw Object.assign(new Error('Nicht gefunden'), { notFound: true });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (json && json.error && !Array.isArray(json)) throw Object.assign(new Error(json.error), { apiError: true });
      if (current !== inst) {
        current = inst;
        try {
          localStorage.setItem(INSTANCE_KEY, inst);
        } catch {
          /* ignore */
        }
        bus.emit('youtube:instance', inst);
      }
      return { data: json, instance: inst };
    } catch (e) {
      lastErr = e;
      if (e.notFound) throw e;
      markBad(inst);
    }
  }
  throw new Error('Kein YouTube-Server erreichbar' + (lastErr ? ` (${lastErr.message})` : '') + '. Unter Einstellungen → YouTube eine andere Instanz eintragen.');
}

export function currentInstance() {
  return current;
}

export function resetInstances() {
  candidates = null;
  current = null;
  bad.clear();
  try {
    localStorage.removeItem(INSTANCE_KEY);
  } catch {
    /* ignore */
  }
}

export async function testInstance(url) {
  const res = await timedFetch(`${clean(url)}/api/v1/trending?region=${region()}`, 10000);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  if (!Array.isArray(j)) throw new Error((j && j.error) || 'keine Invidious-API');
  return j.length;
}

// ---------------------------------------------------------------- normalising

function https(u) {
  if (!u) return null;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/') && current) return current + u;
  return u;
}

export function ytThumb(id, quality = 'mqdefault') {
  return `https://i.ytimg.com/vi/${id}/${quality}.jpg`;
}

function bestThumb(list, min = 100) {
  if (!list || !list.length) return null;
  const sorted = list.slice().sort((a, b) => (a.width || 0) - (b.width || 0));
  return https((sorted.find((t) => (t.width || 0) >= min) || sorted[sorted.length - 1]).url);
}

function video(v) {
  return {
    type: 'video',
    id: v.videoId,
    title: v.title,
    author: v.author,
    authorId: v.authorId,
    thumb: ytThumb(v.videoId),
    duration: v.lengthSeconds || 0,
    views: v.viewCount || 0,
    published: v.published ? v.published * 1000 : 0,
    publishedText: v.publishedText || '',
    live: !!v.liveNow,
    upcoming: !!v.isUpcoming,
    short: (v.lengthSeconds > 0 && v.lengthSeconds <= 60) || /#shorts/i.test(v.title || ''),
  };
}

function channel(c) {
  return {
    type: 'channel',
    id: c.authorId,
    name: c.author,
    thumb: bestThumb(c.authorThumbnails, 100),
    subs: c.subCount || 0,
    videos: c.videoCount || 0,
    description: c.description || '',
  };
}

function filterVideos(list) {
  const hideShorts = cfg().hideShorts;
  return list.filter((x) => x.type !== 'video' || ((!hideShorts || !x.short) && x.id));
}

// ---------------------------------------------------------------- browsing

export const CATEGORIES = [
  { id: '', label: 'Angesagt' },
  { id: 'music', label: 'Musik' },
  { id: 'gaming', label: 'Gaming' },
  { id: 'movies', label: 'Filme' },
];

export async function trending(category = '') {
  const { data } = await api('/trending', { region: region(), type: category || undefined, hl: 'de' });
  return filterVideos(data.filter((v) => v.type === 'video' || v.videoId).map(video));
}

export async function popular() {
  const { data } = await api('/popular');
  return filterVideos(data.map(video));
}

export async function suggestions(q) {
  if (!q || q.length < 2) return [];
  try {
    const { data } = await api('/search/suggestions', { q });
    return (data.suggestions || []).slice(0, 8).map((s) => String(s).replace(/<[^>]+>/g, ''));
  } catch {
    return [];
  }
}

export async function search(q, page = 1) {
  const { data } = await api('/search', { q, page, type: 'all', region: region(), hl: 'de' });
  const out = [];
  for (const r of data) {
    if (r.type === 'video') out.push(video(r));
    else if (r.type === 'channel') out.push(channel(r));
  }
  return filterVideos(out);
}

export async function channelInfo(id) {
  const { data } = await api(`/channels/${id}`, { hl: 'de' });
  return {
    ...channel(data),
    banner: data.authorBanners && data.authorBanners.length ? https(data.authorBanners[0].url) : null,
  };
}

export async function channelVideos(id, continuation) {
  const { data } = await api(`/channels/${id}/videos`, { continuation, sort_by: 'newest' });
  const list = Array.isArray(data) ? data : data.videos || [];
  return { videos: filterVideos(list.map(video)), continuation: data.continuation || null };
}

/** Details + playable streams of a video. */
export async function videoDetails(id) {
  const { data: v, instance } = await api(`/videos/${id}`, { region: region(), hl: 'de' });
  const highQuality = cfg().highQuality !== false;
  const streams = [];
  const mse = !!(window.MediaSource || window.ManagedMediaSource);
  if (v.liveNow && v.hlsUrl) streams.push({ type: 'hls', url: https(v.hlsUrl), label: 'Live (HLS)' });
  if (!v.liveNow && highQuality && mse && (v.adaptiveFormats || []).length) {
    streams.push({ type: 'dash', url: `${instance}/api/manifest/dash/id/${id}?local=true`, label: 'DASH (bis 4K)' });
  }
  const muxed = (v.formatStreams || []).slice().sort((a, b) => parseInt(b.qualityLabel || b.resolution || '0', 10) - parseInt(a.qualityLabel || a.resolution || '0', 10));
  for (const f of muxed) {
    streams.push({ type: 'file', url: `${instance}/latest_version?id=${id}&itag=${f.itag}&local=true`, label: f.qualityLabel || f.resolution || 'MP4' });
  }
  if (v.liveNow && v.hlsUrl === undefined && v.dashUrl) streams.push({ type: 'dash', url: https(v.dashUrl), label: 'Live (DASH)' });
  return {
    id,
    title: v.title,
    author: v.author,
    authorId: v.authorId,
    authorThumb: bestThumb(v.authorThumbnails, 60),
    subCount: v.subCountText || '',
    description: v.description || '',
    views: v.viewCount || 0,
    likes: v.likeCount || 0,
    published: v.published ? v.published * 1000 : 0,
    publishedText: v.publishedText || '',
    duration: v.lengthSeconds || 0,
    live: !!v.liveNow,
    thumb: ytThumb(id, 'hqdefault'),
    captions: (v.captions || []).map((c) => ({ label: c.label, lang: c.language_code || c.languageCode, url: `${instance}${c.url}` })),
    related: filterVideos((v.recommendedVideos || []).map((r) => video({ ...r, published: 0 }))),
    streams,
    instance,
  };
}

// ---------------------------------------------------------------- local library

export async function ytHistory() {
  return (await db.get(HIST)) || [];
}

export async function addYtHistory(entry) {
  const list = (await ytHistory()).filter((e) => e.id !== entry.id);
  list.unshift({ ...entry, at: Date.now() });
  await db.set(HIST, list.slice(0, 100));
  bus.emit('youtube:library');
}

export async function clearYtHistory() {
  await db.del(HIST);
  bus.emit('youtube:library');
}

export async function subscriptions() {
  return (await db.get(SUBS)) || [];
}

export async function isSubscribed(id) {
  return (await subscriptions()).some((s) => s.id === id);
}

export async function toggleSubscription(ch) {
  let list = await subscriptions();
  const on = !list.some((s) => s.id === ch.id);
  if (on) list = list.concat({ id: ch.id, name: ch.name, thumb: ch.thumb, at: Date.now() });
  else list = list.filter((s) => s.id !== ch.id);
  await db.set(SUBS, list);
  await db.del(FEED_CACHE);
  bus.emit('youtube:library');
  return on;
}

/** Newest videos of all subscribed channels (cached 30 min). */
export async function subscriptionFeed({ force = false } = {}) {
  const subs = await subscriptions();
  if (!subs.length) return [];
  const cached = await db.get(FEED_CACHE);
  if (!force && cached && Date.now() - cached.at < 30 * 60e3 && cached.count === subs.length) return cached.videos;
  const all = [];
  const queue = subs.slice();
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      try {
        const { videos } = await channelVideos(s.id);
        all.push(...videos.slice(0, 12));
      } catch {
        /* skip channel */
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  all.sort((a, b) => (b.published || 0) - (a.published || 0));
  const videos = all.slice(0, 120);
  await db.set(FEED_CACHE, { at: Date.now(), count: subs.length, videos });
  return videos;
}

export async function watchLater() {
  return (await db.get(LATER)) || [];
}

export async function toggleWatchLater(v) {
  let list = await watchLater();
  const on = !list.some((x) => x.id === v.id);
  if (on) list.unshift({ id: v.id, title: v.title, author: v.author, authorId: v.authorId, duration: v.duration, thumb: v.thumb, at: Date.now() });
  else list = list.filter((x) => x.id !== v.id);
  await db.set(LATER, list.slice(0, 300));
  bus.emit('youtube:library');
  return on;
}

// ---------------------------------------------------------------- formatting

export function formatViews(n) {
  if (!n) return '';
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.', ',') + ' Mrd. Aufrufe';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' Mio. Aufrufe';
  if (n >= 1e3) return Math.round(n / 1e3) + ' Tsd. Aufrufe';
  return n + ' Aufrufe';
}

export function formatDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

/** Invidious "publishedText" is English ("3 days ago") – German version from the timestamp. */
export function ago(ts, fallback = '') {
  if (!ts) return fallback;
  const d = (Date.now() - ts) / 1000;
  const f = (n, one, many) => `vor ${n} ${n === 1 ? one : many}`;
  if (d < 3600) return f(Math.max(1, Math.round(d / 60)), 'Minute', 'Minuten');
  if (d < 86400) return f(Math.round(d / 3600), 'Stunde', 'Stunden');
  if (d < 86400 * 30) return f(Math.round(d / 86400), 'Tag', 'Tagen');
  if (d < 86400 * 365) return f(Math.round(d / 86400 / 30), 'Monat', 'Monaten');
  return f(Math.round(d / 86400 / 365), 'Jahr', 'Jahren');
}
