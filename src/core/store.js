/**
 * User settings. Kept in localStorage (synchronous – available before the first paint) and mirrored to
 * IndexedDB, so a single wiped store (Safari's 7-day cleanup hits both, but not always at the same time)
 * can be restored from the other. The JSON backup (services/backup.js) is the safe copy outside the browser.
 */
import { db } from './db.js';
import { clone, debounce, deepMerge, getPath, setPath, uid } from './util.js';

const LS_KEY = 'kasy.settings.v1';
const IDB_KEY = 'settings';

export const DEFAULTS = {
  schema: 1,
  ui: {
    inputMode: 'auto', // auto | touch | tv
    perfMode: 'auto', // auto | high | low
    accent: '#3D8BFF',
    accent2: '#8B5CF6',
    startView: 'home',
    showClock: true,
    modules: { live: true, library: true, lampa: true, youtube: true },
    homeRows: { continue: true, recentChannels: true, favorites: true, latest: true },
  },
  iptv: {
    sources: [], // { id, name, type: 'url'|'file', url, fileName, count, updatedAt }
    activeSourceId: null,
    view: 'grid', // grid | list
    sort: 'default', // default | name | number
    lastGroup: '__all',
    corsProxy: '', // e.g. http://192.168.1.10:8080/proxy?url={url}
    proxyStreams: false,
    autoRefreshHours: 12,
  },
  jellyfin: {
    server: '',
    userId: '',
    userName: '',
    token: '',
    serverId: '',
    serverName: '',
    deviceId: '',
    maxBitrate: 20000000,
    preferDirectPlay: true,
  },
  lampa: {
    url: 'http://lampa.mx',
    source: 'remote', // remote | local
  },
  youtube: {
    apiKey: '',
    noCookie: true,
  },
  player: {
    engine: 'auto', // auto | hlsjs | native
    autoplayNext: true,
    resume: true,
    aspect: 'contain', // contain | cover | fill
    bufferSeconds: 30,
    volume: 1,
    muted: false,
    osdTimeout: 4,
    seekStep: 10,
    lowLatencyLive: false,
  },
  blocker: {
    enabled: true,
    hlsAdFilter: true, // remove marked ad breaks from VOD playlists, mute them in live streams
    customRules: '',
    sponsorblock: {
      enabled: true,
      server: 'https://sponsor.ajay.app',
      // per category: skip | button | mute | off
      categories: {
        sponsor: 'skip',
        selfpromo: 'skip',
        interaction: 'skip',
        intro: 'button',
        outro: 'button',
        preview: 'button',
        music_offtopic: 'off',
        filler: 'off',
      },
      notify: true,
    },
    // Jellyfin media segments (Intro Skipper / Jellyfin 10.10): skip | button | off
    mediaSegments: { Intro: 'button', Outro: 'button', Recap: 'button', Preview: 'off', Commercial: 'skip' },
  },
  text: {
    subtitle: {
      font: 'Inter',
      size: 100, // %
      color: '#FFFFFF',
      background: '#000000',
      backgroundOpacity: 0.55,
      edge: 'shadow', // none | outline | shadow | raised | depressed
      edgeColor: '#000000',
      weight: 600,
      position: 8, // % from bottom
      lineHeight: 1.3,
      transform: 'none', // none | uppercase
      italic: false,
    },
    osd: {
      font: 'inherit',
      scale: 100,
      backgroundOpacity: 0.72,
      showClock: true,
    },
    ui: {
      font: 'Inter',
      scale: 100,
      weight: 400,
      letterSpacing: 0,
    },
  },
  backup: {
    lastExport: 0,
    remind: true,
  },
};

let state = clone(DEFAULTS);
const listeners = new Set();

function readLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const persist = debounce(() => {
  const json = JSON.stringify(state);
  try {
    localStorage.setItem(LS_KEY, json);
  } catch (e) {
    console.warn('[store] localStorage voll/gesperrt', e);
  }
  db.set(IDB_KEY, JSON.parse(json)).catch(() => {});
}, 250);

export const store = {
  /** Loads settings (localStorage first, IndexedDB as fallback). */
  async init() {
    let saved = readLocal();
    if (!saved) {
      try {
        saved = await db.get(IDB_KEY);
        if (saved) console.info('[store] Einstellungen aus IndexedDB wiederhergestellt');
      } catch {
        saved = null;
      }
    }
    state = deepMerge(DEFAULTS, saved || {});
    if (!state.jellyfin.deviceId) state.jellyfin.deviceId = uid('kasy-');
    persist();
    return state;
  },
  get(path) {
    return path ? getPath(state, path) : state;
  },
  set(path, value) {
    setPath(state, path, clone(value));
    persist();
    emit(path);
  },
  patch(path, partial) {
    const cur = getPath(state, path) || {};
    setPath(state, path, deepMerge(cur, partial));
    persist();
    emit(path);
  },
  /** Replaces the whole settings object (backup import). */
  replace(next) {
    const deviceId = state.jellyfin.deviceId;
    state = deepMerge(DEFAULTS, next || {});
    if (!state.jellyfin.deviceId) state.jellyfin.deviceId = deviceId;
    persist.flush();
    emit('*');
  },
  reset() {
    const deviceId = state.jellyfin.deviceId;
    state = clone(DEFAULTS);
    state.jellyfin.deviceId = deviceId;
    persist.flush();
    emit('*');
  },
  snapshot() {
    return clone(state);
  },
  /** fn(path) on every change; returns an unsubscribe function. */
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  flush() {
    persist.flush();
  },
};

function emit(path) {
  for (const fn of Array.from(listeners)) {
    try {
      fn(path);
    } catch (e) {
      console.error('[store]', e);
    }
  }
}

window.addEventListener('pagehide', () => persist.flush());
