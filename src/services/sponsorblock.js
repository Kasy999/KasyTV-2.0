/**
 * SponsorBlock (sponsor.ajay.app) + a generic segment skipper.
 *
 * SponsorBlock data exists for YouTube video IDs: the YouTube player of the app (and YouTube links in playlists,
 * Jellyfin trailers, Lampa trailers) gets sponsor/intro/outro/self-promo segments and skips them automatically,
 * offers a skip button or mutes them – per category, as configured.
 * The same SegmentSkipper handles Jellyfin media segments (intro/credits) and IPTV ad breaks.
 *
 * Privacy: lookups use the hash-prefix API (only the first 4 hex chars of SHA-256(videoId) leave the device).
 */
import { store } from '../core/store.js';

export const SB_CATEGORIES = [
  { id: 'sponsor', label: 'Sponsor', desc: 'Bezahlte Werbung im Video' },
  { id: 'selfpromo', label: 'Eigenwerbung', desc: 'Merch, Spenden, eigene Kanäle' },
  { id: 'interaction', label: 'Interaktions-Aufruf', desc: '„Abonnieren & liken“' },
  { id: 'intro', label: 'Intro / Pause', desc: 'Intro-Animation, Wartebildschirm' },
  { id: 'outro', label: 'Abspann / Outro', desc: 'Endkarten, Abspann' },
  { id: 'preview', label: 'Vorschau / Rückblick', desc: 'Zusammenfassung, Vorschau' },
  { id: 'music_offtopic', label: 'Musik: Nicht-Musik', desc: 'Gerede in Musikvideos' },
  { id: 'filler', label: 'Füllmaterial', desc: 'Abschweifungen, Witze' },
];

export const CATEGORY_LABEL = Object.fromEntries(SB_CATEGORIES.map((c) => [c.id, c.label]));
const cache = new Map();

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Segments of a YouTube video: [{ start, end, category, action, uuid, label }] (seconds). */
export async function fetchSponsorSegments(videoId) {
  const cfg = store.get('blocker.sponsorblock');
  if (!cfg.enabled || !videoId) return [];
  const active = Object.keys(cfg.categories).filter((c) => cfg.categories[c] !== 'off');
  if (!active.length) return [];
  const key = videoId + '|' + active.join(',');
  if (cache.has(key)) return cache.get(key);

  const server = (cfg.server || 'https://sponsor.ajay.app').replace(/\/+$/, '');
  const qs = 'categories=' + encodeURIComponent(JSON.stringify(active)) + '&actionTypes=' + encodeURIComponent(JSON.stringify(['skip', 'mute', 'poi', 'full']));
  let list = [];
  try {
    if (crypto && crypto.subtle) {
      const prefix = (await sha256Hex(videoId)).slice(0, 4);
      const res = await fetch(`${server}/api/skipSegments/${prefix}?${qs}`);
      if (res.ok) {
        const all = await res.json();
        const hit = all.find((v) => v.videoID === videoId);
        list = hit ? hit.segments : [];
      } else if (res.status !== 404) throw new Error('HTTP ' + res.status);
    } else {
      const res = await fetch(`${server}/api/skipSegments?videoID=${encodeURIComponent(videoId)}&${qs}`);
      if (res.ok) list = await res.json();
    }
  } catch (e) {
    console.warn('[SponsorBlock]', e);
    return [];
  }
  const segments = list
    .filter((s) => s.actionType !== 'full' && s.actionType !== 'poi')
    .map((s) => ({
      start: s.segment[0],
      end: s.segment[1],
      category: s.category,
      action: s.actionType === 'mute' ? 'mute' : cfg.categories[s.category] || 'skip',
      uuid: s.UUID,
      label: CATEGORY_LABEL[s.category] || s.category,
      source: 'sponsorblock',
    }))
    .sort((a, b) => a.start - b.start);
  cache.set(key, segments);
  return segments;
}

/** Tells SponsorBlock a segment was skipped (counts towards the submitter's stats, as the extension does). */
export function reportSkip(uuid) {
  const server = (store.get('blocker.sponsorblock.server') || 'https://sponsor.ajay.app').replace(/\/+$/, '');
  fetch(`${server}/api/viewedVideoSponsorTime?UUID=${encodeURIComponent(uuid)}`, { method: 'POST' }).catch(() => {});
}

/** Extracts a YouTube video id from URLs (watch, youtu.be, embed, shorts, plugin://…) or a bare id. */
export function youtubeId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m =
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/|plugin\.video\.youtube\/play\/\?video_id=)([A-Za-z0-9_-]{11})/i.exec(s);
  return m ? m[1] : null;
}

/**
 * Generic skipper. adapter: { time(): s, duration(): s, seek(s), setMuted(bool), isMuted(): bool }
 * onUi({ type: 'button'|'skipped'|'clear'|'muted', segment }) drives the player's skip button / notices.
 */
export class SegmentSkipper {
  constructor(adapter, onUi) {
    this.adapter = adapter;
    this.onUi = onUi;
    this.segments = [];
    this.done = new Set();
    this.buttonFor = null;
    this.mutedBy = null;
    this.wasMuted = false;
    this.lastTime = 0;
    this.timer = setInterval(() => this.tick(), 250);
  }

  setSegments(segments) {
    this.segments = (segments || []).slice().sort((a, b) => a.start - b.start);
    this.done.clear();
  }

  addSegments(segments) {
    this.setSegments(this.segments.concat(segments || []));
  }

  tick() {
    let t;
    try {
      t = this.adapter.time();
    } catch {
      return;
    }
    if (!isFinite(t)) return;
    const jumped = Math.abs(t - this.lastTime) > 2.5;
    this.lastTime = t;
    // Seeking back before a segment makes it skippable again.
    if (jumped) for (const s of this.segments) if (t < s.start) this.done.delete(s);

    const active = this.segments.find((s) => t >= s.start && t < s.end - 0.3);

    // mute segments
    if (active && active.action === 'mute') {
      if (!this.mutedBy) {
        this.wasMuted = this.adapter.isMuted();
        this.adapter.setMuted(true);
        this.mutedBy = active;
        this.onUi({ type: 'muted', segment: active });
      }
    } else if (this.mutedBy) {
      this.adapter.setMuted(this.wasMuted);
      this.mutedBy = null;
      this.onUi({ type: 'clear' });
    }

    if (!active || active.action === 'mute') {
      if (this.buttonFor) {
        this.buttonFor = null;
        this.onUi({ type: 'clear' });
      }
      return;
    }
    if (active.action === 'skip' && !this.done.has(active)) {
      // Auto-skip only when playback ran into the segment (not after the user seeked into it on purpose).
      if (!jumped || t - active.start < 3) {
        this.done.add(active);
        this.skip(active, true);
        return;
      }
    }
    if ((active.action === 'button' || (active.action === 'skip' && this.done.has(active))) && this.buttonFor !== active) {
      this.buttonFor = active;
      this.onUi({ type: 'button', segment: active });
    }
  }

  skip(segment = this.buttonFor, auto = false) {
    if (!segment) return;
    const dur = this.adapter.duration();
    const target = isFinite(dur) && dur > 0 ? Math.min(segment.end, dur - 0.5) : segment.end;
    this.adapter.seek(target);
    this.done.add(segment);
    this.buttonFor = null;
    this.onUi({ type: 'skipped', segment, auto });
    if (segment.uuid) reportSkip(segment.uuid);
  }

  destroy() {
    clearInterval(this.timer);
    if (this.mutedBy) this.adapter.setMuted(this.wasMuted);
  }
}
