/** Cards and rows shared by the views. */
import { h, icon, img } from '../core/dom.js';
import { perf } from '../core/performance.js';

/** Horizontal row with a title; children are cards. */
export function row(title, cards, { more } = {}) {
  if (!cards || !cards.length) return null;
  return h(
    'section.row',
    h('div.row-head', h('h2.row-title', title), more ? h('button.link-btn', { type: 'button', data: { focus: true }, onClick: more.onClick }, more.label, icon('next')) : null),
    h('div.row-scroller', { data: { focusGroup: true } }, cards),
  );
}

/** 2:3 poster card (films, series). */
export function posterCard({ title, subtitle, image, progress, badge, onClick, onLongPress, wide = false }) {
  const el = h(
    'button.card.poster' + (wide ? '.wide' : ''),
    { type: 'button', data: { focus: true, longpress: onLongPress ? true : undefined }, onClick, title },
    h('div.card-media', img(image, title, 'cover', title), badge ? h('span.card-badge', badge) : null, progress ? h('div.card-progress', h('span', { style: { width: Math.round(progress * 100) + '%' } })) : null),
    h('div.card-text', h('div.card-title', title), subtitle ? h('div.card-sub', subtitle) : null),
  );
  if (onLongPress) el.addEventListener('longpress', onLongPress);
  return el;
}

/** Channel tile (logo + name) for the grid, or a compact list row. */
export function channelCard(ch, { onClick, onLongPress, favorite, list = false }) {
  const el = h(
    'button.card.channel' + (list ? '.as-list' : ''),
    { type: 'button', data: { focus: true, longpress: true }, onClick, title: ch.name },
    h('span.ch-num', String(ch.number || '')),
    h('div.ch-logo', img(ch.logo, ch.name, 'logo', ch.name)),
    h('div.ch-text', h('div.ch-name', ch.name), list ? h('div.ch-group', ch.group || '') : null),
    favorite ? h('span.ch-fav', icon('star')) : null,
  );
  if (onLongPress) el.addEventListener('longpress', onLongPress);
  return el;
}

/** Simple action card (setup hints on HOME). */
export function actionCard({ iconName, title, text, onClick }) {
  return h('button.card.action', { type: 'button', data: { focus: true }, onClick }, h('div.action-icon', icon(iconName)), h('div.card-title', title), text ? h('div.card-sub', text) : null);
}

export function emptyState({ iconName = 'info', title, text, actions = [] }) {
  return h('div.empty', h('div.empty-icon', icon(iconName)), h('h2', title), text ? h('p', text) : null, actions.length ? h('div.empty-actions', { data: { focusGroup: true } }, actions) : null);
}

export function loading(text = 'Lädt …') {
  return h('div.loading', h('div.spinner'), h('span', text));
}

/**
 * Renders a long list in batches (no layout of thousands of nodes at once – important on TV sticks).
 * More items are appended when the sentinel scrolls into view or the focus reaches the end.
 */
export function batchedList(container, items, renderItem, { batch = perf.batch() } = {}) {
  let index = 0;
  const sentinel = h('div.sentinel');
  const appendMore = () => {
    if (index >= items.length) return;
    const frag = document.createDocumentFragment();
    const end = Math.min(items.length, index + batch);
    for (; index < end; index++) frag.appendChild(renderItem(items[index], index));
    container.insertBefore(frag, sentinel);
    if (index >= items.length) sentinel.remove();
  };
  container.replaceChildren(sentinel);
  appendMore();
  let io = null;
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) appendMore();
    }, { rootMargin: '600px' });
    io.observe(sentinel);
  }
  const onFocus = (e) => {
    const kids = container.children;
    const pos = Array.prototype.indexOf.call(kids, e.target.closest('.card'));
    if (pos > kids.length - batch / 3) appendMore();
  };
  container.addEventListener('focusin', onFocus);
  return {
    destroy() {
      if (io) io.disconnect();
      container.removeEventListener('focusin', onFocus);
    },
    appendMore,
  };
}
