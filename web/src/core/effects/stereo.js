// Stereo enhancer: mid/side width, bass-mono crossover, Haas widening, pan, polarity.
import { def, bool, defaults } from '../schema.js';
import { Biquad, DelayLine, clamp } from '../dsp.js';

export const schema = [
  def('width', 'Width', 0, 2, 1),
  def('bassMono', 'Bass mono below', 0, 400, 0, { unit: 'Hz' }),
  def('haas', 'Haas delay', 0, 30, 0, { unit: 'ms' }),
  def('pan', 'Pan', -1, 1, 0),
  def('balance', 'Balance', -1, 1, 0),
  bool('invertL', 'Invert left', 0),
  bool('invertR', 'Invert right', 0),
  bool('swap', 'Swap L/R', 0),
];

export const meta = { id: 'stereo', name: 'Stereo Enhancer', category: 'Stereo', description: 'Width, bass mono, Haas delay and pan' };

class Stereo {
  constructor(sr) {
    this.sr = sr; this.p = defaults(schema);
    this.lp = new Biquad(); this.lp2 = new Biquad();
    this.hd = new DelayLine(Math.ceil(0.04 * sr));
    this.dirty = true;
  }
  setParam(id, v) { this.p[id] = v; this.dirty = true; }
  reset() { this.lp.reset(); this.lp2.reset(); this.hd.clear(); }
  process(L, R, n) {
    const p = this.p, sr = this.sr;
    if (this.dirty) {
      this.lp.set('lp', sr, Math.max(20, p.bassMono), 0.7071); this.lp2.set('lp', sr, Math.max(20, p.bassMono), 0.7071);
      this.dirty = false;
    }
    const haas = p.haas * 0.001 * sr;
    const panA = (clamp(p.pan, -1, 1) + 1) * 0.7853981634;
    const bal = p.balance;
    const gl = (bal > 0 ? 1 - bal : 1) * Math.cos(panA) * Math.SQRT2, gr = (bal < 0 ? 1 + bal : 1) * Math.sin(panA) * Math.SQRT2;
    const sl = p.invertL ? -1 : 1, sr_ = p.invertR ? -1 : 1;
    for (let i = 0; i < n; i++) {
      let l = L[i] * sl, r = R[i] * sr_;
      if (p.swap) { const t = l; l = r; r = t; }
      let m = (l + r) * 0.5, s = (l - r) * 0.5;
      if (p.bassMono > 0) s -= this.lp2.process(this.lp.process(s)); // remove low-frequency side content
      s *= p.width;
      l = m + s; r = m - s;
      if (haas > 0.5) { this.hd.write(r); r = this.hd.read(haas); }
      L[i] = l * gl; R[i] = r * gr;
    }
  }
}

export function create(sr) { return new Stereo(sr); }
