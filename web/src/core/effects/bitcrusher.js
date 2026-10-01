// Bitcrusher: bit-depth reduction (with optional dither) and sample-rate reduction.
import { def, bool, defaults } from '../schema.js';
import { dbToGain, Noise } from '../dsp.js';

export const schema = [
  def('bits', 'Bit depth', 1, 16, 8, { step: 0.1 }),
  def('rate', 'Sample-rate reduction', 1, 64, 4, { curve: 'log' }),
  def('jitter', 'Jitter', 0, 1, 0),
  bool('dither', 'Dither', 0),
  def('dry', 'Dry', -60, 6, -60, { unit: 'dB' }),
  def('wet', 'Wet', -60, 6, 0, { unit: 'dB' }),
];

export const meta = { id: 'bitcrusher', name: 'Bitcrusher', category: 'Distortion', description: 'Bit depth and sample-rate reduction' };

class Bitcrusher {
  constructor(sr) { this.sr = sr; this.p = defaults(schema); this.hold = [0, 0]; this.cnt = [0, 0]; this.noise = new Noise(7); }
  setParam(id, v) { this.p[id] = v; }
  reset() { this.hold = [0, 0]; this.cnt = [0, 0]; }
  process(L, R, n) {
    const p = this.p;
    const levels = Math.pow(2, p.bits - 1);
    const dry = dbToGain(p.dry) * (p.dry <= -59.5 ? 0 : 1), wet = dbToGain(p.wet) * (p.wet <= -59.5 ? 0 : 1);
    const chans = [L, R];
    for (let c = 0; c < 2; c++) {
      const x = chans[c];
      let hold = this.hold[c], cnt = this.cnt[c];
      for (let i = 0; i < n; i++) {
        const inp = x[i];
        cnt -= 1;
        if (cnt <= 0) {
          cnt += p.rate * (1 + (p.jitter > 0 ? (this.noise.next() * p.jitter * 0.8) : 0));
          let v = inp;
          if (p.dither) v += (this.noise.next() - this.noise.next()) / levels;
          hold = Math.round(v * levels) / levels;
        }
        x[i] = inp * dry + hold * wet;
      }
      this.hold[c] = hold; this.cnt[c] = cnt;
    }
  }
}

export function create(sr) { return new Bitcrusher(sr); }
