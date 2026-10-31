/**
 * YouTube playback through the official IFrame player API, exposed with the same small interface as a <video>
 * element (currentTime, duration, paused, play(), pause(), muted, volume, events) – so the Kasy OSD, the remote
 * keys work unchanged on top of it.
 */
import { loadLib } from '../core/loader.js';
import { store } from '../core/store.js';

export class YouTubeMedia extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.player = null;
    this._time = 0;
    this._duration = NaN;
    this._paused = true;
    this._muted = false;
    this._volume = 1;
    this.poll = null;
  }

  async load(videoId, startSeconds = 0) {
    const YT = await loadLib('youtube');
    const host = store.get('youtube.noCookie') ? 'https://www.youtube-nocookie.com' : 'https://www.youtube.com';
    const mount = document.createElement('div');
    this.container.replaceChildren(mount);
    await new Promise((resolve, reject) => {
      this.player = new YT.Player(mount, {
        host,
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 1,
          playsinline: 1,
          controls: 0,
          rel: 0,
          modestbranding: 1,
          iv_load_policy: 3,
          fs: 0,
          disablekb: 1,
          start: Math.floor(startSeconds) || undefined,
          origin: location.origin,
          hl: 'de',
        },
        events: {
          onReady: () => {
            this._duration = this.player.getDuration() || NaN;
            this.emit('loadedmetadata');
            resolve();
          },
          onStateChange: (e) => this.onState(e.data),
          onError: (e) => {
            const msg = { 2: 'Ungültige Video-ID', 5: 'HTML5-Fehler', 100: 'Video nicht gefunden', 101: 'Einbetten nicht erlaubt', 150: 'Einbetten nicht erlaubt' }[e.data] || 'YouTube-Fehler ' + e.data;
            this.error = { message: msg };
            this.emit('error');
            reject(new Error(msg));
          },
        },
      });
    });
    this.poll = setInterval(() => this.tick(), 250);
  }

  onState(s) {
    // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    if (s === 1) {
      this._paused = false;
      this._duration = this.player.getDuration() || this._duration;
      this.emit('playing');
      this.emit('play');
    } else if (s === 2) {
      this._paused = true;
      this.emit('pause');
    } else if (s === 3) this.emit('waiting');
    else if (s === 0) {
      this._paused = true;
      this.emit('ended');
    }
  }

  tick() {
    if (!this.player || !this.player.getCurrentTime) return;
    const t = this.player.getCurrentTime();
    if (t !== this._time) {
      this._time = t;
      this.emit('timeupdate');
    }
    const d = this.player.getDuration();
    if (d && d !== this._duration) {
      this._duration = d;
      this.emit('durationchange');
    }
  }

  emit(name) {
    this.dispatchEvent(new Event(name));
  }

  get currentTime() {
    return this._time;
  }

  set currentTime(t) {
    if (!this.player) return;
    this.player.seekTo(t, true);
    this._time = t;
    this.emit('seeked');
    this.emit('timeupdate');
  }

  get duration() {
    return this._duration;
  }

  get paused() {
    return this._paused;
  }

  get muted() {
    return this._muted;
  }

  set muted(m) {
    this._muted = m;
    if (!this.player) return;
    if (m) this.player.mute();
    else this.player.unMute();
    this.emit('volumechange');
  }

  get volume() {
    return this._volume;
  }

  set volume(v) {
    this._volume = v;
    if (this.player) this.player.setVolume(Math.round(v * 100));
    this.emit('volumechange');
  }

  get playbackRate() {
    return this.player ? this.player.getPlaybackRate() : 1;
  }

  set playbackRate(r) {
    if (this.player) this.player.setPlaybackRate(r);
  }

  play() {
    if (this.player) this.player.playVideo();
    return Promise.resolve();
  }

  pause() {
    if (this.player) this.player.pauseVideo();
  }

  get buffered() {
    const frac = this.player && this.player.getVideoLoadedFraction ? this.player.getVideoLoadedFraction() : 0;
    const end = (this._duration || 0) * frac;
    return { length: end ? 1 : 0, start: () => 0, end: () => end };
  }

  destroy() {
    clearInterval(this.poll);
    try {
      if (this.player) this.player.destroy();
    } catch {
      /* ignore */
    }
    this.player = null;
    this.container.replaceChildren();
  }
}
