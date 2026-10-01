// Generic instrument editor generated from the instrument schema (tabs = schema groups).
// Instruments with a dedicated editor register it in app.editors[type] and override this.
import { h, clear } from './h.js';
import { paramControl, paramGrid } from './param-controls.js';
import { instrumentSchema, instrumentMeta } from '../core/instruments/index.js';
import { Knob } from './knob.js';
import { showPopup } from './menu.js';
import { instrumentPresetItems } from './presets-ui.js';

export function openChannelEditor(app, chId) {
  const store = app.store;
  const ch = store.channel(chId);
  if (!ch) return null;
  const id = `plugin:${chId}`;
  if (ch.type === 'automation') return app.openAutomationEditor ? app.openAutomationEditor(chId) : null;
  if (app.wm.isOpen(id)) { app.wm.focus(id); return app.wm.get(id); }
  const custom = app.editors[ch.type];
  const meta = instrumentMeta(ch.type);
  const spec = {
    title: ch.name, dynamic: true,
    rect: { x: 180, y: 70, ...(custom && custom.rect ? custom.rect : { w: 520, h: 360 }) },
    minW: 320, minH: 180,
    create: (win) => (custom ? custom(win, app, chId) : genericEditor(win, app, chId)),
  };
  void meta;
  return app.wm.open(id, spec);
}

export function genericEditor(win, app, chId) {
  const store = app.store;
  const ch0 = store.channel(chId);
  const schema = instrumentSchema(ch0.type) || [];
  const meta = instrumentMeta(ch0.type) || { name: ch0.type, tabs: [] };
  win.setTitle(ch0.name, meta.name);
  const groups = [];
  for (const d of schema) { const g = d.group || 'Main'; if (!groups.includes(g)) groups.push(g); }
  let tab = groups[0];
  const tabsEl = h('div.rack-groups');
  const body = h('div.scroll', { style: { flex: 1, minHeight: 0 } });
  const head = h('div.rack-head');

  const sampleName = h('span', { style: { color: 'var(--accent)' } }, '');
  const render = () => {
    clear(tabsEl);
    for (const g of groups) tabsEl.append(h('div.rack-tab', { class: g === tab ? 'on' : '', onclick: () => { tab = g; render(); } }, g));
    clear(body);
    const defs = schema.filter((d) => (d.group || 'Main') === tab);
    // schema-ordered; enumerations and toggles first so they read like a header row
    body.append(paramGrid(app, (id) => `ch:${chId}:p:${id}`, defs));
  };

  const ch = () => store.channel(chId);
  const refreshHead = () => {
    const c = ch();
    if (!c) return;
    sampleName.textContent = c.sample ? c.sample.name : '(no sample)';
    win.setTitle(c.name, meta.name);
  };
  head.append(
    new Knob(app, { addr: `ch:${chId}:vol`, size: 'sm', title: 'Channel volume' }).el,
    new Knob(app, { addr: `ch:${chId}:pan`, size: 'sm', title: 'Channel panning' }).el,
    new Knob(app, { addr: `ch:${chId}:pitch`, size: 'sm', title: 'Channel pitch' }).el);
  if (ch0.type === 'sampler') {
    head.append(sampleName, h('div.btn', { hint: 'Load sample — pick an audio file from disk', onclick: () => app.pickSampleFor(chId) }, 'Load sample…'));
  }
  head.append(h('div.grow'),
    h('div.btn', { hint: 'Presets — factory and your own saved settings for this plugin', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showPopup(instrumentPresetItems(app, chId), r.left, r.bottom, r); } }, 'Presets ▾'),
    h('div.btn', { hint: 'Preview — plays the channel at its root key', onclick: () => app.preview(chId) }, '▶ Preview'));
  if (groups.length > 1) render(); else render();
  refreshHead();
  const off1 = store.bus.on('change', ({ paths }) => { if (paths.some((p) => p[0] === 'channels')) refreshHead(); });
  const off2 = store.bus.on('project', () => { if (!store.channel(chId)) win.close(); else refreshHead(); });
  const el = h('div.rack', head, groups.length > 1 ? tabsEl : null, body);
  return { el, destroy() { off1(); off2(); } };
}
