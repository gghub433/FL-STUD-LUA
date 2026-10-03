// TOOLS > MIDI settings: input devices, output devices (and which ones get MIDI clock), transport buttons
// (learn or pick a profile) and controller scripts from plugin packs.
import { h, clear } from './h.js';
import { modal } from './dialog.js';
import { TRANSPORT_ACTIONS, TRANSPORT_PROFILES } from '../host/midi.js';
import { controllerScripts } from '../core/packs.js';

export function openMidiSettings(app) {
  const m = app.midi;
  const sec = (title, ...kids) => h('div.ms-sec', h('div.ms-title', title), ...kids);
  const check = (label, value, fn, hint) => { const c = h('input', { type: 'checkbox', checked: !!value, onchange: () => fn(c.checked) }); return h('label.row.ms-row', { title: hint || '' }, c, h('span', label)); };
  const body = h('div.ms');
  const render = () => {
    clear(body);
    if (!m.supported) { body.append(h('div.dim', 'Web MIDI is not available in this browser. The desktop app, Chrome and Edge support it.')); return; }
    body.append(sec('Input devices', ...(m.inputs.length ? m.inputs.map((d) => check(d.name, d.on, (on) => m.setDeviceEnabled(d.name, on))) : [h('div.dim', 'No MIDI input devices. Connect one; the list updates by itself.')])));
    const outs = m.outputs;
    body.append(sec('Output devices', ...(outs.length ? outs.map((o) => h('div.row.ms-row', h('span', { style: { flex: 1 } }, o.name),
      check('Send clock', o.clock, (on) => m.setClock(o.name, on), 'MIDI clock (24 per quarter note), Start / Stop and song position follow the transport'),
      h('div.btn', { hint: 'Play a short middle C on this output', onclick: () => { m._send(o.name, [0x90, 60, 100], 0); setTimeout(() => m._send(o.name, [0x80, 60, 0], 0), 300); } }, 'Test'))) : [h('div.dim', 'No MIDI outputs. MIDI Out channels (ADD > Instrument plugin > MIDI Out) send to the device you pick here.')])));
    const rows = TRANSPORT_ACTIONS.map(([id, label]) => {
      const cur = m.transport.map.find((x) => x.action === id);
      const txt = cur ? `${cur.type === 'note' ? 'Note' : 'CC'} ${cur.num}${cur.chan ? ` · ch ${cur.chan}` : ''}` : '—';
      return h('div.row.ms-row', h('span', { style: { width: '150px' } }, label), h('span.dim', { style: { flex: 1 } }, txt),
        h('div.btn', { hint: 'Then press the button on your controller', onclick: () => { m.learnTransport(id); } }, 'Learn'),
        h('div.btn', { onclick: () => { m.setTransportMap(m.transport.map.filter((x) => x.action !== id)); render(); } }, 'Clear'));
    });
    const prof = h('select.select', { style: { flex: 1 } }, h('option', { value: '' }, 'Load a profile…'), ...TRANSPORT_PROFILES.map((p, i) => h('option', { value: String(i) }, p.name)));
    prof.addEventListener('change', () => { if (prof.value !== '') { m.setTransportMap(TRANSPORT_PROFILES[+prof.value].map); render(); } });
    body.append(sec('Transport buttons', h('div.row.ms-row', prof), ...rows));
    const scripts = [...controllerScripts.entries()];
    body.append(sec('Controller scripts', ...(scripts.length
      ? scripts.map(([id, s]) => check(`${s.name}`, m.scriptCfg.on.includes(id), (on) => m.setScriptEnabled(id, on), s.description))
      : [h('div.dim', 'Scripts come in plugin packs, e.g. “FL LUA Controller Scripts” in the Plugin store.'), h('div.btn', { onclick: () => { dlg.close(); app.openStore && app.openStore(); } }, 'Open the Plugin store')])));
  };
  const subs = [app.store.bus.on('midi-devices', render), app.store.bus.on('midi-outputs', render), app.store.bus.on('midi-transport', render), app.store.bus.on('plugins', render)];
  render();
  const dlg = modal({ title: 'MIDI settings', body, width: 560, buttons: [{ label: 'Close', primary: true }], onClose: () => { for (const s of subs) s(); m.transportLearn = null; } });
  return dlg;
}
