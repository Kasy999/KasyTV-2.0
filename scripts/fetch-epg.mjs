// Mirrors EPG (XMLTV) files into <out>/epg/ so the app can load them from its own origin (no CORS).
// Used by the GitHub Pages workflow:  node scripts/fetch-epg.mjs dist
//
//  1. Free EPG from epg-sources.json        → epg/<id>.xml.gz          (index.json)
//  2. EPG addresses of playlists (url-tvg)   → epg/m3u/<hash>.xml.gz    (m3u/index.json)
//     listed in epg-urls/*.txt – one address per file, added with the button
//     "EPG der Playlist freischalten" in the app (it opens GitHub with the file prefilled).
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.argv[2] || 'dist', 'epg');
mkdirSync(resolve(out, 'm3u'), { recursive: true });

/** Same hash as hashString() in src/core/util.js – the app finds the file by it. */
export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 11) KasyTV-EPG-Mirror/1.0' }, redirect: 'follow', signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  let buf = Buffer.from(await res.arrayBuffer());
  const isGz = buf[0] === 0x1f && buf[1] === 0x8b;
  if (!isGz) {
    if (!/<tv[\s>]/.test(buf.subarray(0, 8192).toString('utf8'))) throw new Error('kein XMLTV');
    buf = gzipSync(buf, { level: 9 });
  }
  if (buf.length < 500) throw new Error('zu klein');
  return buf;
}

// 1. free EPG
const { sources } = JSON.parse(readFileSync(resolve(root, 'epg-sources.json'), 'utf8'));
const index = [];
for (const src of sources) {
  for (const url of src.urls) {
    try {
      const buf = await download(url);
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
console.log(`[epg] ${index.length}/${sources.length} freie Quellen gespiegelt`);

// 2. playlist EPG addresses
const dir = resolve(root, 'epg-urls');
const urls = new Set();
if (existsSync(dir)) {
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.txt')) continue;
    for (const line of readFileSync(resolve(dir, f), 'utf8').split(/\r?\n/)) {
      const u = line.trim();
      if (/^https?:\/\/\S+$/i.test(u)) urls.add(u);
    }
  }
}
const m3uIndex = [];
for (const url of urls) {
  const id = hashString(url);
  const variants = /^http:/i.test(url) ? [url, url.replace(/^http:/i, 'https:')] : [url];
  let ok = false;
  for (const v of variants) {
    try {
      const buf = await download(v);
      writeFileSync(resolve(out, 'm3u', `${id}.xml.gz`), buf);
      m3uIndex.push({ id, url, bytes: buf.length, updatedAt: new Date().toISOString() });
      console.log(`[epg] Playlist-EPG ${new URL(url).hostname}: ${(buf.length / 1048576).toFixed(1)} MB → m3u/${id}.xml.gz`);
      ok = true;
      break;
    } catch (e) {
      console.warn(`[epg] Playlist-EPG ${v} fehlgeschlagen – ${e.message}`);
    }
  }
  if (!ok) m3uIndex.push({ id, url, error: true });
}
writeFileSync(resolve(out, 'm3u', 'index.json'), JSON.stringify(m3uIndex.map(({ url, ...r }) => ({ ...r, host: new URL(url).hostname })), null, 2));
console.log(`[epg] ${m3uIndex.filter((x) => !x.error).length}/${urls.size} Playlist-EPGs gespiegelt`);
