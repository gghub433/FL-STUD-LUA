// Web MIDI input: notes play (and record into) the selected channel, CC messages drive the knobs that are
// linked to a controller number ("MIDI learn": pick a knob, move a control on the device). The same
// handle() entry point is used for real devices and by tests, which feed it raw bytes.
import { paramDef, paramLabel } from '../core/addr.js';
import { fromNorm } from '../core/schema.js';

const LS = 'stepwise.midi.disabled';
const load = () => { try { return new Set(JSON.parse(localStorage.getItem(LS) || '[]')); } catch (_) { return new Set(); } };

export class MidiHub {
  constructor(app) {
    this.app = app;
    this.access = null;
    this.inputs = [];                 // [{ id, name, on }]
    this.disabled = load();
    this.learn = null;                // { addr, label } while waiting for a controller move
    this.held = new Map();            // `${chan}:${key}` -> channel id the note went to
    this.lastCC = null;
    this.log = [];
  }

  get supported() { return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function'; }

  async init() {
    if (!this.supported) return false;
    try { this.access = await navigator.requestMIDIAccess({ sysex: false }); } catch (_) { return false; }
    this.access.onstatechange = () => this.rescan();
    this.rescan();
    return true;
  }

  rescan() {
    if (!this.access) return;
    this.inputs = [];
    for (const input of this.access.inputs.values()) {
      const on = !this.disabled.has(input.name);
      input.onmidimessage = on ? (e) => this.handle(e.data, input.name) : null;
      this.inputs.push({ id: input.id, name: input.name, on });
    }
    this.app.store.bus.emit('midi-devices', this.inputs);
  }

  setDeviceEnabled(name, on) {
    if (on) this.disabled.delete(name); else this.disabled.add(name);
    try { localStorage.setItem(LS, JSON.stringify([...this.disabled])); } catch (_) { /* private mode */ }
    this.rescan();
  }

  // ---- parameter linking
  startLearn(addr) {
    const label = paramLabel(this.app.store.project, addr);
    this.learn = { addr, label };
    this.app.toast(`MIDI learn: move a control on your device to link “${label}” (Esc cancels)`);
    this.app.store.bus.emit('midi-learn', this.learn);
  }

  cancelLearn() {
    if (!this.learn) return false;
    this.learn = null;
    this.app.store.bus.emit('midi-learn', null);
    this.app.toast('MIDI learn cancelled');
    return true;
  }

  // ---- incoming bytes
  handle(data, source = '') {
    if (!data || data.length < 2) return;
    const st = data[0], type = st >> 4, chan = st & 15;
    const a = data[1], b = data.length > 2 ? data[2] : 0;
    this.log.push([st, a, b]); if (this.log.length > 64) this.log.shift();
    if (type === 9 && b > 0) this.noteOn(chan, a, b);
    else if (type === 8 || (type === 9 && b === 0)) this.noteOff(chan, a);
    else if (type === 11) this.cc(chan, a, b);
    else if (type === 14) this.bend(chan, a | (b << 7));
  }

  noteOn(chan, key, vel) {
    const app = this.app, ch = app.store.selected;
    if (ch == null || !app.store.channel(ch)) return;
    app.host.resume();
    this.held.set(`${chan}:${key}`, ch);
    app.host.send({ t: 'noteOn', ch, key, vel: vel / 127 });
  }

  noteOff(chan, key) {
    const id = `${chan}:${key}`, ch = this.held.get(id);
    if (ch === undefined) return;
    this.held.delete(id);
    this.app.host.send({ t: 'noteOff', ch, key });
  }

  // pitch wheel: +-2 semitones on the selected channel's pitch while it is held away from the centre
  bend(chan, v14) {
    const app = this.app, ch = app.store.selected;
    if (ch == null || !app.store.channel(ch) || !this.bendEnabled) return;
    app.store.setParam(`ch:${ch}:pitch`, ((v14 - 8192) / 8192) * 2, { noUndo: true });
  }

  cc(chan, cc, value) {
    const store = this.app.store, p = store.project;
    this.lastCC = { chan, cc, value };
    store.bus.emit('midi-cc', this.lastCC);
    if (this.learn) {
      const { addr, label } = this.learn;
      this.learn = null;
      this.app.cmd.setMidiLink(store, { addr, chan: chan + 1, cc, min: 0, max: 1, invert: 0 });
      store.bus.emit('midi-learn', null);
      this.app.toast(`“${label}” linked to CC ${cc} (channel ${chan + 1})`);
      return;
    }
    for (const l of p.controllers) {
      if (l.cc !== cc || (l.chan !== 0 && l.chan !== chan + 1)) continue;
      const d = paramDef(p, l.addr);
      if (!d) continue;
      const x = value / 127, n = l.min + (l.max - l.min) * (l.invert ? 1 - x : x);
      store.setParam(l.addr, fromNorm(d, n), { noUndo: true });
    }
  }
}
