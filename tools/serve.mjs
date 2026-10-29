#!/usr/bin/env node
/**
 * Kasy TV – small server without dependencies (Node 18+).
 *
 *   node tools/serve.mjs dist            → serves the built app        (npm run serve)
 *   node tools/serve.mjs .               → serves the sources unbuilt  (npm run serve:src)
 *   PORT=8080 node tools/serve.mjs dist
 *
 * Also a CORS proxy at /proxy?url=<address> for playlists, EPG, streams and servers that don't allow web apps:
 * HLS playlists are rewritten so their segments go through the proxy as well, Range requests are passed on.
 * In the app: Einstellungen → IPTV → CORS-Proxy = http://<IP of this PC>:8080/proxy?url={url}
 *
 * Note: service workers (offline mode) need HTTPS or localhost. In the LAN over plain http the app works,
 * but without offline start. For the iPhone homescreen with offline mode, host dist/ on an HTTPS server.
 */
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { extname, join, resolve, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';
import { Readable } from 'node:stream';

const root = resolve(process.argv[2] || 'dist');
const port = Number(process.env.PORT || 8080);
const publicDir = resolve(root, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.m3u': 'audio/x-mpegurl',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ts': 'video/mp2t',
  '.mp3': 'audio/mpeg',
  '.vtt': 'text/vtt',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
};

function proxyUrl(base, target) {
  return `${base}?url=${encodeURIComponent(target)}`;
}

function rewritePlaylist(text, sourceUrl, base) {
  const abs = (u) => {
    try {
      return new URL(u, sourceUrl).toString();
    } catch {
      return u;
    }
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxyUrl(base, abs(u))}"`);
      return proxyUrl(base, abs(t));
    })
    .join('\n');
}

async function handleProxy(req, res, url) {
  if (url.searchParams.get('ping')) {
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/plain' });
    return res.end('kasy-proxy');
  }
  const target = url.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) {
    res.writeHead(400, CORS);
    return res.end('url fehlt');
  }
  const headers = { 'User-Agent': req.headers['x-kasy-ua'] || 'Mozilla/5.0 (Linux; Android 11) KasyTV/2.0' };
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['x-kasy-referer']) headers.Referer = req.headers['x-kasy-referer'];
  try {
    const upstream = await fetch(target, { headers, redirect: 'follow' });
    const type = upstream.headers.get('content-type') || '';
    const isPlaylist = /mpegurl/i.test(type) || /\.m3u8(\?|$)/i.test(target);
    const out = { ...CORS, 'Content-Type': type || 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (isPlaylist && upstream.ok) {
      const text = await upstream.text();
      // Only HLS media/master playlists get rewritten – IPTV channel lists (#EXTINF with tvg-…) stay as they are.
      const body = /#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/.test(text) ? rewritePlaylist(text, upstream.url || target, `http://${req.headers.host}/proxy`) : text;
      res.writeHead(upstream.status, out);
      return res.end(body);
    }
    for (const h of ['content-length', 'content-range', 'accept-ranges']) if (upstream.headers.get(h)) out[h] = upstream.headers.get(h);
    res.writeHead(upstream.status, out);
    if (req.method === 'HEAD' || !upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
    req.on('close', () => upstream.body.cancel().catch(() => {}));
  } catch (e) {
    res.writeHead(502, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Proxy-Fehler: ' + e.message);
  }
}

function serveFile(req, res, url) {
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';
  const candidates = [join(root, normalize(path))];
  if (existsSync(publicDir)) candidates.push(join(publicDir, normalize(path))); // unbuilt mode: public/ at the root
  for (const file of candidates) {
    if (!file.startsWith(root)) continue;
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
      const headers = { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' };
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range) {
        const start = range[1] ? parseInt(range[1], 10) : Math.max(0, st.size - parseInt(range[2], 10));
        const end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), st.size - 1) : st.size - 1;
        if (start >= st.size || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          return res.end();
        }
        res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
        if (req.method === 'HEAD') return res.end();
        return createReadStream(file, { start, end }).pipe(res);
      }
      if (path.endsWith('sw.js') || path.endsWith('.html') || path.endsWith('precache-manifest.js')) headers['Cache-Control'] = 'no-cache';
      else if (path.includes('/assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      return createReadStream(file).pipe(res);
    } catch {
      /* try next */
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Nicht gefunden');
}

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (url.pathname === '/proxy' || url.pathname.endsWith('/proxy')) return handleProxy(req, res, url);
  serveFile(req, res, url);
}).listen(port, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log(`Kasy TV läuft:  http://localhost:${port}/`);
  for (const ip of ips) console.log(`Im Heimnetz:    http://${ip}:${port}/   (Proxy: http://${ip}:${port}/proxy?url={url})`);
  console.log(`Ordner: ${root}`);
});
