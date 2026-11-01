/**
 * Sound for MKV files whose audio format the browser can't decode (DTS, TrueHD, Vorbis, PCM …):
 * the picture keeps playing directly through the MKV decoder, and only the sound is fetched converted from
 * the Jellyfin server (MP3 stereo – a tiny job compared to converting the video) and kept in sync.
 *
 *   const ea = new ExternalAudio(video, (startSeconds) => url, { shiftSeconds });
 *   ea.destroy();
 */
export class ExternalAudio {
  constructor(video, urlAt, { shiftSeconds = 0, onError } = {}) {
    this.video = video;
    this.urlAt = urlAt;
    this.shift = shiftSeconds; // media time = video.currentTime - shift
    this.onError = onError;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.base = 0; // media time where the current audio stream starts
    this.failures = 0;
    this.handlers = [];
    const on = (ev, fn) => {
      video.addEventListener(ev, fn);
      this.handlers.push([ev, fn]);
    };
    on('play', () => this.syncPlay());
    on('playing', () => this.syncPlay());
    on('pause', () => this.audio.pause());
    on('waiting', () => this.audio.pause());
    on('seeked', () => this.restart());
    on('ratechange', () => (this.audio.playbackRate = video.playbackRate));
    on('volumechange', () => this.syncVolume());
    this.audio.addEventListener('error', () => {
      if (++this.failures > 3) {
        if (this.onError) this.onError(new Error('Ton konnte nicht vom Server geholt werden'));
        return;
      }
      setTimeout(() => this.restart(), 1500);
    });
    this.timer = setInterval(() => this.drift(), 1000);
    this.syncVolume();
    this.restart();
  }

  mediaTime() {
    return Math.max(0, this.video.currentTime - this.shift);
  }

  syncVolume() {
    this.audio.volume = this.video.volume;
    this.audio.muted = this.video.muted;
  }

  restart() {
    const t = this.mediaTime();
    this.base = t;
    this.audio.src = this.urlAt(t);
    this.audio.load();
    if (!this.video.paused) this.syncPlay();
  }

  syncPlay() {
    if (this.video.paused) return;
    this.audio.play().catch(() => {});
  }

  drift() {
    if (this.video.paused || this.video.seeking || this.audio.readyState < 2) return;
    const want = this.mediaTime() - this.base;
    const diff = this.audio.currentTime - want;
    if (Math.abs(diff) > 1.5) {
      // Converted streams can't be seeked reliably – start a new one at the right place.
      if (want > this.audio.currentTime && this.bufferedTo() > want) this.audio.currentTime = want;
      else this.restart();
      return;
    }
    const rate = this.video.playbackRate || 1;
    if (Math.abs(diff) < 0.06) this.audio.playbackRate = rate;
    else this.audio.playbackRate = rate * (diff > 0 ? 0.96 : 1.04);
  }

  bufferedTo() {
    const b = this.audio.buffered;
    return b.length ? b.end(b.length - 1) : 0;
  }

  destroy() {
    clearInterval(this.timer);
    for (const [ev, fn] of this.handlers) this.video.removeEventListener(ev, fn);
    this.audio.pause();
    this.audio.removeAttribute('src');
    try {
      this.audio.load();
    } catch {
      /* ignore */
    }
  }
}
