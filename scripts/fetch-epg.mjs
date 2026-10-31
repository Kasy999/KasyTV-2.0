// Mirrors free EPG (XMLTV) files into <out>/epg/ so the app can load them from its own origin (no CORS).
// Used by the GitHub Pages workflow:  node scripts/fetch-epg.mjs dist
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.argv[2] || 'dist', 'epg');
mkdirSync(out, { recursive: true });
const { sources } = JSON.parse(readFileSync(resolve(root, 'epg-sources.json'), 'utf8'));

const index = [];
for (const src of sources) {
  for (const url of src.urls) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'KasyTV-EPG-Mirror/1.0' }, signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      let buf = Buffer.from(await res.arrayBuffer());
      const isGz = buf[0] === 0x1f && buf[1] === 0x8b;
      if (!isGz) {
        if (!/<tv[\s>]/.test(buf.subarray(0, 4096).toString('utf8'))) throw new Error('kein XMLTV');
        buf = gzipSync(buf, { level: 9 });
      }
      if (buf.length < 1000) throw new Error('zu klein');
      writeFileSync(resolve(out, `${src.id}.xml.gz`), buf);
      index.push({ id: src.id, label: src.label, file: `${src.id}.xml.gz`, bytes: buf.length, source: url, updatedAt: new Date().toISOString() });
      console.log(`[epg] ${src.id}: ${(buf.length / 1048576).toFixed(1)} MB von ${url}`);
      break;
    } catch (e) {
      console.warn(`[epg] ${src.id}: ${url} fehlgeschlagen – ${e.message}`);
    }
  }
}
writeFileSync(resolve(out, 'index.json'), JSON.stringify(index, null, 2));
console.log(`[epg] ${index.length}/${sources.length} Quellen gespiegelt`);
