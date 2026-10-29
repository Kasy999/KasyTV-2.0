/**
 * Settings controls bound to store paths. Every control is a single focusable button-like row, so it works
 * the same with finger, mouse and remote (no native <select>/<input type=range>, which TVs render badly).
 */
import { h, icon } from '../core/dom.js';
import { store } from '../core/store.js';
import { pickOption, promptDialog } from './dialog.js';

function row(label, desc, control, opts = {}) {
  return h(
    'div.set-row' + (opts.block ? '.block' : ''),
    h('div.set-text', h('div.set-label', label), desc ? h('div.set-desc', desc) : null),
    h('div.set-control', control),
  );
}

/** On/off switch. */
export function toggleRow(label, desc, path, { onChange } = {}) {
  const btn = h('button.switch', { type: 'button', role: 'switch', data: { focus: true }, 'aria-label': label });
  const sync = () => {
    const on = !!store.get(path);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-checked', String(on));
  };
  btn.addEventListener('click', () => {
    store.set(path, !store.get(path));
    sync();
    if (onChange) onChange(store.get(path));
  });
  sync();
  const r = row(label, desc, btn);
  r.classList.add('clickable');
  return r;
}

/** Value from a list – opens a picker dialog. options: [{ value, label, description }] */
export function selectRow(label, desc, path, options, { onChange } = {}) {
  const value = h('span.select-value');
  const btn = h('button.select-btn', { type: 'button', data: { focus: true } }, value, icon('next'));
  const sync = () => {
    const cur = store.get(path);
    const o = options.find((x) => x.value === cur);
    value.textContent = o ? o.label : String(cur);
  };
  btn.addEventListener('click', async () => {
    const v = await pickOption(label, options, store.get(path));
    if (v !== undefined) {
      store.set(path, v);
      sync();
      if (onChange) onChange(v);
    }
  });
  sync();
  return row(label, desc, btn);
}

/** Number with − / + buttons. */
export function stepperRow(label, desc, path, { min, max, step = 1, format = (v) => String(v), onChange } = {}) {
  const value = h('span.stepper-value');
  const set = (v) => {
    v = Math.min(max, Math.max(min, Math.round(v / step) * step));
    v = parseFloat(v.toFixed(4));
    store.set(path, v);
    sync();
    if (onChange) onChange(v);
  };
  const minus = h('button.icon-btn.small', { type: 'button', data: { focus: true }, 'aria-label': 'Weniger', onClick: () => set(store.get(path) - step) }, icon('back'));
  const plus = h('button.icon-btn.small', { type: 'button', data: { focus: true }, 'aria-label': 'Mehr', onClick: () => set(store.get(path) + step) }, icon('next'));
  const sync = () => (value.textContent = format(store.get(path)));
  sync();
  return row(label, desc, h('div.stepper', minus, value, plus));
}

/** Colour swatches (+ free hex entry). */
export function colorRow(label, desc, path, palette, { onChange } = {}) {
  const wrap = h('div.swatches', { data: { focusGroup: true } });
  const render = () => {
    wrap.replaceChildren();
    const cur = (store.get(path) || '').toUpperCase();
    for (const c of palette) {
      wrap.appendChild(
        h('button.swatch' + (c.toUpperCase() === cur ? '.active' : ''), {
          type: 'button',
          data: { focus: true },
          style: { background: c },
          'aria-label': c,
          title: c,
          onClick: () => {
            store.set(path, c);
            render();
            if (onChange) onChange(c);
          },
        }),
      );
    }
    wrap.appendChild(
      h('button.swatch.custom', {
        type: 'button',
        data: { focus: true },
        'aria-label': 'Eigene Farbe',
        title: 'Eigene Farbe (Hex)',
        onClick: async () => {
          const v = await promptDialog('Eigene Farbe', { label: 'Hex-Farbwert', value: store.get(path), placeholder: '#RRGGBB' });
          if (v && /^#?[0-9a-f]{6}$/i.test(v.trim())) {
            store.set(path, '#' + v.trim().replace('#', '').toUpperCase());
            render();
            if (onChange) onChange(store.get(path));
          }
        },
      }, '#'),
    );
  };
  render();
  return row(label, desc, wrap, { block: true });
}

/** Free text (opens an input dialog – friendlier on TV keyboards). */
export function textRow(label, desc, path, { placeholder = '', type = 'text', mask = false, onChange, hint } = {}) {
  const value = h('span.select-value');
  const sync = () => {
    const v = store.get(path) || '';
    value.textContent = v ? (mask ? '••••••' : v) : placeholder || '—';
    value.classList.toggle('muted', !v);
  };
  const btn = h('button.select-btn.text', { type: 'button', data: { focus: true } }, value, icon('next'));
  btn.addEventListener('click', async () => {
    const v = await promptDialog(label, { value: store.get(path) || '', placeholder, type, hint });
    if (v !== null) {
      store.set(path, v.trim());
      sync();
      if (onChange) onChange(v.trim());
    }
  });
  sync();
  return row(label, desc, btn);
}

export function actionRow(label, desc, buttonLabel, onClick, { variant = 'ghost', iconName } = {}) {
  const b = h('button.btn.' + variant, { type: 'button', data: { focus: true }, onClick }, iconName ? icon(iconName) : null, h('span.btn-label', buttonLabel));
  return row(label, desc, b);
}

export function infoRow(label, valueText) {
  return row(label, null, h('span.info-value', valueText));
}

export function section(title, ...children) {
  return h('section.set-section', { data: { focusGroup: true } }, title ? h('h3.set-title', title) : null, ...children);
}
