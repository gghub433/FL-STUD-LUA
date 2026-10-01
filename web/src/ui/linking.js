// Right-click parameter menu (automation clip, controller links, MIDI learn) and the dialogs behind it.
import { formDialog } from './forms.js';
import { paramDef, paramLabel, getParam } from '../core/addr.js';
import { toNorm } from '../core/schema.js';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// default mapping for a fresh link: a window of +-25% around where the knob is now
function defaultRange(app, addr) {
  const d = paramDef(app.store.project, addr);
  if (!d || d.int) return { min: 0, max: 1 };
  const cur = toNorm(d, getParam(app.store.project, addr) ?? d.def);
  let lo = clamp01(cur - 0.25), hi = clamp01(cur + 0.25);
  if (hi - lo < 0.3) { if (lo === 0) hi = 0.5; else lo = 0.5; }
  return { min: lo, max: hi };
}

export async function midiLinkDialog(app, addr) {
  const cur = app.store.project.controllers.find((l) => l.addr === addr);
  const v = await formDialog(`MIDI link: ${paramLabel(app.store.project, addr)}`, [
    { id: 'cc', label: 'Controller number (CC)', type: 'number', min: 0, max: 127, value: cur ? cur.cc : (app.midi.lastCC ? app.midi.lastCC.cc : 1) },
    { id: 'chan', label: 'MIDI channel', type: 'select', value: cur ? cur.chan : 0, options: [[0, 'Any'], ...Array.from({ length: 16 }, (_, i) => [i + 1, String(i + 1)])] },
    { id: 'min', label: 'Minimum', type: 'range', min: 0, max: 100, value: cur ? Math.round(cur.min * 100) : 0, unit: '%' },
    { id: 'max', label: 'Maximum', type: 'range', min: 0, max: 100, value: cur ? Math.round(cur.max * 100) : 100, unit: '%' },
    { id: 'invert', label: 'Invert', type: 'check', value: cur ? !!cur.invert : false },
  ], { ok: 'Link' });
  if (v) app.cmd.setMidiLink(app.store, { addr, chan: v.chan, cc: Math.max(0, Math.min(127, Math.round(v.cc))), min: v.min / 100, max: v.max / 100, invert: v.invert });
}

export function paramMenuItems(app, addr) {
  const store = app.store, p = store.project, cmd = app.cmd;
  if (!paramDef(p, addr)) return [];
  const auto = cmd.automationFor(p, addr);
  const ctrls = p.channels.filter((c) => c.type === 'controller');
  const midi = p.controllers.find((l) => l.addr === addr);
  const items = [
    { label: auto ? 'Add a clip of the existing automation' : 'Create automation clip', fn: () => {
      const made = cmd.createAutomationClip(store, addr, { start: app.playlist ? app.playlist.cursorT : 0 });
      if (made) { app.openAutomationEditor(made.channel.id); app.toast(`Automation clip placed on playlist track ${made.clip.track}`); }
    } },
  ];
  if (auto) items.push({ label: 'Edit events…', fn: () => app.openAutomationEditor(auto.id) });
  items.push({ sep: true });
  items.push({
    label: 'Link to controller', key: 'Ctrl+L',
    submenu: [
      { label: 'MIDI learn (move a control on your device)', fn: () => app.midi.startLearn(addr) },
      { label: 'Set MIDI CC manually…', fn: () => midiLinkDialog(app, addr) },
      { sep: true },
      ...ctrls.map((c) => {
        const linked = c.links.some((l) => l.addr === addr);
        return { label: c.name, checked: linked, fn: () => { if (linked) cmd.unlinkController(store, c.id, addr); else cmd.linkController(store, c.id, addr, defaultRange(app, addr)); } };
      }),
      ...(ctrls.length ? [{ sep: true }] : []),
      { label: 'New LFO controller…', fn: () => { const c = cmd.addController(store, 0, 'LFO'); cmd.linkController(store, c.id, addr, defaultRange(app, addr)); app.openChannelEditor(c.id); } },
      { label: 'New envelope controller…', fn: () => { const c = cmd.addController(store, 1, 'Envelope'); cmd.linkController(store, c.id, addr, defaultRange(app, addr)); app.openChannelEditor(c.id); } },
    ],
  });
  if (midi) items.push({ label: `Remove MIDI link (CC ${midi.cc})`, fn: () => cmd.removeMidiLink(store, addr) });
  return items;
}

// Ctrl+L: link the knob under the pointer
export function linkHovered(app) {
  const addr = app.hoverAddr;
  if (!addr) { app.toast('Point at a knob first, then press Ctrl+L'); return; }
  if (!paramDef(app.store.project, addr)) return;
  app.midi.startLearn(addr);
}
