// Preset menus shared by every plugin window: factory presets, user presets (saved in this browser),
// save / delete, reset. Used by the instrument editors, the generic editor and the effect windows.
import { INSTRUMENT_PRESETS, EFFECT_PRESETS } from '../core/presets.js';
import { instrumentSchema, instrumentMeta } from '../core/instruments/index.js';
import { promptText } from './dialog.js';

const key = (kind, type) => `stepwise.${kind}presets.${type}`;
export function userPresets(kind, type) { try { return JSON.parse(localStorage.getItem(key(kind, type)) || '{}'); } catch (_) { return {}; } }
export function saveUserPresets(kind, type, all) { localStorage.setItem(key(kind, type), JSON.stringify(all)); }

export function allPresets(kind, type) {
  const factory = (kind === 'inst' ? INSTRUMENT_PRESETS : EFFECT_PRESETS)[type] || {};
  const user = userPresets(kind, type);
  return { factory: Object.fromEntries(Object.entries(factory).map(([n, p]) => [n, { params: p }])), user };
}

// menu items for an instrument channel
export function instrumentPresetItems(app, chId) {
  const store = app.store, ch = store.channel(chId);
  if (!ch) return [];
  const type = ch.type;
  const { factory, user } = allPresets('inst', type);
  const load = (preset, name) => { app.cmd.loadInstrumentPreset(store, chId, preset.params); app.toast(`Preset: ${name}`); };
  const items = [{ title: `${instrumentMeta(type).name} presets` }];
  const fn = Object.keys(factory);
  if (fn.length) for (const n of fn) items.push({ label: n, fn: () => load(factory[n], n) });
  else items.push({ label: '(no factory presets)', disabled: true });
  const un = Object.keys(user);
  if (un.length) { items.push({ sep: true }, { title: 'My presets' }); for (const n of un) items.push({ label: n, fn: () => load(user[n], n) }); }
  items.push({ sep: true },
    { label: 'Save preset…', fn: async () => {
      const name = await promptText('Save preset', 'Preset name', `${instrumentMeta(type).name} preset`);
      if (!name) return;
      const all = userPresets('inst', type);
      all[name] = { params: JSON.parse(JSON.stringify(store.channel(chId).params)) };
      try { saveUserPresets('inst', type, all); app.toast(`Saved preset "${name}"`); app.store.bus.emit('presets'); } catch (_) { app.toast('Could not save (storage disabled)'); }
    } },
    { label: 'Reset to defaults', fn: () => app.cmd.loadInstrumentPreset(store, chId, {}, 'Reset plugin') });
  if (un.length) items.push({ label: 'Delete preset…', submenu: un.map((n) => ({ label: n, fn: () => { const all = userPresets('inst', type); delete all[n]; saveUserPresets('inst', type, all); app.store.bus.emit('presets'); } })) });
  return items;
}

export { instrumentSchema };
