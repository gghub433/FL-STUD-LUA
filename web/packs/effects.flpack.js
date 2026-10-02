// FL LUA Effects: seven effects. Original designs, written for FL LUA's plugin pack format (see docs/PACKS.md).
//   Soft Clipper   drive into a smooth clipper with four curves and optional oversampling
//   Maximizer      one-knob three-band loudness maximizer with a look-ahead limiter
//   Hyper Chorus   up to 8 modulated voices spread across the stereo field
//   Waveshaper     eight transfer curves (soft, hard, fold, sine fold, diode, Chebyshev 3 and 5, steps)
//   Overdrive      tight pre-filter, tube / crunch / fuzz clipper with asymmetry, tone and low cut
//   Delay Bank     four independent delay taps (tempo-synced or free) with level, pan, feedback and damping
//   Pitcher        monophonic pitch corrector: snaps a voice or lead to a scale (YIN pitch detection + granular shifter)
globalThis.__flluaRegisterPack({
  id: 'fllua-effects',
  name: 'FL LUA Effects',
  version: '1.0.0',
  author: 'FL LUA',
  license: 'MIT',
  description: 'Soft Clipper, Maximizer, Hyper Chorus, Waveshaper, Overdrive, Delay Bank and Pitcher: mastering, character and vocal tools.',
  api: 1,
  plugins(api) {
    const { def, bool, choice, defaults } = api.params;
    const { TAU, clamp, dbToGain, Biquad, DelayLine, Noise, SYNC_DIVS, SYNC_LABELS } = api.dsp;
    const ms = (v, sr) => Math.max(1, v * 0.001 * sr);
    const tanh = Math.tanh;

    // 2x oversampling around a non-linearity: linear up-sampling, the shaper runs on both samples, a 4th-order low pass
    // (Butterworth, two biquads at the doubled rate) removes what lies above the original Nyquist, then every other sample is kept
    class Over2 {
      constructor(sr) {
        this.prev = 0;
        this.f = [new Biquad().set('lp', sr * 2, sr * 0.46, 0.5412), new Biquad().set('lp', sr * 2, sr * 0.46, 1.3066)];
      }
      mid(x) { const m = (this.prev + x) * 0.5; this.prev = x; return m; }
      down(a, b) {
        let y = this.f[1].process(this.f[0].process(a));
        y = this.f[1].process(this.f[0].process(b));
        return y;
      }
    }
    class DcBlock { constructor() { this.x = 0; this.y = 0; } process(x) { this.y = x - this.x + 0.995 * this.y; this.x = x; return this.y; } }

    // =================================================================================================== Soft Clipper
    const softSchema = [
      def('drive', 'Drive', 0, 36, 12, { unit: 'dB' }),
      def('threshold', 'Threshold', -24, 0, -3, { unit: 'dB' }),
      choice('shape', 'Curve', ['Tanh', 'Cubic', 'Arctan', 'Hard knee'], 0),
      def('output', 'Output', -24, 12, 0, { unit: 'dB' }),
      bool('os', 'Oversampling', 1),
      def('mix', 'Mix', 0, 1, 1),
    ];
    const clipCurve = (kind, u) => {
      switch (kind) {
        case 0: return tanh(u);
        case 1: return u <= -1 ? -1 : u >= 1 ? 1 : 1.5 * (u - (u * u * u) / 3);
        case 2: return (2 / Math.PI) * Math.atan((Math.PI / 2) * u);
        default: { const a = Math.abs(u); return (u < 0 ? -1 : 1) * (a < 0.6 ? a : 0.6 + 0.4 * tanh((a - 0.6) / 0.4)); }
      }
    };
    class SoftClip {
      constructor(sr) { this.sr = sr; this.p = defaults(softSchema); this.o = [new Over2(sr), new Over2(sr)]; }
      setParam(id, v) { this.p[id] = v; }
      process(L, R, n) {
        const p = this.p, drive = dbToGain(p.drive), T = dbToGain(p.threshold), out = dbToGain(p.output), kind = p.shape, mix = p.mix, iT = 1 / T;
        for (let i = 0; i < n; i++) {
          for (let c = 0; c < 2; c++) {
            const buf = c ? R : L, x = buf[i];
            let y;
            if (p.os) { const o = this.o[c], m = o.mid(x); y = o.down(T * clipCurve(kind, m * drive * iT), T * clipCurve(kind, x * drive * iT)); }
            else y = T * clipCurve(kind, x * drive * iT);
            buf[i] = x + (y * out - x) * mix;
          }
        }
      }
    }
    const softPresets = {
      'Gentle glue': { drive: 4, threshold: -3, shape: 0, output: 0 },
      'Loud and round': { drive: 14, threshold: -6, shape: 0, output: 1 },
      'Cubic warmth': { drive: 8, threshold: -4, shape: 1 },
      'Hard knee limiter': { drive: 10, threshold: -1, shape: 3 },
    };

    // =================================================================================================== Maximizer
    const maxSchema = [
      def('amount', 'Amount', 0, 1, 0.5),
      choice('mode', 'Character', ['Clean', 'Punch', 'Warm', 'Loud'], 0),
      def('low', 'Low band', -6, 6, 0, { unit: 'dB' }),
      def('mid', 'Mid band', -6, 6, 0, { unit: 'dB' }),
      def('high', 'High band', -6, 6, 0, { unit: 'dB' }),
      def('ceiling', 'Ceiling', -6, 0, -0.3, { unit: 'dB' }),
      def('mix', 'Mix', 0, 1, 1),
    ];
    const MODES = [[3, 8, 120, 0], [4, 20, 90, 0.2], [3, 12, 200, 0.8], [8, 3, 60, 0.5]];       // ratio, attack ms, release ms, warmth
    class Maximizer {
      constructor(sr) {
        this.sr = sr; this.p = defaults(maxSchema);
        this.la = Math.round(sr * 0.0015);
        const lr = (type, f) => [new Biquad().set(type, sr, f, 0.7071), new Biquad().set(type, sr, f, 0.7071)];       // Linkwitz-Riley 4th order = two Butterworth stages
        const split = () => ({ lp1: lr('lp', 180), hp1: lr('hp', 180), lp2: lr('lp', 2800), hp2: lr('hp', 2800) });
        this.x = [split(), split()];
        this.env = [0, 0, 0]; this.gDb = [0, 0, 0];
        this.dry = [new DelayLine(this.la + 8), new DelayLine(this.la + 8)];
        this.dl = [new DelayLine(this.la + 8), new DelayLine(this.la + 8)];
        this.ring = new Float32Array(this.la + 1); this.ri = 0; this.g = 1;
        this.latency = this.la;
        this.band = new Float64Array(6);
      }
      setParam(id, v) { this.p[id] = v; }
      reset() { this.env.fill(0); this.gDb.fill(0); this.ring.fill(0); this.g = 1; this.dry.forEach((d) => d.clear()); this.dl.forEach((d) => d.clear()); }
      process(L, R, n) {
        const p = this.p, sr = this.sr, la = this.la;
        const [ratio, atk, rel, warm] = MODES[p.mode];
        const ac = 1 - Math.exp(-1 / ms(atk, sr)), rc = 1 - Math.exp(-1 / ms(rel, sr));
        const amt = p.amount, thr = [-amt * 22, -amt * 22, -amt * 18], makeup = amt * 22 * 0.55;
        const trim = [p.low, p.mid, p.high], w = amt * warm, ceil = dbToGain(p.ceiling), limRel = 1 - Math.exp(-1 / ms(80, sr));
        const slope = 1 - 1 / ratio, b = this.band;
        for (let i = 0; i < n; i++) {
          // split both channels into three bands
          for (let c = 0; c < 2; c++) {
            const x = (c ? R : L)[i], s = this.x[c];
            b[c * 3] = s.lp1[1].process(s.lp1[0].process(x));
            const rest = s.hp1[1].process(s.hp1[0].process(x));
            b[c * 3 + 1] = s.lp2[1].process(s.lp2[0].process(rest));
            b[c * 3 + 2] = s.hp2[1].process(s.hp2[0].process(rest));
          }
          const wet = [0, 0];
          for (let k = 0; k < 3; k++) {
            const pk = Math.max(Math.abs(b[k]), Math.abs(b[3 + k]));            // linked detector
            this.env[k] += (pk > this.env[k] ? ac : rc) * (pk - this.env[k]);
            const over = 20 * Math.log10(this.env[k] + 1e-9) - thr[k];
            let red = 0;
            if (over > 3) red = -slope * over; else if (over > -3) red = (-slope * (over + 3) * (over + 3)) / 12;      // 6 dB soft knee
            const target = amt > 0 ? red + makeup * (amt > 0 ? 1 : 0) + trim[k] : trim[k];
            this.gDb[k] += (target - this.gDb[k]) * 0.2;
            const g = Math.exp(this.gDb[k] * 0.1151293);
            wet[0] += b[k] * g; wet[1] += b[3 + k] * g;
          }
          // warmth: blend towards a soft-saturated copy, then the look-ahead limiter on the delayed signal
          let peak = 0;
          for (let c = 0; c < 2; c++) {
            const sat = tanh(wet[c] * 1.3) / 1.3;
            wet[c] += w * (sat - wet[c]);
            this.dl[c].write(wet[c]); this.dry[c].write((c ? R : L)[i]);
            peak = Math.max(peak, Math.abs(wet[c]));
          }
          this.ring[this.ri] = peak; this.ri = (this.ri + 1) % this.ring.length;
          let mx = 0; for (let j = 0; j < this.ring.length; j++) if (this.ring[j] > mx) mx = this.ring[j];
          const want = mx > ceil ? ceil / mx : 1;
          if (want < this.g) this.g += (want - this.g) * Math.min(1, 2 / la); else this.g += (want - this.g) * limRel;
          for (let c = 0; c < 2; c++) {
            const y = clamp(this.dl[c].readInt(la + 1) * Math.min(this.g, want >= 1 ? 1 : want + (this.g - want)), -ceil, ceil);
            const d = this.dry[c].readInt(la + 1);
            (c ? R : L)[i] = d + (y - d) * p.mix;
          }
        }
      }
    }
    const maxPresets = {
      'Mastering touch': { amount: 0.35, mode: 0, ceiling: -0.3 },
      'Punchy drums': { amount: 0.55, mode: 1, low: 1, high: 1 },
      'Warm glue': { amount: 0.5, mode: 2, mid: 0.5 },
      'Loud as it gets': { amount: 0.9, mode: 3, ceiling: -0.1 },
    };

    // =================================================================================================== Hyper Chorus
    const hcSchema = [
      def('voices', 'Voices', 1, 8, 5, { int: true }),
      def('rate', 'Rate', 0.05, 4, 0.35, { unit: 'Hz', curve: 'log' }),
      def('depth', 'Depth', 0, 20, 4, { unit: 'ms' }),
      def('delay', 'Delay', 3, 30, 12, { unit: 'ms' }),
      def('scatter', 'Rate scatter', 0, 1, 0.5),
      def('spread', 'Stereo spread', 0, 1, 0.8),
      def('feedback', 'Feedback', -0.6, 0.6, 0),
      def('lowcut', 'Low cut', 20, 1000, 120, { unit: 'Hz', curve: 'log' }),
      def('highcut', 'High cut', 1000, 20000, 12000, { unit: 'Hz', curve: 'log' }),
      def('mix', 'Mix', 0, 1, 0.5),
    ];
    class HyperChorus {
      constructor(sr) {
        this.sr = sr; this.p = defaults(hcSchema);
        this.d = new DelayLine(Math.round(sr * 0.06));
        this.ph = new Float64Array(8).map((_, i) => i / 8);
        this.hash = [0.13, 0.71, 0.42, 0.93, 0.27, 0.58, 0.84, 0.05];
        this.hp = [new Biquad(), new Biquad()]; this.lp = [new Biquad(), new Biquad()];
        this.fb = 0; this.cacheKey = '';
      }
      setParam(id, v) { this.p[id] = v; }
      reset() { this.d.clear(); this.fb = 0; this.hp.forEach((f) => f.reset()); this.lp.forEach((f) => f.reset()); }
      process(L, R, n) {
        const p = this.p, sr = this.sr, V = Math.round(p.voices);
        const key = `${p.lowcut}|${p.highcut}`;
        if (key !== this.cacheKey) { this.cacheKey = key; for (let c = 0; c < 2; c++) { this.hp[c].set('hp', sr, p.lowcut, 0.7071); this.lp[c].set('lp', sr, p.highcut, 0.7071); } }
        const norm = 1.25 / Math.sqrt(V), base = (p.delay * sr) / 1000, depth = (p.depth * sr) / 1000;
        const pl = [], pr = [], inc = [];
        for (let v = 0; v < V; v++) {
          const pan = V === 1 ? 0 : ((v / (V - 1)) * 2 - 1) * p.spread, a = (pan + 1) * 0.7853981634;
          pl.push(Math.cos(a) * Math.SQRT2); pr.push(Math.sin(a) * Math.SQRT2);
          inc.push((p.rate * (1 + (this.hash[v] - 0.5) * 2 * p.scatter * 0.6)) / sr);
        }
        for (let i = 0; i < n; i++) {
          this.d.write((L[i] + R[i]) * 0.5 + this.fb * p.feedback);
          let wl = 0, wr = 0, mono = 0;
          for (let v = 0; v < V; v++) {
            this.ph[v] += inc[v]; if (this.ph[v] >= 1) this.ph[v] -= 1;
            const t = base + depth * (0.5 + 0.5 * Math.sin(TAU * this.ph[v]));
            const s = this.d.read(Math.max(1, t));
            wl += s * pl[v]; wr += s * pr[v]; mono += s;
          }
          this.fb = mono / V;
          wl = this.lp[0].process(this.hp[0].process(wl * norm)); wr = this.lp[1].process(this.hp[1].process(wr * norm));
          L[i] += (wl - L[i]) * p.mix; R[i] += (wr - R[i]) * p.mix;
        }
      }
    }
    const hcPresets = {
      'Supersaw sheen': { voices: 7, rate: 0.25, depth: 5, spread: 1, mix: 0.55 },
      'Subtle widener': { voices: 3, rate: 0.5, depth: 2, delay: 9, spread: 0.7, mix: 0.35 },
      'Vintage ensemble': { voices: 4, rate: 0.7, depth: 7, delay: 14, scatter: 0.2, spread: 0.6, mix: 0.5 },
      'Seasick': { voices: 6, rate: 0.12, depth: 16, delay: 20, feedback: 0.25, mix: 0.6 },
    };

    // =================================================================================================== Waveshaper
    const wsSchema = [
      choice('curve', 'Curve', ['Soft (tanh)', 'Hard clip', 'Foldback', 'Sine fold', 'Diode', 'Chebyshev 3', 'Chebyshev 5', 'Steps'], 0),
      def('drive', 'Drive', 0, 40, 12, { unit: 'dB' }),
      def('bias', 'Bias', -1, 1, 0),
      def('tone', 'Tone', 200, 20000, 20000, { unit: 'Hz', curve: 'log' }),
      def('output', 'Output', -24, 12, -6, { unit: 'dB' }),
      bool('os', 'Oversampling', 1),
      def('mix', 'Mix', 0, 1, 1),
    ];
    const shapeWs = (kind, x) => {
      switch (kind) {
        case 0: return tanh(x);
        case 1: return x < -1 ? -1 : x > 1 ? 1 : x;
        case 2: { let t = (x + 1) % 4; if (t < 0) t += 4; return (t < 2 ? t : 4 - t) - 1; }
        case 3: return Math.sin(x * 1.5707963);
        case 4: return x >= 0 ? tanh(x) : 0.55 * tanh(x / 0.55) * 0.9;
        case 5: { const u = x < -1 ? -1 : x > 1 ? 1 : x; return 4 * u * u * u - 3 * u; }
        case 6: { const u = x < -1 ? -1 : x > 1 ? 1 : x; return 16 * u ** 5 - 20 * u ** 3 + 5 * u; }
        default: { const t = tanh(x); return 0.5 * t + (0.5 * Math.round(t * 6)) / 6; }
      }
    };
    class Waveshaper {
      constructor(sr) { this.sr = sr; this.p = defaults(wsSchema); this.o = [new Over2(sr), new Over2(sr)]; this.dc = [new DcBlock(), new DcBlock()]; this.lp = [new Biquad(), new Biquad()]; this.tone = -1; }
      setParam(id, v) { this.p[id] = v; }
      reset() { this.dc.forEach((d) => { d.x = d.y = 0; }); this.lp.forEach((f) => f.reset()); }
      process(L, R, n) {
        const p = this.p, drive = dbToGain(p.drive), out = dbToGain(p.output), kind = p.curve, bias = p.bias * 0.5;
        if (p.tone !== this.tone) { this.tone = p.tone; for (const f of this.lp) f.set('lp', this.sr, p.tone, 0.7071); }
        const useTone = p.tone < 19000;
        for (let i = 0; i < n; i++) {
          for (let c = 0; c < 2; c++) {
            const buf = c ? R : L, x = buf[i];
            let y;
            if (p.os) { const o = this.o[c], m = o.mid(x); y = o.down(shapeWs(kind, m * drive + bias), shapeWs(kind, x * drive + bias)); }
            else y = shapeWs(kind, x * drive + bias);
            y = this.dc[c].process(y);
            if (useTone) y = this.lp[c].process(y);
            buf[i] = x + (y * out - x) * p.mix;
          }
        }
      }
    }
    const wsPresets = {
      'Warm tanh': { curve: 0, drive: 10, output: -4 },
      'Wavefolder': { curve: 2, drive: 20, output: -9, tone: 8000 },
      'Sine fold shimmer': { curve: 3, drive: 24, output: -10, tone: 12000 },
      'Odd harmonics (Cheby 3)': { curve: 5, drive: 6, output: -6 },
      'Crushed steps': { curve: 7, drive: 18, output: -8 },
      'Diode bite': { curve: 4, drive: 16, bias: 0.2, output: -7 },
    };

    // =================================================================================================== Overdrive
    const odSchema = [
      choice('mode', 'Character', ['Tube', 'Crunch', 'Fuzz'], 0),
      def('drive', 'Drive', 0, 1, 0.5),
      def('focus', 'Focus', 200, 4000, 900, { unit: 'Hz', curve: 'log' }),
      def('focusGain', 'Focus gain', 0, 12, 6, { unit: 'dB' }),
      def('color', 'Asymmetry', 0, 1, 0.3),
      def('lowcut', 'Low cut', 20, 400, 90, { unit: 'Hz', curve: 'log' }),
      def('tone', 'Tone', 800, 16000, 6000, { unit: 'Hz', curve: 'log' }),
      def('level', 'Level', -24, 6, -6, { unit: 'dB' }),
      def('mix', 'Mix', 0, 1, 1),
    ];
    class Overdrive {
      constructor(sr) {
        this.sr = sr; this.p = defaults(odSchema);
        this.hp = [new Biquad(), new Biquad()]; this.pk = [new Biquad(), new Biquad()]; this.lp = [new Biquad(), new Biquad()];
        this.o = [new Over2(sr), new Over2(sr)]; this.dc = [new DcBlock(), new DcBlock()]; this.key = '';
      }
      setParam(id, v) { this.p[id] = v; }
      reset() { for (const a of [this.hp, this.pk, this.lp]) a.forEach((f) => f.reset()); this.dc.forEach((d) => { d.x = d.y = 0; }); }
      _shape(x, mode, color) {
        if (mode === 0) { const b = color * 0.6; return tanh(x + b) - tanh(b); }
        if (mode === 1) return x >= 0 ? x / (1 + x) : x / (1 - x * (1 - 0.6 * color));
        const a = Math.abs(x), y = 1 - Math.exp(-a * 3);
        return (x < 0 ? -y * (1 - 0.35 * color) : y) ;
      }
      process(L, R, n) {
        const p = this.p, sr = this.sr;
        const key = `${p.lowcut}|${p.focus}|${p.focusGain}|${p.tone}`;
        if (key !== this.key) {
          this.key = key;
          for (let c = 0; c < 2; c++) { this.hp[c].set('hp', sr, p.lowcut, 0.7071); this.pk[c].set('peak', sr, p.focus, 0.9, p.focusGain); this.lp[c].set('lp', sr, p.tone, 0.7071); }
        }
        const pre = Math.pow(10, (p.drive * 40) / 20), out = dbToGain(p.level) / (1 + p.drive * 1.5), mode = p.mode, color = p.color;
        for (let i = 0; i < n; i++) {
          for (let c = 0; c < 2; c++) {
            const buf = c ? R : L, x = buf[i];
            const f = this.pk[c].process(this.hp[c].process(x)) * pre * 0.5;
            const o = this.o[c], m = o.mid(f);
            let y = o.down(this._shape(m, mode, color), this._shape(f, mode, color));
            y = this.lp[c].process(this.dc[c].process(y));
            buf[i] = x + (y * out * 3 - x) * p.mix;
          }
        }
      }
    }
    const odPresets = {
      'Tube warmth': { mode: 0, drive: 0.35, color: 0.4, tone: 5000, level: -5 },
      'Crunchy guitar': { mode: 1, drive: 0.65, focus: 1200, focusGain: 8, tone: 4500 },
      'Fuzz lead': { mode: 2, drive: 0.8, color: 0.5, tone: 3500, level: -9 },
      'Bass grit': { mode: 0, drive: 0.5, lowcut: 40, focus: 400, focusGain: 5, tone: 3000 },
    };

    // =================================================================================================== Delay Bank
    const dbSchema = [bool('sync', 'Tempo sync', 1, { group: 'Global' }), def('lowcut', 'Wet low cut', 20, 2000, 60, { unit: 'Hz', curve: 'log', group: 'Global' }), def('mix', 'Mix', 0, 1, 0.35, { group: 'Global' })];
    const TAPS = [[5, 400, 0, -0.5, 0], [8, 600, -3, 0.5, 0.3], [6, 800, -6, -0.8, 0.3], [9, 1200, -9, 0.8, 0.35]];     // sync index, free ms, dB, pan, feedback
    TAPS.forEach(([sidx, free, lvl, pan, fb], i) => {
      const g = `Tap ${i + 1}`;
      dbSchema.push(choice(`div${i + 1}`, 'Division', SYNC_LABELS, sidx, { group: g }), def(`time${i + 1}`, 'Time', 1, 2000, free, { unit: 'ms', curve: 'log', group: g }),
        def(`level${i + 1}`, 'Level', -60, 6, lvl, { unit: 'dB', group: g }), def(`pan${i + 1}`, 'Pan', -1, 1, pan, { group: g }),
        def(`fb${i + 1}`, 'Feedback', 0, 0.95, fb, { group: g }), def(`cut${i + 1}`, 'High cut', 500, 20000, 9000, { unit: 'Hz', curve: 'log', group: g }));
    });
    class DelayBank {
      constructor(sr, host) {
        this.sr = sr; this.host = host; this.p = defaults(dbSchema);
        this.lines = TAPS.map(() => new DelayLine(Math.round(sr * 4.2)));
        this.t = TAPS.map(() => 0); this.damp = TAPS.map(() => 0); this.fbv = TAPS.map(() => 0);
        this.hp = [new Biquad(), new Biquad()]; this.hpKey = -1; this.init = false;
      }
      setParam(id, v) { this.p[id] = v; }
      reset() { for (const d of this.lines) d.clear(); this.damp.fill(0); this.fbv.fill(0); this.hp.forEach((f) => f.reset()); this.init = false; }
      process(L, R, n) {
        const p = this.p, sr = this.sr, tempo = (this.host && this.host.tempo) || 120;
        if (p.lowcut !== this.hpKey) { this.hpKey = p.lowcut; for (const f of this.hp) f.set('hp', sr, p.lowcut, 0.7071); }
        const target = [], lvl = [], pl = [], pr = [], cut = [], fb = [];
        for (let k = 0; k < 4; k++) {
          const i = k + 1;
          const t = p.sync ? SYNC_DIVS[Math.round(p[`div${i}`])][1] * (60 / tempo) * sr : (p[`time${i}`] * sr) / 1000;
          target.push(clamp(t, 1, sr * 4));
          lvl.push(dbToGain(p[`level${i}`]));
          const a = (p[`pan${i}`] + 1) * 0.7853981634; pl.push(Math.cos(a) * Math.SQRT2); pr.push(Math.sin(a) * Math.SQRT2);
          cut.push(1 - Math.exp((-TAU * p[`cut${i}`]) / sr)); fb.push(p[`fb${i}`]);
          if (!this.init) this.t[k] = target[k];
        }
        this.init = true;
        const sm = 1 - Math.exp(-1 / ms(40, sr));
        for (let i = 0; i < n; i++) {
          const x = (L[i] + R[i]) * 0.5;
          let wl = 0, wr = 0;
          for (let k = 0; k < 4; k++) {
            this.t[k] += (target[k] - this.t[k]) * sm;                           // smoothed time: no clicks when the tempo or the knob moves
            const d = this.lines[k], y = d.read(Math.max(1, this.t[k]));
            this.damp[k] += cut[k] * (y - this.damp[k]);
            d.write(x + this.damp[k] * fb[k]);
            wl += y * lvl[k] * pl[k]; wr += y * lvl[k] * pr[k];
          }
          wl = this.hp[0].process(wl); wr = this.hp[1].process(wr);
          L[i] += wl * p.mix; R[i] += wr * p.mix;
        }
      }
    }
    const dbPresets = {
      'Rhythmic echoes': { sync: 1, level1: 0, level2: -3, level3: -6, level4: -9 },
      'Wide ping-pong': { sync: 1, div1: 8, div2: 8, level1: 0, level2: 0, level3: -60, level4: -60, pan1: -1, pan2: 1, fb1: 0.5, fb2: 0.5 },
      'Slapback': { sync: 0, time1: 90, level1: 0, level2: -60, level3: -60, level4: -60, fb1: 0.1, pan1: 0, mix: 0.3 },
      'Dub tape': { sync: 1, div1: 9, level1: -2, level2: -60, level3: -60, level4: -60, fb1: 0.7, cut1: 2500, mix: 0.4, pan1: 0.4 },
    };

    // =================================================================================================== Pitcher
    const SCALES = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [0, 2, 4, 5, 7, 9, 11], [0, 2, 3, 5, 7, 8, 10], [0, 2, 4, 7, 9], [0, 3, 5, 7, 10], [0, 2, 3, 5, 7, 9, 10], [0, 3, 5, 6, 7, 10]];
    const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const RANGES = [[60, 330], [80, 700], [150, 1100]];
    const pitcherSchema = [
      choice('scale', 'Scale', ['Chromatic', 'Major', 'Minor', 'Pentatonic major', 'Pentatonic minor', 'Dorian', 'Blues'], 0),
      choice('key', 'Key', KEYS, 0),
      def('speed', 'Retune speed', 0, 1, 0.1),
      def('amount', 'Correction amount', 0, 1, 1),
      choice('range', 'Voice range', ['Low (60 to 330 Hz)', 'Medium (80 to 700 Hz)', 'High (150 to 1100 Hz)'], 1),
      def('transpose', 'Transpose', -12, 12, 0, { unit: 'st', int: true }),
      def('mix', 'Mix', 0, 1, 1),
    ];
    class Pitcher {
      constructor(sr) {
        this.sr = sr; this.p = defaults(pitcherSchema);
        this.D = 4; this.srd = sr / 4; this.W = 512; this.hop = 128;
        this.maxLag = Math.ceil(this.srd / 55) + 2;
        this.ring = new Float32Array(2048); this.rw = 0; this.dc = 0; this.lpA = 0; this.lpB = 0; this.hopCount = 0;
        this.tmp = new Float32Array(this.W + this.maxLag + 2); this.cmnd = new Float32Array(this.maxLag + 2);
        this.target = 0; this.cur = 0; this.last = null; this.unvoiced = 0; this.shiftTarget = 0;
        this.Wg = Math.round(sr * 0.03); this.B = 1; while (this.B < this.Wg * 4) this.B <<= 1;
        this.base = 2;                                           // minimum read delay
        this.Wcur = this.Wg; this.Wtarget = this.Wg;             // grain length: a whole number of pitch periods while the input is voiced
        this.buf = [new Float32Array(this.B), new Float32Array(this.B)]; this.w = 0; this.dphase = 0;
        this.latency = Math.round(this.Wg / 4) + this.base;       // about the average delay of the grain cross-fade
        this.dry = [new DelayLine(this.latency + 8), new DelayLine(this.latency + 8)];
        this.freq = 0; this.conf = 0;
      }
      setParam(id, v) { this.p[id] = v; }
      reset() { this.ring.fill(0); this.buf[0].fill(0); this.buf[1].fill(0); this.cur = 0; this.shiftTarget = 0; this.last = null; this.dry.forEach((d) => d.clear()); }
      // YIN on the 4x decimated signal; sets this.freq (Hz, 0 when unvoiced) and this.conf
      _detect() {
        const { W, maxLag, srd, tmp, cmnd, ring } = this;
        const total = W + maxLag + 1, mask = ring.length - 1;
        let e = 0;
        for (let i = 0; i < total; i++) { const v = ring[(this.rw - total + i) & mask]; tmp[i] = v; if (i < W) e += v * v; }
        if (Math.sqrt(e / W) < 0.004) { this.freq = 0; this.conf = 0; return; }
        const [fmin, fmax] = RANGES[this.p.range];
        const tauMin = Math.max(2, Math.floor(srd / fmax)), tauMax = Math.min(maxLag - 1, Math.ceil(srd / fmin));
        let run = 0;
        cmnd[0] = 1;
        for (let tau = 1; tau <= tauMax; tau++) {
          let d = 0;
          for (let j = 0; j < W; j++) { const x = tmp[j] - tmp[j + tau]; d += x * x; }
          run += d;
          cmnd[tau] = run > 0 ? (d * tau) / run : 1;
        }
        let tau = -1;
        for (let t = tauMin; t <= tauMax; t++) {
          if (cmnd[t] < 0.15) { while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++; tau = t; break; }
        }
        if (tau < 0) { this.freq = 0; this.conf = 0; return; }
        const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[Math.min(tau + 1, tauMax)];
        const den = a + c - 2 * b, shift = den !== 0 ? (a - c) / (2 * den) : 0;
        this.freq = srd / (tau + clamp(shift, -1, 1));
        this.conf = 1 - b;
      }
      _correct() {
        const p = this.p;
        if (this.freq <= 0 || this.conf < 0.7) { if (++this.unvoiced > 2) { this.shiftTarget = 0; this.last = null; this.Wtarget = this.Wg; } return; }
        this.unvoiced = 0;
        { const period = this.sr / this.freq; this.Wtarget = 2 * Math.max(1, Math.round((this.Wg * 0.25) / period)) * period; }
        const midi = 69 + 12 * Math.log2(this.freq / 440), mask = SCALES[p.scale], key = p.key;
        const ok = (n) => mask.includes((((n - key) % 12) + 12) % 12);
        let best = null;
        if (this.last !== null && ok(this.last) && Math.abs(midi - this.last) < 0.65) best = this.last;           // hysteresis: stay on the note until the voice has clearly left it
        else {
          let bd = 99;
          for (let n = Math.round(midi) - 3; n <= Math.round(midi) + 3; n++) if (ok(n) && Math.abs(n - midi) < bd) { bd = Math.abs(n - midi); best = n; }
        }
        this.last = best;
        this.shiftTarget = best === null ? 0 : best - midi;
      }
      process(L, R, n) {
        const p = this.p, sr = this.sr, B = this.B, bm = B - 1;
        const tau = 0.001 + p.speed * p.speed * 0.4, k = 1 - Math.exp(-1 / (tau * sr)), lpc = 1 - Math.exp((-TAU * 0.4 * this.srd) / sr);
        const ringMask = this.ring.length - 1;
        for (let i = 0; i < n; i++) {
          const x = (L[i] + R[i]) * 0.5;
          // decimate by 4 behind a low pass
          this.lpA += lpc * (x - this.lpA); this.lpB += lpc * (this.lpA - this.lpB);
          if (++this.dc === this.D) {
            this.dc = 0;
            this.ring[this.rw] = this.lpB; this.rw = (this.rw + 1) & ringMask;
            if (++this.hopCount >= this.hop) { this.hopCount = 0; this._detect(); this._correct(); }
          }
          this.cur += (this.shiftTarget - this.cur) * k;
          const ratio = Math.pow(2, (this.cur * p.amount + p.transpose) / 12);
          // two read taps half a grain apart sweep through the delay line; their Hann-shaped gains cross-fade the grains
          // a grain is a whole number of pitch periods (twice a whole number), so for a voiced signal both taps carry the same
          // waveform and the cross-fade adds up instead of cancelling
          this.Wcur += (this.Wtarget - this.Wcur) * 0.002;
          const W = this.Wcur;
          this.dphase += 1 - ratio;
          if (this.dphase >= W || this.dphase < 0) { this.dphase %= W; if (this.dphase < 0) this.dphase += W; }
          const d1 = this.dphase, d2 = (d1 + W * 0.5) % W;
          const g1 = Math.sin((Math.PI * d1) / W) ** 2, g2 = 1 - g1;
          const r1 = d1 + this.base, r2 = d2 + this.base;
          for (let c = 0; c < 2; c++) {
            const buf = this.buf[c], inp = c ? R[i] : L[i];
            buf[this.w] = inp;
            const rd = (d) => { const r = this.w - (d + 1), i0 = Math.floor(r), fr = r - i0; return buf[i0 & bm] + (buf[(i0 + 1) & bm] - buf[i0 & bm]) * fr; };
            const wet = rd(r1) * g1 + rd(r2) * g2;
            this.dry[c].write(inp);
            const dry = this.dry[c].readInt(this.latency + 1);
            (c ? R : L)[i] = dry + (wet - dry) * p.mix;
          }
          this.w = (this.w + 1) & bm;
        }
      }
    }
    const pitcherPresets = {
      'Natural tuning (C major)': { scale: 1, key: 0, speed: 0.45, amount: 1 },
      'Hard tune (T-pain style)': { scale: 0, speed: 0, amount: 1 },
      'Minor key, gentle': { scale: 2, key: 9, speed: 0.6, amount: 0.8 },
      'Octave down': { scale: 0, speed: 1, amount: 0, transpose: -12 },
    };

    return {
      effects: {
        softclip: { schema: softSchema, meta: { name: 'Soft Clipper', category: 'Distortion', description: 'Drive into a smooth clipper: tanh, cubic, arctan or hard-knee curve, with oversampling' }, create: (sr) => new SoftClip(sr), presets: softPresets },
        maximizer: { schema: maxSchema, meta: { name: 'Maximizer', category: 'Dynamics', description: 'One-knob three-band loudness maximizer with a look-ahead limiter (reports its latency)' }, create: (sr) => new Maximizer(sr), presets: maxPresets },
        hyperchorus: { schema: hcSchema, meta: { name: 'Hyper Chorus', category: 'Modulation', description: 'Up to eight modulated delay voices spread across the stereo field' }, create: (sr) => new HyperChorus(sr), presets: hcPresets },
        waveshaper: { schema: wsSchema, meta: { name: 'Waveshaper', category: 'Distortion', description: 'Eight transfer curves: soft, hard, fold, sine fold, diode, Chebyshev 3 and 5, steps' }, create: (sr) => new Waveshaper(sr), presets: wsPresets },
        overdrive: { schema: odSchema, meta: { name: 'Overdrive', category: 'Distortion', description: 'Tube, crunch or fuzz with a focus pre-filter, asymmetry, tone and low cut' }, create: (sr) => new Overdrive(sr), presets: odPresets },
        delaybank: { schema: dbSchema, meta: { name: 'Delay Bank', category: 'Delay', description: 'Four delay taps, each with its own time, level, pan, feedback and damping; tempo-synced or free' }, create: (sr, host) => new DelayBank(sr, host), presets: dbPresets },
        pitcher: { schema: pitcherSchema, meta: { name: 'Pitcher', category: 'Pitch', description: 'Monophonic pitch corrector: snaps a voice or lead to a scale (reports its latency)' }, create: (sr) => new Pitcher(sr), presets: pitcherPresets },
      },
    };
  },
});
