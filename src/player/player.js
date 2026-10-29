/**
 * Kasy player: full-screen overlay for IPTV channels, direct links, Jellyfin and YouTube.
 *
 * Touch: tap = OSD on/off, double tap left/right = −/+ seek, horizontal drag = scrub (VOD),
 *        vertical swipe = next/previous channel (live).
 * Remote: ▲▼ / CH± = zap (live), ◀▶ = seek (VOD), OK = OSD, digits = channel number, Back = OSD off / close,
 *         Play/Pause/Stop/FF/RW, red = channel list, green = options, yellow = subtitles, blue = audio.
 */
import { h, icon, img } from '../core/dom.js';
import { bus } from '../core/events.js';
import { store } from '../core/store.js';
import { pushScope, focus, focusFirst } from '../core/focus.js';
import { openOverlay } from '../core/router.js';
import { inputMode } from '../core/input-mode.js';
import { formatTime, formatClock, clamp } from '../core/util.js';
import { VideoEngine, detectType } from './engine.js';
import { SubtitleRenderer } from './subtitles.js';
import { YouTubeMedia } from './youtube-engine.js';
import { pickOption, dialog } from '../components/dialog.js';
import { stepperRow, selectRow, colorRow } from '../components/controls.js';
import { toast } from '../components/toast.js';
import { SegmentSkipper, fetchSponsorSegments, youtubeId } from '../services/sponsorblock.js';
import * as iptv from '../services/iptv.js';
import * as epg from '../services/epg.js';
import { navigate } from '../core/router.js';
import * as jf from '../services/jellyfin.js';
import { getResume, saveResume } from '../services/resume.js';
import { COLORS, FONTS } from '../services/text-style.js';

let instance = null;

class Player {
  constructor() {
    this.session = null;
    this.osdVisible = false;
    this.hideTimer = null;
    this.mediaHandlers = [];
    this.build();
    this.video.playsInline = true;
    this.video.setAttribute('webkit-playsinline', '');
    this.video.setAttribute('x-webkit-airplay', 'allow');
    this.video.preload = 'auto';
    this.engine = new VideoEngine(this.video, {
      onAdBreak: (on) => this.onAdBreak(on),
      onAdsRemoved: (r) => toast(`Werbeblocker: ${r.removed} Werbesegmente entfernt (${formatTime(r.seconds)})`, { kind: 'success', iconName: 'shield' }),
      onLevels: () => {},
      onTracks: () => {},
      onFatal: (e) => this.showError(e.message),
    });
    this.subs = new SubtitleRenderer(this.video, this.subLayer);
    this.applyAspect();
  }

  // ------------------------------------------------------------------ DOM
  build() {
    this.video = h('video.player-video', { playsInline: true });
    this.ytHost = h('div.yt-host');
    this.subLayer = h('div.sub-layer');
    this.spinner = h('div.player-spinner', h('div.spinner'));
    this.zap = h('div.player-zap');
    this.seekHint = h('div.seek-hint');
    this.adCover = h(
      'div.player-adcover',
      h('div.adcover-box', icon('shield'), h('div', h('strong', 'Werbepause erkannt'), h('div.muted', 'Ton stummgeschaltet – geht nach der Pause automatisch weiter.'))),
    );
    this.skipBtn = h('button.player-skip', { type: 'button', data: { focus: true }, onClick: () => this.skipper && this.skipper.skip() });
    this.errorBox = h('div.player-error');
    this.nextCard = h('div.player-next');

    // OSD top
    this.titleEl = h('div.osd-title');
    this.subtitleEl = h('div.osd-subtitle');
    this.logoEl = h('div.osd-logo');
    this.clockEl = h('div.osd-clock');
    const top = h(
      'div.osd-top',
      h('button.icon-btn.osd-back', { type: 'button', data: { focus: true }, 'aria-label': 'Schließen', onClick: () => this.close() }, icon('back')),
      this.logoEl,
      h('div.osd-heading', this.titleEl, this.subtitleEl),
      this.clockEl,
    );

    // progress
    this.curEl = h('span.osd-time');
    this.durEl = h('span.osd-time');
    this.bufferBar = h('div.bar-buffer');
    this.playedBar = h('div.bar-played');
    this.thumb = h('div.bar-thumb');
    this.previewEl = h('div.bar-preview');
    this.bar = h(
      'div.osd-bar',
      { data: { focus: true }, role: 'slider', tabindex: '0', 'aria-label': 'Position' },
      h('div.bar-track', this.bufferBar, this.playedBar, this.thumb),
      this.previewEl,
    );
    this.progress = h('div.osd-progress', this.curEl, this.bar, this.durEl);
    this.liveBadge = h('div.osd-live', h('span.live-dot'), 'LIVE');

    // controls
    const cb = (name, label, fn, cls = '') => h('button.osd-btn' + (cls ? '.' + cls : ''), { type: 'button', data: { focus: true }, 'aria-label': label, title: label, onClick: fn }, icon(name));
    this.btnPrev = cb('skipPrev', 'Vorheriger Sender', () => this.zapBy(-1), 'live-only');
    this.btnRew = cb('rewind', 'Zurückspulen', () => this.seekBy(-store.get('player.seekStep')), 'vod-only');
    this.btnPlay = cb('pause', 'Wiedergabe/Pause', () => this.togglePlay(), 'primary');
    this.btnFwd = cb('forward', 'Vorspulen', () => this.seekBy(store.get('player.seekStep')), 'vod-only');
    this.btnNext = cb('skipNext', 'Nächster Sender', () => this.zapBy(1), 'live-only');
    this.btnList = cb('list', 'Senderliste', () => this.openChannelPanel(), 'live-only');
    this.btnFav = cb('star', 'Favorit', () => this.toggleFavorite(), 'live-only');
    this.btnGuide = cb('guide', 'TV-Programm & Archiv', () => this.openGuide(), 'live-only');
    this.btnAudio = cb('audio', 'Tonspur', () => this.menuAudio());
    this.btnSubs = cb('subtitles', 'Untertitel', () => this.menuSubtitles());
    this.btnQuality = cb('quality', 'Qualität', () => this.menuQuality());
    this.btnMore = cb('settings', 'Optionen', () => this.menuMore());
    this.btnPip = cb('pip', 'Bild-in-Bild', () => this.togglePip());
    this.btnFs = cb('fullscreen', 'Vollbild', () => this.toggleFullscreen());
    this.btnMute = cb('volume', 'Ton aus/an', () => this.toggleMute());

    const controls = h(
      'div.osd-controls',
      { data: { focusGroup: true } },
      h('div.osd-group', this.btnPrev, this.btnRew, this.btnPlay, this.btnFwd, this.btnNext),
      h('div.osd-spacer'),
      h('div.osd-group', this.btnList, this.btnGuide, this.btnFav, this.btnAudio, this.btnSubs, this.btnQuality, this.btnMute, this.btnMore, this.btnPip, this.btnFs),
    );
    // Big centre buttons for touch
    this.centerPlay = h('button.osd-center-btn.big', { type: 'button', 'aria-label': 'Wiedergabe/Pause', onClick: () => this.togglePlay() }, icon('play'));
    const center = h(
      'div.osd-center',
      h('button.osd-center-btn.vod-only', { type: 'button', 'aria-label': 'Zurück', onClick: () => this.seekBy(-store.get('player.seekStep')) }, icon('rewind')),
      this.centerPlay,
      h('button.osd-center-btn.vod-only', { type: 'button', 'aria-label': 'Vor', onClick: () => this.seekBy(store.get('player.seekStep')) }, icon('forward')),
    );

    this.osd = h('div.player-osd', top, center, h('div.osd-bottom', h('div.osd-progress-row', this.progress, this.liveBadge), controls));
    this.gesture = h('div.player-gesture');
    this.panel = h('aside.player-panel', { data: { focusGroup: true } });

    this.root = h(
      'div.player',
      { tabindex: '-1', role: 'dialog', 'aria-label': 'Player' },
      h('div.player-stage', this.video, this.ytHost),
      this.subLayer,
      this.gesture,
      this.adCover,
      this.spinner,
      this.zap,
      this.seekHint,
      this.osd,
      this.skipBtn,
      this.nextCard,
      this.errorBox,
      this.panel,
    );

    this.installBarHandlers();
    this.installGestures();
    this.onKeyCapture = (e) => this.handleKey(e);
    this.onRemote = ({ key }) => this.handleRemote(key);
    // Real mouse / Magic Remote pointer (not the emulated mouse events after a tap on touch screens).
    this.root.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      if (!this.osdVisible) this.showOsd(false);
      else this.armHide();
    });
  }

  // ------------------------------------------------------------------ open / close
  async open(session) {
    const wasOpen = !!this.session;
    if (wasOpen) await this.stopCurrent();
    this.session = session;
    if (!wasOpen) {
      document.body.appendChild(this.root);
      document.documentElement.classList.add('player-open');
      this.popScope = pushScope(this.root, { onBack: () => this.onBack(), autofocus: false });
      this.dismiss = openOverlay('player', () => this.teardown());
      window.addEventListener('keydown', this.onKeyCapture, true);
      this.offRemote = bus.on('remote', this.onRemote);
      this.clockTimer = setInterval(() => this.updateClock(), 15000);
      this.updateClock();
      this.root.focus({ preventScroll: true });
      this.requestWakeLock();
      if (inputMode.isTV() && store.get('ui.inputMode') !== 'touch') this.enterFullscreen(true);
      bus.emit('player:opened');
    }
    this.root.classList.toggle('is-live', session.kind === 'channel' && (!session.channels[session.index] || session.channels[session.index].kind !== 'vod'));
    this.root.classList.remove('is-youtube'); // set only when the official embedded player is used
    this.root.classList.toggle('has-pip', this.pipSupported());
    this.root.classList.toggle('has-fs', this.fsSupported());
    await this.start();
  }

  /** Closes the player (Back button, Stop key). */
  close() {
    if (this.dismiss) this.dismiss();
    else this.teardown();
  }

  async stopCurrent() {
    const s = this.session;
    if (!s) return;
    this.savePosition();
    if (s.kind === 'jellyfin' && s.pb) jf.reportStopped(s.item, s.pb, this.time());
    clearInterval(this.progressTimer);
    if (this.skipper) this.skipper.destroy();
    this.skipper = null;
    this.subs.clear();
    this.hideSkip();
    this.nextCard.classList.remove('show');
    clearInterval(this.nextTimer);
    if (this.yt) {
      this.yt.destroy();
      this.yt = null;
    }
    this.engine.destroy();
    this.unbindMedia();
  }

  teardown() {
    if (!this.session) return;
    this.stopCurrent();
    this.session = null;
    this.dismiss = null;
    window.removeEventListener('keydown', this.onKeyCapture, true);
    if (this.offRemote) this.offRemote();
    clearInterval(this.clockTimer);
    clearTimeout(this.hideTimer);
    this.closePanel(true);
    this.releaseWakeLock();
    this.exitFullscreen();
    this.onAdBreak(false);
    this.root.remove();
    document.documentElement.classList.remove('player-open');
    if (this.popScope) this.popScope();
    this.popScope = null;
    try {
      if (navigator.mediaSession) navigator.mediaSession.metadata = null;
    } catch {
      /* ignore */
    }
    bus.emit('player:closed');
  }

  onBack() {
    if (this.panel.classList.contains('open')) {
      this.closePanel();
      return false;
    }
    if (this.osdVisible && inputMode.isTV() && !this.media.paused) {
      this.hideOsd();
      return false;
    }
    this.close();
    return false;
  }

  // ------------------------------------------------------------------ loading
  get media() {
    return this.yt || this.video;
  }

  async start() {
    const s = this.session;
    const token = (this.loadToken = (this.loadToken || 0) + 1);
    this.errorBox.classList.remove('show');
    this.spinner.classList.add('show');
    this.onAdBreak(false);
    this.updateHeader();
    // Touch: show the controls briefly. TV: only the channel banner – ▲▼ zap right away, OK opens the OSD.
    if (!inputMode.isTV()) this.showOsd(false);
    try {
      if (s.kind === 'youtube') await this.startYouTube(s, token);
      else if (s.kind === 'jellyfin') await this.startJellyfin(s, token);
      else await this.startStream(s, token);
      if (token !== this.loadToken) return;
      this.bindMedia();
      this.setupMediaSession();
      await this.safePlay();
      this.updateUi();
    } catch (e) {
      if (token !== this.loadToken) return;
      console.error('[player]', e);
      this.showError(e.message || String(e));
    }
  }

  async startStream(s, token) {
    let url;
    let type = 'auto';
    let startSeconds = 0;
    let live = true;
    if (s.kind === 'channel') {
      const ch = s.channels[s.index];
      url = ch.url;
      live = ch.kind !== 'vod';
      iptv.addHistory(s.sourceId, ch).catch(() => {});
      this.showZap(ch);
      this.updateFavorite();
      // YouTube links in playlists play in the YouTube player (with SponsorBlock).
      const yid = youtubeId(url);
      if (yid) {
        s.youtubeFallback = yid;
        await this.startYouTube({ id: yid, title: ch.name }, token);
        return;
      }
    } else {
      url = s.url;
      type = s.type || 'auto';
      live = !!s.live;
      const yid = youtubeId(url);
      if (yid) {
        await this.startYouTube({ id: yid, title: s.title }, token);
        return;
      }
    }
    if (!live && store.get('player.resume')) startSeconds = await getResume(url);
    this.currentUrl = url;
    this.video.hidden = false;
    await this.engine.load({ url, type, live, startSeconds, allowProxy: true });
    if (startSeconds > 5) toast('Fortgesetzt bei ' + formatTime(startSeconds));
    // A plain direct link with ad markers etc. – skipper for nothing; keep structure uniform.
    this.skipper = new SegmentSkipper(this.adapter(), (ui) => this.onSkipUi(ui));
  }

  async startJellyfin(s, token, opts = {}) {
    const startMs = opts.startMs !== undefined ? opts.startMs : s.startMs;
    const pb = await jf.getPlayback(s.item, { startMs, audioIndex: opts.audioIndex, subtitleIndex: opts.subtitleIndex, forceTranscode: opts.forceTranscode });
    if (token !== this.loadToken) return;
    s.pb = pb;
    this.video.hidden = false;
    try {
      await this.engine.load({ url: pb.url, type: pb.type === 'hls' ? 'hls' : 'file', live: false, startSeconds: pb.startSeconds });
    } catch (e) {
      // Direct play failed (codec the browser can't decode after all) → ask the server to transcode.
      if (pb.method !== 'Transcode' && !opts.forceTranscode) {
        toast('Direkte Wiedergabe nicht möglich – Server wandelt um …');
        return this.startJellyfin(s, token, { ...opts, startMs, forceTranscode: true });
      }
      throw e;
    }
    // default subtitle
    const sub = pb.subtitles.find((x) => x.index === pb.subtitleIndex && x.url) || (pb.subtitleIndex === -1 ? null : pb.subtitles.find((x) => x.forced && x.url));
    if (sub) this.subs.loadUrl(sub.url).catch((err) => console.warn(err));
    jf.reportStart(s.item, pb, pb.startSeconds);
    clearInterval(this.progressTimer);
    this.progressTimer = setInterval(() => {
      if (this.session === s && s.pb) jf.reportProgress(s.item, s.pb, this.time(), this.media.paused);
    }, 10000);
    this.skipper = new SegmentSkipper(this.adapter(), (ui) => this.onSkipUi(ui));
    jf.mediaSegments(s.item)
      .then((segs) => {
        if (this.session !== s || !this.skipper) return;
        this.skipper.setSegments(jf.plausibleSegments(segs, pb.durationSeconds));
      })
      .catch(() => {});
  }

  /** YouTube trailers / links: official embedded player, SponsorBlock on top. */
  async startYouTube(s, token) {
    this.root.classList.remove('is-live');
    this.video.hidden = true;
    this.engine.destroy();
    this.yt = new YouTubeMedia(this.ytHost);
    this.root.classList.add('is-youtube');
    await this.yt.load(s.id, s.startSeconds || 0);
    if (token !== this.loadToken) return;
    if (!s.title || s.title === 'YouTube-Video') {
      try {
        const data = this.yt.player.getVideoData();
        if (data && data.title) {
          s.title = data.title;
          s.channel = data.author;
          this.updateHeader();
        }
      } catch {
        /* ignore */
      }
    }
    this.skipper = new SegmentSkipper(this.adapter(), (ui) => this.onSkipUi(ui));
    fetchSponsorSegments(s.id).then((segs) => {
      if (this.skipper && this.session === s && segs.length) {
        this.skipper.setSegments(segs);
        toast(`SponsorBlock: ${segs.length} Segment${segs.length > 1 ? 'e' : ''} gefunden`, { iconName: 'shield' });
      }
    });
  }

  adapter() {
    return {
      time: () => this.time(),
      duration: () => this.duration(),
      seek: (t) => this.seekTo(t),
      setMuted: (m) => (this.media.muted = m),
      isMuted: () => this.media.muted,
    };
  }

  async safePlay() {
    const m = this.media;
    m.muted = !!store.get('player.muted');
    if (m === this.video) m.volume = store.get('player.volume');
    try {
      await m.play();
    } catch (e) {
      if (e && e.name === 'NotAllowedError') {
        // Autoplay blocked (no user gesture): show the play button.
        this.showOsd(true);
        toast('Zum Starten auf ▶ tippen');
      }
    }
  }

  // ------------------------------------------------------------------ media events
  bindMedia() {
    this.unbindMedia();
    const m = this.media;
    const on = (ev, fn) => {
      m.addEventListener(ev, fn);
      this.mediaHandlers.push([m, ev, fn]);
    };
    on('timeupdate', () => this.updateProgress());
    on('durationchange', () => this.updateUi());
    on('progress', () => this.updateProgress());
    on('play', () => this.updatePlayState());
    on('pause', () => {
      this.updatePlayState();
      this.showOsd(false);
      this.savePosition();
    });
    on('playing', () => {
      this.spinner.classList.remove('show');
      this.updatePlayState();
    });
    on('waiting', () => this.spinner.classList.add('show'));
    on('canplay', () => this.spinner.classList.remove('show'));
    on('loadeddata', () => this.spinner.classList.remove('show'));
    on('volumechange', () => this.updateMute());
    on('ended', () => this.onEnded());
    on('error', () => {
      if (this.media === this.video && this.video.error) this.showError(this.video.error.message || 'Wiedergabefehler');
    });
  }

  unbindMedia() {
    for (const [m, ev, fn] of this.mediaHandlers) m.removeEventListener(ev, fn);
    this.mediaHandlers = [];
  }

  time() {
    return this.media.currentTime || 0;
  }

  duration() {
    const d = this.media.duration;
    return isFinite(d) ? d : NaN;
  }

  isVod() {
    const d = this.duration();
    return isFinite(d) && d > 0;
  }

  async onEnded() {
    const s = this.session;
    if (!s) return;
    if (s.kind === 'jellyfin' && s.item.Type === 'Episode' && store.get('player.autoplayNext')) {
      const next = await jf.nextEpisode(s.item).catch(() => null);
      if (next && this.session === s) return this.offerNext(next);
    }
    if (s.kind === 'channel' && s.channels[s.index].kind !== 'vod') {
      // live stream ended – try to reconnect once
      this.start();
      return;
    }
    this.showOsd(true);
  }

  offerNext(next) {
    let left = 10;
    const label = h('span');
    const go = () => {
      clearInterval(this.nextTimer);
      this.nextCard.classList.remove('show');
      this.open({ kind: 'jellyfin', item: next, startMs: 0 });
    };
    const cancel = () => {
      clearInterval(this.nextTimer);
      this.nextCard.classList.remove('show');
      this.showOsd(true);
    };
    const title = (next.SeriesName ? `S${next.ParentIndexNumber || '?'}E${next.IndexNumber || '?'} · ` : '') + next.Name;
    const playBtn = h('button.btn.primary', { type: 'button', data: { focus: true }, onClick: go }, icon('play'), h('span.btn-label', 'Jetzt abspielen'));
    this.nextCard.replaceChildren(
      h('div.next-info', h('div.muted', 'Nächste Folge'), h('div.next-title', title), label),
      h('div.next-actions', playBtn, h('button.btn.ghost', { type: 'button', data: { focus: true }, onClick: cancel }, h('span.btn-label', 'Abbrechen'))),
    );
    this.nextCard.classList.add('show');
    focus(playBtn);
    const tick = () => {
      label.textContent = `Startet in ${left} s`;
      if (left-- <= 0) go();
    };
    tick();
    clearInterval(this.nextTimer);
    this.nextTimer = setInterval(tick, 1000);
  }

  savePosition() {
    const s = this.session;
    if (!s || !this.isVod() || s.kind === 'jellyfin' || s.kind === 'youtube') return;
    if (this.currentUrl) saveResume(this.currentUrl, this.time(), this.duration()).catch(() => {});
  }

  // ------------------------------------------------------------------ UI updates
  updateHeader() {
    const s = this.session;
    let title = '';
    let sub = '';
    let logo = null;
    if (s.kind === 'channel') {
      const ch = s.channels[s.index];
      title = ch.name;
      sub = `${ch.number ? ch.number + ' · ' : ''}${ch.group || ''}`;
      logo = ch.logo;
      epg.getEpg(s.sourceId, { autoRefresh: false }).then((d) => {
        if (!d || this.session !== s || s.channels[s.index] !== ch) return;
        const nn = epg.nowNext(d, ch);
        if (nn.now) this.subtitleEl.textContent = `${epg.formatHm(nn.now.start)}–${epg.formatHm(nn.now.stop)} ${nn.now.title}` + (nn.next ? `  ·  danach ${epg.formatHm(nn.next.start)} ${nn.next.title}` : '');
      }).catch(() => {});
    } else if (s.kind === 'jellyfin') {
      const it = s.item;
      title = it.SeriesName || it.Name;
      sub = it.SeriesName ? `S${it.ParentIndexNumber || '?'}E${it.IndexNumber || '?'} · ${it.Name}` : [it.ProductionYear, jf.formatRuntime(it.RunTimeTicks)].filter(Boolean).join(' · ');
    } else if (s.kind === 'youtube') {
      title = s.title || 'YouTube';
      sub = [s.channel, 'SponsorBlock ' + (store.get('blocker.sponsorblock.enabled') ? 'an' : 'aus')].filter(Boolean).join(' · ');
    } else {
      title = s.title || 'Stream';
      sub = s.subtitle || '';
    }
    this.titleEl.textContent = title;
    this.subtitleEl.textContent = sub;
    this.logoEl.replaceChildren(logo ? img(logo, title, 'logo', title) : '');
    this.logoEl.hidden = !logo;
    document.title = title + ' – Kasy TV';
  }

  updateUi() {
    const vod = this.isVod();
    this.root.classList.toggle('is-vod', vod);
    this.progress.hidden = !vod;
    this.liveBadge.hidden = vod;
    const s = this.session;
    const isChannel = s && s.kind === 'channel';
    this.root.classList.toggle('has-channels', !!isChannel && s.channels.length > 1);
    this.updateProgress();
    this.updatePlayState();
    this.updateMute();
  }

  updateProgress() {
    if (!this.isVod()) return;
    const t = this.time();
    const d = this.duration();
    const pct = clamp((t / d) * 100, 0, 100);
    this.playedBar.style.width = pct + '%';
    this.thumb.style.left = pct + '%';
    this.curEl.textContent = formatTime(t);
    this.durEl.textContent = '-' + formatTime(d - t);
    this.bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    const b = this.media.buffered;
    if (b && b.length) {
      let end = 0;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 1) end = Math.max(end, b.end(i));
      this.bufferBar.style.width = clamp((end / d) * 100, 0, 100) + '%';
    }
  }

  updatePlayState() {
    const paused = this.media.paused;
    const name = paused ? 'play' : 'pause';
    this.btnPlay.replaceChildren(icon(name));
    this.centerPlay.replaceChildren(icon(name));
    this.root.classList.toggle('is-paused', paused);
    try {
      if (navigator.mediaSession) navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
    } catch {
      /* ignore */
    }
  }

  updateMute() {
    this.btnMute.replaceChildren(icon(this.media.muted ? 'mute' : 'volume'));
  }

  updateClock() {
    this.clockEl.textContent = store.get('text.osd.showClock') ? formatClock() : '';
  }

  async updateFavorite() {
    const s = this.session;
    if (!s || s.kind !== 'channel') return;
    const fav = await iptv.isFavorite(iptv.channelKey(s.sourceId, s.channels[s.index]));
    this.btnFav.classList.toggle('active', fav);
  }

  showZap(ch) {
    this.zap.replaceChildren(
      ...[
        h('div.zap-num', String(ch.number || '')),
        ch.logo ? img(ch.logo, ch.name, 'zap-logo', ch.name) : null,
        h('div.zap-text', h('div.zap-name', ch.name), h('div.zap-group', ch.group || '')),
      ].filter(Boolean),
    );
    this.zap.classList.add('show');
    clearTimeout(this.zapTimer);
    this.zapTimer = setTimeout(() => this.zap.classList.remove('show'), 3500);
  }

  showError(message) {
    this.spinner.classList.remove('show');
    const s = this.session;
    const actions = [h('button.btn.primary', { type: 'button', data: { focus: true }, onClick: () => this.start() }, icon('refresh'), h('span.btn-label', 'Erneut versuchen'))];
    if (s && s.kind === 'channel' && s.channels.length > 1) actions.push(h('button.btn.ghost', { type: 'button', data: { focus: true }, onClick: () => this.zapBy(1) }, icon('skipNext'), h('span.btn-label', 'Nächster Sender')));
    actions.push(h('button.btn.ghost', { type: 'button', data: { focus: true }, onClick: () => this.close() }, icon('close'), h('span.btn-label', 'Schließen')));
    let hint = '';
    const url = s && (s.kind === 'channel' ? s.channels[s.index].url : s.url);
    if (url && location.protocol === 'https:' && /^http:/i.test(url)) hint = 'Hinweis: HTTP-Stream in einer HTTPS-App – Browser blockieren das (Mixed Content). Abhilfe: Stream-Proxy in den IPTV-Einstellungen oder die App über HTTP im Heimnetz öffnen.';
    else if (url && detectType(url) === 'mpegts' && !window.MediaSource) hint = 'Reine MPEG-TS-Streams kann dieses Gerät (iOS) nicht abspielen. Falls der Anbieter HLS (.m3u8) anbietet, diese Variante verwenden.';
    this.errorBox.replaceChildren(h('div.error-box', icon('info', 'big'), h('h3', 'Wiedergabe nicht möglich'), h('p', message), hint ? h('p.hint', hint) : null, h('div.error-actions', actions)));
    this.errorBox.classList.add('show');
    focusFirst(this.errorBox);
  }

  // ------------------------------------------------------------------ OSD
  showOsd(focusControls) {
    this.osdVisible = true;
    this.root.classList.add('osd-visible');
    if (focusControls && inputMode.isTV()) focus(this.isVod() ? this.bar : this.btnPlay);
    else if (inputMode.isTV() && !this.root.contains(document.activeElement)) this.root.focus({ preventScroll: true });
    this.armHide();
  }

  hideOsd() {
    if (this.panel.classList.contains('open')) return;
    this.osdVisible = false;
    this.root.classList.remove('osd-visible');
    clearTimeout(this.hideTimer);
    if (inputMode.isTV() && this.osd.contains(document.activeElement)) this.root.focus({ preventScroll: true });
  }

  armHide() {
    clearTimeout(this.hideTimer);
    const secs = store.get('player.osdTimeout') || 4;
    this.hideTimer = setTimeout(() => {
      if (!this.session || this.media.paused || this.panel.classList.contains('open')) return;
      if (document.querySelector('.dialog-backdrop')) return;
      this.hideOsd();
    }, secs * 1000);
  }

  // ------------------------------------------------------------------ controls
  togglePlay() {
    const m = this.media;
    if (m.paused) m.play().catch(() => {});
    else m.pause();
    this.armHide();
  }

  seekTo(t) {
    const d = this.duration();
    if (!isFinite(d)) return;
    this.media.currentTime = clamp(t, 0, Math.max(0, d - 0.5));
    this.updateProgress();
  }

  seekBy(delta) {
    if (!this.isVod()) return;
    this.seekTo(this.time() + delta);
    this.seekHint.textContent = (delta > 0 ? '+' : '−') + Math.abs(Math.round(delta)) + ' s';
    this.seekHint.classList.remove('left', 'right');
    this.seekHint.classList.add('show', delta > 0 ? 'right' : 'left');
    clearTimeout(this.seekHintTimer);
    this.seekHintTimer = setTimeout(() => this.seekHint.classList.remove('show'), 700);
  }

  toggleMute() {
    this.media.muted = !this.media.muted;
    store.set('player.muted', this.media.muted);
  }

  async zapBy(delta) {
    const s = this.session;
    if (!s || s.kind !== 'channel' || s.channels.length < 2) return;
    s.index = (s.index + delta + s.channels.length) % s.channels.length;
    await this.stopCurrent();
    this.root.classList.toggle('is-live', s.channels[s.index].kind !== 'vod');
    this.start();
  }

  async zapToNumber(n) {
    const s = this.session;
    if (!s || s.kind !== 'channel') return;
    const idx = s.channels.findIndex((c) => c.number === n);
    if (idx < 0) {
      toast('Kein Sender mit Nummer ' + n);
      return;
    }
    if (idx === s.index) return;
    s.index = idx;
    await this.stopCurrent();
    this.start();
  }

  /** Closes the player and opens the programme guide (archive) of the current channel. */
  openGuide() {
    const s = this.session;
    if (!s || s.kind !== 'channel') return;
    const ch = s.channels[s.index];
    this.close();
    setTimeout(() => navigate('/live/epg?ch=' + encodeURIComponent(ch.id)), 50);
  }

  async toggleFavorite() {
    const s = this.session;
    if (!s || s.kind !== 'channel') return;
    const ch = s.channels[s.index];
    const fav = await iptv.toggleFavorite(iptv.channelKey(s.sourceId, ch));
    this.btnFav.classList.toggle('active', fav);
    toast(fav ? `„${ch.name}“ zu Favoriten hinzugefügt` : `„${ch.name}“ aus Favoriten entfernt`, { iconName: 'star' });
  }

  applyAspect() {
    this.video.style.objectFit = store.get('player.aspect') || 'contain';
  }

  // ------------------------------------------------------------------ menus
  async menuAudio() {
    const s = this.session;
    if (s.kind === 'jellyfin' && s.pb && s.pb.audioTracks.length > 1) {
      const v = await pickOption('Tonspur', s.pb.audioTracks.map((t) => ({ value: t.index, label: t.label })), s.pb.audioIndex);
      if (v !== undefined && v !== s.pb.audioIndex) this.reloadJellyfin({ audioIndex: v, subtitleIndex: s.pb.subtitleIndex });
      return;
    }
    const tracks = this.engine.audioTracks();
    if (!tracks.length) return toast('Nur eine Tonspur verfügbar');
    const cur = tracks.find((t) => t.active);
    const v = await pickOption('Tonspur', tracks.map((t) => ({ value: t.id, label: t.label })), cur ? cur.id : undefined);
    if (v !== undefined) this.engine.setAudioTrack(v);
  }

  async menuSubtitles() {
    const s = this.session;
    const options = [{ value: 'off', label: 'Aus' }];
    let current = 'off';
    if (s.kind === 'jellyfin' && s.pb) {
      for (const t of s.pb.subtitles) options.push({ value: 'jf:' + t.index, label: t.label + (t.burnIn ? ' (wird eingebrannt)' : ''), description: t.forced ? 'Erzwungen' : undefined });
      if (s.pb.subtitleIndex !== undefined && s.pb.subtitleIndex >= 0) current = 'jf:' + s.pb.subtitleIndex;
    }
    const tracks = this.engine.textTracks();
    tracks.forEach((t, i) => options.push({ value: 'tt:' + i, label: t.label || t.language || 'Spur ' + (i + 1) }));
    if (this.subs.track) {
      const i = tracks.indexOf(this.subs.track);
      if (i >= 0) current = 'tt:' + i;
    }
    options.push({ value: 'style', label: 'Darstellung anpassen …', description: 'Schrift, Größe, Farbe, Position' });
    const v = await pickOption('Untertitel', options, current);
    if (v === undefined || v === current) return;
    if (v === 'style') return this.subtitleStyleDialog();
    if (v === 'off') {
      this.subs.clear();
      this.engine.enableHlsSubtitles(false);
      if (s.kind === 'jellyfin' && s.pb) {
        const wasBurned = (s.pb.subtitles.find((x) => x.index === s.pb.subtitleIndex) || {}).burnedNow;
        s.pb.subtitleIndex = -1;
        if (wasBurned) this.reloadJellyfin({ subtitleIndex: -1, audioIndex: s.pb.audioIndex });
      }
      return;
    }
    if (v.startsWith('jf:')) {
      const idx = parseInt(v.slice(3), 10);
      const t = s.pb.subtitles.find((x) => x.index === idx);
      if (t.burnIn) return this.reloadJellyfin({ subtitleIndex: idx, audioIndex: s.pb.audioIndex, forceTranscode: true });
      s.pb.subtitleIndex = idx;
      try {
        const n = await this.subs.loadUrl(t.url);
        toast(`Untertitel geladen (${n} Einträge)`);
      } catch (e) {
        toast(e.message, { kind: 'error' });
      }
      return;
    }
    if (v.startsWith('tt:')) {
      const t = tracks[parseInt(v.slice(3), 10)];
      if (this.engine.hls) {
        const i = this.engine.hls.subtitleTracks.findIndex((x) => x.name === t.label || x.lang === t.language);
        if (i >= 0) this.engine.hls.subtitleTrack = i;
        this.engine.enableHlsSubtitles(true);
      }
      this.subs.useTrack(t);
    }
  }

  subtitleStyleDialog() {
    const preview = h('div.sub-preview', h('div.sub-layer.static', h('div.sub-cue', { html: 'So sehen Untertitel aus.<br><i>Zweite Zeile</i>' })));
    dialog({
      title: 'Untertitel-Darstellung',
      wide: true,
      body: h(
        'div.form',
        preview,
        selectRow('Schrift', null, 'text.subtitle.font', FONTS.map((f) => ({ value: f.value, label: f.label }))),
        stepperRow('Größe', null, 'text.subtitle.size', { min: 50, max: 250, step: 10, format: (v) => v + ' %' }),
        stepperRow('Abstand unten', null, 'text.subtitle.position', { min: 0, max: 40, step: 2, format: (v) => v + ' %' }),
        stepperRow('Hintergrund', null, 'text.subtitle.backgroundOpacity', { min: 0, max: 1, step: 0.1, format: (v) => Math.round(v * 100) + ' %' }),
        colorRow('Textfarbe', null, 'text.subtitle.color', COLORS),
      ),
      actions: [{ label: 'Fertig', primary: true, value: true }],
    });
  }

  async menuQuality() {
    const s = this.session;
    if (s.kind === 'jellyfin') {
      const opts = [120e6, 60e6, 40e6, 20e6, 10e6, 8e6, 4e6, 2e6, 1e6].map((b) => ({ value: b, label: b >= 1e6 ? b / 1e6 + ' Mbit/s' : b / 1e3 + ' kbit/s' }));
      const v = await pickOption('Max. Bitrate (Jellyfin)', opts, store.get('jellyfin.maxBitrate'));
      if (v !== undefined && v !== store.get('jellyfin.maxBitrate')) {
        store.set('jellyfin.maxBitrate', v);
        this.reloadJellyfin({ audioIndex: s.pb && s.pb.audioIndex, subtitleIndex: s.pb && s.pb.subtitleIndex });
      }
      return;
    }
    if (s.kind === 'youtube') {
      const levels = this.yt && this.yt.player.getAvailableQualityLevels ? this.yt.player.getAvailableQualityLevels() : [];
      if (!levels.length) return toast('YouTube wählt die Qualität automatisch');
      const v = await pickOption('Qualität', levels.map((l) => ({ value: l, label: l })), this.yt.player.getPlaybackQuality());
      if (v) this.yt.player.setPlaybackQuality(v);
      return;
    }
    const q = this.engine.qualities();
    if (!q.length) return toast('Keine Qualitätsstufen verfügbar (Gerät wählt automatisch)');
    const v = await pickOption('Qualität', [{ value: -1, label: 'Automatisch' }].concat(q.map((x) => ({ value: x.id, label: x.label }))), this.engine.currentQuality);
    if (v !== undefined) this.engine.setQuality(v);
  }

  async menuMore() {
    const speed = this.media.playbackRate || 1;
    const v = await pickOption('Optionen', [
      { value: 'aspect', label: 'Bildformat', description: { contain: 'Einpassen', cover: 'Zoomen (füllen)', fill: 'Strecken' }[store.get('player.aspect')] },
      { value: 'speed', label: 'Geschwindigkeit', description: speed + '×' },
      { value: 'substyle', label: 'Untertitel-Darstellung', description: 'Schrift, Größe, Farbe' },
      { value: 'info', label: 'Stream-Info' },
    ]);
    if (v === 'aspect') {
      const a = await pickOption('Bildformat', [
        { value: 'contain', label: 'Einpassen' },
        { value: 'cover', label: 'Zoomen (füllen)' },
        { value: 'fill', label: 'Strecken' },
      ], store.get('player.aspect'));
      if (a) {
        store.set('player.aspect', a);
        this.applyAspect();
      }
    } else if (v === 'speed') {
      const r = await pickOption('Geschwindigkeit', [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((x) => ({ value: x, label: x + '×' })), speed);
      if (r) this.media.playbackRate = r;
    } else if (v === 'substyle') this.subtitleStyleDialog();
    else if (v === 'info') this.streamInfo();
  }

  streamInfo() {
    const s = this.session;
    const v = this.video;
    const rows = [
      ['Technik', this.yt ? 'YouTube IFrame' : this.engine.kind === 'hlsjs' ? 'hls.js (MSE)' : this.engine.kind === 'mpegts' ? 'mpegts.js (MSE)' : this.engine.kind === 'dash' ? 'dash.js (MSE)' : 'Nativ'],
      ['Auflösung', v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '–'],
      ['Dauer', this.isVod() ? formatTime(this.duration()) : 'Live'],
    ];
    if (s.kind === 'jellyfin' && s.pb) rows.push(['Jellyfin', s.pb.method]);
    if (this.engine.hls && this.engine.hls.levels && this.engine.hls.levels[this.engine.hls.currentLevel]) {
      const l = this.engine.hls.levels[this.engine.hls.currentLevel];
      rows.push(['Bitrate', (l.bitrate / 1e6).toFixed(2) + ' Mbit/s']);
    }
    const url = s.kind === 'channel' ? s.channels[s.index].url : s.url || (s.pb && s.pb.url) || '';
    if (url) rows.push(['Adresse', url.replace(/api_key=[^&]+/, 'api_key=…')]);
    dialog({ title: 'Stream-Info', body: h('dl.info-list', rows.map(([k, val]) => [h('dt', k), h('dd', val)])), actions: [{ label: 'OK', primary: true }] });
  }

  async reloadJellyfin(opts) {
    const s = this.session;
    const pos = this.time();
    await this.stopCurrent();
    const token = (this.loadToken = (this.loadToken || 0) + 1);
    this.spinner.classList.add('show');
    try {
      await this.startJellyfin(s, token, { ...opts, startMs: pos * 1000 });
      this.bindMedia();
      await this.safePlay();
      this.updateUi();
    } catch (e) {
      this.showError(e.message);
    }
  }

  // ------------------------------------------------------------------ channel panel
  openChannelPanel() {
    const s = this.session;
    if (!s || s.kind !== 'channel') return;
    const from = Math.max(0, s.index - 120);
    const to = Math.min(s.channels.length, s.index + 120);
    const list = h('div.panel-list');
    let currentBtn = null;
    for (let i = from; i < to; i++) {
      const ch = s.channels[i];
      const b = h(
        'button.panel-item' + (i === s.index ? '.current' : ''),
        {
          type: 'button',
          data: { focus: true },
          onClick: () => {
            this.closePanel();
            if (i !== s.index) this.zapBy(i - s.index);
          },
        },
        h('span.panel-num', String(ch.number || i + 1)),
        img(ch.logo, ch.name, 'panel-logo', ch.name),
        h('span.panel-name', ch.name),
      );
      if (i === s.index) currentBtn = b;
      list.appendChild(b);
    }
    this.panel.replaceChildren(h('div.panel-head', h('h3', 'Sender'), h('span.muted', `${s.channels.length} in dieser Liste`)), list);
    this.panel.classList.add('open');
    this.showOsd(false);
    requestAnimationFrame(() => {
      if (currentBtn) {
        currentBtn.scrollIntoView({ block: 'center' });
        focus(currentBtn, { scroll: false });
      }
    });
  }

  closePanel(silent) {
    if (!this.panel.classList.contains('open')) return;
    this.panel.classList.remove('open');
    if (!silent && inputMode.isTV()) focus(this.btnList.offsetParent ? this.btnList : this.btnPlay);
  }

  // ------------------------------------------------------------------ skip / ads
  onSkipUi(ui) {
    if (ui.type === 'button') {
      this.skipBtn.replaceChildren(icon('skipNext'), h('span', `${ui.segment.label} überspringen`));
      this.skipBtn.classList.add('show');
      if (inputMode.isTV() && !this.osdVisible) focus(this.skipBtn);
    } else if (ui.type === 'skipped') {
      this.hideSkip();
      if (ui.auto && (ui.segment.source !== 'sponsorblock' || store.get('blocker.sponsorblock.notify'))) toast(`${ui.segment.label} übersprungen`, { iconName: 'skipNext' });
    } else if (ui.type === 'muted') {
      toast(`${ui.segment.label}: stummgeschaltet`, { iconName: 'mute' });
    } else if (ui.type === 'clear') this.hideSkip();
  }

  hideSkip() {
    const hadFocus = this.skipBtn.contains(document.activeElement);
    this.skipBtn.classList.remove('show');
    if (hadFocus) this.root.focus({ preventScroll: true });
  }

  onAdBreak(on) {
    if (on === this.inAd) return;
    this.inAd = on;
    this.adCover.classList.toggle('show', !!on);
    if (!this.media) return;
    if (on) {
      this.adWasMuted = this.media.muted;
      this.media.muted = true;
    } else if (this.adWasMuted !== undefined) {
      this.media.muted = this.adWasMuted;
      this.adWasMuted = undefined;
    }
  }

  // ------------------------------------------------------------------ input
  handleKey(e) {
    if (!this.session) return;
    if (document.querySelector('.dialog-backdrop')) return; // a dialog on top handles its own keys
    const k = e.key;
    const code = e.keyCode;
    const isArrow = /^Arrow/.test(k) || (code >= 37 && code <= 40);
    const isEnter = k === 'Enter' || code === 13;
    const panelOpen = this.panel.classList.contains('open');

    // digits → channel number
    if (/^[0-9]$/.test(k) && this.session.kind === 'channel' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.numberBuffer = (this.numberBuffer || '') + k;
      this.zap.replaceChildren(h('div.zap-num.big', this.numberBuffer));
      this.zap.classList.add('show');
      clearTimeout(this.numberTimer);
      this.numberTimer = setTimeout(() => {
        const n = parseInt(this.numberBuffer, 10);
        this.numberBuffer = '';
        this.zapToNumber(n);
      }, 1400);
      return;
    }

    const a = document.activeElement;
    const inControls = a && a !== this.root && this.root.contains(a);
    if (this.osdVisible) this.armHide();
    if (inControls || panelOpen || this.errorBox.classList.contains('show') || this.nextCard.classList.contains('show')) {
      return; // normal focus navigation inside the OSD / panel / dialogs of the player
    }
    if (!isArrow && !isEnter) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const dir = k === 'ArrowUp' || code === 38 ? 'up' : k === 'ArrowDown' || code === 40 ? 'down' : k === 'ArrowLeft' || code === 37 ? 'left' : k === 'ArrowRight' || code === 39 ? 'right' : null;
    const live = !this.isVod();
    if (isEnter) {
      this.showOsd(true);
      return;
    }
    if (live && this.session.kind === 'channel') {
      if (dir === 'up') this.zapBy(-1);
      else if (dir === 'down') this.zapBy(1);
      else if (dir === 'left') this.openChannelPanel();
      else this.showOsd(true);
      return;
    }
    if (dir === 'left' || dir === 'right') {
      const step = store.get('player.seekStep') * (e.repeat ? 3 : 1);
      this.seekBy(dir === 'left' ? -step : step);
      return;
    }
    this.showOsd(true);
  }

  handleRemote(key) {
    if (!this.session || document.querySelector('.dialog-backdrop')) return;
    const step = store.get('player.seekStep');
    switch (key) {
      case 'playpause':
        this.togglePlay();
        break;
      case 'play':
        this.media.play().catch(() => {});
        break;
      case 'pause':
        this.media.pause();
        break;
      case 'stop':
        this.close();
        break;
      case 'forward':
      case 'next':
        if (this.isVod()) this.seekBy(step * 3);
        else this.zapBy(1);
        break;
      case 'rewind':
      case 'previous':
        if (this.isVod()) this.seekBy(-step * 3);
        else this.zapBy(-1);
        break;
      case 'channelup':
        this.zapBy(-1);
        break;
      case 'channeldown':
        this.zapBy(1);
        break;
      case 'red':
        this.openChannelPanel();
        break;
      case 'green':
      case 'menu':
        this.menuMore();
        break;
      case 'yellow':
        this.menuSubtitles();
        break;
      case 'blue':
        this.menuAudio();
        break;
      case 'guide':
        this.openGuide();
        break;
      case 'info':
        if (this.osdVisible) this.hideOsd();
        else this.showOsd(true);
        break;
      default:
    }
  }

  installBarHandlers() {
    const posFromEvent = (e) => {
      const r = this.bar.getBoundingClientRect();
      return clamp((e.clientX - r.left) / r.width, 0, 1);
    };
    let dragging = false;
    this.bar.addEventListener('pointerdown', (e) => {
      if (!this.isVod()) return;
      dragging = true;
      this.bar.setPointerCapture(e.pointerId);
      this.seekTo(posFromEvent(e) * this.duration());
      this.armHide();
    });
    this.bar.addEventListener('pointermove', (e) => {
      if (!this.isVod()) return;
      const p = posFromEvent(e);
      this.previewEl.textContent = formatTime(p * this.duration());
      this.previewEl.style.left = p * 100 + '%';
      if (dragging) this.seekTo(p * this.duration());
    });
    const end = () => (dragging = false);
    this.bar.addEventListener('pointerup', end);
    this.bar.addEventListener('pointercancel', end);
    // Remote: ◀ ▶ on the focused bar seek.
    this.bar.addEventListener('navkey', (e) => {
      const dir = e.detail.dir;
      if (dir !== 'left' && dir !== 'right') return;
      e.preventDefault();
      const step = store.get('player.seekStep');
      this.seekBy(dir === 'left' ? -step : step);
      this.armHide();
    });
  }

  installGestures() {
    const g = this.gesture;
    let start = null;
    let lastTap = 0;
    let tapTimer = null;
    let scrubbing = false;
    let scrubTarget = 0;
    g.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, y: e.clientY, t: Date.now(), time: this.time() };
      scrubbing = false;
    });
    g.addEventListener('pointermove', (e) => {
      if (!start || e.pointerType === 'mouse') return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!scrubbing && this.isVod() && Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy) * 1.5) scrubbing = true;
      if (scrubbing) {
        const w = g.clientWidth || 1;
        const span = Math.min(this.duration(), 600); // full width = up to 10 minutes
        scrubTarget = clamp(start.time + (dx / w) * span, 0, this.duration());
        const delta = scrubTarget - start.time;
        this.seekHint.textContent = `${formatTime(scrubTarget)} (${delta >= 0 ? '+' : '−'}${formatTime(Math.abs(delta))})`;
        this.seekHint.classList.remove('left', 'right');
        this.seekHint.classList.add('show');
      }
    });
    g.addEventListener('pointerup', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const dt = Date.now() - start.t;
      const s0 = start;
      start = null;
      if (scrubbing) {
        scrubbing = false;
        this.seekTo(scrubTarget);
        setTimeout(() => this.seekHint.classList.remove('show'), 400);
        return;
      }
      // vertical swipe → zap
      if (Math.abs(dy) > 60 && Math.abs(dy) > Math.abs(dx) * 1.5 && dt < 600 && this.session && this.session.kind === 'channel' && !this.isVod()) {
        this.zapBy(dy < 0 ? 1 : -1);
        return;
      }
      if (Math.abs(dx) > 12 || Math.abs(dy) > 12) return;
      const now = Date.now();
      const third = g.clientWidth / 3;
      if (now - lastTap < 300 && this.isVod() && (s0.x < third || s0.x > third * 2)) {
        clearTimeout(tapTimer);
        lastTap = 0;
        this.seekBy(s0.x < third ? -store.get('player.seekStep') : store.get('player.seekStep'));
        return;
      }
      lastTap = now;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => {
        if (this.panel.classList.contains('open')) this.closePanel();
        else if (this.osdVisible) this.hideOsd();
        else this.showOsd(false);
      }, this.isVod() ? 260 : 0);
    });
    g.addEventListener('pointercancel', () => {
      start = null;
      scrubbing = false;
    });
    g.addEventListener('dblclick', (e) => {
      if (!inputMode.isTouch() || e.pointerType === 'mouse') this.toggleFullscreen();
    });
  }

  // ------------------------------------------------------------------ platform features
  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const s = this.session;
    try {
      const artwork = [];
      if (s.kind === 'channel' && s.channels[s.index].logo) artwork.push({ src: s.channels[s.index].logo, sizes: '256x256' });
      if (s.kind === 'jellyfin') {
        const p = jf.posterUrl(s.item);
        if (p) artwork.push({ src: p, sizes: '400x600' });
      }
      artwork.push({ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' });
      navigator.mediaSession.metadata = new MediaMetadata({ title: this.titleEl.textContent, artist: this.subtitleEl.textContent, album: 'Kasy TV', artwork });
      const set = (a, fn) => {
        try {
          navigator.mediaSession.setActionHandler(a, fn);
        } catch {
          /* unsupported action */
        }
      };
      set('play', () => this.media.play());
      set('pause', () => this.media.pause());
      set('seekbackward', () => this.seekBy(-store.get('player.seekStep')));
      set('seekforward', () => this.seekBy(store.get('player.seekStep')));
      set('previoustrack', s.kind === 'channel' ? () => this.zapBy(-1) : null);
      set('nexttrack', s.kind === 'channel' ? () => this.zapBy(1) : null);
      set('seekto', (d) => this.seekTo(d.seekTime));
    } catch {
      /* ignore */
    }
  }

  async requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        if (!this.onVisibility) {
          this.onVisibility = () => {
            if (document.visibilityState === 'visible' && this.session) this.requestWakeLock();
          };
          document.addEventListener('visibilitychange', this.onVisibility);
        }
      }
    } catch {
      /* not allowed */
    }
  }

  releaseWakeLock() {
    try {
      if (this.wakeLock) this.wakeLock.release();
    } catch {
      /* ignore */
    }
    this.wakeLock = null;
  }

  pipSupported() {
    return !!(document.pictureInPictureEnabled || (this.video.webkitSupportsPresentationMode && this.video.webkitSupportsPresentationMode('picture-in-picture')));
  }

  async togglePip() {
    const v = this.video;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v.requestPictureInPicture) await v.requestPictureInPicture();
      else if (v.webkitSetPresentationMode) v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    } catch (e) {
      toast('Bild-in-Bild nicht möglich: ' + e.message, { kind: 'warn' });
    }
  }

  fsSupported() {
    return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  }

  async enterFullscreen(silent) {
    try {
      const el = document.documentElement;
      if (document.fullscreenElement || document.webkitFullscreenElement) return;
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      if (screen.orientation && screen.orientation.lock && inputMode.isTouch()) screen.orientation.lock('landscape').catch(() => {});
    } catch (e) {
      if (!silent) toast('Vollbild nicht möglich', { kind: 'warn' });
    }
  }

  exitFullscreen() {
    try {
      if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
    } catch {
      /* ignore */
    }
  }

  toggleFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) this.exitFullscreen();
    else this.enterFullscreen(false);
  }
}

function player() {
  if (!instance) instance = new Player();
  return instance;
}

// ------------------------------------------------------------------ public API

/** Plays a channel of a list; channels = the list the user zaps through. */
export function playChannel(sourceId, channels, index) {
  return player().open({ kind: 'channel', sourceId, channels, index });
}

export function playUrl(url, { title, subtitle, type, live } = {}) {
  return player().open({ kind: 'url', url, title, subtitle, type, live });
}

export function playJellyfin(item, { startMs } = {}) {
  let start = startMs;
  if (start === undefined && store.get('player.resume') && item.UserData && item.UserData.PlaybackPositionTicks) start = item.UserData.PlaybackPositionTicks / 10000;
  return player().open({ kind: 'jellyfin', item, startMs: start || 0 });
}

export function playYouTube(id, { title, startSeconds } = {}) {
  return player().open({ kind: 'youtube', id, title, startSeconds });
}

export function isPlayerOpen() {
  return !!(instance && instance.session);
}
