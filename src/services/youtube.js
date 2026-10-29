/**
 * YouTube: watch history and (optional, with own API key) search via the YouTube Data API v3.
 * Playback happens in the official IFrame player (player/youtube-engine.js) with SponsorBlock on top.
 */
import { db } from '../core/db.js';
import { store } from '../core/store.js';
import { youtubeId } from './sponsorblock.js';

const HIST = 'youtube.history';

export { youtubeId };

export async function ytHistory() {
  return (await db.get(HIST)) || [];
}

export async function addYtHistory(entry) {
  const list = (await ytHistory()).filter((e) => e.id !== entry.id);
  list.unshift({ ...entry, at: Date.now() });
  await db.set(HIST, list.slice(0, 40));
}

export async function clearYtHistory() {
  await db.del(HIST);
}

export function ytThumb(id) {
  return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}

/** Title via oEmbed (no key needed). */
export async function ytTitle(id) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`);
    if (r.ok) {
      const j = await r.json();
      return { title: j.title, channel: j.author_name };
    }
  } catch {
    /* ignore */
  }
  return { title: 'YouTube-Video', channel: '' };
}

export async function ytSearch(q) {
  const key = store.get('youtube.apiKey');
  if (!key) throw new Error('Für die Suche wird ein YouTube-API-Schlüssel benötigt (Einstellungen → YouTube). Links und IDs funktionieren ohne.');
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=24&safeSearch=none&q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('YouTube-Suche fehlgeschlagen (HTTP ' + r.status + ')');
  const j = await r.json();
  return (j.items || []).map((it) => ({
    id: it.id.videoId,
    title: decodeEntities(it.snippet.title),
    channel: it.snippet.channelTitle,
    thumb: (it.snippet.thumbnails.medium || it.snippet.thumbnails.default).url,
  }));
}

function decodeEntities(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}
