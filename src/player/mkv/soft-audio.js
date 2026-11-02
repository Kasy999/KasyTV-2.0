/**
 * Software sound decoder for the MKV decoder.
 *
 * Used automatically when the device can't play a sound format itself (typical: E-AC-3 / Dolby Digital Plus
 * in Chrome, Edge, Brave or Firefox on Windows and Linux) – TVs, Android TV sticks and Apple devices that
 * decode it in hardware never load it.
 *
 *   MKV sound frames → worker (ffmpeg WebAssembly: E-AC-3/AC-3/DTS/TrueHD → PCM 48 kHz stereo)
 *                    → WebCodecs AudioEncoder (Opus, one continuous encoder = no clicks between pieces)
 *                    → Opus frames → the normal MKV packer → the same MediaSource as the picture (in sync).
 *
 * The decoder (~7 MB) is loaded once on first use and then kept by the browser.
 */
import { store } from '../../core/store.js';

const NS = 1e9;
const FORMATS = { A_EAC3: 'eac3', A_AC3: 'ac3', A_DTS: 'dts', 'A_DTS/EXPRESS': 'dts', 'A_DTS/LOSSLESS': 'dts', A_TRUEHD: 'truehd', A_MLP: 'truehd' };
const VERSION = '0.12.10';
const BATCH_NS = 1.5 * NS;

let capability = null;

/** Format name for ffmpeg, or null if this sound track can't be handled. */
export function softFormat(codecId) {
  return FORMATS[codecId] || null;
}

/**
 * Can this device use the software decoder at all? (WebAssembly, Worker, WebCodecs Opus encoder, Opus in MSE)
 * Setting player.softAudio: 'auto' (default) | 'off'.
 */
export function softAudioCapable() {
  if (!capability) {
    capability = (async () => {
      if (store.get('player.softAudio') === 'off') return false;
      if (typeof WebAssembly !== 'object' || typeof Worker !== 'function' || typeof AudioEncoder !== 'function' || typeof AudioData !== 'function') return false;
      const MS = window.ManagedMediaSource || window.MediaSource;
      if (!MS || !MS.isTypeSupported('audio/mp4; codecs="opus"')) return false;
      try {
        const r = await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 });
        return !!r.supported;
      } catch {
        return false;
      }
    })();
  }
  return capability;
}

export function resetSoftAudioCapability() {
  capability = null;
}

function coreUrls() {
  const local = new URL('./vendor/ffmpeg/', location.href).href;
  const cdn = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${VERSION}/dist/umd/`;
  return [local, cdn];
}

let workerPromise = null;

/** One shared worker with the decoder loaded (local copy first, CDN as fallback). */
function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      let lastErr = null;
      for (const base of coreUrls()) {
        try {
          const head = await fetch(base + 'ffmpeg-core.js', { method: 'HEAD' });
          if (!head.ok) throw new Error('HTTP ' + head.status);
          const w = new Worker(new URL('./kasy-audio-worker.js', location.href).href);
          await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Ton-Decoder: Zeitüberschreitung beim Laden')), 90000);
            w.onmessage = (e) => {
              if (e.data.type === 'ready') {
                clearTimeout(t);
                resolve();
              } else if (e.data.type === 'error') {
                clearTimeout(t);
                reject(new Error(e.data.message));
              }
            };
            w.onerror = (e) => {
              clearTimeout(t);
              reject(new Error(e.message || 'Worker-Fehler'));
            };
            w.postMessage({ type: 'init', coreURL: base + 'ffmpeg-core.js', wasmURL: base + 'ffmpeg-core.wasm' });
          });
          return w;
        } catch (e) {
          lastErr = e;
        }
      }
      workerPromise = null;
      throw lastErr || new Error('Ton-Decoder nicht verfügbar');
    })();
  }
  return workerPromise;
}

let nextId = 1;

export class SoftAudio {
  /**
   * track: Matroska track, onFrame(frame): receives Opus frames { timeNs, data, key }, onError(err)
   */
  constructor(track, { onFrame, onError, channels = 2 }) {
    this.format = softFormat(track.codecId);
    this.onFrame = onFrame;
    this.onError = onError;
    this.channels = channels;
    this.batch = [];
    this.preroll = null; // last frame of the previous batch – decoded again so pieces join without artefacts
    this.queue = Promise.resolve();
    this.pending = 0;
    this.gen = 0;
    this.failed = false;
    this.ready = getWorker().then((w) => (this.worker = w));
    this.ready.catch((e) => this.fail(e));
    this.setupEncoder();
  }

  setupEncoder() {
    const gen = this.gen;
    if (this.encoder && this.encoder.state !== 'closed') {
      try {
        this.encoder.close();
      } catch {
        /* ignore */
      }
    }
    this.encoder = new AudioEncoder({
      output: (chunk) => {
        if (gen !== this.gen) return;
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.onFrame({ timeNs: chunk.timestamp * 1000, data, key: true });
      },
      error: (e) => this.fail(e),
    });
    this.encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 });
  }

  fail(e) {
    if (this.failed) return;
    this.failed = true;
    console.warn('[ton-decoder]', e);
    if (this.onError) this.onError(e instanceof Error ? e : new Error(String(e)));
  }

  /** A compressed sound frame from the MKV file. */
  push(f) {
    if (this.failed) return;
    this.batch.push(f);
    if (this.batch[this.batch.length - 1].timeNs - this.batch[0].timeNs >= BATCH_NS) this.sendBatch();
  }

  sendBatch() {
    const frames = this.batch;
    if (!frames.length) return Promise.resolve();
    this.batch = [];
    const pre = this.preroll;
    this.preroll = frames[frames.length - 1];
    const gen = this.gen;
    const all = pre && frames[0].timeNs - pre.timeNs > 0 && frames[0].timeNs - pre.timeNs < 0.5 * NS ? [pre, ...frames] : frames;
    let size = 0;
    for (const x of all) size += x.data.length;
    const buf = new Uint8Array(size);
    let o = 0;
    for (const x of all) {
      buf.set(x.data, o);
      o += x.data.length;
    }
    const startNs = frames[0].timeNs;
    const lastDur = frames.length > 1 ? frames[frames.length - 1].timeNs - frames[frames.length - 2].timeNs : 32e6;
    const spanNs = frames[frames.length - 1].timeNs + lastDur - (all[0].timeNs);
    const preNs = all === frames ? 0 : frames[0].timeNs - pre.timeNs;
    this.pending++;
    const job = this.ready.then(
      () =>
        new Promise((resolve) => {
          const id = nextId++;
          const w = this.worker;
          const onMsg = (e) => {
            if (e.data.id !== id) return;
            w.removeEventListener('message', onMsg);
            resolve(e.data);
          };
          w.addEventListener('message', onMsg);
          w.postMessage({ type: 'decode', id, format: this.format, data: buf.buffer }, [buf.buffer]);
        }),
    );
    this.queue = this.queue
      .then(() => job)
      .then((res) => {
        this.pending--;
        if (gen !== this.gen || this.failed) return;
        if (res.type === 'error') {
          // A damaged piece: skip it (silence) instead of stopping the sound altogether.
          console.warn('[ton-decoder]', res.message);
          return;
        }
        let pcm = res.pcm;
        let frames2 = pcm.length / 2;
        if (preNs > 0) {
          // Drop the part that belongs to the preroll frame (proportional – frames have a constant length).
          const drop = Math.min(frames2, Math.round((frames2 * preNs) / spanNs)) * 2;
          pcm = pcm.subarray(drop);
          frames2 = pcm.length / 2;
        }
        if (!frames2 || this.encoder.state !== 'configured') return;
        const data = new AudioData({ format: 'f32', sampleRate: 48000, numberOfFrames: frames2, numberOfChannels: 2, timestamp: Math.round(startNs / 1000), data: pcm });
        this.encoder.encode(data);
        data.close();
      })
      .catch((e) => {
        this.pending = Math.max(0, this.pending - 1);
        this.fail(e);
      });
    return this.queue;
  }

  /** End of file: decode the rest and wait until everything is encoded. */
  async flush() {
    await this.sendBatch();
    await this.queue;
    try {
      if (this.encoder.state === 'configured') await this.encoder.flush();
    } catch {
      /* ignore */
    }
  }

  /** After a seek: forget everything in flight. */
  reset() {
    this.gen++;
    this.batch = [];
    this.preroll = null;
    this.pending = 0;
    this.queue = Promise.resolve();
    if (!this.failed) this.setupEncoder();
  }

  destroy() {
    this.gen++;
    this.batch = [];
    try {
      if (this.encoder.state !== 'closed') this.encoder.close();
    } catch {
      /* ignore */
    }
  }
}
