// Controller: makes no sound; produces a control signal (0..1) every block that the engine writes to the
// parameters listed in the channel's `links` (like linking a knob to an LFO / Envelope Controller).
//   LFO       free-running or locked to the song position (tempo sync), six shapes, depth, offset, smoothing
//   Envelope  DAHDSR triggered by the notes of this channel (pattern, piano roll, keyboard or MIDI)
import { def, bool, choice, defaults, schemaMap } from '../schema.js';
import { LFO, DAHDSR, LFO_SHAPES, SYNC_DIVS, SYNC_LABELS, clamp } from '../dsp.js';
import { PPQ } from '../constants.js';

export const schema = [
  choice('mode', 'Type', ['LFO', 'Envelope'], 0, { group: 'Main' }),
  // LFO
  choice('shape', 'Shape', LFO_SHAPES, 0, { group: 'LFO' }),
  bool('sync', 'Tempo sync', 1, { group: 'LFO' }),
  def('rate', 'Rate', 0.02, 30, 1, { unit: 'Hz', curve: 'log', group: 'LFO' }),
  choice('div', 'Division', SYNC_LABELS, 11, { group: 'LFO' }),
  def('phase', 'Phase', 0, 1, 0, { group: 'LFO' }),
  def('depth', 'Depth', 0, 1, 1, { group: 'LFO' }),
  def('offset', 'Offset', -1, 1, 0, { group: 'LFO' }),
  def('smooth', 'Smoothing', 0, 1, 0, { group: 'LFO' }),
  // envelope
  def('delay', 'Delay', 0, 5, 0, { unit: 's', curve: 'pow', group: 'Envelope' }),
  def('attack', 'Attack', 0.001, 8, 0.05, { unit: 's', curve: 'log', group: 'Envelope' }),
  def('hold', 'Hold', 0, 5, 0, { unit: 's', curve: 'pow', group: 'Envelope' }),
  def('decay', 'Decay', 0.005, 10, 0.5, { unit: 's', curve: 'log', group: 'Envelope' }),
  def('sustain', 'Sustain', 0, 1, 0.5, { group: 'Envelope' }),
  def('release', 'Release', 0.005, 12, 0.5, { unit: 's', curve: 'log', group: 'Envelope' }),
  def('amount', 'Amount', 0, 1, 1, { group: 'Envelope' }),
];
export const meta = { id: 'controller', name: 'Controller (LFO / Envelope)', kind: 'controller', rootDefault: 60, description: 'Modulates linked knobs: LFO or note-triggered envelope. Right-click a knob → Link to controller' };
export const paramMap = schemaMap(schema);

export class Controller {
  constructor(sr, host) {
    this.sr = sr; this.host = host; this.p = defaults(schema);
    this.lfo = new LFO(7); this.env = new DAHDSR(); this.held = new Set();
    this.out = 0; this.sm = 0; this.freeRun = 0; this.value = 0;
  }
  get active() { return false; }
  setParam(id, v) { this.p[id] = v; if (id === 'shape') this.lfo.shape = v; }
  allOff() { this.held.clear(); this.env.release(); }
  chokeAll() { this.allOff(); }
  process() {}
  noteOn(ev) { this.held.add(ev.key); this.env.trigger(); this.vel = ev.vel; }
  noteOff(key) { this.held.delete(key); if (!this.held.size) this.env.release(); }

  // advance by n samples and return the control value in 0..1
  control(n) {
    const p = this.p, sr = this.sr, h = this.host || {};
    if (p.mode === 1) {
      const v = this.env.step(n, sr, { delay: p.delay, attack: p.attack, hold: p.hold, decay: p.decay, sustain: p.sustain, release: p.release });
      this.value = clamp(v * p.amount, 0, 1);
      return this.value;
    }
    this.lfo.shape = p.shape;
    let phase;
    if (p.sync) {
      const beats = SYNC_DIVS[p.div][1];
      if (h.playing) phase = ((((h.tick || 0) / (beats * PPQ)) + p.phase) % 1 + 1) % 1;
      else { this.freeRun = (this.freeRun + (((h.tempo || 120) / 60) / beats) * (n / sr)) % 1; phase = (this.freeRun + p.phase) % 1; }
    } else { this.freeRun = (this.freeRun + p.rate * (n / sr)) % 1; phase = (this.freeRun + p.phase) % 1; }
    this.lfo.phase = phase;
    const x = this.lfo.next(0);                       // -1..1 at this phase
    let v = clamp(0.5 + 0.5 * p.depth * x + p.offset * 0.5, 0, 1);
    if (p.smooth > 0) { const a = 1 - Math.exp(-n / (Math.max(0.002, p.smooth * 0.5) * sr)); this.sm += (v - this.sm) * a; v = this.sm; } else this.sm = v;
    this.value = v;
    return v;
  }
}

export function create(sr, host) { return new Controller(sr, host); }
