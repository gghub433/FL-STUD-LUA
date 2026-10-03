// A WAM 2.0 plugin used as an instrument (see ../wam-link.js). Notes become MIDI events scheduled on the plugin's
// processor; the sound it makes comes back on the engine node's input and is mixed like any other channel. The
// plugin itself lives in the page (ADD > WAM plugin…); this object only links the channel to it.
import { linkOf, processorOf, eventTime } from '../wam-link.js';

export const schema = [];
export const meta = { id: 'wam', name: 'WAM plugin…', kind: 'external', description: 'A Web Audio Modules 2.0 instrument loaded from an address (URL)' };

const clampNote = (k) => Math.max(0, Math.min(127, k));

export class WamInstrument {
  constructor(sr, host) { this.sr = sr; this.host = host; this.p = {}; this.owner = null; this.held = new Map(); }
  get link() { return linkOf(this.host, this.owner); }
  get active() { return !!this.link; }
  setParam() {}
  setData(ch) { this.owner = `ch:${ch.id}`; }
  send(bytes) {
    const proc = processorOf(this.host, this.link);
    if (proc) proc.scheduleEvents({ type: 'wam-midi', time: eventTime(this.host, this.sr), data: { bytes } });
  }
  noteOn(ev) {
    const n = clampNote(Math.round(ev.key + (ev.fine || 0) / 100));
    const vel = Math.max(1, Math.min(127, Math.round((ev.vel ?? 0.8) * 127)));
    if (this.held.has(ev.key)) this.noteOff(ev.key);
    this.held.set(ev.key, n);
    this.send([0x90, n, vel]);
  }
  noteOff(key) {
    const n = this.held.get(key);
    if (n === undefined) return;
    this.held.delete(key);
    this.send([0x80, n, 0]);
  }
  allOff() { for (const key of [...this.held.keys()]) this.noteOff(key); }
  chokeAll() { this.allOff(); }
  process(L, R, a, b) {
    const l = this.link, inp = this.host.extIn;
    if (!l || !inp) return;
    const cl = inp[l.port * 2], cr = inp[l.port * 2 + 1] || cl;
    if (!cl) return;
    for (let i = a; i < b; i++) { L[i] += cl[i]; R[i] += cr[i]; }
  }
}

export function create(sr, host) { return new WamInstrument(sr, host); }
