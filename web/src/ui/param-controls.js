// Controls generated from a schema definition, bound to a parameter address.
import { h } from './h.js';
import { Knob } from './knob.js';
import { format } from '../core/schema.js';

// choice -> <select>, bool -> toggle button, number -> labelled knob
export function paramControl(app, addr, def, opts = {}) {
  const store = app.store;
  if (def.options) {
    const sel = h('select.select', { hint: `${def.name}`, onchange: () => store.setParam(addr, +sel.value) },
      def.options.map((o, i) => h('option', { value: i }, o)));
    const sync = (v) => { sel.value = String(Math.round(v)); };
    sync(store.getParam(addr) ?? def.def);
    store.bus.on('param', (a, v) => { if (a === addr && sel.isConnected) sync(v); });
    store.bus.on('project', () => { if (sel.isConnected) sync(store.getParam(addr) ?? def.def); });
    return h('div.tb-col', h('div.knob-label', def.name), sel);
  }
  if (def.bool) {
    const b = h('div.btn', { hint: def.name, onclick: () => store.setParam(addr, store.getParam(addr) ? 0 : 1) }, opts.label || def.name);
    const sync = (v) => b.classList.toggle('on', !!v);
    sync(store.getParam(addr) ?? def.def);
    store.bus.on('param', (a, v) => { if (a === addr && b.isConnected) sync(v); });
    store.bus.on('project', () => { if (b.isConnected) sync(store.getParam(addr) ?? def.def); });
    return b;
  }
  const k = new Knob(app, { addr, label: opts.label || def.name, size: opts.size || '', title: def.name });
  const val = h('div.knob-label', { style: { color: 'var(--accent)' } }, format(def, store.getParam(addr) ?? def.def));
  const upd = () => { val.textContent = format(def, store.getParam(addr) ?? def.def); };
  store.bus.on('param', (a) => { if (a === addr && val.isConnected) upd(); });
  store.bus.on('project', () => { if (val.isConnected) upd(); });
  k.root.append(val);
  return k.root;
}

// A panel of controls for the given defs (optionally filtered by group), laid out in a wrapping grid.
export function paramGrid(app, addrOf, defs, opts = {}) {
  return h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px 14px', padding: '10px', alignContent: 'flex-start' } },
    defs.map((d) => paramControl(app, addrOf(d.id), d, opts)));
}
