/**
 * Segment skipper for intros / credits (Jellyfin media segments, Intro Skipper plugin) and a YouTube-id helper.
 */

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
  }

  destroy() {
    clearInterval(this.timer);
    if (this.mutedBy) this.adapter.setMuted(this.wasMuted);
  }
}
