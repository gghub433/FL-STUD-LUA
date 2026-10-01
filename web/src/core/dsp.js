// DSP primitives shared by instruments and effects. Plain JS, allocation-free in the hot paths.

export const TAU = Math.PI * 2;

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(g > 1e-9 ? g : 1e-9);
export const mtof = (key) => 440 * Math.pow(2, (key - 69) / 12);
export const semi = (s) => Math.pow(2, s / 12);

// Mixer fader / channel volume law: 0.8 = unity (0 dB), 1.0 = about +5.8 dB, cubic below.
export const faderGain = (v) => {
  const r = (v < 0 ? 0 : v) / 0.8;
  return r * r * r;
};

export const fastTanh = (x) => {
  if (x < -3) return -1;
  if (x > 3) return 1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
};

// Equal-power pan, pan in -1..1 -> [gainL, gainR] (written into out to avoid garbage).
export function panGains(pan, out) {
  const a = (clamp(pan, -1, 1) + 1) * Math.PI * 0.25;
  out[0] = Math.cos(a) * Math.SQRT2;
  out[1] = Math.sin(a) * Math.SQRT2;
  return out;
}

export class Noise {
  constructor(seed = 22222) { this.s = seed >>> 0 || 1; }
  next() { // xorshift32 -> [-1, 1)
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 2147483648 - 1;
  }
}

// RBJ biquad, transposed direct form II.
export class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }

  reset() { this.z1 = 0; this.z2 = 0; }

  // type: lp hp bp notch peak ls hs ap
  set(type, sr, f, q = 0.7071, gainDb = 0) {
    f = clamp(f, 5, sr * 0.49);
    q = Math.max(q, 0.05);
    const w = (TAU * f) / sr, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q);
    const A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lp': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'hp': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'bp': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'notch': b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'ap': b0 = 1 - al; b1 = -2 * cw; b2 = 1 + al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'peak':
        b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; break;
      case 'ls': {
        const s = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
        a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; break;
      }
      case 'hs': {
        const s = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
        a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; break;
      }
      default: b0 = 1; b1 = 0; b2 = 0; a0 = 1; a1 = 0; a2 = 0;
    }
    const inv = 1 / a0;
    this.b0 = b0 * inv; this.b1 = b1 * inv; this.b2 = b2 * inv; this.a1 = a1 * inv; this.a2 = a2 * inv;
    return this;
  }

  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  // Magnitude response at frequency f (Hz) for UI curves.
  magnitude(f, sr) {
    const w = (TAU * f) / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = this.b0 + this.b1 * c1 + this.b2 * c2, ni = -(this.b1 * s1 + this.b2 * s2);
    const dr = 1 + this.a1 * c1 + this.a2 * c2, di = -(this.a1 * s1 + this.a2 * s2);
    return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di + 1e-30));
  }
}

// Zavalishin TPT state-variable filter: stable under fast modulation.
export class SVF {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.a1 = 0; this.a2 = 0; this.a3 = 0; this.k = 1; this.lp = 0; this.bp = 0; this.hp = 0; }

  reset() { this.ic1 = 0; this.ic2 = 0; }

  // res 0..1 -> Q 0.5..~25
  setup(sr, cutoff, res) {
    const g = Math.tan((Math.PI * clamp(cutoff, 10, sr * 0.49)) / sr);
    this.k = 1 / (0.5 + res * res * 24.5);
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  process(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2; this.bp = v1; this.hp = x - this.k * v1 - v2;
    return v2;
  }
}

export class OnePole {
  constructor() { this.a = 0; this.z = 0; }
  setCutoff(sr, f) { this.a = 1 - Math.exp((-TAU * clamp(f, 1, sr * 0.49)) / sr); }
  setTime(sr, seconds) { this.a = seconds <= 0 ? 1 : 1 - Math.exp(-1 / (seconds * sr)); }
  process(x) { this.z += this.a * (x - this.z); return this.z; }
}

// Circular delay line with linear fractional read. Size is rounded up to a power of two.
export class DelayLine {
  constructor(maxSamples) {
    let n = 2;
    while (n < maxSamples + 4) n <<= 1;
    this.buf = new Float32Array(n);
    this.mask = n - 1;
    this.w = 0;
  }
  clear() { this.buf.fill(0); this.w = 0; }
  write(x) { this.buf[this.w] = x; this.w = (this.w + 1) & this.mask; }
  // delay in samples (>= 1), counted back from the most recent write
  read(delay) {
    const r = this.w - delay;
    const i0 = Math.floor(r), fr = r - i0;
    const a = this.buf[i0 & this.mask], b = this.buf[(i0 + 1) & this.mask];
    return a + (b - a) * fr;
  }
  readInt(delay) { return this.buf[(this.w - delay) & this.mask]; }
}

export const LFO_SHAPES = ['Sine', 'Triangle', 'Saw up', 'Saw down', 'Square', 'Random'];

export class LFO {
  constructor(seed = 1) { this.phase = 0; this.noise = new Noise(seed * 7919 + 13); this.held = 0; this.shape = 0; this.fadeIn = 1; }
  reset(phase = 0) { this.phase = phase; this.held = this.noise.next(); }
  // advance by inc (cycles/sample) and return -1..1
  next(inc) {
    this.phase += inc;
    if (this.phase >= 1) { this.phase -= 1; this.held = this.noise.next(); }
    const p = this.phase;
    switch (this.shape) {
      case 0: return Math.sin(TAU * p);
      case 1: return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
      case 2: return 2 * p - 1;
      case 3: return 1 - 2 * p;
      case 4: return p < 0.5 ? 1 : -1;
      default: return this.held;
    }
  }
}

// Delay-Attack-Hold-Decay-Sustain-Release envelope. Times in seconds.
export class DAHDSR {
  constructor() { this.stage = 0; this.v = 0; this.t = 0; this.rel0 = 0; }
  // stages: 0 idle, 1 delay, 2 attack, 3 hold, 4 decay, 5 sustain, 6 release
  trigger() { this.stage = 1; this.t = 0; this.v = 0; }
  release() { if (this.stage > 0 && this.stage < 6) { this.stage = 6; this.t = 0; this.rel0 = this.v; } }
  get done() { return this.stage === 0; }

  // Advance by n samples (control rate). p = {delay, attack, hold, decay, sustain, release} in seconds / level.
  step(n, sr, p) {
    let left = n;
    while (left > 0) {
      switch (this.stage) {
        case 1: {
          const len = p.delay * sr;
          if (this.t + left < len) { this.t += left; return this.v; }
          left -= Math.max(0, len - this.t); this.stage = 2; this.t = 0; break;
        }
        case 2: {
          const len = Math.max(p.attack * sr, 1);
          if (this.t + left < len) { this.t += left; this.v = (this.t / len); return this.v; }
          left -= len - this.t; this.v = 1; this.stage = 3; this.t = 0; break;
        }
        case 3: {
          const len = p.hold * sr;
          if (this.t + left < len) { this.t += left; return this.v; }
          left -= Math.max(0, len - this.t); this.stage = 4; this.t = 0; break;
        }
        case 4: {
          const tc = Math.max(p.decay, 0.001) * sr / 4.6; // reaches ~1% of the distance after `decay`
          const target = p.sustain;
          this.v = target + (this.v - target) * Math.exp(-left / tc);
          if (Math.abs(this.v - target) < 0.0005) { this.v = target; this.stage = 5; }
          return this.v;
        }
        case 5: this.v = p.sustain; return this.v;
        case 6: {
          const tc = Math.max(p.release, 0.0005) * sr / 4.6;
          this.v *= Math.exp(-left / tc);
          if (this.v < 0.0003) { this.v = 0; this.stage = 0; }
          return this.v;
        }
        default: return 0;
      }
    }
    return this.v;
  }
}

// Linear-segment ADSR, per-sample, for synth voices.
export class ADSR {
  constructor() { this.stage = 0; this.v = 0; }
  trigger() { this.stage = 1; }
  release() { if (this.stage !== 0) this.stage = 4; }
  get done() { return this.stage === 0; }
  // coefficients precomputed by caller: aInc (per sample), dCo, sustain, rCo
  next(aInc, dCo, sus, rCo) {
    switch (this.stage) {
      case 1: this.v += aInc; if (this.v >= 1) { this.v = 1; this.stage = 2; } break;
      case 2: this.v = sus + (this.v - sus) * dCo; if (this.v - sus < 0.0005) { this.v = sus; this.stage = 3; } break;
      case 3: this.v = sus; break;
      case 4: this.v *= rCo; if (this.v < 0.0002) { this.v = 0; this.stage = 0; } break;
      default: this.v = 0;
    }
    return this.v;
  }
}

export const timeCoef = (seconds, sr) => Math.exp(-4.6 / Math.max(seconds * sr, 1));

// Band-limited step correction for saw/square oscillators.
export function polyBlep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

// 4-point Hermite interpolation on a Float32Array.
export function hermite(data, pos, len) {
  const i = Math.floor(pos), f = pos - i;
  const x0 = i > 0 ? data[i - 1] : data[0];
  const x1 = data[i];
  const x2 = i + 1 < len ? data[i + 1] : 0;
  const x3 = i + 2 < len ? data[i + 2] : 0;
  const c = (x2 - x0) * 0.5;
  const v = x1 - x2;
  const w = c + v;
  const a = w + v + (x3 - x1) * 0.5;
  const b = w + a;
  return ((a * f - b) * f + c) * f + x1;
}

// Tempo-sync divisions: [label, length in beats]
export const SYNC_DIVS = [
  ['1/32', 0.125], ['1/16T', 1 / 6], ['1/16', 0.25], ['1/16.', 0.375], ['1/8T', 1 / 3], ['1/8', 0.5], ['1/8.', 0.75],
  ['1/4T', 2 / 3], ['1/4', 1], ['1/4.', 1.5], ['1/2T', 4 / 3], ['1/2', 2], ['1/2.', 3], ['1 bar', 4], ['2 bars', 8],
];
export const SYNC_LABELS = SYNC_DIVS.map((d) => d[0]);
