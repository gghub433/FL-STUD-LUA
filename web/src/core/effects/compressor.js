// Compressor: feed-forward, log-domain detector, soft knee, attack/release smoothing,
// optional sidechain input (from a mixer route marked "sidechain"), auto make-up gain.
import { def, bool, choice, defaults } from '../schema.js';
import { dbToGain } from '../dsp.js';

export const schema = [
  def('threshold', 'Threshold', -60, 0, -18, { unit: 'dB' }),
  def('ratio', 'Ratio', 1, 20, 4, { curve: 'log', unit: ': 1' }),
  def('attack', 'Attack', 0.05, 200, 8, { unit: 'ms', curve: 'log' }),
  def('release', 'Release', 5, 2000, 120, { unit: 'ms', curve: 'log' }),
  def('knee', 'Knee', 0, 24, 6, { unit: 'dB' }),
  def('gain', 'Make-up gain', -12, 24, 0, { unit: 'dB' }),
  bool('auto', 'Auto make-up', 0),
  choice('detect', 'Detector', ['Peak', 'RMS'], 0),
  choice('sidechain', 'Sidechain', ['Off', 'Sidechain bus'], 0),
  def('scHp', 'Sidechain high-pass', 20, 800, 20, { unit: 'Hz', curve: 'log' }),
];

export const meta = { id: 'compressor', name: 'Compressor', category: 'Dynamics', description: 'Compressor with soft knee and sidechain input' };

class Compressor {
  constructor(sr) {
    this.sr = sr;
    this.p = defaults(schema);
    this.gr = 0;            // smoothed gain reduction in dB (<= 0)
    this.rms = 0;
    this.hpZ = 0;
    this.meters = [0, 0, 0]; // GR dB, input peak dB, output peak dB
    this.peakIn = 0; this.peakOut = 0;
  }
  setParam(id, v) { this.p[id] = v; }
  reset() { this.gr = 0; this.rms = 0; this.hpZ = 0; }

  process(L, R, n, ctx) {
    const p = this.p, sr = this.sr;
    const aCo = Math.exp(-1 / (Math.max(p.attack, 0.02) * 0.001 * sr));
    const rCo = Math.exp(-1 / (p.release * 0.001 * sr));
    const slope = 1 / p.ratio - 1;
    const knee = p.knee, th = p.threshold;
    const auto = p.auto ? -th * (1 - 1 / p.ratio) * 0.5 : 0;
    const makeup = dbToGain(p.gain + auto);
    const useSc = p.sidechain === 1 && ctx && ctx.scL;
    const dL = useSc ? ctx.scL : L, dR = useSc ? ctx.scR : R;
    const hpA = Math.exp(-2 * Math.PI * p.scHp / sr);
    const rmsCo = Math.exp(-1 / (0.01 * sr));
    let gr = this.gr, rms = this.rms, z = this.hpZ, pin = 0, pout = 0, maxGr = 0;
    for (let i = 0; i < n; i++) {
      let x = Math.max(Math.abs(dL[i]), Math.abs(dR[i]));
      if (p.scHp > 21) { z = hpA * z + (1 - hpA) * x; x = Math.max(0, x - z); }
      if (p.detect === 1) { rms = rmsCo * rms + (1 - rmsCo) * x * x; x = Math.sqrt(rms); }
      const lvl = 20 * Math.log10(x + 1e-9);
      const over = lvl - th;
      let target;
      if (2 * over < -knee) target = 0;
      else if (2 * Math.abs(over) <= knee) { const k = over + knee / 2; target = slope * k * k / (2 * knee); }
      else target = slope * over;
      gr = target < gr ? aCo * gr + (1 - aCo) * target : rCo * gr + (1 - rCo) * target;
      const g = Math.pow(10, gr / 20) * makeup;
      const ai = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      L[i] *= g; R[i] *= g;
      const ao = ai * g;
      if (ai > pin) pin = ai;
      if (ao > pout) pout = ao;
      if (gr < maxGr) maxGr = gr;
    }
    this.gr = Math.abs(gr) < 1e-6 ? 0 : gr; this.rms = rms; this.hpZ = z;
    this.meters[0] = maxGr; this.meters[1] = 20 * Math.log10(pin + 1e-9); this.meters[2] = 20 * Math.log10(pout + 1e-9);
  }
}

export function create(sr) { return new Compressor(sr); }
