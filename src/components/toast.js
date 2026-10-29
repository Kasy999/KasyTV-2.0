import { h, icon } from '../core/dom.js';

let root = null;

export function initToasts(el) {
  root = el;
}

/** Short notice at the bottom; kind: info | success | warn | error. */
export function toast(message, { kind = 'info', duration = 3200, iconName } = {}) {
  if (!root) return;
  const icons = { info: 'info', success: 'check', warn: 'info', error: 'close' };
  const el = h('div.toast.toast-' + kind, { role: 'status' }, icon(iconName || icons[kind] || 'info'), h('span', message));
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const remove = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  };
  setTimeout(remove, duration);
  while (root.children.length > 3) root.firstChild.remove();
  return remove;
}
