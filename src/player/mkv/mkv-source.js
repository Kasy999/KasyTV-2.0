/**
 * Kasy MKV decoder: plays Matroska files (Jellyfin direct play, .mkv links in playlists) in any browser with
 * Media Source Extensions – without converting anything on the server.
 *
 *   network (HTTP range requests) → MkvDemuxer → fragmented MP4 (unchanged frames) → MediaSource → <video>
 *
 * - The browser's own hardware decoder decodes the picture and sound, so it costs almost no CPU – fine for
 *   TV sticks. Works on Chrome/Edge/Brave, Android TV, Xiaomi stick, Tizen/webOS, Firefox, Safari and iOS 17.1+
 *   (ManagedMediaSource).
 * - Seeking uses the file's Cues index; without one it jumps to an estimated position and resyncs.
 * - Only what lies ahead is loaded (back-pressure), old data is dropped – keeps memory low.
 * - Sound formats the browser can't decode (DTS, TrueHD …) are reported via `missingAudio`; the player then
 *   fetches just the audio converted from Jellyfin (external-audio.js) while the picture still plays directly.
 */
import { MkvDemuxer, parseCuesElement } from './demuxer.js';
import { describeTrack, mseSupports, initSegment, fragment, audioFrameSamples } from './mp4.js';

const NS = 1e9;

function MS() {
  return window.ManagedMediaSource || window.MediaSource || window.WebKitMediaSource;
}

export function mkvSupported() {
  return !!MS();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Per-track packer: collects frames and turns them into fMP4 fragments with correct timestamps. */
export class TrackPacker {
  constructor(desc, shiftNs) {
    this.desc = desc;
    this.ts = desc.timescale;
    this.shiftNs = shiftNs;
    this.frames = [];
    this.seq = 1;
    this.delay = 0; // video: decode delay in timescale units (B-frames)
    this.waitKey = desc.kind === 'video';
    this.nextAudioDts = null;
  }

  toTs(ns) {
    return ((ns + this.shiftNs) * this.ts) / NS;
  }

  reset() {
    this.frames = [];
    this.lastDts = undefined;
    this.waitKey = this.desc.kind === 'video';
    this.nextAudioDts = null;
  }

  /** Adds a frame; returns a finished fragment (Uint8Array) or null. */
  push(f) {
    if (this.desc.kind === 'video') {
      if (this.waitKey) {
        if (!f.key) return null;
        this.waitKey = false;
      }
      let out = null;
      if (f.key && this.frames.length) out = this.flush();
      this.frames.push(f);
      // Very long GOPs: don't hold more than ~10 s in memory.
      if (!out && this.frames.length > 600) out = this.flush();
      return out;
    }
    this.frames.push(f);
    const span = this.frames[this.frames.length - 1].timeNs - this.frames[0].timeNs;
    return span >= 0.5 * NS ? this.flush() : null;
  }

  flush() {
    const frames = this.frames;
    if (!frames.length) return null;
    this.frames = [];
    return this.desc.kind === 'video' ? this.packVideo(frames) : this.packAudio(frames);
  }

  packVideo(frames) {
    // Matroska stores presentation times in decode order. Decode times: the sorted presentation times minus a
    // constant decode delay (B-frames), so that decode ≤ presentation. The delay is measured on the first
    // fragment and applied to all tracks as a common shift, so no time ever becomes negative.
    let pts = frames.map((f) => this.toTs(f.timeNs));
    if (!this.delayKnown) {
      const sorted0 = pts.slice().sort((a, b) => a - b);
      let need = 0;
      for (let i = 0; i < frames.length; i++) need = Math.max(need, sorted0[i] - pts[i]);
      this.delay = Math.ceil(need);
      this.delayKnown = true;
      this.shiftNs = Math.ceil((this.delay * NS) / this.ts);
      if (this.onShift) this.onShift(this.shiftNs);
      pts = frames.map((f) => this.toTs(f.timeNs));
    }
    const sorted = pts.slice().sort((a, b) => a - b);
    const dts = sorted.map((p, i) => Math.min(p - this.delay, pts[i]));
    for (let i = 1; i < dts.length; i++) if (dts[i] <= dts[i - 1]) dts[i] = dts[i - 1] + 1;
    if (this.lastDts !== undefined && dts[0] <= this.lastDts && dts[0] > this.lastDts - this.ts) {
      const fix = this.lastDts + 1 - dts[0];
      for (let i = 0; i < dts.length; i++) dts[i] += fix;
    }
    const dflt = this.desc.defaultDurationTs || (sorted.length > 1 ? (sorted[sorted.length - 1] - sorted[0]) / (sorted.length - 1) : this.ts / 25);
    const samples = frames.map((f, i) => {
      const dur = i < frames.length - 1 ? dts[i + 1] - dts[i] : dflt;
      return { data: f.data, duration: dur > 0 ? dur : dflt, cts: pts[i] - dts[i], key: f.key };
    });
    this.lastDts = dts[dts.length - 1];
    return fragment(this.seq++, dts[0], samples);
  }

  packAudio(frames) {
    const first = this.toTs(frames[0].timeNs);
    // Continuous audio: keep counting samples, re-anchor only on real jumps (> 50 ms).
    let dts = this.nextAudioDts !== null && Math.abs(this.nextAudioDts - first) < this.ts * 0.05 ? this.nextAudioDts : first;
    const base = dts;
    const samples = frames.map((f, i) => {
      let dur = audioFrameSamples(this.desc, f.data);
      if (!dur) {
        const next = frames[i + 1];
        dur = next ? this.toTs(next.timeNs) - this.toTs(f.timeNs) : this.lastDur || this.ts / 50;
      }
      this.lastDur = dur;
      dts += dur;
      return { data: f.data, duration: dur, cts: 0, key: true };
    });
    this.nextAudioDts = dts;
    return fragment(this.seq++, base, samples);
  }
}

/** Serial append queue for one SourceBuffer. */
class Appender {
  constructor(sb, owner) {
    this.sb = sb;
    this.owner = owner;
    this.queue = [];
    this.busy = false;
    this.idleWaiters = [];
    sb.addEventListener('updateend', () => this.next());
    sb.addEventListener('error', () => this.next());
  }

  append(data) {
    this.queue.push({ type: 'append', data });
    this.kick();
  }

  remove(from, to) {
    if (to <= from) return;
    this.queue.push({ type: 'remove', from, to });
    this.kick();
  }

  kick() {
    if (!this.busy && !this.sb.updating) this.next();
  }

  next() {
    this.busy = false;
    if (this.sb.updating) {
      this.busy = true;
      return;
    }
    const job = this.queue.shift();
    if (!job) {
      const w = this.idleWaiters;
      this.idleWaiters = [];
      w.forEach((fn) => fn());
      return;
    }
    if (this.owner.destroyed) return;
    try {
      this.busy = true;
      if (job.type === 'append') this.sb.appendBuffer(job.data);
      else this.sb.remove(job.from, job.to);
    } catch (e) {
      this.busy = false;
      if (e && e.name === 'QuotaExceededError' && job.type === 'append') {
        // Buffer full: drop what is behind the playhead and retry later.
        this.queue.unshift(job);
        this.owner.onQuota(this);
        return;
      }
      if (e && e.name === 'InvalidStateError') return; // media source closed
      console.warn('[mkv] append', e);
      this.owner.fail(new Error('Puffer-Fehler: ' + (e.message || e.name)));
    }
  }

  idle() {
    if (!this.busy && !this.sb.updating && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  clear() {
    this.queue = [];
  }

  get pending() {
    return this.queue.length;
  }
}

export class MkvSource {
  /**
   * opts: { url, size, startSeconds, audioTrack (index among audio tracks, -1/undefined = default),
   *         preferLanguage, maxAheadSeconds, onFatal, onTracks }
   */
  constructor(video, opts) {
    this.video = video;
    this.opts = opts;
    this.url = opts.url;
    this.size = opts.size || 0;
    this.destroyed = false;
    this.ctrl = null;
    this.packers = new Map(); // track number → TrackPacker
    this.appenders = new Map(); // 'video' | 'audio' → Appender
    this.header = null;
    this.cues = null;
    this.shiftNs = 0;
    this.offset = 0;
    this.generation = 0;
    this.audioTracks = [];
    this.missingAudio = null;
    this.pendingFirst = new Map();
    this.audioHold = [];
    this.shiftKnown = false;
    this.ended = false;
    this.onSeeking = () => this.handleSeek();
    this.maxAhead = opts.maxAheadSeconds || 60;
  }

  // ------------------------------------------------------------ setup
  async open() {
    const Source = MS();
    if (!Source) throw new Error('Media Source Extensions fehlen');
    this.ms = new Source();
    if (window.ManagedMediaSource && this.ms instanceof window.ManagedMediaSource) {
      this.video.disableRemotePlayback = true;
    }
    this.objectUrl = URL.createObjectURL(this.ms);
    this.video.src = this.objectUrl;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('MediaSource öffnet nicht')), 8000);
      this.ms.addEventListener(
        'sourceopen',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
    // Read the header (and the first clusters) from the start of the file.
    const headerReady = new Promise((resolve, reject) => {
      this.headerResolve = resolve;
      this.headerReject = reject;
    });
    this.demuxer = this.makeDemuxer();
    this.pump(0, this.generation);
    await Promise.race([headerReady, sleep(20000).then(() => Promise.reject(new Error('MKV-Kopf nicht lesbar (Zeitüberschreitung)')))]);
    this.video.addEventListener('seeking', this.onSeeking);
    this.cleanupTimer = setInterval(() => this.cleanup(), 5000);
    const start = this.opts.startSeconds || 0;
    if (start > 1) {
      await this.loadCues().catch(() => {});
      this.seekTo(start);
    }
    return this;
  }

  makeDemuxer() {
    return new MkvDemuxer({
      // Tracks are set up synchronously, before the demuxer hands out the first frames of the same chunk.
      onHeader: (h) => {
        try {
          this.setupTracks(h);
          if (this.headerResolve) this.headerResolve(h);
        } catch (e) {
          if (this.headerReject) this.headerReject(e);
          throw e;
        }
      },
      onCues: (c) => {
        if (!this.cues) this.cues = c;
      },
      onFrame: (f) => this.onFrame(f),
    });
  }

  setupTracks(header) {
    this.header = header;
    if (header.cues) this.cues = header.cues;
    const ns = header.info.timecodeScale;
    this.durationSec = (header.info.duration * ns) / NS;
    const tracks = header.tracks.filter((t) => t.enabled !== false);
    const video = tracks.find((t) => t.type === 1);
    if (!video) throw new Error('Keine Videospur in der MKV-Datei');
    const vdesc = describeTrack(video);
    if (vdesc.unsupported || !mseSupports(vdesc)) {
      throw new Error(`Videoformat ${vdesc.unsupported || vdesc.codecString} kann dieses Gerät nicht direkt abspielen`);
    }
    if (video.defaultDuration) vdesc.defaultDurationTs = (video.defaultDuration * vdesc.timescale) / NS;

    // Audio: requested track, otherwise the default one / preferred language, if the browser can play it.
    this.audioTracks = tracks
      .filter((t) => t.type === 2)
      .map((t, i) => {
        const d = describeTrack(t);
        const supported = !!(d.needsFrame || (!d.unsupported && mseSupports(d)));
        return { index: i, number: t.number, track: t, desc: d, supported, label: trackLabel(t, d), lang: t.language };
      });
    let chosen = null;
    const req = this.opts.audioTrack;
    if (req !== undefined && req !== null && req >= 0) chosen = this.audioTracks[req] || null;
    if (!chosen && this.opts.preferLanguage) chosen = this.audioTracks.find((a) => a.lang && a.lang.startsWith(this.opts.preferLanguage));
    if (!chosen) chosen = this.audioTracks.find((a) => a.track.isDefault) || this.audioTracks[0] || null;
    this.selectedAudio = chosen;
    if (chosen && !chosen.supported) {
      this.missingAudio = { index: chosen.index, codec: chosen.desc.unsupported || chosen.desc.codecString };
      chosen = null;
    }

    // Duration first – MSE refuses to change it while a SourceBuffer is busy.
    if (!(this.durationSec > 0) && this.opts.durationSeconds > 0) this.durationSec = this.opts.durationSeconds;
    if (this.durationSec > 0) {
      try {
        this.ms.duration = this.durationSec + 0.5;
      } catch {
        /* ignore */
      }
    }
    // Constant time shift so that video decode times never become negative (B-frames).
    this.shiftNs = 0;
    this.videoDesc = vdesc;
    this.deferred = [];
    // Chrome doesn't accept new SourceBuffers once the first init segment is in, so when the audio
    // configuration comes from the first audio frame (AC-3/E-AC-3/MP3), both buffers are created together.
    const deferVideo = !!(chosen && chosen.desc.needsFrame);
    if (!deferVideo) this.addSourceBuffer('video', vdesc);
    const vp = new TrackPacker(vdesc, 0);
    vp.onShift = (shift) => this.setShift(shift);
    this.packers.set(video.number, vp);
    this.videoNumber = video.number;
    if (chosen) {
      this.audioNumber = chosen.number;
      if (chosen.desc.needsFrame) {
        this.pendingFirst.set(chosen.number, chosen); // config needs the first frame
      } else {
        this.addSourceBuffer('audio', chosen.desc);
        this.packers.set(chosen.number, new TrackPacker(chosen.desc, 0));
      }
    }
    if (this.opts.onTracks) this.opts.onTracks(this.audioTracks);
  }

  addSourceBuffer(kind, desc) {
    const sb = this.ms.addSourceBuffer(desc.mime);
    const app = new Appender(sb, this);
    this.appenders.set(kind, app);
    app.append(initSegment(desc));
    desc.sb = sb;
  }

  // ------------------------------------------------------------ data flow
  onFrame(f) {
    if (f.track === this.audioNumber && this.pendingFirst.has(f.track)) {
      const a = this.pendingFirst.get(f.track);
      this.pendingFirst.delete(f.track);
      const d = describeTrack(a.track, f.data);
      if (d.unsupported || !mseSupports(d)) {
        this.giveUpAudio(a, d.unsupported || d.codecString);
        return;
      }
      a.desc = d;
      try {
        this.finishDeferred(d);
      } catch (e) {
        this.giveUpAudio(a, d.codecString);
        return;
      }
      this.packers.set(f.track, new TrackPacker(d, this.shiftNs));
      if (!this.shiftKnown) {
        this.audioHold.push(f);
        return;
      }
    }
    const p = this.packers.get(f.track);
    if (!p) return;
    if (p.desc.kind === 'audio' && !this.shiftKnown) {
      // Wait for the video's decode delay (common time shift) before packing audio.
      if (this.audioHold.length < 3000) this.audioHold.push(f);
      return;
    }
    const out = p.push(f);
    if (out) this.appendOut(p.desc.kind, out);
    if (this.refeed) this.drainRefeed();
  }

  appendOut(kind, data) {
    const app = this.appenders.get(kind);
    if (app) return app.append(data);
    this.deferred.push([kind, data]);
    // No audio frame for a long time → start the picture without that sound track.
    if (kind === 'video' && this.deferred.length > 2 && this.pendingFirst.size) {
      const a = this.pendingFirst.get(this.audioNumber);
      if (a) this.giveUpAudio(a, 'keine Tondaten');
    }
  }

  finishDeferred(audioDesc) {
    if (!this.appenders.has('video')) this.addSourceBuffer('video', this.videoDesc);
    if (audioDesc && !this.appenders.has('audio')) this.addSourceBuffer('audio', audioDesc);
    const q = this.deferred;
    this.deferred = [];
    for (const [kind, data] of q) {
      const app = this.appenders.get(kind);
      if (app) app.append(data);
    }
  }

  giveUpAudio(a, codec) {
    this.pendingFirst.delete(a.number);
    this.missingAudio = { index: a.index, codec };
    this.audioNumber = undefined;
    for (const [n, p] of this.packers) if (p.desc.kind === 'audio') this.packers.delete(n);
    this.audioHold = [];
    this.finishDeferred(null);
    if (this.opts.onMissingAudio) this.opts.onMissingAudio(this.missingAudio);
  }

  setShift(shiftNs) {
    this.shiftNs = shiftNs;
    this.shiftKnown = true;
    for (const p of this.packers.values()) if (p.desc.kind === 'audio') p.shiftNs = shiftNs;
    // Held audio is packed right after the video fragment that set the shift has been queued.
    this.refeed = this.audioHold;
    this.audioHold = [];
  }

  drainRefeed() {
    const r = this.refeed;
    if (!r) return;
    this.refeed = null;
    r.forEach((f) => this.onFrame(f));
  }

  flushAll() {
    if (!this.shiftKnown) {
      const vp = this.packers.get(this.videoNumber);
      const out = vp && vp.flush();
      if (out) this.appendOut('video', out);
      if (!this.shiftKnown) this.setShift(0);
      this.drainRefeed();
    }
    for (const p of this.packers.values()) {
      const out = p.flush();
      if (out) this.appendOut(p.desc.kind, out);
    }
  }

  async pump(offset, gen) {
    let retries = 0;
    let pos = offset;
    while (!this.destroyed && gen === this.generation) {
      this.ctrl = new AbortController();
      try {
        const headers = {};
        if (pos > 0 || this.size) headers.Range = `bytes=${pos}-`;
        const res = await fetch(this.url, { headers, signal: this.ctrl.signal, cache: 'no-store' });
        if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
        if (pos > 0 && res.status === 200) {
          // Server ignores ranges – can only play from the start.
          if (!this.noRange) console.warn('[mkv] Server unterstützt keine Range-Anfragen');
          this.noRange = true;
          if (pos > 0) throw new Error('Der Server erlaubt kein Springen in der Datei');
        }
        if (!this.size) {
          const cr = res.headers.get('content-range');
          const m = cr && /\/(\d+)/.exec(cr);
          if (m) this.size = parseInt(m[1], 10);
          else if (res.status === 200 && res.headers.get('content-length')) this.size = parseInt(res.headers.get('content-length'), 10);
        }
        const reader = res.body.getReader();
        while (!this.destroyed && gen === this.generation) {
          const { value, done } = await reader.read();
          if (done) break;
          retries = 0;
          pos += value.length;
          this.offset = pos;
          try {
            this.demuxer.feed(value);
          } catch (e) {
            if (this.headerReject && !this.header) this.headerReject(e);
            throw e;
          }
          await this.backpressure(gen);
        }
        reader.cancel().catch(() => {});
        if (this.destroyed || gen !== this.generation) return;
        // End of file
        this.flushAll();
        await this.whenIdle();
        if (gen !== this.generation || this.destroyed) return;
        this.ended = true;
        try {
          if (this.ms.readyState === 'open') this.ms.endOfStream();
        } catch {
          /* ignore */
        }
        return;
      } catch (e) {
        if (this.destroyed || gen !== this.generation || (e && e.name === 'AbortError')) return;
        if (!this.header && this.headerReject && /MKV|Server/.test(e.message)) {
          this.headerReject(e);
          return;
        }
        if (++retries > 4) {
          if (!this.header && this.headerReject) this.headerReject(e);
          else this.fail(new Error('Netzwerkfehler: ' + e.message));
          return;
        }
        await sleep(1000 * retries);
        if (this.noRange && pos > 0) return this.fail(new Error('Der Server erlaubt kein Fortsetzen der Datei'));
        // Continue where we stopped; the demuxer continues seamlessly as long as no bytes are lost.
      }
    }
  }

  bufferedAhead() {
    const t = this.video.currentTime;
    let min = Infinity;
    for (const app of this.appenders.values()) {
      const b = app.sb.buffered;
      let ahead = 0;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= t + 0.5 && b.end(i) > t) ahead = b.end(i) - t;
      }
      min = Math.min(min, ahead);
    }
    return min === Infinity ? 0 : min;
  }

  async backpressure(gen) {
    // Wait while enough is buffered or the append queues are long.
    for (;;) {
      if (this.destroyed || gen !== this.generation) return;
      let pending = 0;
      for (const a of this.appenders.values()) pending += a.pending;
      if (pending < 8 && this.bufferedAhead() < this.maxAhead) return;
      await sleep(pending >= 8 ? 50 : 400);
    }
  }

  whenIdle() {
    return Promise.all([...this.appenders.values()].map((a) => a.idle()));
  }

  onQuota(app) {
    const t = this.video.currentTime;
    const b = app.sb.buffered;
    if (b.length && b.start(0) < t - 3) app.remove(0, t - 3);
    this.maxAhead = Math.max(10, this.maxAhead * 0.7);
    setTimeout(() => app.kick(), 500);
  }

  cleanup() {
    if (this.destroyed) return;
    const t = this.video.currentTime;
    for (const app of this.appenders.values()) {
      const b = app.sb.buffered;
      if (b.length && b.start(0) < t - 30) app.remove(0, t - 20);
      // Data far behind or far ahead from old seeks
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) > t + this.maxAhead * 3) app.remove(b.start(i), b.end(i));
      }
    }
    // Small gap at the start (first frame not at 0) → jump over it.
    const vb = this.appenders.get('video') && this.appenders.get('video').sb.buffered;
    if (vb && vb.length && !this.video.seeking && t < vb.start(0) && vb.start(0) - t < 2 && this.video.readyState < 3) this.video.currentTime = vb.start(0) + 0.01;
  }

  fail(err) {
    if (this.destroyed || this.failed) return;
    this.failed = true;
    if (this.opts.onFatal) this.opts.onFatal(err);
  }

  // ------------------------------------------------------------ seeking
  isBuffered(t) {
    for (const app of this.appenders.values()) {
      const b = app.sb.buffered;
      let ok = false;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.1 && b.end(i) > t + 0.5) ok = true;
      if (!ok) return false;
    }
    return this.appenders.size > 0;
  }

  handleSeek() {
    const t = this.video.currentTime;
    if (this.isBuffered(t)) return;
    clearTimeout(this.seekTimer);
    // Coalesce fast repeated seeks (holding ◀ ▶ on the remote).
    this.seekTimer = setTimeout(() => this.seekTo(this.video.currentTime), 120);
  }

  async loadCues() {
    if (this.cues || !this.header || this.header.cuesPosition < 0) return this.cues;
    if (this.cuesLoading) return this.cuesLoading;
    const pos = this.header.cuesPosition;
    this.cuesLoading = (async () => {
      let len = 512 * 1024;
      for (let i = 0; i < 3; i++) {
        const end = this.size ? Math.min(this.size - 1, pos + len - 1) : pos + len - 1;
        const res = await fetch(this.url, { headers: { Range: `bytes=${pos}-${end}` }, cache: 'no-store' });
        if (res.status !== 206) throw new Error('keine Range-Unterstützung');
        const bytes = new Uint8Array(await res.arrayBuffer());
        const r = parseCuesElement(bytes);
        if (!r) throw new Error('Cues nicht lesbar');
        if (r.cues) {
          this.cues = r.cues;
          return r.cues;
        }
        len = r.needed + 16;
      }
      throw new Error('Cues zu groß');
    })().catch((e) => {
      console.info('[mkv] Kein Index (Cues):', e.message);
      this.cuesLoading = null;
      this.cuesFailed = true;
      return null;
    });
    return this.cuesLoading;
  }

  async seekTo(t) {
    if (this.destroyed || !this.header) return;
    if (this.isBuffered(t)) return;
    const gen = ++this.generation;
    if (this.ctrl) this.ctrl.abort();
    if (!this.cues && !this.cuesFailed) await this.loadCues();
    if (gen !== this.generation) return;
    const scale = this.header.info.timecodeScale;
    const targetNs = Math.max(0, t * NS - this.shiftNs);
    let offset = -1;
    let resync = false;
    if (this.cues && this.cues.length) {
      let best = this.cues[0];
      for (const c of this.cues) {
        if (c.time * scale <= targetNs) best = c;
        else break;
      }
      offset = this.header.segmentStart + best.cluster;
    } else if (this.size && this.durationSec) {
      // No index: estimate by bitrate, a little earlier, then search the next cluster.
      const frac = Math.max(0, Math.min(1, (t - 3) / this.durationSec));
      offset = Math.max(this.header.segmentStart, Math.floor(this.size * frac));
      resync = true;
    } else {
      return; // can't seek
    }
    for (const app of this.appenders.values()) app.clear();
    await this.whenIdle();
    if (gen !== this.generation) return;
    for (const p of this.packers.values()) p.reset();
    // Old buffered ranges stay (they may be useful when seeking back) – cleanup() removes them later.
    try {
      for (const app of this.appenders.values()) app.sb.abort && this.ms.readyState === 'open' && !app.sb.updating && app.sb.abort();
    } catch {
      /* ignore */
    }
    this.ended = false;
    this.demuxer.restartAt(offset, { resync });
    this.pump(offset, gen);
  }

  // ------------------------------------------------------------ teardown
  destroy() {
    this.destroyed = true;
    this.generation++;
    clearInterval(this.cleanupTimer);
    clearTimeout(this.seekTimer);
    if (this.ctrl) this.ctrl.abort();
    this.video.removeEventListener('seeking', this.onSeeking);
    for (const a of this.appenders.values()) a.clear();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }
}

function trackLabel(t, d) {
  const codec = d.unsupported ? d.unsupported : { aac: 'AAC', opus: 'Opus', flac: 'FLAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', mp3: 'MP3' }[d.codec] || (d.needsFrame ? t.codecId.replace(/^A_/, '').replace('EAC3', 'Dolby Digital Plus').replace('AC3', 'Dolby Digital') : '');
  const lang = t.language && t.language !== 'und' ? t.language.toUpperCase() : '';
  const ch = t.audio ? { 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' }[t.audio.channels] || t.audio.channels + ' Kan.' : '';
  return [t.name || lang || 'Tonspur', [codec, ch].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
}
