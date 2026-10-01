// Algorithmic reverb: pre-delay -> input diffusion (4 allpasses) -> 8-line feedback delay
// network with a Hadamard mixing matrix, per-line damping and slow delay modulation.
import { def, defaults } from '../schema.js';
import { DelayLine, dbToGain, OnePole, clamp } from '../dsp.js';

export const schema = [
  def('size', 'Room size', 0.3, 2, 1, { group: 'Main' }),
  def('decay', 'Decay (RT60)', 0.1, 20, 2.4, { unit: 's', curve: 'log', group: 'Main' }),
  def('damping', 'Damping', 0, 1, 0.45, { group: 'Main' }),
  def('predelay', 'Pre-delay', 0, 250, 12, { unit: 'ms', group: 'Main' }),
  def('diffusion', 'Diffusion', 0, 1, 0.7, { group: 'Main' }),
  def('mod', 'Modulation', 0, 1, 0.3, { group: 'Main' }),
  def('width', 'Stereo width', 0, 1, 1, { group: 'Main' }),
  def('lowcut', 'Low cut', 20, 1000, 120, { unit: 'Hz', curve: 'log', group: 'Tone' }),
  def('highcut', 'High cut', 1000, 20000, 11000, { unit: 'Hz', curve: 'log', group: 'Tone' }),
  def('dry', 'Dry', -60, 6, 0, { unit: 'dB', group: 'Level' }),
  def('wet', 'Wet', -60, 6, -8, { unit: 'dB', group: 'Level' }),
];

export const meta = { id: 'reverb', name: 'Reverb', category: 'Space', description: 'Feedback-delay-network reverb with damping and modulation' };

const BASE = [1087, 1283, 1481, 1699, 1951, 2203, 2389, 2657];
const AP = [142, 107, 379, 277];

class Reverb {
  constructor(sr) {
    this.sr = sr;
    this.p = defaults(schema);
    const k = sr / 44100;
    this.k = k;
    this.lines = BASE.map((b) => new DelayLine(Math.ceil(b * 2.2 * k) + 64));
    this.len = new Float64Array(8);
    this.fb = new Float64Array(8);
    this.damp = new Float64Array(8);
    this.y = new Float64Array(8);
    this.pre = new DelayLine(Math.ceil(0.26 * sr));
    this.ap = AP.map((l) => ({ d: new DelayLine(Math.ceil(l * k) + 8), n: Math.round(l * k) }));
    this.lfoPh = [0, 0.37, 0.61, 0.83, 0.12, 0.5, 0.74, 0.25];
    this.hpL = new OnePole(); this.hpR = new OnePole(); this.lpL = new OnePole(); this.lpR = new OnePole();
    this.dirty = true;
    this.hpStateL = 0; this.hpStateR = 0;
  }

  setParam(id, v) { this.p[id] = v; this.dirty = true; }

  reset() {
    for (const l of this.lines) l.clear();
    this.pre.clear();
    for (const a of this.ap) a.d.clear();
    this.damp.fill(0);
    this.hpStateL = this.hpStateR = 0;
    this.lpL.z = this.lpR.z = 0;
  }

  configure() {
    const { p, sr, k } = this;
    for (let i = 0; i < 8; i++) {
      this.len[i] = BASE[i] * k * p.size;
      this.fb[i] = Math.pow(10, (-3 * this.len[i]) / (p.decay * sr));
    }
    this.dampCo = 1 - Math.exp((-2 * Math.PI * (18000 * Math.pow(1 - p.damping, 2) + 800)) / sr);
    this.lpL.setCutoff(sr, p.highcut); this.lpR.setCutoff(sr, p.highcut);
    this.hpCo = 1 - Math.exp((-2 * Math.PI * p.lowcut) / sr);
    this.apG = 0.2 + 0.5 * p.diffusion;
    this.dirty = false;
  }

  process(L, R, n) {
    if (this.dirty) this.configure();
    const { p, sr, lines, len, fb, y, ap } = this;
    const dry = dbToGain(p.dry) * (p.dry <= -59.5 ? 0 : 1), wet = dbToGain(p.wet) * (p.wet <= -59.5 ? 0 : 1);
    const preD = Math.max(1, p.predelay * 0.001 * sr);
    const modDepth = p.mod * 6 * this.k, modInc = 0.35 / sr;
    const dCo = this.dampCo, g = this.apG;
    const wd = clamp(p.width, 0, 1);
    const s8 = 0.35355339; // 1/sqrt(8)
    for (let i = 0; i < n; i++) {
      const dl = L[i], dr = R[i];
      let x = (dl + dr) * 0.5;
      this.pre.write(x);
      x = this.pre.read(preD);
      // input diffusion
      for (let a = 0; a < 4; a++) {
        const d = ap[a].d;
        const del = d.readInt(ap[a].n);
        const v = x - g * del;
        d.write(v);
        x = del + g * v;
      }
      // read the lines (two of them slowly modulated)
      for (let l = 0; l < 8; l++) {
        const ph = (this.lfoPh[l] += modInc * (1 + l * 0.13));
        if (ph >= 1) this.lfoPh[l] -= 1;
        const m = modDepth * Math.sin(6.283185307 * this.lfoPh[l]);
        y[l] = lines[l].read(Math.max(2, len[l] + m));
      }
      // Hadamard mixing (fast Walsh-Hadamard, 8 points)
      for (let s = 1; s < 8; s <<= 1) {
        for (let a = 0; a < 8; a += s << 1) {
          for (let b = a; b < a + s; b++) { const u = y[b], v = y[b + s]; y[b] = u + v; y[b + s] = u - v; }
        }
      }
      let oL = 0, oR = 0;
      for (let l = 0; l < 8; l++) {
        const w = y[l] * s8 * fb[l] + x * 0.35;
        this.damp[l] += dCo * (w - this.damp[l]);
        lines[l].write(this.damp[l]);
        if (l & 1) oR += y[l] * (l & 2 ? -1 : 1); else oL += y[l] * (l & 2 ? -1 : 1);
      }
      oL *= 0.5; oR *= 0.5;
      const mid = (oL + oR) * 0.5, side = (oL - oR) * 0.5;
      let wl = mid + side * wd, wr = mid - side * wd;
      // tone: high-pass (one-pole) then low-pass
      this.hpStateL += this.hpCo * (wl - this.hpStateL); wl -= this.hpStateL;
      this.hpStateR += this.hpCo * (wr - this.hpStateR); wr -= this.hpStateR;
      wl = this.lpL.process(wl); wr = this.lpR.process(wr);
      L[i] = dl * dry + wl * wet;
      R[i] = dr * dry + wr * wet;
    }
  }
}

export function create(sr) { return new Reverb(sr); }
