/**
 * Video engine: plays a URL in a <video> element with the best available technique and falls back on failure.
 *
 *  - HLS (.m3u8): hls.js on MSE browsers (Chrome, Android TV/Xiaomi stick, Tizen, webOS, desktop), native HLS on
 *    iOS/Safari (also gives AirPlay & background audio). Configurable: auto | hls.js | nativ.
 *  - MPEG-TS (.ts, Xtream live without extension): mpegts.js, then native.
 *  - Files (mp4, webm, mkv, mp3 …): native.
 *  - Unknown URLs: tries HLS → MPEG-TS → native in turn (each attempt with a timeout).
 *
 * The ad blocker hooks in here: VOD playlists lose their marked ad breaks; ad breaks in live streams are reported
 * through onAdBreak(true/false) so the player can mute and cover them.
 */
import { loadLib } from '../core/loader.js';
import { store } from '../core/store.js';
import { perf } from '../core/performance.js';
import { isIOS } from '../core/util.js';
import { filterVodPlaylist, fragmentIsAd } from '../services/adblock.js';
import { proxied } from '../services/net.js';

const ATTEMPT_TIMEOUT = 15000;

export function detectType(url) {
  const u = String(url || '').toLowerCase().split(/[?#]/)[0];
  if (/\.m3u8$|\.m3u$/.test(u) || /\/(hls|manifest)(\.|\/)|\/playlist\.m3u|format=m3u8|type=m3u8/.test(String(url).toLowerCase())) return 'hls';
  if (/\.(ts|mts|m2ts)$/.test(u)) return 'mpegts';
  if (/\.(mp4|m4v|mov|webm|mkv|ogv|mp3|aac|m4a|ogg|oga|flac|wav|opus)$/.test(u)) return 'file';
  return 'unknown';
}

function hasMSE() {
  return !!(window.MediaSource || window.ManagedMediaSource || window.WebKitMediaSource);
}

function nativeHls(video) {
  return !!video.canPlayType('application/vnd.apple.mpegurl').replace('no', '');
}

export class VideoEngine {
  constructor(video, { onAdBreak, onAdsRemoved, onLevels, onTracks, onFatal } = {}) {
    this.video = video;
    this.cb = { onAdBreak, onAdsRemoved, onLevels, onTracks, onFatal };
    this.hls = null;
    this.mpegts = null;
    this.kind = null; // 'hlsjs' | 'mpegts' | 'dash' | 'native'
    this.dash = null;
    this.adState = { inAd: false };
    this.token = 0;
  }

  candidates(type) {
    const pref = store.get('player.engine');
    const mse = hasMSE();
    const native = nativeHls(this.video);
    const appleFirst = native && (isIOS() || (!/Chrome|Android|CrKey/i.test(navigator.userAgent) && /Safari/.test(navigator.userAgent)));
    const hlsOrder = () => {
      if (pref === 'native') return native ? ['native', 'hlsjs'] : ['hlsjs', 'native'];
      if (pref === 'hlsjs') return mse ? ['hlsjs', 'native'] : ['native'];
      if (appleFirst) return mse ? ['native', 'hlsjs'] : ['native'];
      return mse ? ['hlsjs', 'native'] : ['native'];
    };
    switch (type) {
      case 'hls':
        return hlsOrder();
      case 'mpegts':
        return mse ? ['mpegts', 'native'] : ['native'];
      case 'file':
        return ['native'];
      case 'dash':
        return mse ? ['dash'] : [];
      default:
        return appleFirst ? ['native', 'hlsjs'] : mse ? ['hlsjs', 'mpegts', 'native'] : ['native'];
    }
  }

  /**
   * load({ url, type, live, startSeconds }) → resolves when metadata is there; rejects when nothing works.
   */
  async load(src) {
    const token = ++this.token;
    let url = src.url;
    if (store.get('iptv.proxyStreams') && src.allowProxy) url = proxied(url) || url;
    const type = src.type && src.type !== 'auto' ? src.type : detectType(src.url);
    const list = this.candidates(type);
    let lastError = null;
    for (const kind of list) {
      if (token !== this.token) throw new Error('abgebrochen');
      this.teardown();
      try {
        await this.attempt(kind, url, src, token);
        this.kind = kind;
        return kind;
      } catch (e) {
        lastError = e;
        console.warn(`[engine] ${kind} fehlgeschlagen:`, e && e.message);
      }
    }
    this.teardown();
    throw lastError || new Error('Stream kann nicht abgespielt werden');
  }

  attempt(kind, url, src, token) {
    const v = this.video;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        v.removeEventListener('loadedmetadata', onMeta);
        v.removeEventListener('error', onErr);
        if (err) reject(err);
        else resolve();
      };
      const onMeta = () => {
        if (src.startSeconds > 0 && isFinite(v.duration) && v.duration > src.startSeconds) {
          try {
            v.currentTime = src.startSeconds;
          } catch {
            /* ignore */
          }
        }
        done();
      };
      const onErr = () => done(new Error(mediaErrorText(v.error)));
      const timer = setTimeout(() => done(new Error('Zeitüberschreitung beim Laden')), ATTEMPT_TIMEOUT);
      v.addEventListener('loadedmetadata', onMeta);
      v.addEventListener('error', onErr);

      if (kind === 'native') {
        v.src = url;
        v.load();
        return;
      }
      if (kind === 'hlsjs') {
        loadLib('hls')
          .then((Hls) => {
            if (token !== this.token || settled) return;
            if (!Hls.isSupported()) return done(new Error('hls.js wird nicht unterstützt'));
            this.startHls(Hls, url, src, done);
          })
          .catch((e) => done(e));
        return;
      }
      if (kind === 'dash') {
        loadLib('dash')
          .then((dashjs) => {
            if (token !== this.token || settled) return;
            const p = dashjs.MediaPlayer().create();
            this.dash = p;
            p.updateSettings({
              debug: { logLevel: dashjs.Debug ? dashjs.Debug.LOG_LEVEL_WARNING : 2 },
              streaming: {
                buffer: { bufferTimeAtTopQuality: perf.low ? 12 : 30, bufferTimeAtTopQualityLongForm: perf.low ? 20 : 60 },
                abr: { limitBitrateByPortal: perf.low },
              },
            });
            p.on(dashjs.MediaPlayer.events.ERROR, (ev) => {
              const err = new Error('DASH: ' + ((ev.error && (ev.error.message || ev.error.code)) || 'Fehler'));
              if (!settled) done(err);
              else if (this.cb.onFatal) this.cb.onFatal(err);
            });
            p.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => this.emitLevels());
            p.initialize(v, url, false, src.startSeconds > 0 ? src.startSeconds : undefined);
          })
          .catch((e) => done(e));
        return;
      }
      if (kind === 'mpegts') {
        loadLib('mpegts')
          .then((mpegts) => {
            if (token !== this.token || settled) return;
            if (!mpegts.getFeatureList().mseLivePlayback) return done(new Error('mpegts.js nicht unterstützt'));
            const p = mpegts.createPlayer(
              { type: 'mpegts', isLive: src.live !== false, url },
              {
                enableWorker: true,
                lazyLoad: false,
                liveBufferLatencyChasing: !!store.get('player.lowLatencyLive'),
                autoCleanupSourceBuffer: true,
                autoCleanupMaxBackwardDuration: perf.low ? 20 : 60,
                autoCleanupMinBackwardDuration: perf.low ? 10 : 30,
                stashInitialSize: perf.low ? 128 * 1024 : 384 * 1024,
              },
            );
            this.mpegts = p;
            p.on(mpegts.Events.ERROR, (t, d) => {
              if (!settled) done(new Error('MPEG-TS: ' + (d || t)));
              else if (this.cb.onFatal) this.cb.onFatal(new Error('MPEG-TS: ' + (d || t)));
            });
            p.attachMediaElement(v);
            p.load();
          })
          .catch((e) => done(e));
      }
    });
  }

  startHls(Hls, url, src, done) {
    const v = this.video;
    const self = this;
    const Base = Hls.DefaultConfig.loader;
    // Playlist loader that removes ad breaks from VOD playlists before hls.js sees them.
    class AdFilterLoader extends Base {
      constructor(config) {
        super(config);
        const load = this.load.bind(this);
        this.load = function (context, cfg, callbacks) {
          const onSuccess = callbacks.onSuccess;
          callbacks.onSuccess = function (response, stats, ctx, net) {
            if (response && typeof response.data === 'string' && ctx && ctx.type !== 'manifest-master') {
              const r = filterVodPlaylist(response.data, ctx.url || url);
              if (r.removed) {
                response.data = r.text;
                if (self.cb.onAdsRemoved) self.cb.onAdsRemoved(r);
              }
            }
            onSuccess(response, stats, ctx, net);
          };
          load(context, cfg, callbacks);
        };
      }
    }
    const buffer = perf.low ? Math.min(20, store.get('player.bufferSeconds') || 30) : store.get('player.bufferSeconds') || 30;
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: !!store.get('player.lowLatencyLive'),
      maxBufferLength: buffer,
      maxMaxBufferLength: buffer * 2,
      backBufferLength: perf.low ? 10 : 30,
      maxBufferSize: (perf.low ? 30 : 60) * 1000 * 1000,
      startLevel: -1,
      capLevelToPlayerSize: perf.low,
      startPosition: src.startSeconds > 0 ? src.startSeconds : -1,
      fragLoadingMaxRetry: 4,
      manifestLoadingMaxRetry: 2,
      levelLoadingMaxRetry: 3,
      pLoader: AdFilterLoader,
    });
    this.hls = hls;
    let networkRetries = 0;
    let mediaRecoveries = 0;
    let started = false;
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      started = true;
      this.emitLevels();
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, () => this.emitLevels());
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => this.cb.onTracks && this.cb.onTracks());
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => this.cb.onTracks && this.cb.onTracks());
    hls.on(Hls.Events.FRAG_CHANGED, (e, data) => {
      if (!store.get('blocker.enabled') || !store.get('blocker.hlsAdFilter')) return;
      const before = this.adState.inAd;
      const now = fragmentIsAd(data.frag && data.frag.tagList, this.adState);
      if (before !== now && this.cb.onAdBreak) this.cb.onAdBreak(now);
    });
    hls.on(Hls.Events.ERROR, (e, data) => {
      if (!data.fatal) return;
      if (!started) {
        done(new Error('HLS: ' + data.details));
        return;
      }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 3) {
        networkRetries++;
        setTimeout(() => this.hls === hls && hls.startLoad(), 1000 * networkRetries);
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
        mediaRecoveries++;
        if (mediaRecoveries === 2) hls.swapAudioCodec();
        hls.recoverMediaError();
      } else if (this.cb.onFatal) this.cb.onFatal(new Error('HLS: ' + data.details));
    });
    hls.attachMedia(v);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(url));
  }

  emitLevels() {
    if (this.cb.onLevels) this.cb.onLevels(this.qualities());
  }

  qualities() {
    if (this.dash) {
      try {
        return this.dash.getBitrateInfoListFor('video').map((b) => ({ id: b.qualityIndex, label: (b.height ? b.height + 'p' : '') + ` · ${(b.bitrate / 1e6).toFixed(1)} Mbit/s`, height: b.height }));
      } catch {
        return [];
      }
    }
    if (!this.hls || !this.hls.levels) return [];
    return this.hls.levels.map((l, i) => ({
      id: i,
      label: (l.height ? l.height + 'p' : Math.round((l.bitrate || 0) / 1000) + ' kbit/s') + (l.bitrate ? ` · ${(l.bitrate / 1e6).toFixed(1)} Mbit/s` : ''),
      height: l.height,
    }));
  }

  get currentQuality() {
    if (this.dash) {
      try {
        return this.dash.getSettings().streaming.abr.autoSwitchBitrate.video ? -1 : this.dash.getQualityFor('video');
      } catch {
        return -1;
      }
    }
    return this.hls ? (this.hls.autoLevelEnabled ? -1 : this.hls.currentLevel) : -1;
  }

  setQuality(id) {
    if (this.dash) {
      this.dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: id === -1 } } } });
      if (id !== -1) this.dash.setQualityFor('video', id, true);
      return;
    }
    if (!this.hls) return;
    this.hls.currentLevel = id; // -1 = auto
  }

  audioTracks() {
    if (this.hls && this.hls.audioTracks && this.hls.audioTracks.length > 1) {
      return this.hls.audioTracks.map((t, i) => ({ id: i, label: t.name || t.lang || 'Audio ' + (i + 1), lang: t.lang, active: i === this.hls.audioTrack }));
    }
    const at = this.video.audioTracks;
    if (at && at.length > 1) {
      return Array.from(at).map((t, i) => ({ id: i, label: t.label || t.language || 'Audio ' + (i + 1), lang: t.language, active: t.enabled }));
    }
    return [];
  }

  setAudioTrack(id) {
    if (this.hls && this.hls.audioTracks && this.hls.audioTracks.length > 1) {
      this.hls.audioTrack = id;
      return;
    }
    const at = this.video.audioTracks;
    if (at) for (let i = 0; i < at.length; i++) at[i].enabled = i === id;
  }

  /** In-stream subtitle tracks (HLS subtitles, embedded CEA-608 on Safari) as TextTrack objects. */
  textTracks() {
    const tt = this.video.textTracks;
    if (!tt) return [];
    return Array.from(tt).filter((t) => (t.kind === 'subtitles' || t.kind === 'captions') && !t.label.startsWith('kasy:'));
  }

  enableHlsSubtitles(on) {
    if (this.hls) {
      this.hls.subtitleDisplay = false; // we render ourselves
      if (!on) this.hls.subtitleTrack = -1;
    }
  }

  teardown() {
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        /* ignore */
      }
      this.hls = null;
    }
    if (this.dash) {
      try {
        this.dash.reset();
      } catch {
        /* ignore */
      }
      this.dash = null;
    }
    if (this.mpegts) {
      try {
        this.mpegts.pause();
        this.mpegts.unload();
        this.mpegts.detachMediaElement();
        this.mpegts.destroy();
      } catch {
        /* ignore */
      }
      this.mpegts = null;
    }
    this.adState = { inAd: false };
    const v = this.video;
    try {
      v.pause();
      v.removeAttribute('src');
      v.load();
    } catch {
      /* ignore */
    }
  }

  destroy() {
    this.token++;
    this.teardown();
  }
}

export function mediaErrorText(err) {
  if (!err) return 'Unbekannter Wiedergabefehler';
  switch (err.code) {
    case 1:
      return 'Wiedergabe abgebrochen';
    case 2:
      return 'Netzwerkfehler beim Laden des Streams';
    case 3:
      return 'Der Stream kann nicht dekodiert werden';
    case 4:
      return 'Format oder Adresse wird nicht unterstützt';
    default:
      return err.message || 'Wiedergabefehler';
  }
}
