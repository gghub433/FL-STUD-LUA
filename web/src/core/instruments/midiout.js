// MIDI Out: plays no sound itself; its notes go to a MIDI device or another program (a hardware synth, a
// virtual port into another DAW). The engine stamps every message with the audio frame it belongs to, and the
// page sends it with a Web MIDI timestamp, so the device plays in time with the audio you hear.
import { def, defaults } from '../schema.js';

export const schema = [
  def('channel', 'MIDI channel', 1, 16, 1, { int: true, group: 'Main' }),
  def('program', 'Program', 0, 128, 0, { int: true, group: 'Main' }),           // 0 = none, 1..128 = program change
  def('transpose', 'Transpose', -48, 48, 0, { int: true, unit: 'st', group: 'Main' }),
  def('velocity', 'Velocity', 0, 2, 1, { group: 'Main' }),
];
export const meta = { id: 'midiout', name: 'MIDI Out', kind: 'utility', rootDefault: 60, description: 'Sends this channel\'s notes to a MIDI device or another program' };

const clampNote = (k) => Math.max(0, Math.min(127, k));

export class MidiOut {
  constructor(sr, host) { this.sr = sr; this.host = host; this.p = defaults(schema); this.port = ''; this.held = new Map(); }
  get active() { return false; }
  get ch() { return (Math.round(this.p.channel) - 1) & 15; }
  emit(data) {
    const q = this.host.midiQueue;
    if (q && q.length < 4096) q.push({ port: this.port, data, frame: this.host.evFrame || 0 });
  }
  setParam(id, v) {
    const was = this.p[id];
    this.p[id] = v;
    if (id === 'program' && v > 0 && v !== was && this.ready) this.emit([0xc0 | this.ch, Math.round(v) - 1]);   // a change while loaded, not the load itself
  }
  setData(ch) { this.port = typeof ch.port === 'string' ? ch.port : ''; this.ready = true; }
  sendProgram() { if (this.p.program > 0) this.emit([0xc0 | this.ch, Math.round(this.p.program) - 1]); }
  noteOn(ev) {
    const n = clampNote(Math.round(ev.key + this.p.transpose + (ev.fine || 0) / 100));
    const vel = Math.max(1, Math.min(127, Math.round((ev.vel ?? 0.8) * this.p.velocity * 127)));
    if (this.held.has(ev.key)) this.noteOff(ev.key);
    this.held.set(ev.key, { n, ch: this.ch });
    this.emit([0x90 | this.ch, n, vel]);
  }
  noteOff(key) {
    const h = this.held.get(key);
    if (!h) return;
    this.held.delete(key);
    this.emit([0x80 | h.ch, h.n, 0]);
  }
  allOff() { for (const key of [...this.held.keys()]) this.noteOff(key); }
  chokeAll() { this.allOff(); }
  process() {}
}

export function create(sr, host) { return new MidiOut(sr, host); }
