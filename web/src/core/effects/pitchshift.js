// Pitch shifter: two crossfaded delay-line read heads sweep through a short buffer at a different
// speed than it is written (classic dual-tap granular shifter). The dry path is delayed by the
// average wet delay and reported as latency so mixer delay compensation keeps parallel paths aligned.
import { def, defaults } from '../schema.js';
import { DelayLine } from '../dsp.js';

export const schema = [
  def('semi', 'Pitch', -24, 24, 0, { unit: 'st', step: 1 }),
  def('fine', 'Fine', -100, 100, 0, { unit: 'cents', step: 1 }),
  def('grain', 'Grain size', 20, 120, 50, { unit: 'ms' }),
  def('feedback', 'Feedback', 0, 0.8, 0),
  def('mix', 'Mix', 0, 1, 1),
];
export const meta = { id: 'pitchshift', name: 'Pitch Shifter', category: 'Pitch', description: 'Shift pitch up or down in real time', latencyParams: ['grain'] };

class PitchShift {
  constructor(sr) {
    this.sr = sr; this.p = defaults(schema);
    const max = Math.ceil(0.14 * sr);
    this.dl = new DelayLine(max); this.dr = new DelayLine(max);
    this.dryL = new DelayLine(max); this.dryR = new DelayLine(max);
    this.ph = 0; this.fbL = 0; this.fbR = 0;
    this.latency = Math.round(0.5 * this.p.grain * 0.001 * sr);
    this.latencyParams = ['grain'];
  }
  setParam(id, v) { this.p[id] = v; if (id === 'grain') this.latency = Math.round(0.5 * v * 0.001 * this.sr); }
  reset() { this.dl.clear(); this.dr.clear(); this.dryL.clear(); this.dryR.clear(); this.fbL = this.fbR = 0; }
  process(L, R, n) {
    const p = this.p, sr = this.sr;
    const ratio = Math.pow(2, (p.semi + p.fine / 100) / 12);
    const G = p.grain * 0.001 * sr;
    const dPh = (1 - ratio) / G;                      // read heads move at `ratio` samples per sample
    const half = G * 0.5;
    for (let i = 0; i < n; i++) {
      this.ph += dPh;
      this.ph -= Math.floor(this.ph);
      const p1 = this.ph, p2 = (this.ph + 0.5) % 1;
      const w1 = 0.5 - 0.5 * Math.cos(2 * Math.PI * p1), w2 = 0.5 - 0.5 * Math.cos(2 * Math.PI * p2);
      const d1 = 2 + p1 * G, d2 = 2 + p2 * G;
      this.dl.write(L[i] + this.fbL * p.feedback); this.dr.write(R[i] + this.fbR * p.feedback);
      const wl = this.dl.read(d1) * w1 + this.dl.read(d2) * w2;
      const wr = this.dr.read(d1) * w1 + this.dr.read(d2) * w2;
      this.fbL = wl; this.fbR = wr;
      this.dryL.write(L[i]); this.dryR.write(R[i]);
      const dl = this.dryL.read(half + 2), dr = this.dryR.read(half + 2);
      L[i] = dl + (wl - dl) * p.mix; R[i] = dr + (wr - dr) * p.mix;
    }
  }
}
export function create(sr) { return new PitchShift(sr); }
