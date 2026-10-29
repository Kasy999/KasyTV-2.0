/**
 * M3U / M3U8 (extended) playlist parser – port of the Android app's M3uParser.kt.
 *
 * Pure function (no DOM), so it runs in a Web Worker and in Node tests. Single pass over the lines,
 * attribute regex only on #EXTINF lines: ~50 000 channels parse in well under a second on a TV stick.
 *
 * Supports: #EXTM3U header attributes (url-tvg, x-tvg-url, catchup*, tvg-shift), #EXTINF attributes (tvg-id,
 * tvg-name, tvg-logo, tvg-chno, group-title, catchup*, timeshift, tvg-rec), #EXTGRP, #EXTVLCOPT / #KODIPROP /
 * #EXTHTTP headers and "url|User-Agent=…" suffixes (kept for proxies – browsers can't set those headers),
 * plain URL lists without #EXTINF, and HLS master playlists given by mistake (reported as a single stream).
 */

const ATTR_RE = /([A-Za-z0-9_\-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s,]+))/g;
export const XTREAM_RE = /^(https?:\/\/[^/]+)\/(?:live\/)?([^/]+)\/([^/]+)\/(\d+)(\.[A-Za-z0-9]+)?(\?.*)?$/;
const VOD_EXT_RE = /\.(mp4|mkv|avi|mov|m4v|webm|wmv|flv|mpg|mpeg)(\?|$)/i;

export function parseCatchupType(raw) {
  switch (String(raw || '').trim().toLowerCase()) {
    case 'default': return 'DEFAULT';
    case 'append': return 'APPEND';
    case 'shift':
    case 'timeshift': return 'SHIFT';
    case 'flussonic':
    case 'fs': return 'FLUSSONIC';
    case 'flussonic-hls': return 'FLUSSONIC_HLS';
    case 'flussonic-ts':
    case 'fs-ts': return 'FLUSSONIC_TS';
    case 'xc':
    case 'xtream':
    case 'xtream-codes': return 'XTREAM';
    case 'vod': return 'VOD';
    default: return null;
  }
}

function parseAttributes(text) {
  const map = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(text)) !== null) {
    const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : '';
    map[m[1].toLowerCase()] = value.trim();
  }
  return map;
}

/** Index of the comma between attributes and title (commas inside quotes don't count). */
function findTitleComma(body) {
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i);
    if (quote !== null && c === quote) quote = null;
    else if (quote === null && (c === '"' || c === "'")) quote = c;
    else if (quote === null && c === ',') return i;
  }
  return -1;
}

const toInt = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
};
const toFloat = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
};

function resolveUrl(u, base) {
  if (!u || !base || /^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  try {
    return new URL(u, base).toString();
  } catch {
    return u;
  }
}

function splitPipeHeaders(raw) {
  const idx = raw.indexOf('|');
  if (idx < 0) return { url: raw.trim(), headers: null };
  const headers = {};
  raw
    .substring(idx + 1)
    .split('&')
    .forEach((pair) => {
      const eq = pair.indexOf('=');
      if (eq > 0) {
        try {
          headers[pair.substring(0, eq).trim()] = decodeURIComponent(pair.substring(eq + 1).trim());
        } catch {
          headers[pair.substring(0, eq).trim()] = pair.substring(eq + 1).trim();
        }
      }
    });
  return { url: raw.substring(0, idx).trim(), headers };
}

function buildChannel(info, rawUrl, ctx) {
  const { groupOverride, number, usedIds, global, pendingHeaders, baseUrl } = ctx;
  const colon = info.indexOf(':');
  const body = colon >= 0 ? info.substring(colon + 1) : '';
  const comma = findTitleComma(body);
  const attrPart = comma >= 0 ? body.substring(0, comma) : body;
  const title = comma >= 0 ? body.substring(comma + 1).trim() : '';
  const attrs = parseAttributes(attrPart);

  const split = splitPipeHeaders(rawUrl);
  const url = resolveUrl(split.url, baseUrl);
  const headers = Object.assign({}, pendingHeaders || {}, split.headers || {});
  const name = title || attrs['tvg-name'] || 'Kanal ' + number;
  const tvgId = attrs['tvg-id'] && attrs['tvg-id'].trim() ? attrs['tvg-id'] : null;
  const groupRaw = groupOverride !== null ? groupOverride : attrs['group-title'];
  let group = groupRaw ? groupRaw.split(';')[0].trim() : '';
  if (!group) group = 'Ohne Kategorie';

  let days = toInt(attrs['catchup-days'] !== undefined ? attrs['catchup-days'] : attrs.timeshift !== undefined ? attrs.timeshift : attrs['tvg-rec']);
  if (days === null) days = global.days;
  const source = attrs['catchup-source'] !== undefined ? attrs['catchup-source'] : global.source;
  let explicitType = parseCatchupType(attrs.catchup !== undefined ? attrs.catchup : attrs['catchup-type']);
  if (!explicitType && global.type && global.type !== 'NONE') explicitType = global.type;
  let type;
  if (explicitType) type = explicitType;
  else if (days > 0 && source && source.trim()) type = 'DEFAULT';
  else if (days > 0 && XTREAM_RE.test(url)) type = 'XTREAM';
  else if (days > 0) type = 'SHIFT';
  else type = 'NONE';
  const effectiveDays = type !== 'NONE' && days <= 0 ? 7 : days;

  const baseId = (tvgId || name).toLowerCase().trim();
  let id = baseId;
  let suffix = 2;
  while (usedIds.has(id)) id = baseId + '#' + suffix++;
  usedIds.add(id);

  const shift = toFloat(attrs['tvg-shift']);
  const logo = attrs['tvg-logo'] && attrs['tvg-logo'].trim() ? resolveUrl(attrs['tvg-logo'], baseUrl) : null;
  const kind = VOD_EXT_RE.test(url) || /\/(movie|series)\//i.test(url) ? 'vod' : 'live';

  const ch = {
    id,
    number: toInt(attrs['tvg-chno']) || number,
    name,
    url,
    logo,
    group,
    kind,
    tvgId,
    tvgName: attrs['tvg-name'] && attrs['tvg-name'].trim() ? attrs['tvg-name'] : null,
    catchup: { type, source: source && source.trim() ? source : null, days: effectiveDays },
    tvgShiftHours: shift !== null ? shift : global.shift,
  };
  if (Object.keys(headers).length) ch.headers = headers;
  if (attrs['parent-code'] || attrs.censored === '1' || attrs.adult === '1') ch.adult = true;
  return ch;
}

/**
 * parseM3u(text, { baseUrl }) → { channels, groups, epgUrls, isMaster }
 * groups keep the order of first appearance.
 */
export function parseM3u(text, { baseUrl = null } = {}) {
  const channels = [];
  const epgUrls = [];
  const usedIds = new Set();
  const global = { type: null, source: null, days: 0, shift: 0 };
  let pendingInfo = null;
  let pendingGroup = null;
  let pendingHeaders = null;
  let isMaster = false;

  if (text.charCodeAt(0) === 0xfeff) text = text.substring(1);
  const lines = text.split(/\r\n|\n|\r/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.charAt(0) === '#') {
      const upper = line.substring(0, 18).toUpperCase();
      if (upper.startsWith('#EXTM3U')) {
        const attrs = parseAttributes(line.substring(7));
        const tvg = attrs['url-tvg'] || attrs['x-tvg-url'] || attrs['tvg-url'];
        if (tvg) {
          for (let u of tvg.split(',')) {
            u = u.trim();
            if (u && !epgUrls.includes(u)) epgUrls.push(u);
          }
        }
        global.type = parseCatchupType(attrs.catchup !== undefined ? attrs.catchup : attrs['catchup-type']);
        global.source = attrs['catchup-source'] || null;
        global.days = toInt(attrs['catchup-days'] !== undefined ? attrs['catchup-days'] : attrs.timeshift) || 0;
        global.shift = toFloat(attrs['tvg-shift']) || 0;
      } else if (upper.startsWith('#EXTINF')) {
        pendingInfo = line;
      } else if (upper.startsWith('#EXTGRP:')) {
        pendingGroup = line.substring(line.indexOf(':') + 1).trim();
      } else if (upper.startsWith('#EXTVLCOPT:')) {
        const opt = line.substring(11);
        const eq = opt.indexOf('=');
        if (eq > 0) {
          const key = opt.substring(0, eq).trim().toLowerCase();
          const val = opt.substring(eq + 1).trim();
          pendingHeaders = pendingHeaders || {};
          if (key === 'http-user-agent') pendingHeaders['User-Agent'] = val;
          else if (key === 'http-referrer' || key === 'http-referer') pendingHeaders.Referer = val;
          else if (key === 'http-origin') pendingHeaders.Origin = val;
        }
      } else if (upper.startsWith('#EXTHTTP:')) {
        try {
          pendingHeaders = Object.assign(pendingHeaders || {}, JSON.parse(line.substring(9)));
        } catch {
          /* ignore */
        }
      } else if (upper.startsWith('#EXT-X-STREAM-INF') || upper.startsWith('#EXT-X-TARGETDURATION')) {
        isMaster = true;
      }
      continue;
    }
    // URL line
    if (isMaster && pendingInfo === null) continue;
    if (pendingInfo !== null) {
      channels.push(buildChannel(pendingInfo, line, { groupOverride: pendingGroup, number: channels.length + 1, usedIds, global, pendingHeaders, baseUrl }));
    } else if (line.indexOf('://') >= 0) {
      const last = line.substring(line.lastIndexOf('/') + 1).split('?')[0];
      channels.push(
        buildChannel('#EXTINF:-1,' + decodeSafe(last), line, {
          groupOverride: pendingGroup,
          number: channels.length + 1,
          usedIds,
          global: { type: null, source: null, days: 0, shift: global.shift },
          pendingHeaders,
          baseUrl,
        }),
      );
    }
    pendingInfo = null;
    pendingGroup = null;
    pendingHeaders = null;
  }

  const groupSet = new Map();
  for (const ch of channels) groupSet.set(ch.group, (groupSet.get(ch.group) || 0) + 1);
  const groups = Array.from(groupSet, ([name, count]) => ({ name, count }));
  return { channels, groups, epgUrls, isMaster: isMaster && channels.length === 0 };
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Quick check whether a text looks like a playlist at all. */
export function looksLikeM3u(text) {
  const head = text.slice(0, 2048);
  return /#EXTM3U|#EXTINF/i.test(head) || /^\s*https?:\/\//im.test(head);
}
