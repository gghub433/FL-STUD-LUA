// Pluck: Karplus-Strong plucked string. A burst of noise (shaped by pick position and brightness)
// circulates in a delay line whose length sets the pitch; a damping low-pass and a loop gain set how
// fast the sound dies. Two slightly detuned strings per voice give width.
import { def, defaults, schemaMap } from '../schema.js';
import { Noise, mtof, clamp } from '../dsp.js';

export const schema = [
  def('decay', 'Decay', 0.1, 20, 3, { unit: 's', curve: 'log', group: 'String' }),
  def('damping', 'Damping', 0, 1, 0.35, { group: 'String' }),
  def('pickPos', 'Pick position', 0.05, 0.5, 0.25, { group: 'String' }),
  def('bright', 'Pick brightness', 0, 1, 0.7, { group: 'String' }),
  def('velBright', 'Velocity to brightness', 0, 1, 0.5, { group: 'String' }),
  def('release', 'Release (mute)', 5, 2000, 120, { unit: 'ms', curve: 'log', group: 'String' }),
  def('width', 'Stereo width', 0, 1, 0.5, { group: 'Output' }),
  def('detune', 'String detune', 0, 20, 5, { unit: 'cents', group: 'Output' }),
  def('poly', 'Polyphony', 1, 16, 12, { int: true, group: 'Output' }),
  def('gain', 'Gain', 0, 1.5, 0.9, { group: 'Output' }),
];
export const meta = { id: 'pluck', name: 'Pluck', kind: 'string', rootDefault: 60, description: 'Karplus-Strong plucked string' };
export const paramMap = schemaMap(schema);

class String1 {
  constructor(size) { this.buf = new Float32Array(size); this.mask = size - 1; this.w = 0; this.N = 0; this.c = 0; this.apx = 0; this.apy = 0; this.lp = 0; }
}

class Voice {
  constructor(size, seed) { this.alive = false; this.s = [new String1(size), new String1(size)]; this.noise = new Noise(seed); }
}

export class Pluck {
  constructor(sr) {
    this.sr = sr; this.p = defaults(schema);
    let size = 1024; while (size < sr / 14) size <<= 1;          // longest period: ~14 Hz
    this.voices = Array.from({ length: 16 }, (_, i) => new Voice(size, 31 + i * 977));
    this.burst = new Float32Array(size);
    this.counter = 0;
  }

  get active() { for (const v of this.voices) if (v.alive) return true; return false; }
  setParam(id, v) { this.p[id] = v; }
  allOff() { for (const v of this.voices) v.alive = false; }
  chokeAll() { for (const v of this.voices) if (v.alive) { v.released = true; v.rg = 0.9; } }

  noteOn(ev) {
    const p = this.p, sr = this.sr;
    let v = null, n = 0, oldest = null;
    for (const x of this.voices) { if (x.alive) { n++; if (!oldest || x.time < oldest.time) oldest = x; } else if (!v) v = x; }
    if (!v || n >= p.poly) { if (!oldest) return; v = oldest; }
    v.alive = true; v.released = false; v.rg = 1; v.key = ev.key; v.time = ++this.counter; v.age = 0;
    const f0 = mtof(ev.key + (ev.fine || 0) / 100);
    const a = 1 - 0.85 * p.damping;                         // one-pole low-pass coefficient in the loop
    const tauLp = (1 - a) / a;                              // its phase delay at low frequencies, in samples
    const bright = clamp(p.bright * (1 - p.velBright) + p.velBright * ev.vel, 0.02, 1);
    const g = Math.pow(10, (-3 * (1 / f0)) / p.decay);      // loop gain for a T60 of `decay` seconds
    v.a = a; v.g = Math.min(0.99995, g);
    const detune = [-p.detune * p.width * 0.5, p.detune * p.width * 0.5];
    const pan = clamp(ev.pan || 0, -1, 1), ang = (pan + 1) * 0.7853981634;
    v.gl = Math.cos(ang) * 1.41421356 * ev.vel; v.gr = Math.sin(ang) * 1.41421356 * ev.vel;
    v.relG = Math.pow(10, (-3 * (1 / f0)) / Math.max(0.005, p.release * 0.001));
    for (let k = 0; k < 2; k++) {
      const s = v.s[k];
      const total = sr / mtof(ev.key + (ev.fine || 0) / 100 + detune[k] / 100);
      const N = Math.max(2, Math.floor(total - tauLp - 0.5));
      const tau = total - tauLp - N;                         // 0.5 .. 1.5 samples left for the all-pass
      s.N = N; s.c = (1 - tau) / (1 + tau); s.apx = s.apy = s.lp = 0;
      // excitation: noise, low-passed by `bright`, comb-filtered by the pick position
      let lp = 0;
      const burst = this.burst;
      for (let i = 0; i < N; i++) { lp += (v.noise.next() - lp) * (0.08 + 0.92 * bright * bright); burst[i] = lp; }
      const off = Math.max(1, Math.round(p.pickPos * N));
      let peak = 1e-9;
      for (let i = 0; i < N; i++) { burst[i] -= burst[(i - off + N) % N]; if (Math.abs(burst[i]) > peak) peak = Math.abs(burst[i]); }
      s.buf.fill(0);
      for (let i = 0; i < N; i++) s.buf[i] = burst[i] / peak * 0.8;
      s.w = N;
    }
  }

  noteOff(key) {
    for (const v of this.voices) if (v.alive && !v.released && v.key === key) v.released = true;
  }

  process(L, R, i0, i1) {
    const gain = this.p.gain;
    for (const v of this.voices) {
      if (!v.alive) continue;
      const g = v.released ? v.g * v.relG : v.g, a = v.a;
      const s0 = v.s[0], s1 = v.s[1];
      for (let i = i0; i < i1; i++) {
        let y0 = s0.buf[(s0.w - s0.N) & s0.mask], y1 = s1.buf[(s1.w - s1.N) & s1.mask];
        s0.lp += a * (y0 - s0.lp); s1.lp += a * (y1 - s1.lp);
        const f0 = s0.lp * g, f1 = s1.lp * g;
        const o0 = s0.c * (f0 - s0.apy) + s0.apx; s0.apx = f0; s0.apy = o0;
        const o1 = s1.c * (f1 - s1.apy) + s1.apx; s1.apx = f1; s1.apy = o1;
        s0.buf[s0.w & s0.mask] = o0; s0.w = (s0.w + 1) & s0.mask;
        s1.buf[s1.w & s1.mask] = o1; s1.w = (s1.w + 1) & s1.mask;
        const w = this.p.width;
        const m = (y0 + y1) * 0.5;
        const l = m + (y0 - m) * w, r = m + (y1 - m) * w;
        L[i] += l * v.gl * gain; R[i] += r * v.gr * gain;
      }
      v.age += i1 - i0;
      // silent strings free their voice (checked per block)
      if (v.age > 256 && Math.abs(s0.lp) < 1e-5 && Math.abs(s1.lp) < 1e-5 && v.age > 2 * s0.N) {
        let e = 0; for (let k = 0; k < s0.N; k += 7) e = Math.max(e, Math.abs(s0.buf[(s0.w - 1 - k) & s0.mask]));
        if (e < 1e-5) v.alive = false;
      }
    }
  }
}

export function create(sr) { return new Pluck(sr); }
