/**
 * Hash router + overlay history.
 *
 * Every view change and every overlay (player, dialogs) is a history entry, so the hardware Back of Android TV,
 * the browser Back button, the Escape key and the remote's Back key (Tizen 10009, webOS 461) all behave the same:
 * the topmost overlay closes first, then the previous view comes back.
 *
 * history.state = { d: depth, ov: [overlay ids] }
 */
import { bus } from './events.js';

const routes = [];
let current = null; // { path, view, params, el }
let outlet = null;
let renderedPath = null;
const overlays = []; // { id, close }
let ignorePop = 0;
let fallback = '/home';
const settledQueue = [];

/** Runs fn once pending history.back() calls have landed (pushState before them would be undone). */
function whenSettled(fn) {
  if (ignorePop > 0) settledQueue.push(fn);
  else fn();
}

export function defineRoute(pattern, factory) {
  const keys = [];
  const re = new RegExp(
    '^' +
      pattern.replace(/\/:([A-Za-z]+)(\?)?/g, (_, k, opt) => {
        keys.push(k);
        return opt ? '(?:/([^/]+))?' : '/([^/]+)';
      }) +
      '/?$',
  );
  routes.push({ pattern, re, keys, factory });
}

function parse(hash) {
  const raw = (hash || '').replace(/^#/, '') || fallback;
  const [path, qs] = raw.split('?');
  const query = {};
  if (qs) for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
  return { path: path || fallback, query, raw };
}

function match(path) {
  for (const r of routes) {
    const m = r.re.exec(path);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => (params[k] = m[i + 1] ? decodeURIComponent(m[i + 1]) : undefined));
      return { route: r, params };
    }
  }
  return null;
}

function state() {
  return history.state && typeof history.state === 'object' ? history.state : { d: 0, ov: [] };
}

async function render() {
  const { path, query, raw } = parse(location.hash);
  if (raw === renderedPath) return;
  const m = match(path);
  if (!m) {
    navigate(fallback, { replace: true });
    return;
  }
  renderedPath = raw;
  if (current && current.view && current.view.unmount) {
    try {
      current.view.unmount();
    } catch (e) {
      console.error(e);
    }
  }
  const el = document.createElement('section');
  el.className = 'view view-' + m.route.pattern.split('/')[1];
  outlet.replaceChildren(el);
  outlet.scrollTop = 0;
  const ctx = { params: m.params, query, path };
  current = { path, el, params: m.params, view: null };
  bus.emit('route', { path, params: m.params, query });
  try {
    const view = await m.route.factory(el, ctx);
    if (current && current.el === el) current.view = view || null;
  } catch (e) {
    console.error('[router]', e);
    el.textContent = 'Fehler beim Laden der Ansicht: ' + e.message;
  }
  bus.emit('route:mounted', { path, el });
}

export const router = {
  start(outletEl, defaultPath) {
    outlet = outletEl;
    fallback = defaultPath || '/home';
    // A reload keeps the overlay ids in the state, but the overlays are gone: clean up.
    const s = state();
    history.replaceState({ d: s.d || 0, ov: [] }, '', location.hash || '#' + fallback);
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', () => render());
    render();
  },
  get path() {
    return current ? current.path : null;
  },
  get atRoot() {
    return state().d === 0;
  },
  refresh() {
    renderedPath = null;
    render();
  },
};

export function navigate(path, { replace = false } = {}) {
  if (ignorePop > 0) {
    settledQueue.push(() => navigate(path, { replace }));
    return;
  }
  const s = state();
  const target = '#' + path;
  if (location.hash === target && !replace) return;
  if (replace) history.replaceState({ d: s.d, ov: [] }, '', target);
  else history.pushState({ d: (s.d || 0) + 1, ov: [] }, '', target);
  render();
}

/** One step back: closes the top overlay or returns to the previous view; at the start view → false. */
export function back() {
  const s = state();
  if (overlays.length) {
    if ((s.ov || []).length) history.back();
    else closeTopOverlayDirect();
    return true;
  }
  if (s.d > 0) {
    history.back();
    return true;
  }
  const { path } = parse(location.hash);
  if (path !== fallback) {
    navigate(fallback, { replace: true });
    return true;
  }
  bus.emit('back:root');
  return false;
}

function onPop() {
  if (ignorePop > 0) {
    ignorePop--;
    if (ignorePop === 0) {
      while (settledQueue.length) settledQueue.shift()();
    }
    return;
  }
  const s = state();
  const keep = new Set(s.ov || []);
  // Close overlays that are no longer in the history state (topmost first).
  for (let i = overlays.length - 1; i >= 0; i--) {
    if (!keep.has(overlays[i].id)) {
      const o = overlays.splice(i, 1)[0];
      try {
        o.close('history');
      } catch (e) {
        console.error(e);
      }
    }
  }
  render();
}

function closeTopOverlayDirect() {
  const o = overlays.pop();
  if (o) o.close('direct');
}

/**
 * Registers an overlay; returns `dismiss()` to close it from the UI (keeps history in sync).
 * close(reason) is called exactly once, by Back or by dismiss().
 */
export function openOverlay(id, close) {
  const entry = { id: id + ':' + Math.random().toString(36).slice(2, 7), close };
  overlays.push(entry);
  whenSettled(() => {
    if (!overlays.includes(entry)) return;
    const st = state();
    history.pushState({ d: (st.d || 0) + 1, ov: (st.ov || []).concat(entry.id) }, '', location.hash);
  });
  let done = false;
  return function dismiss() {
    if (done) return;
    done = true;
    const idx = overlays.indexOf(entry);
    if (idx < 0) return; // already closed by history
    overlays.splice(idx, 1);
    const st = state();
    if ((st.ov || []).includes(entry.id)) {
      ignorePop++;
      history.back();
    }
    close('dismiss');
  };
}

export function hasOverlay() {
  return overlays.length > 0;
}
