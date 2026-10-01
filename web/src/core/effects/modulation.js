// Chorus, Flanger and Phaser. Three small effects sharing LFO / delay helpers.
import { def, choice, defaults } from '../schema.js';
import { DelayLine, dbToGain, TAU } from '../dsp.js';

// ------------------------------------------------------------------------------ chorus
export const chorusSchema = [
  def('rate', 'Rate', 0.05, 8, 0.6, { unit: 'Hz', curve: 'log' }),
  def('depth', 'Depth', 0, 1, 0.5),
  def('delay', 'Delay', 2, 30, 13, { unit: 'ms' }),
  choice('voices', 'Voices', ['2', '3', '4'], 1),
  def('width', 'Stereo width', 0, 1, 0.8),
  def('feedback', 'Feedback', 0, 0.7, 0),
  def('dry', 'Dry', -60, 6, 0, { unit: 'dB' }),
  def('wet', 'Wet', -60, 6, -3, { unit: 'dB' }),
];
export const chorusMeta = { id: 'chorus', name: 'Chorus', category: 'Modulation', description: 'Multi-voice chorus' };

class Chorus {
  constructor(sr) {
    this.sr = sr; this.p = defaults(chorusSchema);
    this.dl = new DelayLine(Math.ceil(0.08 * sr)); this.dr = new DelayLine(Math.ceil(0.08 * sr));
    this.ph = 0; this.fbL = 0; this.fbR = 0;
  }
  setParam(id, v) { this.p[id] = v; }
  reset() { this.dl.clear(); this.dr.clear(); this.fbL = this.fbR = 0; }
  process(L, R, n) {
    const p = this.p, sr = this.sr;
    const nv = p.voices + 2;
    const base = p.delay * 0.001 * sr, depth = p.depth * 0.006 * sr;
    const inc = p.rate / sr;
    const dry = dbToGain(p.dry) * (p.dry <= -59.5 ? 0 : 1), wet = dbToGain(p.wet) * (p.wet <= -59.5 ? 0 : 1);
    const fb = p.feedback, wd = p.width;
    for (let i = 0; i < n; i++) {
      this.ph += inc; if (this.ph >= 1) this.ph -= 1;
      this.dl.write(L[i] + this.fbL * fb); this.dr.write(R[i] + this.fbR * fb);
      let wl = 0, wr = 0;
      for (let v = 0; v < nv; v++) {
        const lfo = Math.sin(TAU * (this.ph + v / nv));
        const d = base + depth * lfo + v * 0.0004 * sr;
        const a = this.dl.read(Math.max(2, d)), b = this.dr.read(Math.max(2, d));
        const pan = nv === 1 ? 0.5 : v / (nv - 1);
        const gl = 1 - pan * wd, gr = 0.5 + (pan - 0.5) * wd + 0.5 * (1 - wd);
        wl += a * gl * 0.7; wr += b * (gr > 1 ? 1 : gr) * 0.7;
      }
      wl /= Math.sqrt(nv); wr /= Math.sqrt(nv);
      this.fbL = wl; this.fbR = wr;
      L[i] = L[i] * dry + wl * wet; R[i] = R[i] * dry + wr * wet;
    }
  }
}
export function createChorus(sr) { return new Chorus(sr); }

// ------------------------------------------------------------------------------ flanger
export const flangerSchema = [
  def('rate', 'Rate', 0.02, 6, 0.25, { unit: 'Hz', curve: 'log' }),
  def('depth', 'Depth', 0, 1, 0.7),
  def('delay', 'Delay', 0.1, 10, 1.5, { unit: 'ms', curve: 'log' }),
  def('feedback', 'Feedback', -0.95, 0.95, 0.5),
  def('phase', 'Stereo phase', 0, 0.5, 0.25),
  def('dry', 'Dry', -60, 6, 0, { unit: 'dB' }),
  def('wet', 'Wet', -60, 6, -3, { unit: 'dB' }),
];
export const flangerMeta = { id: 'flanger', name: 'Flanger', category: 'Modulation', description: 'Swept short delay with feedback' };

class Flanger {
  constructor(sr) {
    this.sr = sr; this.p = defaults(flangerSchema);
    this.dl = new DelayLine(Math.ceil(0.03 * sr)); this.dr = new DelayLine(Math.ceil(0.03 * sr));
    this.ph = 0; this.fbL = 0; this.fbR = 0;
  }
  setParam(id, v) { this.p[id] = v; }
  reset() { this.dl.clear(); this.dr.clear(); this.fbL = this.fbR = 0; }
  process(L, R, n) {
    const p = this.p, sr = this.sr;
    const base = p.delay * 0.001 * sr, depth = base * 0.9 * p.depth;
    const inc = p.rate / sr;
    const dry = dbToGain(p.dry) * (p.dry <= -59.5 ? 0 : 1), wet = dbToGain(p.wet) * (p.wet <= -59.5 ? 0 : 1);
    for (let i = 0; i < n; i++) {
      this.ph += inc; if (this.ph >= 1) this.ph -= 1;
      const dL = base + depth * (0.5 + 0.5 * Math.sin(TAU * this.ph));
      const dR = base + depth * (0.5 + 0.5 * Math.sin(TAU * (this.ph + p.phase)));
      this.dl.write(L[i] + this.fbL * p.feedback); this.dr.write(R[i] + this.fbR * p.feedback);
      const wl = this.dl.read(Math.max(1.5, dL)), wr = this.dr.read(Math.max(1.5, dR));
      this.fbL = wl; this.fbR = wr;
      L[i] = L[i] * dry + wl * wet; R[i] = R[i] * dry + wr * wet;
    }
  }
}
export function createFlanger(sr) { return new Flanger(sr); }

// ------------------------------------------------------------------------------ phaser
export const phaserSchema = [
  def('rate', 'Rate', 0.02, 8, 0.4, { unit: 'Hz', curve: 'log' }),
  def('depth', 'Depth', 0, 1, 0.8),
  def('center', 'Center', 100, 5000, 900, { unit: 'Hz', curve: 'log' }),
  choice('stages', 'Stages', ['2', '4', '6', '8', '10', '12'], 2),
  def('feedback', 'Feedback', -0.9, 0.9, 0.4),
  def('phase', 'Stereo phase', 0, 0.5, 0.25),
  def('dry', 'Dry', -60, 6, 0, { unit: 'dB' }),
  def('wet', 'Wet', -60, 6, -3, { unit: 'dB' }),
];
export const phaserMeta = { id: 'phaser', name: 'Phaser', category: 'Modulation', description: 'All-pass phaser with up to 12 stages' };

class Phaser {
  constructor(sr) {
    this.sr = sr; this.p = defaults(phaserSchema);
    this.x1 = [new Float64Array(12), new Float64Array(12)]; this.y1 = [new Float64Array(12), new Float64Array(12)];
    this.ph = 0; this.fb = [0, 0];
  }
  setParam(id, v) { this.p[id] = v; }
  reset() { for (const a of [...this.x1, ...this.y1]) a.fill(0); this.fb = [0, 0]; }
  process(L, R, n) {
    const p = this.p, sr = this.sr;
    const stages = (p.stages + 1) * 2;
    const inc = p.rate / sr;
    const dry = dbToGain(p.dry) * (p.dry <= -59.5 ? 0 : 1), wet = dbToGain(p.wet) * (p.wet <= -59.5 ? 0 : 1);
    const span = p.depth * 3; // octaves swept around the centre
    for (let i = 0; i < n; i++) {
      this.ph += inc; if (this.ph >= 1) this.ph -= 1;
      for (let c = 0; c < 2; c++) {
        const lfo = Math.sin(TAU * (this.ph + (c ? p.phase : 0)));
        const f = Math.min(sr * 0.45, p.center * Math.pow(2, lfo * span * 0.5));
        const tn = Math.tan(Math.PI * f / sr), a = (tn - 1) / (tn + 1);
        const x0 = c === 0 ? L[i] : R[i];
        let x = x0 + this.fb[c] * p.feedback;
        const x1 = this.x1[c], y1 = this.y1[c];
        for (let s = 0; s < stages; s++) {
          const y = a * x + x1[s] - a * y1[s];
          x1[s] = x; y1[s] = y; x = y;
        }
        this.fb[c] = x;
        const out = x0 * dry + (x0 + x) * 0.5 * wet;
        if (c === 0) L[i] = out; else R[i] = out;
      }
    }
  }
}
export function createPhaser(sr) { return new Phaser(sr); }
