// FL LUA Keys: four playable keyboard instruments, all synthesised (no samples).
//   E-Piano   tine electric piano: two-operator FM with a velocity-driven bark, bell and tremolo
//   Strings   string ensemble: three detuned saws per note, a gentle filter and a stereo ensemble chorus
//   Piano     soft piano: additive partials with string inharmonicity, two strings per note and a hammer
//   Choir     formant choir: a band-limited saw voice source through three vowel formants, morphing a–e–i–o–u
globalThis.__flluaRegisterPack({
  id: 'fllua-keys',
  name: 'FL LUA Keys',
  version: '1.0.0',
  author: 'FL LUA',
  license: 'MIT',
  description: 'E-Piano, Strings, Piano and Choir: playable keyboard instruments synthesised in real time.',
  api: 1,
  plugins(api) {
    const { def, choice, defaults } = api.params;
    const { TAU, clamp, polyBlep, Biquad, Noise, DelayLine } = api.dsp;
    const mtof = (k) => 440 * Math.pow(2, (k - 69) / 12);
    const coef = (sec, sr) => Math.exp(-1 / Math.max(1, sec * sr));

    // shared voice bookkeeping: up to `max` voices, oldest stolen; noteOff releases matching keys
    class Poly {
      constructor(sr, max, make) { this.sr = sr; this.voices = Array.from({ length: max }, make); this.n = 0; }
      get active() { for (const v of this.voices) if (v.on) return true; return false; }
      take() { let v = this.voices.find((x) => !x.on); if (!v) v = this.voices.reduce((a, b) => (a.age < b.age ? a : b)); v.age = ++this.n; return v; }
      allOff() { for (const v of this.voices) v.on = false; }
      noteOff(key) { for (const v of this.voices) if (v.on && v.key === key && !v.rel) v.rel = true; }
      chokeAll() { for (const v of this.voices) if (v.on) v.rel = true; }
    }

    // ---------------------------------------------------------------------------------------------- E-Piano
    const epSchema = [
      def('bark', 'Bark (velocity → brightness)', 0, 1, 0.55, { group: 'Tone' }),
      def('bell', 'Bell', 0, 1, 0.35, { group: 'Tone' }),
      def('decay', 'Decay', 0.3, 3, 1, { curve: 'log', group: 'Tone' }),
      def('release', 'Release', 0.02, 2, 0.25, { unit: 's', curve: 'log', group: 'Tone' }),
      def('trem', 'Tremolo depth', 0, 1, 0.3, { group: 'Tremolo' }),
      def('tremRate', 'Tremolo rate', 0.5, 9, 4.5, { unit: 'Hz', group: 'Tremolo' }),
      def('drive', 'Drive', 0, 1, 0.15, { group: 'Tone' }),
      def('volume', 'Volume', -24, 6, 0, { unit: 'dB', group: 'Tone' }),
    ];
    class EPiano extends Poly {
      constructor(sr) { super(sr, 24, () => ({ on: false })); this.p = defaults(epSchema); this.lfo = 0; }
      setParam(id, v) { this.p[id] = v; }
      noteOn(ev) {
        const v = this.take(), p = this.p, vel = clamp(ev.vel ?? 0.8, 0, 1);
        const f = mtof(ev.key) * Math.pow(2, (ev.fine || 0) / 1200);
        Object.assign(v, { on: true, rel: false, key: ev.key, f, pc: 0, pm: 0, pt: 0, t: 0, amp: 1, vel, ie: 1, be: 1,
          idx: 0.6 + vel * vel * 4 * p.bark, dk: coef((2.4 - (ev.key - 40) * 0.02) * p.decay, this.sr), pan: clamp((ev.key - 64) / 50, -0.6, 0.6) });
      }
      process(L, R, a, b) {
        const p = this.p, sr = this.sr, rk = coef(p.release * 0.3, sr), vol = Math.pow(10, p.volume / 20) * 0.22;
        const dr = 1 + p.drive * 3, lfoInc = p.tremRate / sr, ieCo = Math.exp(-3.5 / sr), beCo = Math.exp(-9 / sr);
        for (let i = a; i < b; i++) {
          this.lfo += lfoInc; if (this.lfo >= 1) this.lfo -= 1;
          const tr = Math.sin(TAU * this.lfo) * p.trem;
          let l = 0, r = 0;
          for (const v of this.voices) {
            if (!v.on) continue;
            v.t += 1 / sr;
            v.pm += v.f / sr; v.pc += v.f / sr; v.pt += (v.f * 14.2) / sr;
            if (v.pm >= 1) v.pm -= 1; if (v.pc >= 1) v.pc -= 1; if (v.pt >= 1) v.pt -= 1;
            v.ie *= ieCo; v.be *= beCo;
            let s = Math.sin(TAU * v.pc + v.idx * v.ie * Math.sin(TAU * v.pm));
            if (v.be > 0.001) s += p.bell * v.vel * Math.sin(TAU * v.pt) * v.be * 0.4;     // the tine's metallic ping
            v.amp *= v.rel ? rk : v.dk;
            s *= v.amp * Math.min(1, v.t * 4000);
            const pl = 1 - v.pan, pr = 1 + v.pan;
            l += s * pl * (1 + tr); r += s * pr * (1 - tr);
            if (v.amp < 0.0003) v.on = false;
          }
          L[i] += Math.tanh(l * vol * dr) / dr * 1.2; R[i] += Math.tanh(r * vol * dr) / dr * 1.2;
        }
      }
    }

    // ---------------------------------------------------------------------------------------------- Strings
    const stSchema = [
      def('attack', 'Attack', 0.005, 3, 0.35, { unit: 's', curve: 'log', group: 'Shape' }),
      def('release', 'Release', 0.05, 5, 0.9, { unit: 's', curve: 'log', group: 'Shape' }),
      def('bright', 'Brightness', 0, 1, 0.45, { group: 'Tone' }),
      def('detune', 'Detune', 0, 30, 9, { unit: 'cents', group: 'Tone' }),
      choice('octave', 'Layer', ['None', 'Octave down', 'Octave up'], 0, { group: 'Tone' }),
      def('ensemble', 'Ensemble', 0, 1, 0.6, { group: 'Ensemble' }),
      def('volume', 'Volume', -24, 6, 0, { unit: 'dB', group: 'Tone' }),
    ];
    class Strings extends Poly {
      constructor(sr) {
        super(sr, 20, () => ({ on: false, ph: new Float64Array(6), f1: new Biquad(), f2: new Biquad() }));
        this.p = defaults(stSchema);
        this.dl = new DelayLine(Math.ceil(sr * 0.05)); this.dr = new DelayLine(Math.ceil(sr * 0.05)); this.lfo = 0;
      }
      setParam(id, v) { this.p[id] = v; }
      noteOn(ev) {
        const v = this.take(), p = this.p, vel = clamp(ev.vel ?? 0.8, 0, 1);
        const f = mtof(ev.key) * Math.pow(2, (ev.fine || 0) / 1200);
        const cents = [-p.detune, 0, p.detune];
        v.fs = cents.map((c) => f * Math.pow(2, c / 1200));
        v.layer = p.octave === 1 ? 0.5 : p.octave === 2 ? 2 : 0;
        for (let k = 0; k < 6; k++) v.ph[k] = (k * 0.37) % 1;
        const cut = clamp(f * (2 + p.bright * 10) * (0.6 + vel * 0.6), 200, this.sr * 0.45);
        v.f1.set('lp', this.sr, cut, 0.6); v.f2.set('lp', this.sr, cut, 0.9);
        Object.assign(v, { on: true, rel: false, key: ev.key, env: 0, vel: 0.5 + vel * 0.5 });
      }
      process(L, R, a, b) {
        const p = this.p, sr = this.sr, att = 1 / Math.max(1, p.attack * sr), rk = coef(p.release * 0.3, sr), vol = Math.pow(10, p.volume / 20) * 0.16;
        for (let i = a; i < b; i++) {
          let s = 0;
          for (const v of this.voices) {
            if (!v.on) continue;
            let x = 0;
            for (let k = 0; k < 3; k++) {
              const dt = v.fs[k] / sr;
              v.ph[k] += dt; if (v.ph[k] >= 1) v.ph[k] -= 1;
              x += 2 * v.ph[k] - 1 - polyBlep(v.ph[k], dt);
              if (v.layer) { const d2 = dt * v.layer; v.ph[k + 3] += d2; if (v.ph[k + 3] >= 1) v.ph[k + 3] -= 1; x += 0.6 * (2 * v.ph[k + 3] - 1 - polyBlep(v.ph[k + 3], d2)); }
            }
            if (v.rel) { v.env *= rk; if (v.env < 0.0003) { v.on = false; continue; } } else v.env = Math.min(1, v.env + att);
            s += v.f2.process(v.f1.process(x)) * v.env * v.vel;
          }
          // ensemble: two modulated delays, opposite phase per side
          this.lfo += 0.6 / sr; if (this.lfo >= 1) this.lfo -= 1;
          const m = Math.sin(TAU * this.lfo), m2 = Math.sin(TAU * (this.lfo * 3.1 + 0.25));
          const dL = sr * (0.012 + 0.004 * p.ensemble * (m + 0.3 * m2)), dR = sr * (0.012 - 0.004 * p.ensemble * (m - 0.3 * m2));
          this.dl.write(s); this.dr.write(s);
          const wl = this.dl.read(dL), wr = this.dr.read(dR), e = p.ensemble;
          L[i] += (s * (1 - 0.5 * e) + wl * e) * vol; R[i] += (s * (1 - 0.5 * e) + wr * e) * vol;
        }
      }
    }

    // ---------------------------------------------------------------------------------------------- Piano
    const pnSchema = [
      def('bright', 'Brightness', 0, 1, 0.5, { group: 'Tone' }),
      def('hammer', 'Hammer', 0, 1, 0.35, { group: 'Tone' }),
      def('decay', 'Sustain length', 0.3, 3, 1, { curve: 'log', group: 'Tone' }),
      def('detune', 'String detune', 0, 6, 1.2, { unit: 'cents', group: 'Tone' }),
      def('release', 'Release (damper)', 0.03, 1.5, 0.18, { unit: 's', curve: 'log', group: 'Tone' }),
      def('volume', 'Volume', -24, 6, 0, { unit: 'dB', group: 'Tone' }),
    ];
    const NP = 12;
    class Piano extends Poly {
      constructor(sr) {
        super(sr, 18, () => ({ on: false, c: new Float64Array(NP * 2), s: new Float64Array(NP * 2), rc: new Float64Array(NP * 2), rs: new Float64Array(NP * 2), a: new Float64Array(NP * 2), k: new Float64Array(NP * 2), hb: new Biquad() }));
        this.p = defaults(pnSchema); this.nz = new Noise(77);
      }
      setParam(id, v) { this.p[id] = v; }
      noteOn(ev) {
        const v = this.take(), p = this.p, sr = this.sr, vel = clamp(ev.vel ?? 0.8, 0, 1);
        const f = mtof(ev.key) * Math.pow(2, (ev.fine || 0) / 1200), B = 0.00012 * Math.pow(2, (ev.key - 60) / 12);    // inharmonicity rises up the keyboard
        const base = (3.5 - (ev.key - 21) * 0.032) * p.decay;                                                       // low notes ring longer
        let n = 0;
        for (let str = 0; str < 2; str++) {
          const fs = f * Math.pow(2, ((str ? 1 : -1) * p.detune * 0.5) / 1200);
          for (let k = 1; k <= NP; k++, n++) {
            const fk = k * fs * Math.sqrt(1 + B * k * k);
            if (fk > sr * 0.45) { v.a[n] = 0; continue; }
            const w = TAU * fk / sr;
            v.rc[n] = Math.cos(w); v.rs[n] = Math.sin(w); v.c[n] = 1; v.s[n] = 0;
            const tilt = Math.pow(k, -(1.6 - p.bright * 0.9 - vel * 0.5));
            v.a[n] = tilt * (k === 1 ? 1 : 0.9) * 0.5;
            v.k[n] = coef(Math.max(0.15, base / (1 + 0.35 * (k - 1))), sr);
          }
        }
        v.hb.set('bp', sr, clamp(f * 3, 400, 6000), 1.2);
        Object.assign(v, { on: true, rel: false, key: ev.key, t: 0, gain: (0.25 + vel * 0.75), ham: p.hammer * vel });
      }
      process(L, R, a, b) {
        const p = this.p, sr = this.sr, rk = coef(p.release * 0.25, sr), vol = Math.pow(10, p.volume / 20) * 0.12;
        for (let i = a; i < b; i++) {
          let s = 0;
          for (const v of this.voices) {
            if (!v.on) continue;
            let x = 0, live = 0;
            for (let n = 0; n < NP * 2; n++) {
              if (v.a[n] < 1e-5) continue;
              const c = v.c[n] * v.rc[n] - v.s[n] * v.rs[n], sn = v.c[n] * v.rs[n] + v.s[n] * v.rc[n];
              v.c[n] = c; v.s[n] = sn;
              x += sn * v.a[n];
              v.a[n] *= v.rel ? rk : v.k[n];
              live++;
            }
            v.t += 1 / sr;
            if (v.t < 0.03) x += v.hb.process(this.nz.next()) * v.ham * Math.exp(-v.t * 160) * 1.5;
            if ((i & 63) === 0) { const m = Math.hypot(v.c[0], v.s[0]); if (m > 0) for (let n = 0; n < NP * 2; n++) { v.c[n] /= m; v.s[n] /= m; } }   // keep the rotators on the unit circle
            s += x * v.gain;
            if (!live) v.on = false;
          }
          L[i] += s * vol; R[i] += s * vol;
        }
      }
    }

    // ---------------------------------------------------------------------------------------------- Choir
    const VOW = [[800, 1150, 2900], [400, 1600, 2700], [300, 2300, 3000], [450, 800, 2830], [325, 700, 2530]];     // a e i o u
    const VGAIN = [[1, 0.5, 0.25], [1, 0.45, 0.3], [1, 0.35, 0.25], [1, 0.4, 0.1], [1, 0.25, 0.06]];
    const chSchema = [
      def('vowel', 'Vowel (a e i o u)', 0, 4, 0, { group: 'Voice' }),
      def('voices', 'Singers per note', 1, 4, 3, { int: true, group: 'Voice' }),
      def('spread', 'Spread', 0, 30, 12, { unit: 'cents', group: 'Voice' }),
      def('vibrato', 'Vibrato', 0, 1, 0.4, { group: 'Voice' }),
      def('breath', 'Breath', 0, 1, 0.2, { group: 'Voice' }),
      def('attack', 'Attack', 0.01, 2, 0.25, { unit: 's', curve: 'log', group: 'Shape' }),
      def('release', 'Release', 0.05, 4, 0.6, { unit: 's', curve: 'log', group: 'Shape' }),
      def('volume', 'Volume', -24, 6, 0, { unit: 'dB', group: 'Shape' }),
    ];
    class Choir extends Poly {
      constructor(sr) {
        super(sr, 12, () => ({ on: false, ph: new Float64Array(4), vb: new Float64Array(4), dt: new Float64Array(4), fl: [new Biquad(), new Biquad(), new Biquad()] }));
        this.p = defaults(chSchema); this.nz = new Noise(91); this.cnt = 0;
      }
      setParam(id, v) { this.p[id] = v; }
      formants(v) {
        const p = this.p, x = clamp(p.vowel, 0, 4), i = Math.min(3, Math.floor(x)), t = x - i;
        for (let k = 0; k < 3; k++) { const f = VOW[i][k] + (VOW[i + 1][k] - VOW[i][k]) * t; v.fl[k].set('bp', this.sr, f, f / 110); v.g[k] = VGAIN[i][k] + (VGAIN[i + 1][k] - VGAIN[i][k]) * t; }
      }
      noteOn(ev) {
        const v = this.take(), vel = clamp(ev.vel ?? 0.8, 0, 1);
        v.f = mtof(ev.key) * Math.pow(2, (ev.fine || 0) / 1200);
        v.g = [1, 0.5, 0.25];
        for (let k = 0; k < 4; k++) { v.ph[k] = (k * 0.29) % 1; v.vb[k] = (k * 0.41) % 1; v.dt[k] = v.f / this.sr; }
        for (const f of v.fl) f.reset();
        v.tilt = 0;
        this.formants(v); v.fv = this.p.vowel;
        Object.assign(v, { on: true, rel: false, key: ev.key, env: 0, vel: 0.4 + vel * 0.6, t: 0 });
      }
      process(L, R, a, b) {
        const p = this.p, sr = this.sr, att = 1 / Math.max(1, p.attack * sr), rk = coef(p.release * 0.3, sr), vol = Math.pow(10, p.volume / 20) * 0.6;
        const nv = Math.round(p.voices);
        for (const v of this.voices) if (v.on && v.fv !== p.vowel) { this.formants(v); v.fv = p.vowel; }
        for (let i = a; i < b; i++) {
          let sl = 0, sr_ = 0;
          for (const v of this.voices) {
            if (!v.on) continue;
            v.t += 1 / sr;
            let src = 0;
            const upd = (i & 15) === 0;                                       // pitch (spread + vibrato) every 16 samples
            for (let k = 0; k < nv; k++) {
              if (upd) {
                v.vb[k] += (16 * (4.8 + k * 0.33)) / sr; if (v.vb[k] >= 1) v.vb[k] -= 1;
                const det = nv > 1 ? ((k / (nv - 1)) - 0.5) * p.spread : 0;
                const vib = p.vibrato * 22 * Math.sin(TAU * v.vb[k]) * Math.min(1, v.t * 1.5);
                v.dt[k] = v.f * Math.pow(2, (det + vib) / 1200) / sr;
              }
              const dt = v.dt[k];
              v.ph[k] += dt; if (v.ph[k] >= 1) v.ph[k] -= 1;
              src += 2 * v.ph[k] - 1 - polyBlep(v.ph[k], dt);                // band-limited saw as the voice source
            }
            v.tilt += 0.35 * (src / nv - v.tilt);                              // a little more roll-off, like a glottal pulse
            src = v.tilt + this.nz.next() * p.breath * 0.15;
            const y = v.fl[0].process(src) * v.g[0] + v.fl[1].process(src) * v.g[1] + v.fl[2].process(src) * v.g[2];
            if (v.rel) { v.env *= rk; if (v.env < 0.0003) { v.on = false; continue; } } else v.env = Math.min(1, v.env + att);
            const o = y * v.env * v.vel, pan = ((v.key % 7) - 3) * 0.08;
            sl += o * (1 - pan); sr_ += o * (1 + pan);
          }
          L[i] += sl * vol; R[i] += sr_ * vol;
        }
      }
    }

    return {
      instruments: {
        epiano: { schema: epSchema, meta: { name: 'E-Piano', description: 'Tine electric piano: FM with velocity bark, bell and stereo tremolo' }, create: (sr) => new EPiano(sr),
          presets: { Default: {}, Soft: { bark: 0.25, bell: 0.15, trem: 0.15 }, 'Bright bark': { bark: 0.95, bell: 0.5, drive: 0.4 }, 'Tremolo ballad': { trem: 0.7, tremRate: 3.2, decay: 1.6 } } },
        strings: { schema: stSchema, meta: { name: 'Strings', description: 'String ensemble: detuned saws, gentle filter, stereo ensemble chorus' }, create: (sr) => new Strings(sr),
          presets: { Default: {}, 'Slow pad': { attack: 1.4, release: 2.5, bright: 0.3 }, Staccato: { attack: 0.01, release: 0.12, bright: 0.6 }, 'Wide octaves': { octave: 1, ensemble: 0.9, detune: 14 } } },
        piano: { schema: pnSchema, meta: { name: 'Piano', description: 'Soft piano: additive strings with inharmonicity, two strings per note and a hammer' }, create: (sr) => new Piano(sr),
          presets: { Default: {}, Felt: { bright: 0.15, hammer: 0.15, release: 0.4 }, Bright: { bright: 0.9, hammer: 0.6 }, 'Honky tonk': { detune: 6, bright: 0.7 } } },
        choir: { schema: chSchema, meta: { name: 'Choir', description: 'Formant choir: several singers per note, vowels a–e–i–o–u, vibrato and breath' }, create: (sr) => new Choir(sr),
          presets: { Default: {}, Ooh: { vowel: 4 }, Eeh: { vowel: 2, spread: 8 }, 'Big hall': { voices: 4, spread: 22, attack: 0.6, release: 1.8 } } },
      },
    };
  },
});
