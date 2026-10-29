/**
 * Archive (catch-up) stream URLs from the M3U catch-up parameters – port of CatchupUrlBuilder.kt / catchup.js.
 *
 * Placeholders in catchup-source (Kodi IPTV Simple, TiviMate, OTT Navigator):
 *  {utc} ${start} {start} · {utcend} ${end} {end} · {lutc} ${now} ${timestamp} · {duration} {duration:60}
 *  {offset:1} · {Y}{m}{d}{H}{M}{S} · {utc:Y-m-d-H-M-S} {utcend:…} · ${(b)yyyyMMddHHmmss} ${(e)…}
 */
import { XTREAM_RE } from './m3u-parser.js';

const DAY = 86400000;
const PLACEHOLDER = /\$?\{([A-Za-z]+)(?::([^}]*))?\}/g;
const JAVA_PATTERN = /\$\{\(([be])\)([^}]+)\}/g;
const FLUSSONIC = /^(https?:\/\/[^/]+)\/(.*)\/([^/]*)(mpegts|\.m3u8)(\?.+=.+)?$/;

const pad2 = (n) => String(n).padStart(2, '0');
const pad4 = (n) => String(n).padStart(4, '0');

export function hasArchive(channel) {
  return !!(channel && channel.catchup && channel.catchup.type !== 'NONE' && channel.catchup.days > 0);
}

/** Whether a programme starting at startMs can be played from the archive now. */
export function isAvailable(channel, startMs, now = Date.now()) {
  if (!hasArchive(channel)) return false;
  return startMs >= now - channel.catchup.days * DAY && startMs <= now;
}

function hasPlaceholder(s) {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(s);
}

/** Archive URL for [startMs, endMs] of a channel, or null without catch-up support. */
export function buildArchiveUrl(channel, startMs, endMs, nowMs = Date.now()) {
  const start = Math.floor(startMs / 1000);
  // Programmes still running are requested until "now".
  const end = Math.floor(Math.min(endMs, nowMs) / 1000);
  const now = Math.floor(nowMs / 1000);
  const { source, type } = channel.catchup;
  const url = channel.url;
  const sep = url.includes('?') ? '&' : '?';
  switch (type) {
    case 'NONE':
      return null;
    case 'DEFAULT':
    case 'VOD':
      return fill(source || url, start, end, now);
    case 'APPEND':
      return fill(url + (source || ''), start, end, now);
    case 'SHIFT':
      return source ? fill(url + source, start, end, now) : `${url}${sep}utc=${start}&lutc=${now}`;
    case 'FLUSSONIC':
    case 'FLUSSONIC_HLS':
    case 'FLUSSONIC_TS':
      if (source && hasPlaceholder(source)) return fill(source, start, end, now);
      return flussonic(url, start, end - start, type) || fill(url, start, end, now);
    case 'XTREAM':
      if (source && hasPlaceholder(source)) return fill(source, start, end, now);
      return xtream(url, start, end - start) || `${url}${sep}utc=${start}&lutc=${now}`;
    default:
      return null;
  }
}

function flussonic(url, start, duration, type) {
  const m = FLUSSONIC.exec(url);
  if (!m) return null;
  const [, host, channelPath, listType, streamType] = m;
  const query = m[5] || '';
  const asTs = type === 'FLUSSONIC_TS' || (type === 'FLUSSONIC' && streamType === 'mpegts');
  if (asTs) return `${host}/${channelPath}/timeshift_abs-${start}.ts${query}`;
  const prefix = !listType || listType === 'index' ? 'index' : listType;
  return `${host}/${channelPath}/${prefix}-${start}-${duration}.m3u8${query}`;
}

function xtream(url, start, duration) {
  const m = XTREAM_RE.exec(url);
  if (!m) return null;
  const [, host, user, pass, streamId] = m;
  const ext = m[5] || '.ts';
  const minutes = Math.max(1, Math.floor((duration + 59) / 60));
  const d = new Date(start * 1000);
  const startFormatted = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}:${pad2(d.getHours())}-${pad2(d.getMinutes())}`;
  return `${host}/timeshift/${user}/${pass}/${minutes}/${startFormatted}/${streamId}${ext}`;
}

/** Java SimpleDateFormat subset (y M d H h m s S a, quoted text). */
function javaFormat(pattern, epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  return pattern.replace(/'[^']*'|y+|M+|d+|H+|h+|m+|s+|S+|a/g, (t) => {
    if (t[0] === "'") return t.slice(1, -1);
    const n = t.length;
    switch (t[0]) {
      case 'y': return n === 2 ? pad2(d.getFullYear() % 100) : pad4(d.getFullYear());
      case 'M': return n >= 2 ? pad2(d.getMonth() + 1) : String(d.getMonth() + 1);
      case 'd': return n >= 2 ? pad2(d.getDate()) : String(d.getDate());
      case 'H': return n >= 2 ? pad2(d.getHours()) : String(d.getHours());
      case 'h': return pad2(d.getHours() % 12 || 12);
      case 'm': return n >= 2 ? pad2(d.getMinutes()) : String(d.getMinutes());
      case 's': return n >= 2 ? pad2(d.getSeconds()) : String(d.getSeconds());
      case 'S': return ('00' + d.getMilliseconds()).slice(-3);
      case 'a': return d.getHours() < 12 ? 'AM' : 'PM';
      default: return t;
    }
  });
}

/** Kodi letters: Y=year, m=month, d=day, H=hour, M=minute, S=second; other characters are literal. */
function kodiFormat(pattern, epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  let out = '';
  for (const c of pattern) {
    switch (c) {
      case 'Y': out += pad4(d.getFullYear()); break;
      case 'm': out += pad2(d.getMonth() + 1); break;
      case 'd': out += pad2(d.getDate()); break;
      case 'H': out += pad2(d.getHours()); break;
      case 'M': out += pad2(d.getMinutes()); break;
      case 'S': out += pad2(d.getSeconds()); break;
      default: out += c;
    }
  }
  return out;
}

function fill(template, start, end, now) {
  const withJava = template.replace(JAVA_PATTERN, (m, which, pattern) => {
    try {
      return javaFormat(pattern, which === 'b' ? start : end);
    } catch {
      return m;
    }
  });
  const d = new Date(start * 1000);
  return withJava.replace(PLACEHOLDER, (m, name, arg) => {
    const div = Math.max(1, parseInt(arg, 10) || 1);
    switch (name) {
      case 'utc':
      case 'start': return arg ? kodiFormat(arg, start) : String(start);
      case 'utcend':
      case 'end': return arg ? kodiFormat(arg, end) : String(end);
      case 'lutc':
      case 'now':
      case 'timestamp': return arg ? kodiFormat(arg, now) : String(now);
      case 'duration': return String(Math.floor((end - start) / div));
      case 'offset': return String(Math.floor((now - start) / div));
      case 'Y': return pad4(d.getFullYear());
      case 'm': return pad2(d.getMonth() + 1);
      case 'd': return pad2(d.getDate());
      case 'H': return pad2(d.getHours());
      case 'M': return pad2(d.getMinutes());
      case 'S': return pad2(d.getSeconds());
      default: return m;
    }
  });
}
