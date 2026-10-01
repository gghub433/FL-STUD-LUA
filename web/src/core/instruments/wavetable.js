// Wavetable synth. Each wavetable is a set of 16 single-cycle frames defined by harmonic spectra and
// rendered with an inverse FFT; every frame exists in several band-limited mip levels so notes of any
// pitch play without aliasing. `Position` scans through the frames (and can be modulated by an envelope
// and an LFO), followed by unison, a sub oscillator, a multimode filter and amp/filter envelopes.
import { def, bool, choice, defaults, schemaMap } from '../schema.js';
import { getFFT } from '../fft.js';
import { SVF, ADSR, LFO, Noise, LFO_SHAPES, mtof, clamp, timeCoef, TAU } from '../dsp.js';

const N = 2048, H = 1023, FRAMES = 16, MIPS = 9;

// ---- table definitions: gen(t, h) -> { s, c } amplitudes of the sine / cosine partial h at morph position t (0..1)
const saw = (h) => 1 / h;
const sq = (h) => (h & 1 ? 1 / h : 0);
const tri = (h) => (h & 1 ? (((h - 1) / 2) & 1 ? -1 : 1) / (h * h) : 0);
const sine = (h) => (h === 1 ? 1 : 0);
const mix = (a, b, u) => a * (1 - u) + b * u;
const gauss = (h, c, w) => Math.exp(-(((h - c) / w) ** 2));
const hash = (n) => { let x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

export const TABLES = [
  { name: 'Analog sweep', gen: (t, h) => {
    const u = t * 3;
    const a = u < 1 ? [sine, tri, u] : u < 2 ? [tri, saw, u - 1] : [saw, sq, u - 2];
    return { s: mix(a[0](h), a[1](h), a[2]) };
  } },
  { name: 'Pulse width', gen: (t, h) => {
    const phi = TAU * (0.5 - 0.44 * t);
    return { s: (1 - Math.cos(h * phi)) / h, c: Math.sin(h * phi) / h };
  } },
  { name: 'Vowels', gen: (t, h) => {
    const V = [[5, 10, 26], [3, 22, 30], [2, 28, 36], [4, 7, 24], [2, 4, 22]];
    const u = t * (V.length - 1), i = Math.min(V.length - 2, Math.floor(u)), f = u - i;
    let a = 0;
    for (let k = 0; k < 3; k++) a += gauss(h, mix(V[i][k], V[i + 1][k], f), 1.6 + 0.12 * mix(V[i][k], V[i + 1][k], f)) * (k === 0 ? 1 : k === 1 ? 0.6 : 0.3);
    return { s: (a + 0.02) / Math.pow(h, 0.55) };
  } },
  { name: 'Harmonic sweep', gen: (t, h) => ({ s: saw(h) * (1 + 7 * gauss(h, 1 + t * 34, 1.4)) }) },
  { name: 'Odd / even', gen: (t, h) => ({ s: (h & 1 ? 1 - t : t) / h * (h === 1 ? 1 : 1) }) },
  { name: 'Digital', gen: (t, h) => {
    const u = t * 3, i = Math.min(2, Math.floor(u)), f = u - i;
    const r = (k) => (hash(h * 3.1 + k * 17.3) < 0.55 ? hash(h + k * 5.7) : 0.05) / Math.pow(h, 0.7);
    return { s: mix(r(i), r(i + 1), f) };
  } },
];
export const TABLE_NAMES = TABLES.map((t) => t.name);

const cache = new Map();     // `${table}:${mip}` -> Float32Array(FRAMES * (N + 1))
const spectra = new Map();   // `${table}` -> [{ s, c }] per frame (partial amplitudes, index = harmonic)
const gains = new Map();     // `${table}` -> Float64Array(FRAMES): gain that peak-normalises each frame at full bandwidth

function spectraOf(table) {
  let sp = spectra.get(table);
  if (sp) return sp;
  sp = [];
  const gen = TABLES[table].gen, fft = getFFT(N), re = new Float64Array(N), im = new Float64Array(N), g = new Float64Array(FRAMES);
  for (let f = 0; f < FRAMES; f++) {
    const s = new Float64Array(H + 1), c = new Float64Array(H + 1), t = f / (FRAMES - 1);
    for (let h = 1; h <= H; h++) { const a = gen(t, h); if (a.s) s[h] = a.s; if (a.c) c[h] = a.c; }
    sp.push({ s, c });
    re.fill(0); im.fill(0);
    for (let h = 1; h <= H; h++) { im[h] = -s[h]; re[h] = c[h]; }
    fft.transform(re, im, true);
    let pk = 1e-9; for (let i = 0; i < N; i++) pk = Math.max(pk, Math.abs(re[i]));
    g[f] = 0.9 / pk;
  }
  spectra.set(table, sp); gains.set(table, g);
  return sp;
}

function build(table, mip) {
  const key = `${table}:${mip}`;
  let data = cache.get(key);
  if (data) return data;
  const sp = spectraOf(table), g = gains.get(table);
  data = new Float32Array(FRAMES * (N + 1));
  const fft = getFFT(N), re = new Float64Array(N), im = new Float64Array(N), hMax = Math.max(1, H >> mip);
  for (let f = 0; f < FRAMES; f++) {
    re.fill(0); im.fill(0);
    const { s, c } = sp[f];
    for (let h = 1; h <= hMax; h++) { im[h] = -s[h]; re[h] = c[h]; }
    fft.transform(re, im, true);
    const o = f * (N + 1), norm = g[f];     // the gain comes from the full-bandwidth frame: every mip level has the same loudness
    for (let i = 0; i < N; i++) data[o + i] = re[i] * norm;
    data[o + N] = data[o];
  }
  cache.set(key, data);
  return data;
}

export const schema = [
  choice('table', 'Wavetable', TABLE_NAMES, 0, { group: 'Osc' }),
  def('pos', 'Position', 0, 1, 0, { group: 'Osc' }),
  def('posEnv', 'Position envelope', -1, 1, 0, { group: 'Osc' }),
  def('uni', 'Unison voices', 1, 5, 1, { int: true, group: 'Osc' }),
  def('unidet', 'Unison detune', 0, 100, 18, { unit: 'cents', group: 'Osc' }),
  def('unispread', 'Unison spread', 0, 1, 0.7, { group: 'Osc' }),
  def('sub', 'Sub oscillator', 0, 1, 0, { group: 'Osc' }),
  def('oct', 'Octave', -2, 2, 0, { int: true, group: 'Osc' }),
  def('semi', 'Semitone', -12, 12, 0, { int: true, unit: 'st', group: 'Osc' }),
  def('fine', 'Fine', -100, 100, 0, { unit: 'cents', group: 'Osc' }),
  choice('ftype', 'Filter', ['Lowpass', 'Highpass', 'Bandpass', 'Off'], 0, { group: 'Filter' }),
  def('cutoff', 'Cutoff', 20, 20000, 7000, { unit: 'Hz', curve: 'log', group: 'Filter' }),
  def('res', 'Resonance', 0, 1, 0.15, { group: 'Filter' }),
  def('fenv', 'Envelope amount', -1, 1, 0.3, { group: 'Filter' }),
  def('keytrack', 'Key tracking', 0, 1, 0.3, { group: 'Filter' }),
  def('aa', 'Amp attack', 0.001, 8, 0.005, { unit: 's', curve: 'log', group: 'Envelopes' }),
  def('ad', 'Amp decay', 0.005, 8, 0.4, { unit: 's', curve: 'log', group: 'Envelopes' }),
  def('as', 'Amp sustain', 0, 1, 0.7, { group: 'Envelopes' }),
  def('ar', 'Amp release', 0.005, 10, 0.25, { unit: 's', curve: 'log', group: 'Envelopes' }),
  def('fa', 'Filter attack', 0.001, 8, 0.005, { unit: 's', curve: 'log', group: 'Envelopes' }),
  def('fd', 'Filter decay', 0.005, 8, 0.5, { unit: 's', curve: 'log', group: 'Envelopes' }),
  def('fs', 'Filter sustain', 0, 1, 0.2, { group: 'Envelopes' }),
  def('fr', 'Filter release', 0.005, 10, 0.3, { unit: 's', curve: 'log', group: 'Envelopes' }),
  def('ma', 'Mod attack', 0.001, 8, 0.01, { unit: 's', curve: 'log', group: 'Envelopes' }),
  def('md', 'Mod decay', 0.01, 8, 0.8, { unit: 's', curve: 'log', group: 'Envelopes' }),
  def('lrate', 'LFO rate', 0.05, 20, 2, { unit: 'Hz', curve: 'log', group: 'LFO' }),
  choice('lshape', 'LFO shape', LFO_SHAPES, 0, { group: 'LFO' }),
  def('lpos', 'LFO to position', 0, 1, 0, { group: 'LFO' }),
  def('lpitch', 'LFO to pitch', 0, 2, 0, { unit: 'st', group: 'LFO' }),
  def('lcut', 'LFO to cutoff', 0, 3, 0, { unit: 'oct', group: 'LFO' }),
  def('poly', 'Polyphony', 1, 16, 8, { int: true, group: 'Voice' }),
  bool('mono', 'Mono', 0, { group: 'Voice' }),
  def('glide', 'Glide', 0, 1000, 0, { unit: 'ms', curve: 'pow', group: 'Voice' }),
  def('gain', 'Gain', 0, 1.5, 0.7, { group: 'Voice' }),
];
export const meta = { id: 'wavetable', name: 'Wavetable', kind: 'synth', rootDefault: 60, description: 'Band-limited wavetable synth with morphing position, unison and filter' };
export const paramMap = schemaMap(schema);

const CHUNK = 16;

class Voice {
  constructor(i) {
    this.alive = false; this.aEnv = new ADSR(); this.fEnv = new ADSR(); this.mEnv = new ADSR(); this.lfo = new LFO(i + 3);
    this.ph = new Float64Array(5); this.sub = 0;
    this.fL = new SVF(); this.fR = new SVF(); this.noise = new Noise(i * 313 + 9);
  }
}

export class Wavetable {
  constructor(sr, host) {
    this.sr = sr; this.host = host; this.p = defaults(schema);
    this.voices = Array.from({ length: 16 }, (_, i) => new Voice(i));
    this.counter = 0;
    prewarm(this.p.table);
  }

  get active() { for (const v of this.voices) if (v.alive) return true; return false; }
  setParam(id, v) { this.p[id] = v; if (id === 'table') prewarm(v); }
  allOff() { for (const v of this.voices) v.alive = false; }
  chokeAll() { for (const v of this.voices) if (v.alive) { v.aEnv.release(); v.fEnv.release(); v.fast = true; } }

  noteOn(ev) {
    const p = this.p;
    let v = null;
    if (ev.slide) { for (const x of this.voices) if (x.alive && !x.released && (!v || x.time > v.time)) v = x; if (v) { v.target = ev.key + (ev.fine || 0) / 100; return; } }
    if (p.mono) for (const x of this.voices) if (x.alive) { x.aEnv.release(); x.fEnv.release(); x.fast = true; }
    let n = 0, oldest = null;
    for (const x of this.voices) { if (x.alive) { n++; if (!oldest || x.time < oldest.time) oldest = x; } else if (!v) v = x; }
    if (!v || n >= (p.mono ? 1 : p.poly)) {
      if (oldest && (!v || n >= p.poly)) { oldest.aEnv.release(); oldest.fEnv.release(); oldest.fast = true; }
      if (!v) v = oldest;
    }
    v.alive = true; v.released = false; v.fast = false; v.key = ev.key; v.target = ev.key + (ev.fine || 0) / 100; v.cur = v.target;
    v.vel = ev.vel; v.pan = ev.pan || 0; v.time = ++this.counter; v.age = 0;
    for (let u = 0; u < 5; u++) v.ph[u] = (u * 0.2137 + hashPhase(this.counter, u)) % 1;
    v.sub = 0;
    v.aEnv.v = 0; v.fEnv.v = 0; v.mEnv.v = 0; v.aEnv.trigger(); v.fEnv.trigger(); v.mEnv.trigger();
    v.lfo.reset(0); v.lfo.shape = p.lshape; v.fL.reset(); v.fR.reset();
  }

  noteOff(key) {
    for (const v of this.voices) if (v.alive && !v.released && Math.abs(v.key - key) < 0.5) { v.released = true; v.aEnv.release(); v.fEnv.release(); v.mEnv.release(); }
  }

  // wave data for the current table at the mip level that is free of aliasing for `freq`
  _data(freq) {
    const maxH = Math.max(1, Math.floor((0.46 * this.sr) / freq));
    let mip = 0; while (mip < MIPS - 1 && (H >> mip) > maxH) mip++;
    return build(this.p.table, mip);
  }

  process(L, R, i0, i1) {
    const p = this.p, sr = this.sr;
    const U = p.uni, uGain = 1 / Math.sqrt(U);
    const det = this._det || (this._det = new Float64Array(5)), pcs = this._pc || (this._pc = new Float64Array(5)), pss = this._ps || (this._ps = new Float64Array(5));
    for (let u = 0; u < U; u++) {
      const t = U === 1 ? 0 : (2 * u) / (U - 1) - 1;
      det[u] = (t * p.unidet) / 100;
      const a = (clamp(t * p.unispread, -1, 1) + 1) * 0.7853981634;
      pcs[u] = Math.cos(a) * 1.41421356; pss[u] = Math.sin(a) * 1.41421356;
    }
    const aInc = 1 / Math.max(1, p.aa * sr), dCo = timeCoef(p.ad, sr), rCo = timeCoef(p.ar, sr), fastCo = timeCoef(0.004, sr);
    const faInc = 1 / Math.max(1, p.fa * sr), fdCo = timeCoef(p.fd, sr), frCo = timeCoef(p.fr, sr);
    const maInc = 1 / Math.max(1, p.ma * sr), mdCo = timeCoef(p.md, sr);
    const lfoInc = p.lrate / sr;
    const ft = p.ftype, filterOn = ft !== 3;
    for (const v of this.voices) {
      if (!v.alive) continue;
      let i = i0;
      while (i < i1 && v.alive) {
        const n = Math.min(CHUNK, i1 - i);
        const lf = v.lfo.next(lfoInc * n);
        const gl = p.glide * 0.001;
        if (gl > 0.0005) v.cur += (v.target - v.cur) * (1 - Math.exp(-n / (gl * sr * 0.35))); else v.cur = v.target;
        const keyF = v.cur + p.oct * 12 + p.semi + p.fine / 100 + lf * p.lpitch;
        const freq = mtof(keyF);
        const data = this._data(freq * (1 + det[U - 1] * 0.06));
        const pos = clamp(p.pos + v.mEnv.v * p.posEnv + lf * p.lpos * 0.5, 0, 1) * (FRAMES - 1);
        const f0 = Math.min(FRAMES - 2, Math.floor(pos)), fr = pos - f0;
        const o0 = f0 * (N + 1), o1 = (f0 + 1) * (N + 1);
        const cut = clamp(p.cutoff * Math.pow(2, v.fEnv.v * p.fenv * 6 + lf * p.lcut + p.keytrack * (v.cur - 60) / 12), 20, sr * 0.45);
        if (filterOn) { v.fL.setup(sr, cut, p.res); v.fR.a1 = v.fL.a1; v.fR.a2 = v.fL.a2; v.fR.a3 = v.fL.a3; v.fR.k = v.fL.k; }
        const incs = this._inc || (this._inc = new Float64Array(5));
        for (let u = 0; u < U; u++) incs[u] = (freq * Math.pow(2, det[u] / 12)) / sr;
        const subInc = (freq * 0.5) / sr;
        const relCo = v.fast ? fastCo : rCo;
        const gBase = v.vel * p.gain;
        for (let j = 0; j < n; j++) {
          let aL = 0, aR = 0;
          for (let u = 0; u < U; u++) {
            let ph = v.ph[u] + incs[u]; if (ph >= 1) ph -= 1; v.ph[u] = ph;
            const x = ph * N, k = x | 0, f = x - k;
            const a = data[o0 + k] + (data[o0 + k + 1] - data[o0 + k]) * f;
            const b = data[o1 + k] + (data[o1 + k + 1] - data[o1 + k]) * f;
            const s = a + (b - a) * fr;
            aL += s * pcs[u]; aR += s * pss[u];
          }
          aL *= uGain; aR *= uGain;
          if (p.sub > 0) { v.sub += subInc; if (v.sub >= 1) v.sub -= 1; const s = Math.sin(TAU * v.sub) * p.sub * 0.7; aL += s; aR += s; }
          if (filterOn) {
            v.fL.process(aL); v.fR.process(aR);
            aL = ft === 0 ? v.fL.lp : ft === 1 ? v.fL.hp : v.fL.bp;
            aR = ft === 0 ? v.fR.lp : ft === 1 ? v.fR.hp : v.fR.bp;
          }
          const env = v.aEnv.next(aInc, dCo, p.as, relCo);
          v.fEnv.next(faInc, fdCo, p.fs, frCo); v.mEnv.next(maInc, mdCo, 0, rCo);
          const gl2 = env * gBase;
          const pa = (clamp(v.pan, -1, 1) + 1) * 0.7853981634;
          L[i + j] += aL * gl2 * Math.cos(pa) * 0.70710678 * 1.41421356; R[i + j] += aR * gl2 * Math.sin(pa) * 0.70710678 * 1.41421356;
          if (v.aEnv.done) { v.alive = false; break; }
        }
        i += n;
      }
    }
  }
}

// One frame of a wavetable for display: `pos` 0..1 scans the frames (linear blend), full bandwidth. Returns N samples.
export function frameWave(table, pos, out = new Float32Array(N)) {
  const data = build(table, 0), x = clamp(pos, 0, 1) * (FRAMES - 1), f0 = Math.min(FRAMES - 2, Math.floor(x)), fr = x - f0;
  const a = f0 * (N + 1), b = (f0 + 1) * (N + 1);
  for (let i = 0; i < N; i++) out[i] = data[a + i] + (data[b + i] - data[a + i]) * fr;
  return out;
}
export const WT_FRAMES = FRAMES;

// render every mip level of a table ahead of the first note (called when the table is chosen)
function prewarm(table) { for (let m = 0; m < MIPS; m++) build(table, m); }

function hashPhase(c, u) { const x = Math.sin(c * 12.9898 + u * 78.233) * 43758.5453; return x - Math.floor(x); }

export function create(sr, host) { return new Wavetable(sr, host); }
