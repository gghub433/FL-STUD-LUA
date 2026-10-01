// Channel vocoder. Carrier = the track's audio (e.g. a synth). Modulator = the sidechain bus
// (route a vocal track to this track as "sidechain") or, when no sidechain is routed, the input itself.
// 8-32 band-pass analysis/synthesis bands, envelope followers, unvoiced (noise) path and formant shift.
import { def, choice, defaults } from '../schema.js';
import { Biquad, Noise, dbToGain } from '../dsp.js';

const BAND_COUNTS = [8, 12, 16, 24, 32];

export const schema = [
  choice('bands', 'Bands', BAND_COUNTS.map(String), 2),
  def('low', 'Low frequency', 60, 1000, 120, { unit: 'Hz', curve: 'log' }),
  def('high', 'High frequency', 2000, 16000, 9000, { unit: 'Hz', curve: 'log' }),
  def('q', 'Band sharpness', 1, 20, 7, { curve: 'log' }),
  def('attack', 'Attack', 0.5, 50, 4, { unit: 'ms', curve: 'log' }),
  def('release', 'Release', 5, 500, 40, { unit: 'ms', curve: 'log' }),
  def('formant', 'Formant shift', -12, 12, 0, { unit: 'st', step: 0.01 }),
  def('unvoiced', 'Unvoiced (sibilants)', 0, 1, 0.4),
  choice('modSource', 'Modulator', ['Sidechain bus', 'Input (self)'], 0),
  def('carrierGain', 'Carrier gain', -12, 12, 0, { unit: 'dB' }),
  def('out', 'Output', -24, 12, 0, { unit: 'dB' }),
];

export const meta = { id: 'vocoder', name: 'Vocoder', category: 'Creative', description: 'Channel vocoder with sidechain modulator' };

const MAXB = 32;

class Vocoder {
  constructor(sr) {
    this.sr = sr; this.p = defaults(schema);
    this.mod = []; this.car = [];
    for (let b = 0; b < MAXB; b++) {
      this.mod.push([new Biquad(), new Biquad()]);
      this.car.push([new Biquad(), new Biquad(), new Biquad(), new Biquad()]); // [L1, L2, R1, R2]
    }
    this.env = new Float32Array(MAXB);
    this.hpMod = new Biquad(); this.noise = new Noise(99); this.nEnv = 0;
    this.dirty = true;
    this.nb = 16;
  }
  setParam(id, v) { this.p[id] = v; this.dirty = true; }
  reset() { for (const b of this.mod) for (const f of b) f.reset(); for (const b of this.car) for (const f of b) f.reset(); this.env.fill(0); this.nEnv = 0; }

  configure() {
    const { p, sr } = this;
    const nb = BAND_COUNTS[p.bands];
    this.nb = nb;
    const ratio = Math.pow(p.high / p.low, 1 / (nb - 1));
    const shift = Math.pow(2, p.formant / 12);
    for (let b = 0; b < nb; b++) {
      const fm = p.low * Math.pow(ratio, b), fc = Math.min(fm * shift, sr * 0.45);
      const q = p.q * (nb / 16 > 1 ? 1 : 1);
      for (const f of this.mod[b]) f.set('bp', sr, fm, q);
      for (const f of this.car[b]) f.set('bp', sr, fc, q);
    }
    this.hpMod.set('hp', sr, 6000, 0.7071);
    this.dirty = false;
  }

  process(L, R, n, ctx) {
    if (this.dirty) this.configure();
    const { p, sr, nb, env } = this;
    const useSc = p.modSource === 0 && ctx && ctx.scL;
    const mL = useSc ? ctx.scL : L, mR = useSc ? ctx.scR : R;
    const aC = Math.exp(-1 / (p.attack * 0.001 * sr)), rC = Math.exp(-1 / (p.release * 0.001 * sr));
    const cg = dbToGain(p.carrierGain) * 14 / Math.sqrt(nb / 16), og = dbToGain(p.out);
    const eC = Math.exp(-1 / (0.006 * sr));
    for (let i = 0; i < n; i++) {
      const m = (mL[i] + mR[i]) * 0.5;
      const cl = L[i], cr = R[i];
      let sl = 0, sr_ = 0;
      for (let b = 0; b < nb; b++) {
        const mb = this.mod[b][1].process(this.mod[b][0].process(m));
        const a = Math.abs(mb);
        env[b] = a > env[b] ? aC * env[b] + (1 - aC) * a : rC * env[b] + (1 - rC) * a;
        const g = env[b] * 2;
        sl += this.car[b][1].process(this.car[b][0].process(cl)) * g;
        sr_ += this.car[b][3].process(this.car[b][2].process(cr)) * g;
      }
      // unvoiced path: noise shaped by the high-frequency energy of the modulator
      const hf = Math.abs(this.hpMod.process(m));
      this.nEnv = hf > this.nEnv ? eC * this.nEnv + (1 - eC) * hf : rC * this.nEnv + (1 - rC) * hf;
      const nz = this.noise.next() * this.nEnv * 2.5 * p.unvoiced;
      L[i] = (sl * cg + nz) * og;
      R[i] = (sr_ * cg + nz) * og;
    }
  }
}

export function create(sr) { return new Vocoder(sr); }
