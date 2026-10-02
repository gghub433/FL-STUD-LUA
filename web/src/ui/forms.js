// Small form builder for tool dialogs: describe the fields, get a modal and the values back.
import { h } from './h.js';
import { modal } from './dialog.js';

// fields: [{ id, label, type: 'range'|'number'|'select'|'check'|'text', min, max, step, value, options: [[value,label]], unit, hint }]
// returns a promise of the values object, or null when cancelled.
export function formDialog(title, fields, { ok = 'Apply', width = 360, onChange, extra, scroll = false } = {}) {
  return new Promise((resolve) => {
    const inputs = {};
    const vals = () => {
      const o = {};
      for (const f of fields) {
        const el = inputs[f.id];
        if (f.type === 'check') o[f.id] = el.checked;
        else if (f.type === 'select') o[f.id] = f.options.find(([v]) => String(v) === el.value)[0];
        else if (f.type === 'text') o[f.id] = el.value;
        else o[f.id] = +el.value;
      }
      return o;
    };
    const rows = fields.map((f) => {
      let el;
      if (f.type === 'range') {
        const out = h('span.dim', { style: { width: '44px', textAlign: 'right' } }, '');
        el = h('input', { type: 'range', min: f.min, max: f.max, step: f.step ?? 1, value: f.value, style: { flex: 1, accentColor: 'var(--accent)' } });
        const show = () => { out.textContent = `${(+el.value).toFixed(f.step && f.step < 1 ? 2 : 0)}${f.unit || ''}`; };
        el.addEventListener('input', () => { show(); if (onChange) onChange(vals()); });
        show();
        inputs[f.id] = el;
        return h('div.row', { style: { margin: '5px 0' }, title: f.hint || '' }, h('span', { style: { width: '120px' } }, f.label), el, out);
      }
      if (f.type === 'select') {
        el = h('select.select', { style: { flex: 1 } }, f.options.map(([v, l]) => h('option', { value: String(v) }, l)));
        el.value = String(f.value);
        el.addEventListener('change', () => { if (onChange) onChange(vals()); });
      } else if (f.type === 'check') {
        el = h('input', { type: 'checkbox', checked: !!f.value });
        el.addEventListener('change', () => { if (onChange) onChange(vals()); });
      } else {
        el = h('input.field', { type: f.type === 'text' ? 'text' : 'number', min: f.min, max: f.max, step: f.step ?? 1, value: f.value, style: { width: f.type === 'text' ? '100%' : '90px' } });
        el.addEventListener('keydown', (e) => e.stopPropagation());
        el.addEventListener('change', () => { if (onChange) onChange(vals()); });
      }
      inputs[f.id] = el;
      return h('div.row', { style: { margin: '5px 0' }, title: f.hint || '' }, h('span', { style: { width: '120px' } }, f.label), el, f.unit && f.type !== 'range' ? h('span.dim', f.unit) : null);
    });
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    modal({
      title, width, body: [scroll ? h('div', { style: { maxHeight: '62vh', overflowY: 'auto', paddingRight: '6px' } }, rows) : rows, extra ? extra(inputs, vals) : null],
      buttons: [{ label: 'Cancel', fn: () => { finish(null); } }, { label: ok, primary: true, fn: () => { finish(vals()); } }],
      onClose: () => finish(null),
    });
  });
}
