// Copies the player libraries from node_modules into public/vendor, so the app loads them from its own origin
// (and the service worker can cache them for offline use). Missing packages are skipped – the app then falls
// back to the pinned CDN copies (see src/core/loader.js).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'public/vendor');
mkdirSync(out, { recursive: true });

const files = [
  ['node_modules/hls.js/dist/hls.min.js', 'hls.min.js'],
  ['node_modules/mpegts.js/dist/mpegts.js', 'mpegts.js'],
];

for (const [from, to] of files) {
  const src = resolve(root, from);
  if (existsSync(src)) {
    copyFileSync(src, resolve(out, to));
    console.log(`[vendor] ${to} kopiert`);
  } else {
    console.warn(`[vendor] ${from} fehlt – CDN-Fallback wird verwendet`);
  }
}
