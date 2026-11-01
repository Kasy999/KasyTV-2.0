/**
 * Resume positions and the "last playback".
 *
 * - Positions for non-Jellyfin videos (IPTV VOD, direct links) – with title/image so they can appear under
 *   "Weiterschauen" on HOME. Jellyfin items keep their position on the server; a local copy is kept as a
 *   fallback (e.g. the progress report didn't reach the server when the TV was switched off).
 * - The last playback (channel, film, episode, link) so the app can continue it with one tap – or right at
 *   start-up (Einstellungen → Player → "Beim App-Start fortsetzen").
 */
import { db } from '../core/db.js';
import { hashString } from '../core/util.js';

const KEY = 'resume.positions';
const LAST = 'resume.last';
let cache = null;
let saveTimer = null;

async function load() {
  if (!cache) cache = (await db.get(KEY)) || {};
  return cache;
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.set(KEY, cache).catch(() => {}), 300);
}

export function resumeKey(urlOrId) {
  return hashString(String(urlOrId));
}

export async function getResume(url) {
  const e = await getResumeEntry(url);
  return e ? e.pos : 0;
}

export async function getResumeEntry(url) {
  const all = await load();
  return all[resumeKey(url)] || null;
}

/**
 * Saves a position. meta: { title, subtitle, image, kind: 'channel'|'url'|'jellyfin', sourceId, channel, itemId }
 * Nearly finished or barely started → the entry is removed (nothing to resume).
 */
export async function saveResume(url, pos, duration, meta = {}) {
  const all = await load();
  const k = resumeKey(url);
  if (!duration || !isFinite(duration) || pos < 30 || pos > duration - Math.min(60, duration * 0.05)) delete all[k];
  else all[k] = { ...(all[k] || {}), ...meta, url, pos: Math.floor(pos), duration: Math.floor(duration), at: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > 300) {
    keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 300).forEach((x) => delete all[x]);
  }
  persist();
}

export async function removeResume(url) {
  const all = await load();
  delete all[resumeKey(url)];
  persist();
}

/** Unfinished videos (not Jellyfin), newest first – for "Weiterschauen". */
export async function listResume(limit = 20) {
  const all = await load();
  return Object.values(all)
    .filter((e) => e.kind !== 'jellyfin' && e.title)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

/** Write everything now (app is being closed). */
export function flushResume() {
  if (!cache) return;
  clearTimeout(saveTimer);
  db.set(KEY, cache).catch(() => {});
}

export async function setLast(entry) {
  await db.set(LAST, { ...entry, at: Date.now() }).catch(() => {});
}

export async function getLast() {
  return (await db.get(LAST).catch(() => null)) || null;
}

export async function clearLast() {
  await db.set(LAST, null).catch(() => {});
}
