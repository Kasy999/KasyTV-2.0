/** Resume positions for non-Jellyfin videos (IPTV VOD, direct links) in IndexedDB. */
import { db } from '../core/db.js';
import { hashString } from '../core/util.js';

const KEY = 'resume.positions';
let cache = null;

async function load() {
  if (!cache) cache = (await db.get(KEY)) || {};
  return cache;
}

export async function getResume(url) {
  const all = await load();
  const e = all[hashString(url)];
  return e ? e.pos : 0;
}

export async function saveResume(url, pos, duration) {
  const all = await load();
  const k = hashString(url);
  // Nearly finished or barely started → nothing to resume.
  if (!duration || pos < 30 || pos > duration - 60) delete all[k];
  else all[k] = { pos: Math.floor(pos), at: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > 300) {
    keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 300).forEach((x) => delete all[x]);
  }
  await db.set(KEY, all);
}
