/*
 * Kasy TV – sound decoder worker (classic worker, loaded on demand).
 *
 * Decodes sound formats the browser can't play itself (E-AC-3, AC-3, DTS, TrueHD) with ffmpeg compiled to
 * WebAssembly and returns 48 kHz stereo PCM (float, interleaved). Runs off the main thread so the picture and
 * the remote control stay smooth. The main thread re-encodes the PCM to Opus (WebCodecs) for Media Source.
 *
 * Messages in:  { type: 'init', coreURL, wasmURL }
 *               { type: 'decode', id, format, data: ArrayBuffer }
 * Messages out: { type: 'ready' } | { type: 'error', id?, message } | { type: 'pcm', id, pcm: Float32Array }
 */
/* global createFFmpegCore, importScripts */
let core = null;
let busy = Promise.resolve();

async function init(coreURL, wasmURL) {
  importScripts(coreURL);
  core = await createFFmpegCore({
    mainScriptUrlOrBlob: coreURL + '#' + btoa(JSON.stringify({ wasmURL, workerURL: '' })),
  });
  core.setLogger(() => {});
}

function decode(id, format, data) {
  const inName = 'in' + id + '.' + format;
  const outName = 'out' + id + '.pcm';
  core.FS.writeFile(inName, new Uint8Array(data));
  let ret;
  try {
    ret = core.exec('-hide_banner', '-loglevel', 'error', '-f', format, '-i', inName, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', outName);
  } finally {
    try {
      core.reset();
    } catch (e) {
      /* older core */
    }
  }
  let bytes = null;
  try {
    bytes = core.FS.readFile(outName);
  } catch (e) {
    bytes = null;
  }
  try {
    core.FS.unlink(inName);
  } catch (e) {
    /* ignore */
  }
  try {
    core.FS.unlink(outName);
  } catch (e) {
    /* ignore */
  }
  if (!bytes || !bytes.length) throw new Error('Ton nicht dekodierbar (ffmpeg ' + ret + ')');
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4)).slice();
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    init(m.coreURL, m.wasmURL).then(
      () => self.postMessage({ type: 'ready' }),
      (err) => self.postMessage({ type: 'error', message: 'Ton-Decoder lädt nicht: ' + (err && err.message) }),
    );
    return;
  }
  if (m.type === 'decode') {
    busy = busy.then(() => {
      try {
        const pcm = decode(m.id, m.format, m.data);
        self.postMessage({ type: 'pcm', id: m.id, pcm }, [pcm.buffer]);
      } catch (err) {
        self.postMessage({ type: 'error', id: m.id, message: (err && err.message) || String(err) });
      }
    });
  }
};
