/** Small shared helpers. */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return d;
}

export function uid(prefix = '') {
  const r = crypto && crypto.getRandomValues ? crypto.getRandomValues(new Uint32Array(2)) : [Math.random() * 1e9, Date.now()];
  return prefix + Array.from(r, (n) => Math.floor(n).toString(36)).join('');
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

export function formatClock(d = new Date()) {
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

export function formatDate(ts) {
  if (!ts) return '–';
  return new Date(ts).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatBytes(n) {
  if (!n && n !== 0) return '–';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}

/** Deep merge of plain objects; arrays and primitives of `patch` replace those of `base`. */
export function deepMerge(base, patch) {
  if (!isPlain(base) || !isPlain(patch)) return patch === undefined ? clone(base) : clone(patch);
  const out = {};
  for (const k of Object.keys(base)) out[k] = clone(base[k]);
  for (const k of Object.keys(patch)) out[k] = k in base ? deepMerge(base[k], patch[k]) : clone(patch[k]);
  return out;
}

export function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isPlain(o[keys[i]])) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

/** Normalises a server address: adds http(s)://, drops trailing slashes and /web/… paths. */
export function normalizeServerUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = (location.protocol === 'https:' ? 'https://' : 'http://') + s;
  s = s.replace(/\/web(\/.*)?$/i, '').replace(/\/+$/, '');
  return s;
}

/** True when a https page would block this http resource (mixed content). */
export function isMixedContent(url) {
  return location.protocol === 'https:' && /^http:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(url);
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
}

/** Decodes uploaded text: UTF-8, falls back to Windows-1251 / -1252 for older Russian/European playlists. */
export function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      const cyr = new TextDecoder('windows-1251').decode(buffer);
      if (/[А-Яа-я]/.test(cyr)) return cyr;
      return new TextDecoder('windows-1252').decode(buffer);
    } catch {
      return new TextDecoder().decode(buffer);
    }
  }
}
