/**
 * Dual control system: "touch" (phones/tablets, mouse) and "tv" (D-pad / remote / keyboard).
 *
 * In "auto" the mode starts from the device (TV user agents, no touch screen) and then follows the user:
 * an arrow key switches to TV mode, a finger on the screen back to touch mode. The mode is a class on <html>
 * (mode-tv / mode-touch) – CSS sizes the layout, the focus engine only draws its ring in TV mode.
 */
import { store } from './store.js';
import { bus } from './events.js';

const TV_UA =
  /SMART-?TV|SmartTV|Tizen|Web0S|webOS|NetCast|HbbTV|BRAVIA|AFT[A-Z0-9]|Android ?TV|GoogleTV|CrKey|MiTV|MIBOX|Mi ?Box|Xiaomi.*TV|AmazonWebAppPlatform|VIDAA|Hisense|Philips|Roku|PlayStation|Xbox|Nintendo|DTV|STB|TPM191E|Chromecast/i;

let mode = 'touch';
let detected = 'touch';

export function detectDevice() {
  const ua = navigator.userAgent || '';
  if (TV_UA.test(ua)) return 'tv';
  // Android without touch screen = TV box / stick (e.g. Xiaomi TV Stick with a browser).
  if (/Android/i.test(ua) && navigator.maxTouchPoints === 0) return 'tv';
  const mm = (q) => window.matchMedia && window.matchMedia(q).matches;
  if (mm('(any-pointer: coarse)') || navigator.maxTouchPoints > 0) return 'touch';
  // Desktop browsers: mouse + keyboard → touch layout (pointer UI); arrow keys flip to TV mode on use.
  return 'touch';
}

export function isTvUserAgent() {
  return TV_UA.test(navigator.userAgent || '');
}

function apply(next, reason) {
  if (next === mode && document.documentElement.classList.contains('mode-' + next)) return;
  mode = next;
  const root = document.documentElement;
  root.classList.toggle('mode-tv', mode === 'tv');
  root.classList.toggle('mode-touch', mode === 'touch');
  bus.emit('inputmode', { mode, reason });
}

export function initInputMode() {
  detected = detectDevice();
  const pref = store.get('ui.inputMode');
  apply(pref === 'auto' ? detected : pref, 'init');

  store.subscribe((path) => {
    if (path === '*' || path.startsWith('ui')) {
      const p = store.get('ui.inputMode');
      apply(p === 'auto' ? detected : p, 'setting');
    }
  });

  const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  window.addEventListener(
    'keydown',
    (e) => {
      if (store.get('ui.inputMode') !== 'auto') return;
      if (NAV_KEYS.has(e.key) || e.keyCode === 37 || e.keyCode === 38 || e.keyCode === 39 || e.keyCode === 40) {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && mode === 'touch') return;
        if (mode !== 'tv') apply('tv', 'keyboard');
      }
    },
    true,
  );
  window.addEventListener(
    'touchstart',
    () => {
      if (store.get('ui.inputMode') === 'auto' && mode !== 'touch') apply('touch', 'touch');
    },
    { passive: true, capture: true },
  );
}

export const inputMode = {
  get current() {
    return mode;
  },
  get detected() {
    return detected;
  },
  isTV: () => mode === 'tv',
  isTouch: () => mode === 'touch',
};
