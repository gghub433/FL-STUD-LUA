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
    section('Generators', Object.entries(INSTRUMENTS), 'instrument');
    section('Effects', Object.entries(EFFECTS), 'effect');
  };

  const add = (id, kind) => {
    if (kind === 'instrument') app.addInstrument(id);
    else app.addEffectToSelected(id);
  };

  const more = h('div.btn', { hint: 'Download more plugins: installable plugin packs', onclick: () => app.openStore && app.openStore() }, 'Get more…');
  const addBtn = h('div.btn.primary', { onclick: () => { if (selected) add(selected.id, selected.kind); }, hint: 'Add — adds the selected plugin' }, 'Add');
  render();
  app.store.bus.on('plugins', render);                    // a pack was installed
  return { el: h('div.rack', list, info, h('div.rack-foot', more, h('div.grow'), addBtn)), onShow: render };
}
