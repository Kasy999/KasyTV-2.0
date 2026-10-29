// Parses big playlists off the main thread, so the UI (and the remote) stay responsive.
import { parseM3u } from './m3u-parser.js';

self.onmessage = (e) => {
  const { id, text, baseUrl } = e.data;
  try {
    const t0 = performance.now();
    const result = parseM3u(text, { baseUrl });
    result.parseMs = Math.round(performance.now() - t0);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
