// Slicer: a loop cut into slices; slice i is played by key (C5 + i). The slice table lives in the
// channel (`ch.slices` = start frames in the source sample, `ch.loopBpm`); `slice-detect.js` finds
// transients and the UI can write the original slice order into the pattern as MIDI.
import { def, bool, choice, defaults, schemaMap } from '../schema.js';
import { hermite, clamp } from '../dsp.js';

export const BASE_KEY = 60;

export const schema = [
  def('gain', 'Gain', 0, 1.5, 1, { group: 'Main' }),
  bool('tempoSync', 'Fit loop to project tempo', 1, { group: 'Main' }),
  def('pitch', 'Pitch', -12, 12, 0, { unit: 'st', step: 0.01, group: 'Main' }),
  def('attack', 'Attack', 0, 50, 1, { unit: 'ms', group: 'Main' }),
  def('release', 'Release', 1, 500, 12, { unit: 'ms', curve: 'log', group: 'Main' }),
  bool('mono', 'Mono (new slice cuts the last)', 1, { group: 'Main' }),
  bool('reverse', 'Reverse slices', 0, { group: 'Main' }),
  choice('playTo', 'Slice ends at', ['Next slice', 'Sample end'], 0, { group: 'Main' }),
];

export const meta = { id: 'slicer', name: 'Slicer', kind: 'sampler', rootDefault: 60, description: 'Chop a loop at transients and play the slices from the keyboard' };
export const paramMap = schemaMap(schema);

class V { constructor() { this.alive = false; } }

export class Slicer {
  constructor(sr, host) {
    this.sr = sr; this.host = host;
    this.p = defaults(schema);
    this.sampleId = null; this.slices = []; this.loopBpm = 0;
    this.voices = Array.from({ length: 24 }, () => new V());
    this.counter = 0;
  }

  get active() { for (const v of this.voices) if (v.alive) return true; return false; }
  setParam(id, v) { this.p[id] = v; }
  setData(ch) { this.sampleId = ch.sample ? ch.sample.id : null; this.slices = Array.isArray(ch.slices) ? ch.slices : []; this.loopBpm = ch.loopBpm || 0; }
  allOff() { for (const v of this.voices) v.alive = false; }
  chokeAll() { for (const v of this.voices) if (v.alive) v.kill = 1; }

  noteOn(ev) {
    const smp = this.sampleId ? this.host.getSample(this.sampleId) : null;
    const idx = ev.key - BASE_KEY;
    if (!smp || idx < 0 || idx >= this.slices.length) return;
    const p = this.p;
    if (p.mono) for (const v of this.voices) if (v.alive && !v.kill) v.kill = 1;
    let v = this.voices.find((x) => !x.alive);
    if (!v) v = this.voices.reduce((a, b) => (a.time < b.time ? a : b));
    const start = clamp(Math.floor(this.slices[idx]), 0, smp.length - 1);
    const end = p.playTo === 0 && idx + 1 < this.slices.length ? clamp(Math.floor(this.slices[idx + 1]), start + 1, smp.length) : smp.length;
    v.alive = true; v.kill = 0; v.time = ++this.counter;
    v.l = smp.ch[0]; v.r = smp.ch[1] || smp.ch[0]; v.len = smp.length;
    v.start = start; v.end = end;
    const tempo = this.host.tempo || 120;
    const fit = p.tempoSync && this.loopBpm > 0 ? tempo / this.loopBpm : 1;
    v.inc = (smp.rate / this.sr) * fit * Math.pow(2, (p.pitch + (ev.fine || 0) / 100) / 12) * (p.reverse ? -1 : 1);
    v.pos = p.reverse ? end - 1 : start;
    const a = (clamp(ev.pan || 0, -1, 1) + 1) * 0.7853981634;
    const g = clamp(ev.vel, 0, 1) * p.gain;
    v.gl = Math.cos(a) * 1.41421356 * g; v.gr = Math.sin(a) * 1.41421356 * g;
    v.age = 0; v.rel = 1;
  }

  noteOff() {}

  process(L, R, i0, i1) {
    const p = this.p, sr = this.sr;
    const att = Math.max(1, p.attack * 0.001 * sr), rel = Math.max(8, p.release * 0.001 * sr);
    for (const v of this.voices) {
      if (!v.alive) continue;
      const l = v.l, r = v.r, len = v.len, mono = l === r;
      for (let i = i0; i < i1; i++) {
        if (v.inc > 0 ? v.pos >= v.end : v.pos < v.start) { v.alive = false; break; }
        const remain = v.inc > 0 ? (v.end - v.pos) / v.inc : (v.pos - v.start) / -v.inc;
        let g = v.age < att ? v.age / att : 1;
        if (remain < rel) g *= remain / rel;
        v.age++;
        if (v.kill) { v.kill -= 1 / (0.005 * sr); if (v.kill <= 0) { v.alive = false; break; } g *= v.kill; }
        const a = hermite(l, v.pos, len), b = mono ? a : hermite(r, v.pos, len);
        L[i] += a * v.gl * g; R[i] += b * v.gr * g;
        v.pos += v.inc;
      }
    }
  }
}

export function create(sr, host) { return new Slicer(sr, host); }
