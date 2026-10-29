/**
 * Spatial focus navigation for remotes, D-pads and keyboards.
 *
 *  - Focusable elements carry `data-focus`. Containers with `data-focus-group` remember their last focused child,
 *    so returning to a row lands where you left it (like Android TV's focus restoration).
 *  - Scopes: dialogs / the player push a scope; only elements inside the top scope are reachable.
 *  - Arrow keys pick the nearest element in that direction (geometry of the bounding boxes).
 *  - OK/Enter clicks; holding OK (or the menu key) fires a `longpress` event on the element.
 *  - Back keys (Escape, Backspace, Tizen 10009, webOS 461, GoBack) call the router's back() or a scope handler.
 *  - Media/colour/channel keys are re-emitted on the bus as `remote` events (used by the player).
 */
import { bus } from './events.js';
import { back as routerBack } from './router.js';
import { inputMode } from './input-mode.js';
import { perf } from './performance.js';

const SELECTOR = '[data-focus]';
const scopes = []; // { el, onBack, restore }
const groupMemory = new WeakMap();
let rootEl = document.body;

const KEY = {
  LEFT: [37, 'ArrowLeft', 'Left'],
  UP: [38, 'ArrowUp', 'Up'],
  RIGHT: [39, 'ArrowRight', 'Right'],
  DOWN: [40, 'ArrowDown', 'Down'],
  ENTER: [13, 'Enter', 'Select', 'NumpadEnter', 'Accept'],
  BACK: [27, 10009, 461, 'Escape', 'GoBack', 'BrowserBack', 'Back', 'XF86Back'],
  BACKSPACE: [8, 'Backspace'],
  MENU: [93, 'ContextMenu', 'Menu'],
};

const REMOTE = {
  415: 'play', 19: 'pause', 10252: 'playpause', 179: 'playpause', 413: 'stop', 178: 'stop',
  417: 'forward', 228: 'forward', 412: 'rewind', 227: 'rewind', 176: 'next', 177: 'previous',
  427: 'channelup', 428: 'channeldown', 33: 'channelup', 34: 'channeldown',
  403: 'red', 404: 'green', 405: 'yellow', 406: 'blue', 457: 'info', 458: 'guide',
};
const REMOTE_BY_KEY = {
  MediaPlayPause: 'playpause', MediaPlay: 'play', MediaPause: 'pause', MediaStop: 'stop',
  MediaFastForward: 'forward', MediaRewind: 'rewind', MediaTrackNext: 'next', MediaTrackPrevious: 'previous',
  ChannelUp: 'channelup', ChannelDown: 'channeldown', PageUp: 'channelup', PageDown: 'channeldown',
  ColorF0Red: 'red', ColorF1Green: 'green', ColorF2Yellow: 'yellow', ColorF3Blue: 'blue', Info: 'info', Guide: 'guide',
};

function is(e, list) {
  return list.includes(e.keyCode) || list.includes(e.key);
}

function topScope() {
  return scopes.length ? scopes[scopes.length - 1].el : rootEl;
}

function isVisible(el) {
  if (!el.isConnected || el.disabled || el.hidden) return false;
  if (el.closest('[inert],[hidden],[aria-hidden="true"]')) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

export function focusables(scope = topScope()) {
  return Array.from(scope.querySelectorAll(SELECTOR)).filter(isVisible);
}

function groupOf(el) {
  return el ? el.closest('[data-focus-group]') : null;
}

function remember(el) {
  let g = groupOf(el);
  while (g) {
    groupMemory.set(g, el);
    g = g.parentElement ? groupOf(g.parentElement) : null;
  }
}

/** Focuses an element (and scrolls it into view). */
export function focus(el, { scroll = true } = {}) {
  if (!el) return false;
  try {
    el.focus({ preventScroll: true });
  } catch {
    el.focus();
  }
  remember(el);
  if (scroll) scrollIntoView(el);
  bus.emit('focus', el);
  return document.activeElement === el;
}

function scrollIntoView(el) {
  try {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: perf.scrollBehavior() });
  } catch {
    el.scrollIntoView(false);
  }
}

export function current() {
  const a = document.activeElement;
  if (a && a !== document.body && topScope().contains(a) && a.matches(SELECTOR)) return a;
  return null;
}

/** Focuses `data-focus-default`, the remembered element of a group, or the first focusable in the container. */
export function focusFirst(container = topScope()) {
  const items = focusables(container);
  if (!items.length) return false;
  const remembered = groupMemory.get(container);
  if (remembered && items.includes(remembered)) return focus(remembered);
  const def = items.find((el) => el.hasAttribute('data-focus-default'));
  return focus(def || items[0]);
}

function center(r) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * Geometry of a candidate relative to the focused rect in a direction:
 * { primary: distance along the direction, overlap: shared span across it, offset: centre distance across }
 * or null when the candidate doesn't lie in that direction.
 */
function measure(a, b, dir) {
  const ac = center(a);
  const bc = center(b);
  const T = 2;
  switch (dir) {
    case 'right':
      if (!(b.left >= a.right - T || (bc.x > ac.x + T && b.right > a.right + T))) return null;
      return { primary: Math.max(0, b.left - a.right), overlap: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top), offset: Math.abs(bc.y - ac.y) };
    case 'left':
      if (!(b.right <= a.left + T || (bc.x < ac.x - T && b.left < a.left - T))) return null;
      return { primary: Math.max(0, a.left - b.right), overlap: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top), offset: Math.abs(bc.y - ac.y) };
    case 'down':
      if (!(b.top >= a.bottom - T || (bc.y > ac.y + T && b.bottom > a.bottom + T))) return null;
      return { primary: Math.max(0, b.top - a.bottom), overlap: Math.min(a.right, b.right) - Math.max(a.left, b.left), offset: Math.abs(bc.x - ac.x) };
    default:
      if (!(b.bottom <= a.top + T || (bc.y < ac.y - T && b.top < a.top - T))) return null;
      return { primary: Math.max(0, a.top - b.bottom), overlap: Math.min(a.right, b.right) - Math.max(a.left, b.left), offset: Math.abs(bc.x - ac.x) };
  }
}

function crossDistance(m) {
  return (m.overlap > 0 ? 0 : -m.overlap) + m.offset * 0.1;
}

/**
 * Picks the target:
 *  ▲▼  – the nearest "row" in that direction (band of candidates about as near as the nearest one), inside the
 *        same region (content / nav), then the element closest across – so Down from the header lands on the
 *        chip row below it, not on a card further down that happens to be aligned.
 *  ◀▶  – only elements sharing the row (vertical overlap), or any element of another region (content → nav rail).
 *        At the end of a row nothing happens, instead of jumping into another row.
 */
function pick(from, items, dir) {
  const fr = from.getBoundingClientRect();
  const vertical = dir === 'up' || dir === 'down';
  const region = from.closest('[data-focus-region]');
  const list = [];
  for (const el of items) {
    if (el === from) continue;
    const r = el.getBoundingClientRect();
    const m = measure(fr, r, dir);
    if (!m) continue;
    const sameRegion = el.closest('[data-focus-region]') === region;
    if (vertical && !sameRegion) continue;
    if (!vertical && sameRegion && m.overlap <= 0) continue;
    list.push({ el, m });
  }
  if (!list.length) return null;
  let minPrimary = Infinity;
  for (const c of list) minPrimary = Math.min(minPrimary, c.m.primary);
  const tolerance = Math.max(16, (vertical ? fr.height : fr.width) * 0.6);
  let best = null;
  let bestScore = Infinity;
  for (const c of list) {
    if (c.m.primary > minPrimary + tolerance) continue;
    const score = crossDistance(c.m) * 2 + c.m.primary;
    if (score < bestScore) {
      bestScore = score;
      best = c.el;
    }
  }
  return best;
}

/** Moves the focus in a direction; returns true when it moved. */
export function move(dir) {
  const scope = topScope();
  const from = current();
  const items = focusables(scope);
  if (!items.length) return false;
  if (!from) return focusFirst(scope);

  // Explicit overrides: data-focus-left="#id" or "none".
  const override = from.getAttribute('data-focus-' + dir);
  if (override === 'none') return false;
  if (override) {
    const t = scope.querySelector(override);
    if (t && isVisible(t)) return focus(t);
  }

  let best = pick(from, items, dir);
  if (!best) {
    bus.emit('focus:edge', { dir, from });
    return false;
  }
  // Entering another group: go to the element remembered there, if it lies in that direction too.
  const g = groupOf(best);
  if (g && g !== groupOf(from) && !g.contains(from)) {
    const mem = groupMemory.get(g);
    if (mem && mem !== best && items.includes(mem) && measure(from.getBoundingClientRect(), mem.getBoundingClientRect(), dir)) best = mem;
  }
  return focus(best);
}

/**
 * Re-renders a container without losing the remote's position: remembers the index of the focused element
 * among the container's focusables and focuses the same index afterwards.
 */
export async function preserveFocus(container, render) {
  const active = document.activeElement;
  const before = container.contains(active) ? Array.from(container.querySelectorAll(SELECTOR)).indexOf(active) : -1;
  await render();
  if (before < 0 || container.contains(document.activeElement)) return;
  const items = Array.from(container.querySelectorAll(SELECTOR)).filter(isVisible);
  if (items.length) focus(items[Math.min(before, items.length - 1)], { scroll: false });
}

/** Pushes a focus scope (dialog, player). Returns pop(). */
export function pushScope(el, { onBack, autofocus = true } = {}) {
  const prev = document.activeElement;
  const entry = { el, onBack, restore: prev };
  scopes.push(entry);
  if (autofocus) requestAnimationFrame(() => focusFirst(el));
  return function pop() {
    const i = scopes.indexOf(entry);
    if (i < 0) return;
    scopes.splice(i, 1);
    if (i === scopes.length && entry.restore && entry.restore.isConnected && isVisible(entry.restore)) {
      focus(entry.restore, { scroll: false });
    } else if (inputMode.isTV()) {
      focusFirst(topScope());
    }
  };
}

function isTextInput(el) {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  if (el.tagName !== 'INPUT') return false;
  return !['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset', 'color'].includes(el.type);
}

// ---- OK / long press ----
let enterTarget = null;
let enterDown = 0;
let longFired = false;
const LONG_MS = 550;
let longTimer = null;

function fireLongPress(el) {
  longFired = true;
  el.dispatchEvent(new CustomEvent('longpress', { bubbles: true }));
}

function onKeyDown(e) {
  const active = document.activeElement;
  const typing = isTextInput(active);

  // Back
  if (is(e, KEY.BACK) || (is(e, KEY.BACKSPACE) && !typing)) {
    if (typing && is(e, [27, 'Escape'])) {
      active.blur();
      if (active.matches(SELECTOR)) focus(active);
      e.preventDefault();
      return;
    }
    e.preventDefault();
    handleBack();
    return;
  }

  // Remote / media keys
  const remote = REMOTE[e.keyCode] || REMOTE_BY_KEY[e.key];
  if (remote && !(typing && (e.key === 'PageUp' || e.key === 'PageDown'))) {
    e.preventDefault();
    bus.emit('remote', { key: remote, event: e });
    return;
  }

  const dir = is(e, KEY.LEFT) ? 'left' : is(e, KEY.RIGHT) ? 'right' : is(e, KEY.UP) ? 'up' : is(e, KEY.DOWN) ? 'down' : null;
  if (dir) {
    if (typing) {
      // Inside a text field left/right move the caret; leave the field only at its ends.
      if (dir === 'left' || dir === 'right') {
        const len = (active.value || '').length;
        const atStart = active.selectionStart === 0 && active.selectionEnd === 0;
        const atEnd = active.selectionStart === len;
        if ((dir === 'left' && !atStart) || (dir === 'right' && !atEnd)) return;
      }
      if (active.tagName === 'TEXTAREA' && (dir === 'up' || dir === 'down')) return;
    }
    // Let the active element handle it first (e.g. sliders, the player's seek bar).
    const handled = !active || active === document.body ? false : !active.dispatchEvent(new CustomEvent('navkey', { detail: { dir }, cancelable: true, bubbles: true }));
    e.preventDefault();
    if (handled) return;
    if (!current() && bus) bus.emit('navkey:unfocused', dir);
    move(dir);
    return;
  }

  if (is(e, KEY.ENTER)) {
    if (typing) return; // submit / IME
    const el = current();
    if (!el) {
      e.preventDefault();
      focusFirst();
      return;
    }
    e.preventDefault();
    if (!el.hasAttribute('data-longpress')) {
      // No context menu: act immediately on key down (snappier on slow remotes, no keyup needed).
      if (!e.repeat) el.click();
      enterTarget = null;
      return;
    }
    if (!e.repeat) {
      enterTarget = el;
      enterDown = Date.now();
      longFired = false;
      clearTimeout(longTimer);
      if (el.hasAttribute('data-longpress')) {
        longTimer = setTimeout(() => {
          if (enterTarget === el && !longFired) fireLongPress(el);
        }, LONG_MS);
      }
    } else if (enterTarget === el && !longFired && el.hasAttribute('data-longpress') && Date.now() - enterDown > LONG_MS) {
      fireLongPress(el);
    }
    return;
  }

  if (is(e, KEY.MENU)) {
    const el = current();
    if (el && el.hasAttribute('data-longpress')) {
      e.preventDefault();
      fireLongPress(el);
    } else {
      bus.emit('remote', { key: 'menu', event: e });
    }
  }
}

function onKeyUp(e) {
  if (!is(e, KEY.ENTER)) return;
  clearTimeout(longTimer);
  const el = enterTarget;
  enterTarget = null;
  if (!el || longFired) {
    longFired = false;
    return;
  }
  if (isTextInput(el)) {
    // OK on a text field opens the keyboard of the TV / phone.
    el.focus();
    if (el.select) el.select();
    return;
  }
  if (el.isConnected) {
    e.preventDefault();
    el.click();
  }
}

export function handleBack() {
  const s = scopes[scopes.length - 1];
  if (s && s.onBack) {
    if (s.onBack() === false) return;
    return;
  }
  routerBack();
}

/** Long press with finger / mouse for elements with data-longpress (context menus). */
function installPointerLongPress() {
  let timer = null;
  let target = null;
  let startX = 0;
  let startY = 0;
  let fired = false;
  document.addEventListener(
    'pointerdown',
    (e) => {
      const el = e.target.closest && e.target.closest('[data-longpress]');
      if (!el || e.button > 0) return;
      target = el;
      fired = false;
      startX = e.clientX;
      startY = e.clientY;
      clearTimeout(timer);
      timer = setTimeout(() => {
        fired = true;
        if (navigator.vibrate) navigator.vibrate(12);
        target.dispatchEvent(new CustomEvent('longpress', { bubbles: true }));
      }, LONG_MS);
    },
    { passive: true },
  );
  const cancel = () => clearTimeout(timer);
  document.addEventListener('pointerup', cancel, { passive: true });
  document.addEventListener('pointercancel', cancel, { passive: true });
  document.addEventListener(
    'pointermove',
    (e) => {
      if (target && (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10)) cancel();
    },
    { passive: true },
  );
  // Swallow the click that follows a long press.
  document.addEventListener(
    'click',
    (e) => {
      if (fired && target && target.contains(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        fired = false;
      }
    },
    true,
  );
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest && e.target.closest('[data-longpress]')) e.preventDefault();
  });
}

export function initFocus(root) {
  rootEl = root;
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  installPointerLongPress();
  // LG Magic Remote / mouse in TV mode: hovering focuses.
  document.addEventListener(
    'mouseover',
    (e) => {
      if (!inputMode.isTV()) return;
      const el = e.target.closest && e.target.closest(SELECTOR);
      if (el && topScope().contains(el) && document.activeElement !== el) focus(el, { scroll: false });
    },
    { passive: true },
  );
  document.addEventListener('focusin', (e) => {
    if (e.target && e.target.matches && e.target.matches(SELECTOR)) remember(e.target);
  });
  // After every view change (TV mode): focus the first element of the new view.
  bus.on('route:mounted', ({ el }) => {
    if (!inputMode.isTV() || scopes.length) return;
    requestAnimationFrame(() => {
      if (!current() || !el.contains(document.activeElement)) focusFirst(el);
    });
  });
  bus.on('inputmode', ({ mode }) => {
    if (mode === 'tv' && !current()) focusFirst();
  });
}
