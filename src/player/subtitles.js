/**
 * Subtitle renderer. All subtitles – external WebVTT/SRT files (Jellyfin) and in-stream tracks (HLS, Safari) – are
 * drawn by the app into its own layer, so the "Zeichen-Typ" settings (font, size, colour, background, edge,
 * position) apply everywhere, including iOS where ::cue styling is very limited.
 */
import { h } from '../core/dom.js';

function parseTime(s) {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(s);
  if (!m) return NaN;
  return (parseInt(m[1] || '0', 10) * 3600) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4].padEnd(3, '0'), 10) / 1000;
}

/** Parses WebVTT and SRT into [{ start, end, text }]. */
export function parseSubtitles(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, '').replace(/^﻿/, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.length);
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const [a, b] = lines[idx].split('-->');
    const start = parseTime(a);
    const end = parseTime(b);
    if (isNaN(start) || isNaN(end)) continue;
    const body = lines.slice(idx + 1).join('\n').trim();
    if (body) cues.push({ start, end, text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/** Keeps <i>, <b>, <u> and line breaks; drops every other tag (incl. VTT voice/class spans, ASS overrides). */
function toHtml(text) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&lt;(\/?)(i|b|u)&gt;/gi, '<$1$2>')
    .replace(/&lt;\/?[^&]*?&gt;/g, '')
    .replace(/\\N/g, '<br>')
    .replace(/\n/g, '<br>');
}

export class SubtitleRenderer {
  constructor(video, layer) {
    this.video = video;
    this.layer = layer;
    this.cues = null; // external cues
    this.track = null; // TextTrack
    this.offset = 0; // seconds (user sync)
    this.lastHtml = '';
    this.onTime = () => this.renderExternal();
    this.onCue = () => this.renderTrack();
    video.addEventListener('timeupdate', this.onTime);
    video.addEventListener('seeked', this.onTime);
  }

  /** External subtitle file. */
  async loadUrl(url) {
    this.clear();
    const res = await fetch(url);
    if (!res.ok) throw new Error('Untertitel: HTTP ' + res.status);
    this.cues = parseSubtitles(await res.text());
    this.renderExternal();
    return this.cues.length;
  }

  setCues(cues) {
    this.clear();
    this.cues = cues;
  }

  /** In-stream track: we keep it "hidden" (browser doesn't draw) and render its active cues. */
  useTrack(track) {
    this.clear();
    if (!track) return;
    this.track = track;
    track.mode = 'hidden';
    track.addEventListener('cuechange', this.onCue);
    this.renderTrack();
  }

  renderExternal() {
    if (!this.cues) return;
    const t = this.video.currentTime - this.offset;
    const active = [];
    // cues are sorted – binary search for the first cue that may be active
    let lo = 0;
    let hi = this.cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid].end < t) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.cues.length && this.cues[i].start <= t; i++) if (this.cues[i].end > t) active.push(this.cues[i].text);
    this.show(active);
  }

  renderTrack() {
    if (!this.track || !this.track.activeCues) return;
    const list = Array.from(this.track.activeCues).map((c) => c.text || '');
    this.show(list);
  }

  show(texts) {
    const html = texts.map(toHtml).join('<br>');
    if (html === this.lastHtml) return;
    this.lastHtml = html;
    this.layer.replaceChildren();
    if (!html) return;
    this.layer.appendChild(h('div.sub-cue', { html }));
  }

  clear() {
    if (this.track) {
      this.track.removeEventListener('cuechange', this.onCue);
      try {
        this.track.mode = 'disabled';
      } catch {
        /* ignore */
      }
    }
    this.track = null;
    this.cues = null;
    this.lastHtml = '';
    this.layer.replaceChildren();
  }

  destroy() {
    this.clear();
    this.video.removeEventListener('timeupdate', this.onTime);
    this.video.removeEventListener('seeked', this.onTime);
  }
}
