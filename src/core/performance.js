/**
 * Automatic performance mode for TV sticks and weak hardware (Xiaomi TV Stick 4K, Fire TV, older Smart TVs).
 *
 * Detection (perfMode = auto): TV/stick user agents, ≤ 2 GB memory, ≤ 2 CPU cores, Save-Data – and, if none of
 * those match, a short frame-time probe after start. "Low" sets html.perf-low, which the CSS uses to drop
 * backdrop-filter, big shadows, transitions and animations (styles/perf-low.css), and the JS uses for smaller
 * images, smaller video buffers, instant scrolling and smaller render batches.
 */
import { store } from './store.js';
import { bus } from './events.js';
import { isTvUserAgent } from './input-mode.js';

const PROBE_KEY = 'kasy.perf.probe';
const WEAK_UA = /AFT[A-Z0-9]|MiTV|MIBOX|Mi ?Box|Xiaomi.*TV|Android ?TV|Tizen|Web0S|webOS|NetCast|BRAVIA|VIDAA|HbbTV|SmartTV|SMART-TV|STB|Chromecast|CrKey/i;

let low = false;
let reasons = [];

function staticSignals() {
  const r = [];
  const ua = navigator.userAgent || '';
  if (WEAK_UA.test(ua) || isTvUserAgent()) r.push('TV-Gerät / Stick');
  if (navigator.deviceMemory && navigator.deviceMemory <= 2) r.push(navigator.deviceMemory + ' GB RAM');
  if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) r.push(navigator.hardwareConcurrency + ' CPU-Kerne');
  if (navigator.connection && navigator.connection.saveData) r.push('Datensparmodus');
  if (/Android/i.test(ua) && navigator.maxTouchPoints === 0) r.push('Android ohne Touchscreen');
  try {
    const p = JSON.parse(sessionStorage.getItem(PROBE_KEY) || localStorage.getItem(PROBE_KEY) || 'null');
    if (p && p.slow) r.push('Bildrate gemessen: ' + p.fps + ' FPS');
  } catch {
    /* ignore */
  }
  return r;
}

function apply() {
  const pref = store.get('ui.perfMode');
  reasons = staticSignals();
  low = pref === 'low' || (pref === 'auto' && reasons.length > 0);
  document.documentElement.classList.toggle('perf-low', low);
  document.documentElement.classList.toggle('perf-high', !low);
  bus.emit('perfmode', { low, reasons });
}

/** Measures ~45 frames; avg frame time > 24 ms (< ~42 FPS) while idle = weak device. */
function probe() {
  if (store.get('ui.perfMode') !== 'auto' || low) return;
  let frames = 0;
  let last = 0;
  let total = 0;
  let worst = 0;
  const step = (t) => {
    if (last) {
      const d = t - last;
      total += d;
      worst = Math.max(worst, d);
    }
    last = t;
    if (++frames < 46) requestAnimationFrame(step);
    else {
      const avg = total / 45;
      const fps = Math.round(1000 / avg);
      const slow = avg > 24 && document.visibilityState === 'visible';
      const result = { slow, fps, at: Date.now() };
      try {
        localStorage.setItem(PROBE_KEY, JSON.stringify(result));
      } catch {
        /* ignore */
      }
      if (slow) apply();
    }
  };
  // Measure once the first view is idle, not while it is building.
  setTimeout(() => requestAnimationFrame(step), 2500);
}

export function initPerformance() {
  apply();
  store.subscribe((path) => {
    if (path === '*' || path.startsWith('ui')) apply();
  });
  probe();
}

export const perf = {
  get low() {
    return low;
  },
  get reasons() {
    return reasons.slice();
  },
  /** Width of poster images requested from Jellyfin. */
  posterWidth: () => (low ? 240 : 400),
  backdropWidth: () => (low ? 1280 : 1920),
  /** Items rendered per batch in long lists. */
  batch: () => (low ? 60 : 160),
  scrollBehavior: () => (low ? 'auto' : 'smooth'),
  resetProbe() {
    try {
      localStorage.removeItem(PROBE_KEY);
    } catch {
      /* ignore */
    }
    apply();
    probe();
  },
};
