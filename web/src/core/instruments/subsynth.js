// Subtractive synthesizer: 2 oscillators (saw / square+PWM / triangle / sine / noise) with detune
// and phase, noise generator, unison (up to 8 voices with stereo spread), multimode filter
// (12/24 dB low-pass, high-pass, band-pass, notch) with ADSR, amplitude ADSR, 2 LFOs routable to
// pitch / cutoff / amplitude / PWM / pan, glide, mono/legato mode and polyphony.
import { def, bool, choice, defaults, schemaMap } from '../schema.js';
import { SVF, ADSR, LFO, LFO_SHAPES, Noise, mtof, clamp, polyBlep, SYNC_DIVS, SYNC_LABELS, timeCoef, TAU } from '../dsp.js';

export const WAVES = ['Saw', 'Square', 'Triangle', 'Sine', 'Noise'];
export const FILTERS = ['Low pass 12', 'Low pass 24', 'High pass', 'Band pass', 'Notch'];

function oscParams(n) {
  const g = `Osc ${n}`;
  return [
    choice(`o${n}wave`, `Osc ${n} wave`, WAVES, n === 1 ? 0 : 1, { group: g }),
    def(`o${n}oct`, `Osc ${n} octave`, -3, 3, 0, { int: true, group: g }),
    def(`o${n}semi`, `Osc ${n} semitones`, -12, 12, 0, { int: true, group: g }),
    def(`o${n}fine`, `Osc ${n} fine`, -100, 100, n === 1 ? 0 : 7, { unit: 'cents', group: g }),
    def(`o${n}level`, `Osc ${n} level`, 0, 1, n === 1 ? 0.8 : 0.5, { group: g }),
    def(`o${n}pw`, `Osc ${n} pulse width`, 0.05, 0.95, 0.5, { group: g }),
    def(`o${n}phase`, `Osc ${n} start phase`, 0, 1, 0, { group: g }),
  ];
}

function lfoParams(n) {
  const g = `LFO ${n}`;
  return [
    choice(`l${n}shape`, `LFO ${n} shape`, LFO_SHAPES, 0, { group: g }),
    def(`l${n}rate`, `LFO ${n} rate`, 0.02, 30, 5, { unit: 'Hz', curve: 'log', group: g }),
    bool(`l${n}sync`, `LFO ${n} tempo sync`, 0, { group: g }),
    choice(`l${n}div`, `LFO ${n} division`, SYNC_LABELS, 8, { group: g }),
    def(`l${n}pitch`, `LFO ${n} → pitch`, 0, 12, 0, { unit: 'st', group: g }),
    def(`l${n}cut`, `LFO ${n} → cutoff`, 0, 5, 0, { unit: 'oct', group: g }),
    def(`l${n}amp`, `LFO ${n} → amplitude`, 0, 1, 0, { group: g }),
    def(`l${n}pw`, `LFO ${n} → pulse width`, 0, 0.45, 0, { group: g }),
    def(`l${n}pan`, `LFO ${n} → pan`, 0, 1, 0, { group: g }),
    def(`l${n}fade`, `LFO ${n} fade-in`, 0, 3, 0, { unit: 's', curve: 'pow', group: g }),
  ];
}

export const schema = [
  ...oscParams(1), ...oscParams(2),
  def('noise', 'Noise level', 0, 1, 0, { group: 'Osc 2' }),
  choice('noiseType', 'Noise color', ['White', 'Pink'], 0, { group: 'Osc 2' }),
  choice('ftype', 'Filter type', FILTERS, 1, { group: 'Filter' }),
  def('cutoff', 'Cutoff', 20, 20000, 2200, { unit: 'Hz', curve: 'log', group: 'Filter' }),
  def('res', 'Resonance', 0, 1, 0.2, { group: 'Filter' }),
  def('fenv', 'Envelope amount', -1, 1, 0.35, { group: 'Filter' }),
  def('keytrack', 'Key tracking', 0, 1, 0.4, { group: 'Filter' }),
  def('fa', 'Filter attack', 0.001, 8, 0.005, { unit: 's', curve: 'pow', skew: 3, group: 'Filter' }),
  def('fd', 'Filter decay', 0.001, 8, 0.35, { unit: 's', curve: 'pow', skew: 3, group: 'Filter' }),
  def('fs', 'Filter sustain', 0, 1, 0.3, { group: 'Filter' }),
  def('fr', 'Filter release', 0.001, 8, 0.25, { unit: 's', curve: 'pow', skew: 3, group: 'Filter' }),
  def('aa', 'Attack', 0.001, 8, 0.004, { unit: 's', curve: 'pow', skew: 3, group: 'Amp' }),
  def('ad', 'Decay', 0.001, 8, 0.4, { unit: 's', curve: 'pow', skew: 3, group: 'Amp' }),
  def('as', 'Sustain', 0, 1, 0.7, { group: 'Amp' }),
  def('ar', 'Release', 0.001, 8, 0.2, { unit: 's', curve: 'pow', skew: 3, group: 'Amp' }),
  def('gain', 'Gain', 0, 1.5, 0.7, { group: 'Amp' }),
  ...lfoParams(1), ...lfoParams(2),
  def('uni', 'Unison voices', 1, 8, 1, { int: true, group: 'Unison' }),
  def('unidet', 'Unison detune', 0, 100, 18, { unit: 'cents', group: 'Unison' }),
  def('unispread', 'Stereo spread', 0, 1, 0.7, { group: 'Unison' }),
  def('glide', 'Glide time', 0, 2000, 0, { unit: 'ms', curve: 'pow', group: 'Voice' }),
  bool('mono', 'Mono', 0, { group: 'Voice' }),
  bool('legato', 'Legato (no retrigger)', 1, { group: 'Voice' }),
  def('poly', 'Polyphony', 1, 16, 8, { int: true, group: 'Voice' }),
];

export const meta = { id: 'subsynth', name: 'Sub Synth', kind: 'synth', rootDefault: 60, description: 'Subtractive synthesizer: 2 oscillators, unison, multimode filter, 2 LFOs' };
export const paramMap = schemaMap(schema);

const CHUNK = 16;

class Voice {
  constructor(i) {
    this.alive = false;
    this.p1 = new Float64Array(8); this.p2 = new Float64Array(8);
    this.aEnv = new ADSR(); this.fEnv = new ADSR();
    this.fL = [new SVF(), new SVF()]; this.fR = [new SVF(), new SVF()];
    this.lfo = [new LFO(i + 1), new LFO(i + 11)];
    this.noise = new Noise(i * 977 + 5);
    this.pk = [0, 0, 0, 0, 0, 0, 0];
  }
}

export class SubSynth {
  constructor(sr, host) {
    this.sr = sr; this.host = host;
    this.p = defaults(schema);
    this.voices = Array.from({ length: 20 }, (_, i) => new Voice(i));
    this.counter = 0;
  }

  get active() { for (const v of this.voices) if (v.alive) return true; return false; }
  setParam(id, v) { this.p[id] = v; }
  allOff() { for (const v of this.voices) v.alive = false; }
  chokeAll() { for (const v of this.voices) if (v.alive) { v.aEnv.release(); v.fEnv.release(); v.fast = true; } }

  noteOn(ev) {
    const p = this.p;
    const key = ev.key;
    // slide notes and legato mono: glide the sounding voice to the new key
    let v = null;
    if (ev.slide || (p.mono && p.legato)) {
      for (const x of this.voices) if (x.alive && !x.released && (!v || x.time > v.time)) v = x;
      if (v) { v.target = key + (ev.fine || 0) / 100; v.vel = ev.vel; if (ev.slide && ev.len) v.slideTime = ev.len / this.sr; return; }
    }
    if (p.mono) for (const x of this.voices) if (x.alive) { x.aEnv.release(); x.fEnv.release(); x.fast = true; }
    let n = 0, oldest = null;
    for (const x of this.voices) { if (x.alive) { n++; if (!oldest || x.time < oldest.time) oldest = x; } else if (!v) v = x; }
    if (!v || n >= (p.mono ? 1 : p.poly)) {
      if (oldest && (!v || n >= p.poly)) { oldest.aEnv.release(); oldest.fEnv.release(); oldest.fast = true; }
      if (!v) v = oldest;
    }
    v.alive = true; v.released = false; v.fast = false;
    v.key = key; v.target = key + (ev.fine || 0) / 100; v.cur = v.target; v.vel = ev.vel; v.pan = ev.pan || 0;
    v.time = ++this.counter; v.slideTime = 0; v.age = 0;
    v.rel = ev.rel == null ? 64 : ev.rel;
    for (let u = 0; u < 8; u++) { v.p1[u] = (p.o1phase + u * 0.137) % 1; v.p2[u] = (p.o2phase + u * 0.291) % 1; }
    v.aEnv.v = 0; v.fEnv.v = 0; v.aEnv.trigger(); v.fEnv.trigger();
    for (let i = 0; i < 2; i++) { v.lfo[i].reset(0); v.lfo[i].shape = p[`l${i + 1}shape`]; for (const f of [v.fL[i], v.fR[i]]) f.reset(); }
    v.fL[0].reset(); v.fL[1].reset(); v.fR[0].reset(); v.fR[1].reset();
    v.pk.fill(0);
  }

  noteOff(key) {
    for (const v of this.voices) {
      if (v.alive && !v.released && Math.abs(v.key - key) < 0.5) { v.released = true; v.aEnv.release(); v.fEnv.release(); }
    }
  }

  _osc(wave, p, dt, pw, v) {
    switch (wave) {
      case 0: return 2 * p - 1 - polyBlep(p, dt);
      case 1: { const q = p + 1 - pw; return (p < pw ? 1 : -1) + polyBlep(p, dt) - polyBlep(q >= 1 ? q - 1 : q, dt); }
      case 2: return 4 * Math.abs(p - 0.5) - 1;
      case 3: return Math.sin(TAU * p);
      default: return v.noise.next();
    }
  }

  process(L, R, i0, i1) {
    const p = this.p, sr = this.sr;
    const tempo = this.host && this.host.tempo ? this.host.tempo : 120;
    const U = p.uni;
    const uGain = 1 / Math.sqrt(U);
    const detunes = this._det || (this._det = new Float64Array(8)), pans = this._pan || (this._pan = new Float64Array(8));
    const pcos = this._pc || (this._pc = new Float64Array(8)), psin = this._ps || (this._ps = new Float64Array(8));
    const inc1 = this._i1 || (this._i1 = new Float64Array(8)), inc2 = this._i2 || (this._i2 = new Float64Array(8));
    for (let u = 0; u < U; u++) {
      const t = U === 1 ? 0 : (2 * u) / (U - 1) - 1;
      detunes[u] = (t * p.unidet) / 100; pans[u] = t * p.unispread;
      const an = (clamp(pans[u], -1, 1) + 1) * 0.7853981634;
      pcos[u] = Math.cos(an) * 1.41421356; psin[u] = Math.sin(an) * 1.41421356;
    }
    const aInc = 1 / Math.max(1, p.aa * sr), dCo = timeCoef(p.ad, sr), rCo = timeCoef(p.ar, sr), fastCo = timeCoef(0.004, sr);
    const faInc = 1 / Math.max(1, p.fa * sr), fdCo = timeCoef(p.fd, sr), frCo = timeCoef(p.fr, sr);
    const lfoInc = [1, 2].map((n) => (p[`l${n}sync`] ? tempo / 60 / SYNC_DIVS[p[`l${n}div`]][1] / sr : p[`l${n}rate`] / sr));
    const ft = p.ftype, stages = ft === 1 ? 2 : 1;
    const hasN1 = p.o1level > 0, hasN2 = p.o2level > 0;

    for (const v of this.voices) {
      if (!v.alive) continue;
      let i = i0;
      while (i < i1 && v.alive) {
        const n = Math.min(CHUNK, i1 - i);
        // ---- control rate: LFOs, glide, filter, oscillator increments ----
        const m1 = v.lfo[0].next(lfoInc[0] * n) * (p.l1fade > 0 ? Math.min(1, v.age / (p.l1fade * sr)) : 1);
        const m2 = v.lfo[1].next(lfoInc[1] * n) * (p.l2fade > 0 ? Math.min(1, v.age / (p.l2fade * sr)) : 1);
        v.age += n;
        const gl = v.slideTime > 0 ? v.slideTime : p.glide * 0.001;
        if (gl > 0.0005) v.cur += (v.target - v.cur) * (1 - Math.exp(-n / (gl * sr * 0.35))); else v.cur = v.target;
        const keyBase = v.cur + m1 * p.l1pitch + m2 * p.l2pitch;
        const base1 = keyBase + p.o1oct * 12 + p.o1semi + p.o1fine / 100;
        const base2 = keyBase + p.o2oct * 12 + p.o2semi + p.o2fine / 100;
        for (let u = 0; u < U; u++) { inc1[u] = mtof(base1 + detunes[u]) / sr; inc2[u] = mtof(base2 - detunes[u] * 0.7) / sr; }
        const pwMod = m1 * p.l1pw + m2 * p.l2pw;
        const pw1 = clamp(p.o1pw + pwMod, 0.05, 0.95), pw2 = clamp(p.o2pw + pwMod, 0.05, 0.95);
        const am = 1 - p.l1amp * (0.5 - 0.5 * m1) - p.l2amp * (0.5 - 0.5 * m2);
        const panMod = clamp(v.pan + m1 * p.l1pan + m2 * p.l2pan, -1, 1);
        const pa = (panMod + 1) * 0.7853981634, pcL = Math.cos(pa) * 0.70710678 * 1.41421356, pcR = Math.sin(pa) * 0.70710678 * 1.41421356;
        const cut = clamp(p.cutoff * Math.pow(2, v.fEnv.v * p.fenv * 6 + (m1 * p.l1cut + m2 * p.l2cut) + p.keytrack * (v.cur - 60) / 12), 20, sr * 0.45);
        const fl = v.fL, fr = v.fR;
        fl[0].setup(sr, cut, p.res); fr[0].a1 = fl[0].a1; fr[0].a2 = fl[0].a2; fr[0].a3 = fl[0].a3; fr[0].k = fl[0].k;
        if (stages === 2) { fl[1].setup(sr, cut, p.res * 0.5); fr[1].a1 = fl[1].a1; fr[1].a2 = fl[1].a2; fr[1].a3 = fl[1].a3; fr[1].k = fl[1].k; }
        const relCo = v.fast ? fastCo : (v.rel === 64 ? rCo : Math.pow(rCo, Math.pow(2, (64 - v.rel) / 32)));
        const gainBase = v.vel * p.gain * am;

        for (let j = 0; j < n; j++) {
          let aL = 0, aR = 0;
          for (let u = 0; u < U; u++) {
            let ph1 = v.p1[u] + inc1[u]; if (ph1 >= 1) ph1 -= 1; v.p1[u] = ph1;
            let ph2 = v.p2[u] + inc2[u]; if (ph2 >= 1) ph2 -= 1; v.p2[u] = ph2;
            let s = 0;
            if (hasN1) s += this._osc(p.o1wave, ph1, inc1[u], pw1, v) * p.o1level;
            if (hasN2) s += this._osc(p.o2wave, ph2, inc2[u], pw2, v) * p.o2level;
            aL += s * pcos[u]; aR += s * psin[u];
          }
          aL *= uGain; aR *= uGain;
          if (p.noise > 0) {
            let w = v.noise.next();
            if (p.noiseType === 1) { // Paul Kellet pink noise
              const k = v.pk;
              k[0] = 0.99886 * k[0] + w * 0.0555179; k[1] = 0.99332 * k[1] + w * 0.0750759; k[2] = 0.969 * k[2] + w * 0.153852;
              k[3] = 0.8665 * k[3] + w * 0.3104856; k[4] = 0.55 * k[4] + w * 0.5329522; k[5] = -0.7616 * k[5] - w * 0.016898;
              w = (k[0] + k[1] + k[2] + k[3] + k[4] + k[5] + k[6] + w * 0.5362) * 0.11; k[6] = w * 0.115926;
            }
            aL += w * p.noise; aR += w * p.noise;
          }
          fl[0].process(aL); fr[0].process(aR);
          let sl, sr_;
          switch (ft) {
            case 0: sl = fl[0].lp; sr_ = fr[0].lp; break;
            case 1: fl[1].process(fl[0].lp); fr[1].process(fr[0].lp); sl = fl[1].lp; sr_ = fr[1].lp; break;
            case 2: sl = fl[0].hp; sr_ = fr[0].hp; break;
            case 3: sl = fl[0].bp * (0.4 + p.res); sr_ = fr[0].bp * (0.4 + p.res); break;
            default: sl = fl[0].lp + fl[0].hp; sr_ = fr[0].lp + fr[0].hp;
          }
          const e = v.aEnv.next(aInc, dCo, p.as, relCo);
          v.fEnv.next(faInc, fdCo, p.fs, frCo);
          if (v.aEnv.done) { v.alive = false; break; }
          const g = e * gainBase;
          L[i + j] += sl * g * pcL;
          R[i + j] += sr_ * g * pcR;
        }
        i += n;
      }
    }
  }
}

export function create(sr, host) { return new SubSynth(sr, host); }
