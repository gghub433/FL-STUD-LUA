// Organ: tonewheel-style additive organ. Nine drawbars (16' .. 1') set the level of nine harmonics,
// a percussion partial (2nd or 3rd harmonic) decays after every key press, key click, vibrato, a
// rotary-speaker style tremolo and overdrive finish the sound.
import { def, bool, choice, defaults, schemaMap } from '../schema.js';
import { Noise, mtof, clamp, TAU } from '../dsp.js';

// drawbar footage -> multiple of the 8' (played) pitch
export const FOOTAGE = [["16'", 0.5], ["5 1/3'", 1.5], ["8'", 1], ["4'", 2], ["2 2/3'", 3], ["2'", 4], ["1 3/5'", 5], ["1 1/3'", 6], ["1'", 8]];
export const PRESETS = {
  'Full': [8, 8, 8, 8, 8, 8, 8, 8, 8], 'Jazz': [8, 8, 8, 0, 0, 0, 0, 0, 0], 'Gospel': [8, 8, 8, 6, 4, 4, 2, 2, 4],
  'Rock': [8, 8, 8, 8, 0, 0, 0, 0, 0], 'Soft flute': [0, 0, 8, 0, 0, 0, 0, 0, 0], 'Reed': [0, 0, 8, 6, 8, 6, 4, 3, 0],
};

export const schema = [
  ...FOOTAGE.map(([n], i) => def(`d${i}`, `Drawbar ${n}`, 0, 8, [8, 8, 8, 0, 0, 0, 0, 0, 0][i], { int: true, group: 'Drawbars' })),
  bool('perc', 'Percussion', 0, { group: 'Percussion' }),
  choice('percHarm', 'Percussion harmonic', ['2nd', '3rd'], 1, { group: 'Percussion' }),
  choice('percDecay', 'Percussion decay', ['Fast', 'Slow'], 0, { group: 'Percussion' }),
  def('percLevel', 'Percussion level', 0, 1, 0.7, { group: 'Percussion' }),
  def('click', 'Key click', 0, 1, 0.25, { group: 'Sound' }),
  def('vibrato', 'Vibrato depth', 0, 1, 0, { group: 'Sound' }),
  def('vibRate', 'Vibrato rate', 3, 9, 6.5, { unit: 'Hz', group: 'Sound' }),
  choice('rotary', 'Rotary speaker', ['Off', 'Slow', 'Fast'], 0, { group: 'Sound' }),
  def('rotDepth', 'Rotary depth', 0, 1, 0.5, { group: 'Sound' }),
  def('drive', 'Overdrive', 0, 1, 0.15, { group: 'Sound' }),
  def('release', 'Release', 5, 500, 40, { unit: 'ms', curve: 'log', group: 'Sound' }),
  def('gain', 'Gain', 0, 1.5, 0.8, { group: 'Sound' }),
];
export const meta = { id: 'organ', name: 'Organ', kind: 'organ', rootDefault: 60, description: 'Tonewheel-style drawbar organ' };
export const paramMap = schemaMap(schema);

const TABLE = (() => { const t = new Float32Array(2049); for (let i = 0; i <= 2048; i++) t[i] = Math.sin((TAU * i) / 2048); return t; })();
const sinT = (ph) => { const x = ph * 2048, i = x | 0, f = x - i; return TABLE[i] + (TABLE[i + 1] - TABLE[i]) * f; };

class Voice { constructor(i) { this.alive = false; this.ph = new Float64Array(9); this.noise = new Noise(100 + i * 31); } }

export class Organ {
  constructor(sr) {
    this.sr = sr; this.p = defaults(schema);
    this.voices = Array.from({ length: 24 }, (_, i) => new Voice(i));
    this.counter = 0; this.vib = 0; this.rot = 0; this.rotRate = 0; this.lpL = 0; this.lpR = 0;
  }
  get active() { for (const v of this.voices) if (v.alive) return true; return false; }
  setParam(id, v) { this.p[id] = v; }
  allOff() { for (const v of this.voices) v.alive = false; }
  chokeAll() { for (const v of this.voices) if (v.alive) v.released = true; }

  noteOn(ev) {
    let v = null, oldest = null;
    for (const x of this.voices) { if (x.alive) { if (!oldest || x.time < oldest.time) oldest = x; } else if (!v) v = x; }
    if (!v) v = oldest;
    v.alive = true; v.released = false; v.key = ev.key; v.time = ++this.counter; v.age = 0;
    v.f0 = mtof(ev.key + (ev.fine || 0) / 100); v.vel = 0.55 + 0.45 * ev.vel; v.env = 0; v.pe = 1; v.ck = 1;
    v.pan = clamp(ev.pan || 0, -1, 1);
    for (let k = 0; k < 9; k++) v.ph[k] = (k * 0.173) % 1;              // fixed phase offsets, like tonewheels
  }
  noteOff(key) { for (const v of this.voices) if (v.alive && !v.released && v.key === key) v.released = true; }

  process(L, R, i0, i1) {
    const p = this.p, sr = this.sr;
    const amps = this._amps || (this._amps = new Float64Array(9));
    let total = 0;
    for (let k = 0; k < 9; k++) { const lv = p[`d${k}`]; amps[k] = lv === 0 ? 0 : Math.pow(10, (-3 * (8 - lv)) / 20); total += amps[k]; }
    const norm = 0.55 / Math.sqrt(Math.max(total, 1));       // more open drawbars are louder, but less than proportionally
    const percMul = p.percHarm === 0 ? 2 : 3;
    const percDec = Math.exp(-1 / ((p.percDecay === 0 ? 0.22 : 0.65) * sr));
    const attack = 1 - Math.exp(-1 / (0.002 * sr)), relCo = Math.exp(-1 / (Math.max(0.002, p.release * 0.001) * sr));
    const rotTarget = p.rotary === 0 ? 0 : p.rotary === 1 ? 0.8 : 6.5;
    const drive = 1 + p.drive * 6, dNorm = 1 / Math.tanh(drive);
    const clickDec = Math.exp(-1 / (0.004 * sr));
    const lpA = 1 - Math.exp((-TAU * 9000) / sr);
    for (let i = i0; i < i1; i++) {
      this.vib += p.vibRate / sr; if (this.vib >= 1) this.vib -= 1;
      this.rotRate += (rotTarget - this.rotRate) * (2.2 / sr);           // the horn takes a moment to speed up or slow down
      this.rot += this.rotRate / sr; if (this.rot >= 1) this.rot -= 1;
      const vibMul = 1 + p.vibrato * 0.012 * Math.sin(TAU * this.vib);
      const rotSin = Math.sin(TAU * this.rot);
      const tremolo = 1 - p.rotDepth * (p.rotary === 0 ? 0 : 0.35) * (0.5 - 0.5 * rotSin);
      const panMod = p.rotary === 0 ? 0 : p.rotDepth * 0.6 * Math.sin(TAU * this.rot + 1.2);
      let sl = 0, sr_ = 0;
      for (const v of this.voices) {
        if (!v.alive) continue;
        v.env = v.released ? v.env * relCo : v.env + (1 - v.env) * attack;
        if (v.released && v.env < 0.0005) { v.alive = false; continue; }
        const inc = (v.f0 * 0.5 * vibMul) / sr;                         // phase of the 16' wheel
        let s = 0;
        for (let k = 0; k < 9; k++) {
          if (amps[k] === 0) { continue; }
          let ph = v.ph[k] + inc * FOOTAGE[k][1] * 2; ph -= Math.floor(ph); v.ph[k] = ph;
          s += sinT(ph) * amps[k];
        }
        s *= norm;
        if (p.perc) {
          // percussion: extra 2nd/3rd harmonic that fades quickly (plays on every key press)
          v.pe *= percDec;
          s += Math.sin(TAU * ((v.age * v.f0 * percMul) / sr % 1)) * v.pe * p.percLevel * norm * 2.4;
        }
        if (p.click > 0 && v.ck > 0.001) { s += v.noise.next() * v.ck * p.click * 0.25; v.ck *= clickDec; }
        v.age++;
        const out = s * v.env * v.vel;
        const pan = clamp(v.pan + panMod, -1, 1), a = (pan + 1) * 0.7853981634;
        sl += out * Math.cos(a) * 1.41421356; sr_ += out * Math.sin(a) * 1.41421356;
      }
      sl = Math.tanh(sl * drive) * dNorm * tremolo * p.gain; sr_ = Math.tanh(sr_ * drive) * dNorm * tremolo * p.gain;
      this.lpL += (sl - this.lpL) * lpA; this.lpR += (sr_ - this.lpR) * lpA;       // tames the click and fold-over of the overdrive
      L[i] += this.lpL; R[i] += this.lpR;
    }
  }
}

export function create(sr) { return new Organ(sr); }
