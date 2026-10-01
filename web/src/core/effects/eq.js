// Parametric EQ: 7 bands, each with its own type, frequency, gain, Q and slope.
import { def, bool, choice, defaults } from '../schema.js';
import { Biquad, dbToGain } from '../dsp.js';

export const BAND_TYPES = ['Low shelf', 'Peak', 'High shelf', 'Low pass', 'High pass', 'Notch', 'Band pass'];
const TYPE_ID = ['ls', 'peak', 'hs', 'lp', 'hp', 'notch', 'bp'];
const FREQS = [45, 130, 380, 1000, 2800, 7000, 14000];
const DEFAULT_TYPES = [0, 1, 1, 1, 1, 1, 2];

export const BANDS = 7;

export const schema = [def('out', 'Output', -18, 18, 0, { unit: 'dB', group: 'Main' })];
for (let i = 1; i <= BANDS; i++) {
  schema.push(
    bool(`b${i}on`, `Band ${i} on`, 1, { group: `Band ${i}` }),
    choice(`b${i}type`, `Band ${i} type`, BAND_TYPES, DEFAULT_TYPES[i - 1], { group: `Band ${i}` }),
    def(`b${i}freq`, `Band ${i} frequency`, 20, 20000, FREQS[i - 1], { unit: 'Hz', curve: 'log', group: `Band ${i}` }),
    def(`b${i}gain`, `Band ${i} gain`, -24, 24, 0, { unit: 'dB', group: `Band ${i}` }),
    def(`b${i}q`, `Band ${i} Q`, 0.1, 18, 1, { curve: 'log', group: `Band ${i}` }),
    choice(`b${i}slope`, `Band ${i} slope`, ['12 dB/oct', '24 dB/oct'], 0, { group: `Band ${i}` }),
  );
}

export const meta = { id: 'eq', name: 'Parametric EQ', category: 'EQ', description: '7-band parametric equaliser with a live spectrum' };

// Build the biquad chain of one band (used by both the DSP and the UI response curve).
export function bandFilters(p, i, sr) {
  const t = p[`b${i}type`], id = TYPE_ID[t];
  const f = p[`b${i}freq`], g = p[`b${i}gain`], q = p[`b${i}q`];
  const stages = (id === 'lp' || id === 'hp') && p[`b${i}slope`] === 1 ? 2 : 1;
  const out = [];
  for (let s = 0; s < stages; s++) {
    const bq = new Biquad();
    bq.set(id, sr, f, id === 'peak' || id === 'notch' || id === 'bp' ? q : (id === 'lp' || id === 'hp') ? (stages === 2 ? (s === 0 ? 0.54 : 1.31) : q * 0.7071) : 0.7071, g);
    out.push(bq);
  }
  return out;
}

// Magnitude response in dB at the given frequencies (for drawing the curve).
export function eqResponse(p, sr, freqs) {
  const res = new Float32Array(freqs.length);
  const chains = [];
  for (let i = 1; i <= BANDS; i++) if (p[`b${i}on`]) chains.push(bandFilters(p, i, sr));
  for (let k = 0; k < freqs.length; k++) {
    let m = 1;
    for (const ch of chains) for (const bq of ch) m *= bq.magnitude(freqs[k], sr);
    res[k] = 20 * Math.log10(m + 1e-12) + p.out;
  }
  return res;
}

class EQ {
  constructor(sr) {
    this.sr = sr;
    this.p = defaults(schema);
    this.dirty = true;
    this.chains = [];      // per active band: { L:[Biquad], R:[Biquad] }
    this.gain = 1;
  }
  setParam(id, v) { this.p[id] = v; this.dirty = true; }
  reset() { for (const c of this.chains) for (const b of [...c.L, ...c.R]) b.reset(); }
  rebuild() {
    this.chains = [];
    for (let i = 1; i <= BANDS; i++) {
      if (!this.p[`b${i}on`]) continue;
      const t = TYPE_ID[this.p[`b${i}type`]];
      if ((t === 'peak' || t === 'ls' || t === 'hs') && Math.abs(this.p[`b${i}gain`]) < 0.01) continue;
      this.chains.push({ L: bandFilters(this.p, i, this.sr), R: bandFilters(this.p, i, this.sr) });
    }
    this.gain = dbToGain(this.p.out);
    this.dirty = false;
  }
  process(L, R, n) {
    if (this.dirty) this.rebuild();
    for (const c of this.chains) {
      for (const bq of c.L) for (let i = 0; i < n; i++) L[i] = bq.process(L[i]);
      for (const bq of c.R) for (let i = 0; i < n; i++) R[i] = bq.process(R[i]);
    }
    if (this.gain !== 1) for (let i = 0; i < n; i++) { L[i] *= this.gain; R[i] *= this.gain; }
  }
}

export function create(sr) { return new EQ(sr); }
