// Transient shaper: boosts or softens the attack and the sustain of a signal, independent of level.
// A fast and a slow envelope follower are compared (in dB): where the fast one leads, a transient is
// in progress; elsewhere the sound is sustaining.
import { def, bool, defaults } from '../schema.js';
import { dbToGain, clamp } from '../dsp.js';

export const schema = [
  def('attack', 'Attack', -100, 100, 0, { unit: '%', step: 1 }),
  def('sustain', 'Sustain', -100, 100, 0, { unit: '%', step: 1 }),
  def('speed', 'Speed', 0.2, 20, 2, { unit: 'ms', curve: 'log' }),
  def('range', 'Max change', 3, 18, 12, { unit: 'dB' }),
  def('output', 'Output', -24, 12, 0, { unit: 'dB' }),
  bool('link', 'Link channels', 1),
];
export const meta = { id: 'transient', name: 'Transient Shaper', category: 'Dynamics', description: 'Boost or tame attack and sustain' };

class Transient {
  constructor(sr) { this.sr = sr; this.p = defaults(schema); this.reset(); this.meters = [0]; }
  setParam(id, v) { this.p[id] = v; }
  reset() { this.f = [0, 0]; this.s = [0, 0]; this.g = [1, 1]; }
  process(L, R, n) {
    const p = this.p, sr = this.sr;
    const ms = p.speed * 0.001;
    const fa = 1 - Math.exp(-1 / (ms * 0.5 * sr)), fr = 1 - Math.exp(-1 / (ms * 8 * sr));        // fast follower
    const sa = 1 - Math.exp(-1 / (ms * 12 * sr)), sr_ = 1 - Math.exp(-1 / (ms * 40 * sr));       // slow follower
    const gs = 1 - Math.exp(-1 / (0.0008 * sr));                                                  // gain smoothing
    const att = p.attack / 100, sus = p.sustain / 100, range = p.range, out = dbToGain(p.output);
    let lastDb = 0;
    for (let i = 0; i < n; i++) {
      const a0 = Math.abs(L[i]), a1 = Math.abs(R[i]);
      const mx = a0 > a1 ? a0 : a1;
      for (let c = 0; c < 2; c++) {
        const x = p.link ? mx : c === 0 ? a0 : a1;
        this.f[c] += (x - this.f[c]) * (x > this.f[c] ? fa : fr);
        this.s[c] += (x - this.s[c]) * (x > this.s[c] ? sa : sr_);
        const dbF = 20 * Math.log10(this.f[c] + 1e-9), dbS = 20 * Math.log10(this.s[c] + 1e-9);
        const t = clamp((dbF - dbS) / 12, 0, 1);                        // 1 = a transient is in progress
        const live = clamp((dbS + 70) / 20, 0, 1);                      // fade the sustain control out below -50 dB
        const gDb = (att * t + sus * (1 - t) * live) * range;
        const target = Math.pow(10, gDb / 20);
        this.g[c] += (target - this.g[c]) * gs;
        lastDb = gDb;
      }
      L[i] *= this.g[0] * out; R[i] *= this.g[1] * out;
    }
    this.meters[0] = lastDb;
  }
}
export function create(sr) { return new Transient(sr); }
