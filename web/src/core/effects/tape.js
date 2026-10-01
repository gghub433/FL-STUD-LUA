// Tape saturator: soft saturation with adjustable bias (even harmonics), head-bump low shelf, tone
// roll-off, wow & flutter (slow and fast speed drift of a short modulated delay) and optional hiss.
import { def, defaults } from '../schema.js';
import { Biquad, DelayLine, Noise, dbToGain, TAU } from '../dsp.js';

export const schema = [
  def('drive', 'Drive', 0, 30, 8, { unit: 'dB' }),
  def('bias', 'Bias', -1, 1, 0.1),
  def('bump', 'Head bump', 0, 8, 2, { unit: 'dB' }),
  def('tone', 'Tone', 1000, 20000, 11000, { unit: 'Hz', curve: 'log' }),
  def('wow', 'Wow', 0, 1, 0.15),
  def('flutter', 'Flutter', 0, 1, 0.1),
  def('hiss', 'Hiss', -90, -40, -90, { unit: 'dB' }),
  def('output', 'Output', -24, 12, 0, { unit: 'dB' }),
  def('mix', 'Mix', 0, 1, 1),
];
export const meta = { id: 'tape', name: 'Tape Saturator', category: 'Distortion', description: 'Tape-style saturation, wow & flutter, head bump and hiss' };

class Tape {
  constructor(sr) {
    this.sr = sr; this.p = defaults(schema);
    this.bumpL = new Biquad(); this.bumpR = new Biquad(); this.lpL = new Biquad(); this.lpR = new Biquad(); this.lp2L = new Biquad(); this.lp2R = new Biquad();
    this.dl = new DelayLine(Math.ceil(0.02 * sr)); this.dr = new DelayLine(Math.ceil(0.02 * sr));
    this.noise = new Noise(77); this.wph = 0; this.fph = 0; this.dirty = true;
    this.dcL = 0; this.dcR = 0;
  }
  setParam(id, v) { this.p[id] = v; this.dirty = true; }
  reset() { for (const b of [this.bumpL, this.bumpR, this.lpL, this.lpR, this.lp2L, this.lp2R]) b.reset(); this.dl.clear(); this.dr.clear(); this.dcL = this.dcR = 0; }
  process(L, R, n) {
    const p = this.p, sr = this.sr;
    if (this.dirty) {
      this.dirty = false;
      for (const b of [this.bumpL, this.bumpR]) b.set('ls', sr, 90, 0.7, p.bump);
      for (const b of [this.lpL, this.lpR, this.lp2L, this.lp2R]) b.set('lp', sr, p.tone, 0.6);
    }
    const drive = dbToGain(p.drive), comp = 1 / Math.max(1, Math.tanh(drive * 0.8) * 1.15), out = dbToGain(p.output);
    const bias = p.bias * 0.5, tb = Math.tanh(bias);
    const hiss = p.hiss > -89 ? dbToGain(p.hiss) : 0;
    const base = 0.004 * sr;
    const wowInc = 0.55 / sr, fluInc = 7.3 / sr;
    const wowDepth = p.wow * 0.0016 * sr, fluDepth = p.flutter * 0.00015 * sr;
    const dcA = 1 - Math.exp(-TAU * 12 / sr);
    for (let i = 0; i < n; i++) {
      this.wph += wowInc; if (this.wph >= 1) this.wph -= 1;
      this.fph += fluInc; if (this.fph >= 1) this.fph -= 1;
      const d = base + wowDepth * Math.sin(TAU * this.wph) + fluDepth * Math.sin(TAU * this.fph + 1.3);
      this.dl.write(L[i]); this.dr.write(R[i]);
      let l = this.dl.read(d), r = this.dr.read(d);
      l = this.bumpL.process(l); r = this.bumpR.process(r);
      l = (Math.tanh(l * drive + bias) - tb) * comp; r = (Math.tanh(r * drive + bias) - tb) * comp;
      // bias makes the curve asymmetric and shifts the DC level: remove it
      this.dcL += (l - this.dcL) * dcA; this.dcR += (r - this.dcR) * dcA; l -= this.dcL; r -= this.dcR;
      if (hiss) { l += this.noise.next() * hiss; r += this.noise.next() * hiss; }
      l = this.lp2L.process(this.lpL.process(l)) * out; r = this.lp2R.process(this.lpR.process(r)) * out;
      // the dry path is delayed by the same base delay so mixing does not comb
      const dl2 = this.dl.read(base), dr2 = this.dr.read(base);
      L[i] = dl2 + (l - dl2) * p.mix; R[i] = dr2 + (r - dr2) * p.mix;
    }
  }
}
export function create(sr) { return new Tape(sr); }
