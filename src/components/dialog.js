/**
 * Modal dialogs that work with finger and remote: each dialog is a focus scope and a history entry,
 * so Back (remote, Escape, Android back) closes it.
 */
import { h, button, icon } from '../core/dom.js';
import { pushScope, focus } from '../core/focus.js';
import { openOverlay } from '../core/router.js';

let root = null;

export function initDialogs(el) {
  root = el;
}

/**
 * dialog({ title, body, actions: [{ label, primary, danger, value, onClick }], wide, onClose })
 * Resolves with the action's value (or undefined when dismissed).
 */
export function dialog({ title, body, actions = [], wide = false, className = '', onClose } = {}) {
  return new Promise((resolve) => {
    let popScope = null;
    let result;
    const close = () => {
      if (popScope) popScope();
      backdrop.classList.remove('show');
      setTimeout(() => backdrop.remove(), 180);
      if (onClose) onClose(result);
      resolve(result);
    };
    const dismiss = openOverlay('dialog', close);
    const finish = (value) => {
      result = value;
      dismiss();
    };

    const actionEls = actions.map((a) =>
      button(a.label, async () => {
        if (a.onClick) {
          const r = await a.onClick();
          if (r === false) return; // keep open
          finish(r !== undefined ? r : a.value);
        } else finish(a.value);
      }, { variant: a.primary ? 'primary' : a.danger ? 'danger' : 'ghost', icon: a.icon, default: a.primary }),
    );

    const panel = h(
      'div.dialog' + (wide ? '.wide' : '') + (className ? '.' + className : ''),
      { role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' },
      h(
        'header.dialog-head',
        h('h2', title || ''),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Schließen', data: { focus: true }, onClick: () => finish(undefined) }, icon('close')),
      ),
      h('div.dialog-body', body || null),
      actionEls.length ? h('footer.dialog-actions', actionEls) : null,
    );
    const backdrop = h('div.dialog-backdrop', {
      onClick: (e) => {
        if (e.target === backdrop) finish(undefined);
      },
    }, panel);
    root.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('show'));
    popScope = pushScope(panel, { autofocus: false });
    // Focus: explicit default → first element of the body → first action → close button.
    requestAnimationFrame(() => {
      const target =
        panel.querySelector('[data-focus-default]') ||
        panel.querySelector('.dialog-body [data-focus]') ||
        panel.querySelector('.dialog-actions [data-focus]') ||
        panel.querySelector('[data-focus]');
      if (target) focus(target);
    });
    panel.__finish = finish;
  });
}

export function confirmDialog(title, message, { okLabel = 'OK', danger = false } = {}) {
  return dialog({
    title,
    body: h('p.dialog-text', message),
    actions: [
      { label: 'Abbrechen', value: false },
      { label: okLabel, value: true, primary: !danger, danger },
    ],
  }).then((v) => v === true);
}

export function alertDialog(title, message) {
  return dialog({ title, body: h('p.dialog-text', message), actions: [{ label: 'OK', value: true, primary: true }] });
}

/** Text input dialog. Resolves with the string or null. */
export function promptDialog(title, { label = '', value = '', placeholder = '', type = 'text', hint = '' } = {}) {
  const input = h('input.input', { type, value, placeholder, data: { focus: true, focusDefault: true }, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const body = h('div.form', label ? h('label.field-label', label) : null, input, hint ? h('p.hint', hint) : null);
  const p = dialog({
    title,
    body,
    actions: [
      { label: 'Abbrechen', value: null },
      { label: 'Übernehmen', primary: true, onClick: () => input.value },
    ],
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const panel = input.closest('.dialog');
      if (panel && panel.__finish) panel.__finish(input.value);
    }
  });
  return p.then((v) => (v === undefined ? null : v));
}

/**
 * Option list (replaces <select>, which is awkward on TVs). options: [{ value, label, description }]
 * Resolves with the chosen value or undefined.
 */
export function pickOption(title, options, selected) {
  let finishRef = null;
  const list = h(
    'div.option-list',
    { data: { focusGroup: true } },
    options.map((o) =>
      h(
        'button.option' + (o.value === selected ? '.selected' : ''),
        {
          type: 'button',
          data: { focus: true, focusDefault: o.value === selected || undefined },
          onClick: () => finishRef && finishRef(o.value),
        },
        h('span.option-check', o.value === selected ? icon('check') : null),
        h('span.option-text', h('span.option-label', o.label), o.description ? h('span.option-desc', o.description) : null),
      ),
    ),
  );
  const p = dialog({ title, body: list, className: 'picker' });
  const panel = list.closest('.dialog');
  if (panel) finishRef = panel.__finish;
  return p;
}
