// Distortion / saturation with 2x oversampling around the waveshaper to keep aliasing down.
import { def, choice, defaults } from '../schema.js';
import { Biquad, dbToGain, fastTanh } from '../dsp.js';

export const TYPES = ['Soft clip', 'Hard clip', 'Tube', 'Foldback', 'Sine fold', 'Rectify'];

export const schema = [
  choice('type', 'Type', TYPES, 0),
  def('drive', 'Drive', 0, 48, 12, { unit: 'dB' }),
  def('bias', 'Bias', -1, 1, 0),
  def('tone', 'Tone (low-pass)', 400, 20000, 14000, { unit: 'Hz', curve: 'log' }),
  def('out', 'Output', -24, 12, -6, { unit: 'dB' }),
  def('dry', 'Dry', -60, 6, -60, { unit: 'dB' }),
  def('wet', 'Wet', -60, 6, 0, { unit: 'dB' }),
];

export const meta = { id: 'distortion', name: 'Distortion', category: 'Distortion', description: 'Six waveshapers with 2x oversampling' };

function shape(type, x, bias) {
  x += bias * 0.5;
  switch (type) {
    case 0: return fastTanh(x);
    case 1: return x > 1 ? 1 : x < -1 ? -1 : x;
    case 2: return x >= 0 ? 1 - Math.exp(-x) : -(1 - Math.exp(x * 1.6)) * 0.8; // asymmetric, even harmonics
    case 3: { // foldback
      let y = x;
      for (let k = 0; k < 6 && (y > 1 || y < -1); k++) y = y > 1 ? 2 - y : -2 - y;
      return y;
    }
    case 4: return Math.sin(x * 1.5707963);
    default: return Math.abs(x) * 2 - 1 > 1 ? 1 : Math.abs(x) * 2 - 1; // rectify (octave up)
  }
}

class Distortion {
  constructor(sr) {
    this.sr = sr; this.p = defaults(schema);
    this.up = [new Biquad(), new Biquad()]; this.dn = [new Biquad(), new Biquad()];
    this.upR = [new Biquad(), new Biquad()]; this.dnR = [new Biquad(), new Biquad()];
    this.tone = [new Biquad(), new Biquad()];
    this.prev = [0, 0];
    this.dirty = true;
  }
  setParam(id, v) { this.p[id] = v; this.dirty = true; }
  reset() { for (const b of [...this.up, ...this.dn, ...this.upR, ...this.dnR, ...this.tone]) b.reset(); this.prev = [0, 0]; }
  configure() {
    const s2 = this.sr * 2, f = this.sr * 0.45;
    for (const b of [...this.up, ...this.upR, ...this.dn, ...this.dnR]) b.set('lp', s2, f, 0.7071);
    this.up[1].set('lp', s2, f, 1.3); this.dn[1].set('lp', s2, f, 1.3); this.upR[1].set('lp', s2, f, 1.3); this.dnR[1].set('lp', s2, f, 1.3);
    for (const b of this.tone) b.set('lp', this.sr, Math.min(this.p.tone, this.sr * 0.45), 0.7071);
    this.dirty = false;
  }
  process(L, R, n) {
    if (this.dirty) this.configure();
    const p = this.p;
    const drive = dbToGain(p.drive), out = dbToGain(p.out);
    const dry = dbToGain(p.dry) * (p.dry <= -59.5 ? 0 : 1), wet = dbToGain(p.wet) * (p.wet <= -59.5 ? 0 : 1);
    const type = p.type, bias = p.bias;
    const chans = [L, R];
    for (let c = 0; c < 2; c++) {
      const x = chans[c];
      const u = c === 0 ? this.up : this.upR, d = c === 0 ? this.dn : this.dnR;
      let prev = this.prev[c];
      for (let i = 0; i < n; i++) {
        const cur = x[i];
        // 2x upsample (linear midpoint), shape, low-pass, decimate
        const mid = (prev + cur) * 0.5;
        let a = shape(type, u[1].process(u[0].process(mid * 2)) * 0.5 * drive, bias);
        let b = shape(type, u[1].process(u[0].process(cur * 2)) * 0.5 * drive, bias);
        a = d[1].process(d[0].process(a)); b = d[1].process(d[0].process(b));
        void a;
        let y = b * out;
        y = this.tone[c].process(y);
        x[i] = cur * dry + y * wet;
        prev = cur;
      }
      this.prev[c] = prev;
    }
  }
}

export function create(sr) { return new Distortion(sr); }
