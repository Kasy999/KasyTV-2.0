/** Tiny DOM helpers – the whole UI is built with these, no framework. */

const PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'muted', 'playsInline', 'autoplay', 'loop', 'src']);

/**
 * h('button.btn.primary', { onClick, data: { focus: '' } }, 'Text', child…)
 * Tag may carry classes after dots. `data-focus` marks elements reachable by the remote.
 */
export function h(tag, props, ...children) {
  const parts = tag.split('.');
  const el = document.createElement(parts[0] || 'div');
  if (parts.length > 1) el.className = parts.slice(1).join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  if (props) {
    for (const key of Object.keys(props)) {
      const v = props[key];
      if (v === undefined || v === null || v === false) continue;
      if (key === 'class') el.className = (el.className ? el.className + ' ' : '') + v;
      else if (key === 'style' && typeof v === 'object') {
        for (const s of Object.keys(v)) {
          if (s.startsWith('--')) el.style.setProperty(s, v[s]);
          else el.style[s] = v[s];
        }
      } else if (key === 'data') {
        for (const d of Object.keys(v)) if (v[d] !== undefined && v[d] !== null && v[d] !== false) el.dataset[d] = v[d] === true ? '' : v[d];
      } else if (key === 'html') el.innerHTML = v;
      else if (key === 'text') el.textContent = v;
      else if (key.startsWith('on') && typeof v === 'function') el.addEventListener(key.slice(2).toLowerCase(), v);
      else if (PROPS.has(key)) el[key] = v;
      else if (v === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Focusable button with optional icon. */
export function button(label, onClick, opts = {}) {
  const b = h(
    'button.btn' + (opts.variant ? '.' + opts.variant : ''),
    {
      type: 'button',
      data: { focus: true, focusDefault: opts.default || undefined },
      title: opts.title || (typeof label === 'string' ? label : undefined),
      'aria-label': opts.ariaLabel || opts.title,
      class: opts.class,
      onClick: (e) => {
        if (b.disabled) return;
        onClick && onClick(e);
      },
      disabled: opts.disabled,
    },
    opts.icon ? icon(opts.icon) : null,
    label ? h('span.btn-label', label) : null,
  );
  return b;
}

/** Inline SVG icons (stroke style, 24px grid). */
const ICONS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  tv: 'M3 6h18v12H3zM8 21h8M12 18v3M8 2l4 4 4-4',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4',
  lamp: 'M9 18h6M10 21h4M12 3a6 6 0 0 1 4 10.5c-.7.7-1 1.5-1 2.5H9c0-1-.3-1.8-1-2.5A6 6 0 0 1 12 3z',
  youtube: 'M2.5 7.5c.2-1.6 1.4-2.8 3-3C7.7 4.2 9.9 4 12 4s4.3.2 6.5.5c1.6.2 2.8 1.4 3 3 .3 1.5.5 3 .5 4.5s-.2 3-.5 4.5c-.2 1.6-1.4 2.8-3 3-2.2.3-4.4.5-6.5.5s-4.3-.2-6.5-.5c-1.6-.2-2.8-1.4-3-3C2.2 15 2 13.5 2 12s.2-3 .5-4.5zM10 9v6l5-3z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h4v16H7zM13 4h4v16h-4z',
  back: 'M15 18l-6-6 6-6',
  next: 'M9 18l6-6-6-6',
  up: 'M18 15l-6-6-6 6',
  down: 'M6 9l6 6 6-6',
  close: 'M6 6l12 12M18 6L6 18',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  star: 'M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.3L12 17.5 6.5 20.4l1-6.3L3 9.7l6.2-.9z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  sort: 'M3 6h11M3 12h8M3 18h5M18 5v14M14.5 15.5L18 19l3.5-3.5',
  refresh: 'M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  plus: 'M12 5v14M5 12h14',
  rewind: 'M11 19l-9-7 9-7zM22 19l-9-7 9-7z',
  forward: 'M13 19l9-7-9-7zM2 19l9-7-9-7z',
  skipNext: 'M5 4l10 8-10 8zM19 5v14',
  skipPrev: 'M19 20L9 12l10-8zM5 19V5',
  volume: 'M11 5L6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  mute: 'M11 5L6 9H2v6h4l5 4zM23 9l-6 6M17 9l6 6',
  subtitles: 'M3 5h18v14H3zM7 13h4M13 13h4M7 16h10',
  audio: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  quality: 'M4 6h16M4 12h10M4 18h6M18 14l2 2 4-4',
  aspect: 'M3 5h18v14H3zM7 9v6M17 9v6',
  pip: 'M3 5h18v14H3zM12 12h7v5h-7z',
  fullscreen: 'M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  text: 'M4 7V4h16v3M9 20h6M12 4v16',
  save: 'M5 3h11l5 5v13H5zM8 3v6h8M8 21v-7h8v7',
  link: 'M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  speed: 'M12 14l4-4M3.3 17a10 10 0 1 1 17.4 0',
  user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  gauge: 'M12 21a9 9 0 1 1 9-9M12 12l5-3',
  external: 'M14 3h7v7M10 14L21 3M21 14v7H3V3h7',
  folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  check: 'M5 12l5 5L20 7',
  remote: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 6h.01M10 10h4M12 8v4',
  touch: 'M9 11V5a2 2 0 1 1 4 0v5M13 10V8a2 2 0 1 1 4 0v3M17 10a2 2 0 1 1 4 0v4a8 8 0 0 1-8 8h-1a7 7 0 0 1-5.6-2.8L3 15a2 2 0 0 1 3-2.6l3 2.6',
};

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon ' + cls);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] || ICONS.info);
  svg.appendChild(p);
  return svg;
}

/** Image that hides itself (and shows a text fallback) when loading fails. */
export function img(src, alt, cls, fallbackText) {
  const wrap = h('div.img-wrap' + (cls ? '.' + cls : ''));
  const fb = h('span.img-fallback', initials(fallbackText || alt || ''));
  wrap.appendChild(fb);
  if (src) {
    const i = h('img', { alt: alt || '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    i.addEventListener('load', () => wrap.classList.add('loaded'));
    i.addEventListener('error', () => i.remove());
    i.src = src;
    wrap.appendChild(i);
  }
  return wrap;
}

export function initials(text) {
  const words = String(text).replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '•';
  return (words[0][0] + (words[1] ? words[1][0] : words[0][1] || '')).toUpperCase();
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
