/**
 * "Zeichen-Typ-Bereich": fonts, sizes, colours and edge styles for subtitles, the player OSD and the app UI.
 * Everything ends up as CSS custom properties on <html>, so a change is visible immediately (live preview).
 */
import { store } from '../core/store.js';

/** Fonts bundled in public/fonts (same 7 as the Android app) + system stacks. */
export const FONTS = [
  { value: 'system', label: 'System', stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' },
  { value: 'Inter', label: 'Inter', stack: '"Inter", system-ui, sans-serif', file: 'font_inter.ttf' },
  { value: 'Montserrat', label: 'Montserrat', stack: '"Montserrat", system-ui, sans-serif', file: 'font_montserrat.ttf' },
  { value: 'Nunito', label: 'Nunito', stack: '"Nunito", system-ui, sans-serif', file: 'font_nunito.ttf' },
  { value: 'Rubik', label: 'Rubik', stack: '"Rubik", system-ui, sans-serif', file: 'font_rubik.ttf' },
  { value: 'Exo 2', label: 'Exo 2', stack: '"Exo 2", system-ui, sans-serif', file: 'font_exo2.ttf' },
  { value: 'Comfortaa', label: 'Comfortaa', stack: '"Comfortaa", system-ui, sans-serif', file: 'font_comfortaa.ttf' },
  { value: 'Oswald', label: 'Oswald (schmal)', stack: '"Oswald", system-ui, sans-serif', file: 'font_oswald.ttf' },
  { value: 'serif', label: 'Serifen', stack: 'Georgia, "Times New Roman", serif' },
  { value: 'mono', label: 'Monospace', stack: 'ui-monospace, Menlo, Consolas, monospace' },
];

export const EDGE_STYLES = [
  { value: 'none', label: 'Keine' },
  { value: 'outline', label: 'Kontur' },
  { value: 'shadow', label: 'Schlagschatten' },
  { value: 'raised', label: 'Erhaben' },
  { value: 'depressed', label: 'Vertieft' },
];

export const COLORS = ['#FFFFFF', '#FFF59D', '#FFEB3B', '#80DEEA', '#A5D6A7', '#F48FB1', '#FFCC80', '#BDBDBD', '#000000'];
export const ACCENTS = ['#3D8BFF', '#8B5CF6', '#22C55E', '#F59E0B', '#EF4444', '#EC4899', '#14B8A6', '#06B6D4', '#F97316', '#A3E635', '#E5E7EB', '#6366F1'];

export function fontStack(value, fallback = FONTS[0].stack) {
  if (value === 'inherit') return 'inherit';
  const f = FONTS.find((x) => x.value === value);
  return f ? f.stack : fallback;
}

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(0,0,0,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export function edgeShadow(edge, color) {
  const c = color || '#000';
  switch (edge) {
    case 'outline':
      return `-1px -1px 0 ${c}, 1px -1px 0 ${c}, -1px 1px 0 ${c}, 1px 1px 0 ${c}, 0 0 2px ${c}`;
    case 'shadow':
      return `0.06em 0.06em 0.12em ${hexToRgba(c, 0.9)}`;
    case 'raised':
      return `0.04em 0.04em 0 ${c}, 0.08em 0.08em 0 ${hexToRgba(c, 0.6)}`;
    case 'depressed':
      return `-0.04em -0.04em 0 ${c}, 0.04em 0.04em 0 rgba(255,255,255,.35)`;
    default:
      return 'none';
  }
}

/** Writes the CSS variables for a text config onto an element (default: <html>). */
export function applyTextStyles(text = store.get('text'), target = document.documentElement) {
  const s = target.style;
  const sub = text.subtitle;
  s.setProperty('--sub-font', fontStack(sub.font));
  s.setProperty('--sub-size', String(sub.size / 100));
  s.setProperty('--sub-color', sub.color);
  s.setProperty('--sub-bg', hexToRgba(sub.background, sub.backgroundOpacity));
  s.setProperty('--sub-shadow', edgeShadow(sub.edge, sub.edgeColor));
  s.setProperty('--sub-weight', String(sub.weight));
  s.setProperty('--sub-bottom', sub.position + '%');
  s.setProperty('--sub-line', String(sub.lineHeight));
  s.setProperty('--sub-transform', sub.transform);
  s.setProperty('--sub-style', sub.italic ? 'italic' : 'normal');

  const osd = text.osd;
  s.setProperty('--osd-font', osd.font === 'inherit' ? 'var(--ui-font)' : fontStack(osd.font));
  s.setProperty('--osd-scale', String(osd.scale / 100));
  s.setProperty('--osd-bg-alpha', String(osd.backgroundOpacity));

  const ui = text.ui;
  if (target === document.documentElement) {
    s.setProperty('--ui-font', fontStack(ui.font));
    s.setProperty('--ui-scale', String(ui.scale / 100));
    s.setProperty('--ui-weight', String(ui.weight));
    s.setProperty('--ui-letter', ui.letterSpacing / 100 + 'em');
  }
}

export function applyAccent() {
  const s = document.documentElement.style;
  const a = store.get('ui.accent') || '#3D8BFF';
  const b = store.get('ui.accent2') || '#8B5CF6';
  s.setProperty('--accent', a);
  s.setProperty('--accent-2', b);
  s.setProperty('--accent-a18', hexToRgba(a, 0.18));
  s.setProperty('--accent-a35', hexToRgba(a, 0.35));
  s.setProperty('--glow', hexToRgba(a, 0.75));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', '#0B0E14');
}

export function initTextStyles() {
  applyTextStyles();
  applyAccent();
  store.subscribe((path) => {
    if (path === '*' || path.startsWith('text')) applyTextStyles();
    if (path === '*' || path.startsWith('ui')) applyAccent();
  });
}
