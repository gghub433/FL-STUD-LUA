// HELP > Keyboard shortcuts: every app command with its keys. Change: press the new keys (Esc cancels, Backspace
// removes the shortcut). Keys taken from another command move over. Editor keys are listed for reference.
import { h, clear } from './h.js';
import { modal } from './dialog.js';
import { comboOf } from '../app/keymap.js';

const EDITOR_KEYS = [
  ['Z S X D C V G B H N J M', 'Play the selected channel from the keyboard (C–B)'], ['Q 2 W 3 E R 5 T 6 Y 7 U I', 'Same, one octave higher'],
  ['Piano roll: P B D T C E Z Y', 'Draw · paint · delete · slice · select · zoom · playback tools (typing keyboard off)'],
  ['Patcher: Del · Ctrl+D · Ctrl+A', 'Delete / duplicate / select all nodes; wheel zooms, middle mouse (or Space) pans'],
  ['Audio editor: Space · Ctrl+C/X/V · Del', 'Play · copy / cut / paste · delete the selection; Ctrl+Z / Ctrl+Y undo inside the editor; wheel zooms'],
];

export function openShortcuts(app) {
  const km = app.keymap;
  const body = h('div.ks');
  let capturing = null;
  const render = () => {
    clear(body);
    for (const c of km.cmds) {
      const keys = km.keysOf(c.id);
      const changed = !!km.custom[c.id];
      body.append(h('div.ks-row', { dataset: { cmd: c.id } },
        h('span.ks-label', c.label),
        h('span.ks-keys', capturing === c.id ? h('i.ks-wait', 'Press the keys…') : keys.length ? keys.map((k) => h('b.ks-key', k)) : h('span.dim', '—')),
        h('div.btn.sm', { hint: 'Press the new keys; Esc cancels, Backspace removes the shortcut', onclick: () => { capturing = c.id; render(); } }, 'Change'),
        h('div.btn.sm' + (changed ? '' : '.disabled'), { hint: 'Back to the default keys', onclick: () => { km.reset(c.id); render(); } }, 'Default')));
    }
    body.append(h('div.ks-sub', 'In the editors'), ...EDITOR_KEYS.map(([k, d]) => h('div.ks-row', h('span.ks-label', d), h('span.ks-keys', h('b.ks-key', k)))));
  };
  const onKey = (e) => {
    if (!capturing) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { capturing = null; render(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') { km.clear(capturing); capturing = null; render(); return; }
    const combo = comboOf(e);
    if (!combo) return;                                       // a modifier on its own: wait for the key
    const lost = km.assign(capturing, combo);
    if (lost) app.toast(`${combo} moved from “${lost.label}”`);
    capturing = null; render();
  };
  window.addEventListener('keydown', onKey, true);
  render();
  return modal({ title: 'Keyboard shortcuts', body, width: 620,
    buttons: [{ label: 'Reset all', fn: () => { km.reset(); render(); return false; } }, { label: 'Close', primary: true }],
    onClose: () => window.removeEventListener('keydown', onKey, true) });
}
