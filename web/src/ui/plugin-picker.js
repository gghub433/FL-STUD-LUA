// Plugin picker: browse generators (instruments) and effects; double-click or Add to use them.
import { h, clear } from './h.js';
import { INSTRUMENTS } from '../core/instruments/index.js';
import { EFFECTS } from '../core/effects/index.js';

export function createPicker(win, app) {
  win.setTitle('Plugin picker');
  const list = h('div.scroll', { style: { flex: 1, padding: '6px' } });
  const info = h('div.dim', { style: { padding: '6px 8px', minHeight: '34px', borderTop: '1px solid var(--line)' } }, 'Select a plugin. Double-click to add: instruments go to the Channel rack, effects to the selected mixer track.');
  let selected = null;

  const render = () => {
    clear(list);
    const section = (title, items, kind) => {
      list.append(h('div.title', { style: { color: 'var(--accent)', padding: '6px 2px 2px', textTransform: 'uppercase', fontSize: '10px', letterSpacing: '.8px' } }, title));
      for (const [id, mod] of items) {
        const row = h('div.item', {
          class: selected && selected.id === id && selected.kind === kind ? 'sel' : '',
          style: { padding: '4px 8px', borderRadius: '3px', cursor: 'default', background: selected && selected.id === id && selected.kind === kind ? 'var(--bg3)' : '' },
          onclick: () => { selected = { id, kind }; info.textContent = mod.meta.description || mod.meta.name; render(); },
          ondblclick: () => add(id, kind),
          hint: `${mod.meta.name} — ${mod.meta.description || kind}`,
        }, mod.meta.name, h('span.dim', { style: { float: 'right' } }, (mod.meta.pack ? '◆ ' : '') + (kind === 'instrument' ? (mod.meta.kind || '') : (mod.meta.category || ''))));
        list.append(row);
      }
    };
    const own = ([id]) => id !== 'plugin';
    section('Generators', Object.entries(INSTRUMENTS).filter(own), 'instrument');
    section('Effects', Object.entries(EFFECTS).filter(own), 'effect');
    // installed VST3 / CLAP plugins (desktop app)
    const P = app.plugins;
    if (P && P.available) {
      for (const [title, kind] of [['Installed instruments (VST3 / CLAP)', 'instrument'], ['Installed effects (VST3 / CLAP)', 'effect']]) {
        const ps = (P.catalog.plugins || []).filter((p) => p.kind === kind);
        list.append(h('div.title', { style: { color: 'var(--accent)', padding: '8px 2px 2px', textTransform: 'uppercase', fontSize: '10px', letterSpacing: '.8px' } }, title));
        if (!ps.length) list.append(h('div.dim', { style: { padding: '2px 8px' } }, P.catalog.scannedAt ? 'None found. Manage plugins… adds folders.' : 'Press Find plugins below.'));
        for (const p of ps) {
          const key = `${p.format}:${p.path}:${p.uid}`;
          list.append(h('div.item', {
            style: { padding: '4px 8px', borderRadius: '3px', cursor: 'default', background: selected && selected.id === key ? 'var(--bg3)' : '' },
            onclick: () => { selected = { id: key, kind, plugin: p }; info.textContent = `${p.name} · ${p.vendor || ''} · ${p.format === 'clap' ? 'CLAP' : 'VST3'}`; render(); },
            ondblclick: () => addInstalled(p),
            hint: p.path,
          }, p.name, h('span.dim', { style: { float: 'right' } }, `${p.vendor || ''} ${p.format === 'clap' ? 'CLAP' : 'VST3'}`)));
        }
      }
    }
  };
  const addInstalled = (p) => {
    const P = app.plugins;
    if (p.kind === 'instrument') { const ch = P.addInstrument(p); app.openChannelEditor(ch.id); return; }
    const pr = app.store.project, tn = pr.mixer.selected, slot = pr.mixer.tracks[tn].fx.findIndex((s) => !s);
    if (slot < 0) { app.toast('All 10 effect slots on this track are used'); return; }
    P.addEffect(tn, slot, p);
  };

  const add = (id, kind) => {
    if (kind === 'instrument') app.addInstrument(id);
    else app.addEffectToSelected(id);
  };

  const more = h('div.btn', { hint: 'Download more plugins: installable plugin packs', onclick: () => app.openStore && app.openStore() }, 'Get more…');
  const addBtn = h('div.btn.primary', { onclick: () => { if (selected && selected.plugin) addInstalled(selected.plugin); else if (selected) add(selected.id, selected.kind); }, hint: 'Add — adds the selected plugin' }, 'Add');
  const find = app.plugins && app.plugins.available ? h('div.btn', { hint: 'Look for VST3 and CLAP plugins installed on this computer', onclick: () => app.plugins.scan() }, 'Find plugins') : null;
  const manage = app.plugins && app.plugins.available ? h('div.btn', { hint: 'Plugin folders and the list of installed plugins', onclick: () => app.openWindow('plugins') }, 'Manage…') : null;
  render();
  app.store.bus.on('plugins', render);                    // a pack was installed
  return { el: h('div.rack', list, info, h('div.rack-foot', more, find, manage, h('div.grow'), addBtn)), onShow: render };
}
