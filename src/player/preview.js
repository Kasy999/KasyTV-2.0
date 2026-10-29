/**
 * Live preview of the highlighted channel in the Live-TV list (like the Android app's PreviewPlayer).
 *
 * - Remote: the channel under the focus plays after a short pause (no stream starts while scrolling fast).
 * - Touch/mouse: tapping a channel shows it here; tapping it again (or the picture / "Vollbild") opens the
 *   full-screen player.
 * - Muted by default (toggle), own <video> + engine, stopped while the full-screen player runs, so a TV stick
 *   never decodes two streams at once.
 */
import { h, icon, img } from '../core/dom.js';
import { store } from '../core/store.js';
import { bus } from '../core/events.js';
import { perf } from '../core/performance.js';
import { VideoEngine } from './engine.js';

export class PreviewPanel {
  constructor({ onOpen, onGuide, nowNext }) {
    this.onOpen = onOpen; // (index) => open full screen
    this.onGuide = onGuide; // (channel) => open the programme guide
    this.nowNext = nowNext; // (channel) => { now, next, progress } or null
    this.channel = null;
    this.index = -1;
    this.timer = null;
    this.paused = false;
    this.video = h('video.preview-video', { playsInline: true, muted: true });
    this.video.setAttribute('webkit-playsinline', '');
    this.video.muted = true;
    this.engine = new VideoEngine(this.video, {});
    this.status = h('div.preview-status');
    this.logo = h('div.preview-logo');
    this.name = h('div.preview-name');
    this.meta = h('div.preview-meta.muted');
    this.muteBtn = h('button.icon-btn.small', { type: 'button', data: { focus: true }, 'aria-label': 'Ton', title: 'Ton an/aus', onClick: () => this.toggleMute() }, icon('mute'));
    const fsBtn = h('button.btn.primary.small', { type: 'button', data: { focus: true }, onClick: () => this.open() }, icon('fullscreen'), h('span.btn-label', 'Vollbild'));
    const guideBtn = h('button.icon-btn.small', { type: 'button', data: { focus: true }, 'aria-label': 'TV-Programm', title: 'TV-Programm & Archiv', onClick: () => this.channel && this.onGuide && this.onGuide(this.channel) }, icon('guide'));
    this.epgBox = h('div.preview-epg');
    this.el = h(
      'aside.preview',
      { data: { focusGroup: true } },
      h(
        'div.preview-screen',
        { onClick: () => this.open() },
        this.video,
        this.status,
      ),
      h('div.preview-info', this.logo, h('div.preview-text', this.name, this.meta), h('div.preview-actions', this.muteBtn, guideBtn, fsBtn)),
      this.epgBox,
    );
    this.setIdle();
    this.offs = [
      bus.on('player:opened', () => this.suspend()),
      bus.on('player:closed', () => this.resume()),
    ];
  }

  setIdle() {
    this.status.replaceChildren(h('div.preview-hint', icon('tv'), h('span', 'Sender auswählen für die Vorschau')));
    this.status.classList.add('show');
  }

  /** Shows a channel (debounced). immediate = touch selection. */
  show(channel, index, { immediate = false } = {}) {
    if (this.channel && channel && this.channel.url === channel.url && this.index === index) return;
    this.channel = channel;
    this.index = index;
    this.name.textContent = channel.name;
    this.meta.textContent = [channel.number ? 'Nr. ' + channel.number : null, channel.group].filter(Boolean).join(' · ');
    this.logo.replaceChildren(img(channel.logo, channel.name, 'logo', channel.name));
    this.renderEpg();
    clearTimeout(this.timer);
    this.engine.destroy();
    this.status.replaceChildren(h('div.spinner'));
    this.status.classList.add('show');
    if (this.paused) return;
    this.timer = setTimeout(() => this.load(), immediate ? 0 : perf.low ? 900 : 550);
  }

  /** Now / next of the previewed channel (from the EPG). */
  renderEpg() {
    const nn = this.channel && this.nowNext ? this.nowNext(this.channel) : null;
    if (!nn || (!nn.now && !nn.next)) {
      this.epgBox.replaceChildren();
      return;
    }
    const hm = (t) => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    this.epgBox.replaceChildren(
      nn.now
        ? h('div.pe-now', h('span.pe-time', hm(nn.now.start)), h('span.pe-title', nn.now.title), h('span.pe-bar', h('span', { style: { width: Math.round(nn.progress * 100) + '%' } })))
        : null,
      nn.next ? h('div.pe-next', h('span.pe-time', hm(nn.next.start)), h('span.pe-title', nn.next.title)) : null,
    );
  }

  isShowing(index) {
    return this.index === index && !!this.channel;
  }

  async load() {
    const ch = this.channel;
    if (!ch || this.paused) return;
    const token = (this.token = (this.token || 0) + 1);
    try {
      await this.engine.load({ url: ch.url, type: 'auto', live: ch.kind !== 'vod', allowProxy: true });
      if (token !== this.token) return;
      this.video.muted = !store.get('iptv.previewSound');
      await this.video.play().catch(() => {
        this.video.muted = true;
        return this.video.play();
      });
      this.updateMute();
      this.status.classList.remove('show');
    } catch (e) {
      if (token !== this.token) return;
      this.status.replaceChildren(h('div.preview-hint.error', icon('info'), h('span', 'Keine Vorschau: ' + (e.message || 'Stream nicht abspielbar'))));
      this.status.classList.add('show');
    }
  }

  toggleMute() {
    const sound = !store.get('iptv.previewSound');
    store.set('iptv.previewSound', sound);
    this.video.muted = !sound;
    this.updateMute();
  }

  updateMute() {
    this.muteBtn.replaceChildren(icon(this.video.muted ? 'mute' : 'volume'));
  }

  open() {
    if (this.channel && this.onOpen) this.onOpen(this.index);
  }

  suspend() {
    this.paused = true;
    clearTimeout(this.timer);
    this.token = (this.token || 0) + 1;
    this.engine.destroy();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.channel && this.el.isConnected) {
      this.status.replaceChildren(h('div.spinner'));
      this.status.classList.add('show');
      this.timer = setTimeout(() => this.load(), 300);
    }
  }

  destroy() {
    clearTimeout(this.timer);
    this.token = (this.token || 0) + 1;
    this.engine.destroy();
    this.offs.forEach((o) => o());
  }
}
