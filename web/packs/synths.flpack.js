// FL LUA Synths: four generators. Original designs, written for FL LUA's plugin pack format (see docs/PACKS.md).
//   Acid Bass  monophonic bass with a resonant ladder filter, accent and slide
//   Tri-Osc    three oscillators with sync, ring modulation and FM, a filter and two envelopes
//   Chip       console-style pulse / triangle / noise voices with arpeggio, vibrato and bit reduction
//   Additive   up to 64 partials with spectral shaping, a formant, inharmonicity and a morph between two spectra
globalThis.__flluaRegisterPack({
  id: 'fllua-synths',
  name: 'FL LUA Synths',
  version: '1.0.0',
  author: 'FL LUA',
  license: 'MIT',
  description: 'Acid Bass, Tri-Osc, Chip and Additive: four generators for basses, leads, game sounds and evolving pads.',
  api: 1,
  plugins(api) {
    const { def, bool, choice, defaults } = api.params;
    const { TAU, clamp, mtof, Noise, polyBlep, SVF, ADSR, fastTanh } = api.dsp;
    const panGain = (pan) => { const a = (clamp(pan || 0, -1, 1) + 1) * 0.7853981634; return [Math.cos(a) * 1.41421356, Math.sin(a) * 1.41421356]; };
    const ms = (v, sr) => Math.max(1, v * 0.001 * sr);

    // =================================================================================================== Acid Bass
    const acidSchema = [
      choice('wave', 'Waveform', ['Saw', 'Square'], 0, { group: 'Oscillator' }),
      def('tune', 'Tune', -24, 24, 0, { unit: 'st', int: true, group: 'Oscillator' }),
      def('slide', 'Slide time', 5, 400, 70, { unit: 'ms', curve: 'log', group: 'Oscillator' }),
      def('cutoff', 'Cutoff', 30, 9000, 500, { unit: 'Hz', curve: 'log', group: 'Filter' }),
      def('res', 'Resonance', 0, 1, 0.65, { group: 'Filter' }),
      def('envMod', 'Envelope amount', 0, 1, 0.6, { group: 'Filter' }),
      def('decay', 'Envelope decay', 30, 2500, 280, { unit: 'ms', curve: 'log', group: 'Filter' }),
      def('accent', 'Accent strength', 0, 1, 0.6, { group: 'Filter' }),
      def('drive', 'Drive', 0, 1, 0.3, { group: 'Output' }),
      def('release', 'Release', 5, 600, 60, { unit: 'ms', curve: 'log', group: 'Output' }),
      def('gain', 'Gain', 0, 1.5, 0.8, { group: 'Output' }),
    ];
    class Acid {
      constructor(sr) {
        this.sr = sr; this.p = defaults(acidSchema);
        this.held = []; this.gate = false; this.lf = Math.log2(110); this.tf = this.lf; this.ph = 0;
        this.amp = 0; this.fenv = 0; this.accent = false; this.pan = [1, 1]; this.vel = 1;
        this.y = [0, 0, 0, 0]; this.last = 0;
      }
      get active() { return this.gate || this.amp > 0.0005; }
      setParam(id, v) { this.p[id] = v; }
      allOff() { this.held.length = 0; this.gate = false; this.amp = 0; this.fenv = 0; this.y.fill(0); }
      _target(key, fine) { return Math.log2(mtof(key + this.p.tune + (fine || 0) / 100)); }
      noteOn(ev) {
        const legato = this.gate;
        this.held = this.held.filter((h) => h.key !== ev.key);
        this.held.push({ key: ev.key, fine: ev.fine || 0 });
        this.tf = this._target(ev.key, ev.fine);
        if (!legato) { this.lf = this.tf; this.fenv = 1; this.accent = ev.vel > 0.8; this.pan = panGain(ev.pan); this.vel = 1; }
        else if (ev.vel > 0.8) this.accent = true;                       // a slid note keeps the filter envelope running; accent still counts
        this.gate = true;
      }
      noteOff(key) {
        this.held = this.held.filter((h) => h.key !== key);
        if (!this.held.length) this.gate = false;
        else { const h = this.held[this.held.length - 1]; this.tf = this._target(h.key, h.fine); }
      }
      process(L, R, i0, i1) {
        if (!this.active) return;
        const p = this.p, sr = this.sr;
        const glide = 1 - Math.exp(-1 / ms(p.slide, sr));
        const ac = this.accent ? p.accent : 0;
        const dec = Math.exp(-4.6 / ms(p.decay * (1 - 0.55 * ac), sr));          // decay and release are times to fall to 1 %
        const rel = Math.exp(-4.6 / ms(p.release, sr)), atk = 1 / ms(1.5, sr);
        const k = p.res * 3.85, drive = 1 + p.drive * 7, dn = 1 / fastTanh(drive);
        const depth = p.envMod * (1 + ac * 0.9) * 3.6, vol = p.gain * (1 + ac * 0.45);
        const y = this.y;
        for (let i = i0; i < i1; i++) {
          this.lf += (this.tf - this.lf) * glide;
          const dt = Math.pow(2, this.lf) / sr;
          this.ph += dt; if (this.ph >= 1) this.ph -= 1;
          let o;
          if (p.wave === 0) o = 2 * this.ph - 1 - polyBlep(this.ph, dt);
          else o = (this.ph < 0.5 ? 1 : -1) + polyBlep(this.ph, dt) - polyBlep((this.ph + 0.5) % 1, dt);
          this.fenv *= dec;
          this.amp = this.gate ? Math.min(1, this.amp + atk) : this.amp * rel;
          const fc = Math.min(p.cutoff * Math.pow(2, depth * this.fenv), 0.23 * sr);
          const g = 1 - Math.exp((-TAU * fc) / sr);
          // four cascaded one-pole stages with tanh in the loop and resonance feedback from the last one
          const x = fastTanh((o - k * y[3]) * 1.0);
          y[0] += g * (x - fastTanh(y[0]));
          y[1] += g * (fastTanh(y[0]) - fastTanh(y[1]));
          y[2] += g * (fastTanh(y[1]) - fastTanh(y[2]));
          y[3] += g * (fastTanh(y[2]) - fastTanh(y[3]));
          const s = fastTanh(y[3] * (1 + k * 0.35) * drive) * dn * this.amp * vol;
          L[i] += s * this.pan[0]; R[i] += s * this.pan[1];
        }
        if (!this.gate && this.amp < 0.0005) { this.amp = 0; this.y.fill(0); }
      }
    }
    const acidPresets = {
      'Classic squelch': { wave: 0, cutoff: 380, res: 0.78, envMod: 0.7, decay: 240, accent: 0.7, drive: 0.35 },
      'Square growl': { wave: 1, cutoff: 260, res: 0.6, envMod: 0.8, decay: 420, accent: 0.5, drive: 0.55, slide: 120 },
      'Deep sub': { wave: 0, cutoff: 150, res: 0.3, envMod: 0.25, decay: 600, accent: 0.2, drive: 0.1, release: 120 },
      'Screamer': { wave: 0, cutoff: 700, res: 0.92, envMod: 0.9, decay: 150, accent: 0.9, drive: 0.7, slide: 40 },
    };

    // =================================================================================================== Tri-Osc
    const WAVES = ['Sine', 'Triangle', 'Saw', 'Square', 'Pulse 25%', 'Pulse 12%'];
    const trioSchema = [];
    [[1, 2, 0, 0, 0.8], [2, 2, 0, 8, 0.6], [3, 3, -12, 0, 0.5]].forEach(([n, w, semi, fine, lvl]) => {
      const grp = `Oscillator ${n}`;
      trioSchema.push(choice(`wave${n}`, 'Waveform', WAVES, w, { group: grp }), def(`semi${n}`, 'Semitones', -36, 36, semi, { int: true, group: grp }),
        def(`fine${n}`, 'Fine tune', -100, 100, fine, { unit: 'cents', group: grp }), def(`lvl${n}`, 'Level', 0, 1, lvl, { group: grp }));
    });
    trioSchema.push(
      bool('sync', 'Oscillator 2 syncs to 1', 0, { group: 'Modulation' }),
      def('ring', 'Ring mod 1 × 2', 0, 1, 0, { group: 'Modulation' }),
      def('fm', 'FM: osc 1 into osc 3', 0, 1, 0, { group: 'Modulation' }),
      choice('ftype', 'Filter type', ['Low pass', 'High pass', 'Band pass'], 0, { group: 'Filter' }),
      def('cutoff', 'Cutoff', 20, 18000, 3500, { unit: 'Hz', curve: 'log', group: 'Filter' }),
      def('res', 'Resonance', 0, 1, 0.2, { group: 'Filter' }),
      def('fenv', 'Envelope amount', -1, 1, 0.35, { group: 'Filter' }),
      def('track', 'Key tracking', 0, 1, 0.3, { group: 'Filter' }),
      def('fdecay', 'Filter decay', 10, 5000, 400, { unit: 'ms', curve: 'log', group: 'Filter' }),
      def('fsustain', 'Filter sustain', 0, 1, 0.2, { group: 'Filter' }),
      def('attack', 'Attack', 1, 5000, 5, { unit: 'ms', curve: 'log', group: 'Amplifier' }),
      def('decay', 'Decay', 5, 5000, 300, { unit: 'ms', curve: 'log', group: 'Amplifier' }),
      def('sustain', 'Sustain', 0, 1, 0.7, { group: 'Amplifier' }),
      def('release', 'Release', 5, 8000, 250, { unit: 'ms', curve: 'log', group: 'Amplifier' }),
      def('glide', 'Glide', 0, 500, 0, { unit: 'ms', group: 'Performance' }),
      def('vibrato', 'Vibrato depth', 0, 1, 0, { group: 'Performance' }),
      def('vibRate', 'Vibrato rate', 0.1, 12, 5, { unit: 'Hz', group: 'Performance' }),
      def('poly', 'Polyphony', 1, 8, 8, { int: true, group: 'Performance' }),
      def('gain', 'Gain', 0, 1.5, 0.7, { group: 'Performance' }));
    const pulse = (ph, dt, w) => (ph < w ? 1 : -1) + polyBlep(ph, dt) - polyBlep((ph + 1 - w) % 1, dt) + (1 - 2 * w);   // band-limited, DC removed
    const wave3 = (kind, ph, dt) => {
      switch (kind) {
        case 0: return Math.sin(TAU * ph);
        case 1: return 4 * Math.abs(ph - 0.5) - 1;
        case 2: return 2 * ph - 1 - polyBlep(ph, dt);
        case 3: return pulse(ph, dt, 0.5);
        case 4: return pulse(ph, dt, 0.25);
        default: return pulse(ph, dt, 0.125);
      }
    };
    class TriVoice {
      constructor() { this.alive = false; this.ph = [0, 0, 0]; this.a = new ADSR(); this.f = new ADSR(); this.svf = new SVF(); this.lf = 0; }
    }
    class Trio {
      constructor(sr) {
        this.sr = sr; this.p = defaults(trioSchema);
        this.voices = Array.from({ length: 8 }, () => new TriVoice());
        this.counter = 0; this.lastKey = null; this.vib = 0;
      }
      get active() { return this.voices.some((v) => v.alive); }
      setParam(id, v) { this.p[id] = v; }
      allOff() { for (const v of this.voices) v.alive = false; }
      chokeAll() { for (const v of this.voices) if (v.alive) { v.a.release(); v.f.release(); } }
      noteOn(ev) {
        const p = this.p;
        let v = null, n = 0, oldest = null;
        for (const x of this.voices) { if (x.alive) { n++; if (!oldest || x.time < oldest.time) oldest = x; } else if (!v) v = x; }
        if (!v || n >= p.poly) { if (!oldest) return; v = oldest; }
        v.alive = true; v.key = ev.key; v.time = ++this.counter; v.vel = 0.4 + 0.6 * ev.vel; v.fine = ev.fine || 0;
        const lf = Math.log2(mtof(ev.key + v.fine / 100));
        v.lf = p.glide > 0 && this.lastKey !== null ? Math.log2(mtof(this.lastKey)) : lf; v.tf = lf;
        this.lastKey = ev.key;
        v.ph = [0, 0, 0]; v.a.v = 0; v.f.v = 0; v.a.trigger(); v.f.trigger(); v.pan = panGain(ev.pan); v.n = 0;
        v.svf.reset(); v.svf.setup(this.sr, clamp(p.cutoff, 20, 0.45 * this.sr), p.res);
      }
      noteOff(key) { for (const v of this.voices) if (v.alive && v.key === key && v.a.stage !== 4) { v.a.release(); v.f.release(); } }
      process(L, R, i0, i1) {
        const p = this.p, sr = this.sr;
        const aInc = 1 / ms(p.attack, sr), dCo = Math.exp(-4.6 / ms(p.decay, sr)), rCo = Math.exp(-4.6 / ms(p.release, sr));
        const fdCo = Math.exp(-4.6 / ms(p.fdecay, sr)), frCo = Math.exp(-4.6 / ms(p.release, sr));
        const glide = p.glide > 0 ? 1 - Math.exp(-1 / ms(p.glide, sr)) : 1;
        const o = [[p.wave1, Math.pow(2, p.semi1 / 12 + p.fine1 / 1200), p.lvl1], [p.wave2, Math.pow(2, p.semi2 / 12 + p.fine2 / 1200), p.lvl2], [p.wave3, Math.pow(2, p.semi3 / 12 + p.fine3 / 1200), p.lvl3]];
        const vibInc = p.vibRate / sr, norm = 0.5, fAinc = 1 / ms(2, sr), glide16 = glide >= 1 ? 1 : 1 - Math.pow(1 - glide, 16);
        for (const v of this.voices) {
          if (!v.alive) continue;
          for (let i = i0; i < i1; i++) {
            v.n++;
            const am = v.a.next(aInc, dCo, p.sustain, rCo);
            if (v.a.stage === 0) { v.alive = false; break; }
            // filter envelope: quick attack, its own decay and sustain, released together with the amplifier
            const fe = v.f.next(fAinc, fdCo, p.fsustain, frCo);
            if ((v.n & 15) === 0) {
              v.lf += (v.tf - v.lf) * glide16;
              const fc = clamp(p.cutoff * Math.pow(2, p.fenv * fe * 5 + (v.lf - Math.log2(261.63)) * p.track), 20, 0.45 * sr);
              v.svf.setup(sr, fc, p.res);
            }
            const vibr = p.vibrato > 0 ? Math.sin(TAU * (this.vib + (i - i0) * vibInc)) * p.vibrato * 0.5 / 12 : 0;
            const base = Math.pow(2, v.lf + vibr) / sr;
            let sum = 0, o1 = 0, o2 = 0;
            for (let k = 0; k < 3; k++) {
              const [w, mul, lvl] = o[k];
              if (lvl <= 0) continue;
              const dt = base * mul;
              let ph = v.ph[k] + dt;
              if (ph >= 1) { ph -= 1; if (k === 0 && p.sync) v.ph[1] = 0; }
              v.ph[k] = ph;
              let pp = ph;
              if (k === 2 && p.fm > 0) pp = (ph + p.fm * 0.6 * o1 + 8) % 1;
              const s = wave3(w, pp, dt);
              if (k === 0) o1 = s; else if (k === 1) o2 = s;
              sum += s * lvl;
            }
            sum += p.ring * o1 * o2 * 0.8;
            v.svf.process(sum * norm);
            const f = p.ftype === 0 ? v.svf.lp : p.ftype === 1 ? v.svf.hp : v.svf.bp * (1 + p.res);
            const s = f * am * v.vel * p.gain;
            L[i] += s * v.pan[0]; R[i] += s * v.pan[1];
          }
        }
        this.vib = (this.vib + (i1 - i0) * vibInc) % 1;
      }
    }
    const trioPresets = {
      'Fat saw lead': { wave1: 2, wave2: 2, wave3: 3, semi3: -12, fine2: 10, cutoff: 2800, res: 0.3, fenv: 0.4, glide: 60 },
      'Sync lead': { wave1: 2, wave2: 2, sync: 1, semi2: 7, lvl2: 0.8, cutoff: 5000, fenv: 0.1, vibrato: 0.3 },
      'Ring bell': { wave1: 0, wave2: 0, semi2: 7, ring: 0.8, lvl1: 0.4, lvl2: 0.4, lvl3: 0, cutoff: 9000, attack: 2, decay: 900, sustain: 0.15 },
      'Warm pad': { wave1: 1, wave2: 2, wave3: 1, semi3: 12, fine2: -9, lvl1: 0.7, lvl2: 0.4, lvl3: 0.3, cutoff: 1800, attack: 600, release: 1200, fenv: 0.15 },
      'FM bass': { wave1: 0, wave2: 1, wave3: 0, semi1: -12, fm: 0.7, lvl1: 0, lvl2: 0.3, lvl3: 0.9, cutoff: 3500, decay: 250, sustain: 0.4 },
    };

    // =================================================================================================== Chip
    const chipSchema = [
      choice('wave', 'Channel', ['Pulse', 'Triangle', 'Noise (long)', 'Noise (short)'], 0, { group: 'Voice' }),
      choice('duty', 'Pulse width', ['12.5 %', '25 %', '50 %', '75 %'], 1, { group: 'Voice' }),
      def('bits', 'Amplitude bits', 1, 8, 4, { int: true, group: 'Voice' }),
      def('crush', 'Rate reduction', 0, 1, 0, { group: 'Voice' }),
      choice('arp', 'Arpeggio', ['Off', 'Major', 'Minor', 'Octave', 'Fifth', 'Diminished 7th'], 0, { group: 'Arpeggio' }),
      def('arpRate', 'Arpeggio speed', 4, 60, 24, { unit: 'Hz', group: 'Arpeggio' }),
      def('sweep', 'Pitch sweep', -24, 24, 0, { unit: 'st/s', group: 'Pitch' }),
      def('vibDepth', 'Vibrato depth', 0, 1, 0, { group: 'Pitch' }),
      def('vibRate', 'Vibrato rate', 1, 15, 6, { unit: 'Hz', group: 'Pitch' }),
      def('vibDelay', 'Vibrato delay', 0, 1000, 150, { unit: 'ms', group: 'Pitch' }),
      def('attack', 'Attack', 0, 500, 0, { unit: 'ms', group: 'Envelope' }),
      def('decay', 'Decay', 10, 3000, 600, { unit: 'ms', curve: 'log', group: 'Envelope' }),
      def('sustain', 'Sustain', 0, 1, 0.6, { group: 'Envelope' }),
      def('release', 'Release', 5, 1000, 80, { unit: 'ms', curve: 'log', group: 'Envelope' }),
      def('poly', 'Polyphony', 1, 8, 4, { int: true, group: 'Output' }),
      def('gain', 'Gain', 0, 1.5, 0.6, { group: 'Output' }),
    ];
    const ARPS = [[0], [0, 4, 7], [0, 3, 7], [0, 12], [0, 7], [0, 3, 6, 9]];
    const DUTY = [0.125, 0.25, 0.5, 0.75];
    class ChipVoice { constructor() { this.alive = false; } }
    class Chip {
      constructor(sr) {
        this.sr = sr; this.p = defaults(chipSchema);
        this.voices = Array.from({ length: 8 }, () => new ChipVoice());
        this.counter = 0;
      }
      get active() { return this.voices.some((v) => v.alive); }
      setParam(id, v) { this.p[id] = v; }
      allOff() { for (const v of this.voices) v.alive = false; }
      chokeAll() { for (const v of this.voices) if (v.alive) v.gate = false; }
      noteOn(ev) {
        const p = this.p;
        let v = null, n = 0, oldest = null;
        for (const x of this.voices) { if (x.alive) { n++; if (!oldest || x.time < oldest.time) oldest = x; } else if (!v) v = x; }
        if (!v || n >= p.poly) { if (!oldest) return; v = oldest; }
        Object.assign(v, { alive: true, gate: true, key: ev.key, fine: ev.fine || 0, time: ++this.counter, age: 0, ph: 0, env: 0, stage: 0, lfsr: 0x7fff, nclk: 0, nval: 1, hold: 0, hv: 0, vel: 0.5 + 0.5 * ev.vel, pan: panGain(ev.pan), semis: 0 });
      }
      noteOff(key) { for (const v of this.voices) if (v.alive && v.key === key && v.gate) v.gate = false; }
      process(L, R, i0, i1) {
        const p = this.p, sr = this.sr;
        const arp = ARPS[p.arp], arpStep = sr / p.arpRate, duty = DUTY[p.duty];
        const levels = Math.pow(2, p.bits) - 1, hold = p.crush > 0 ? Math.max(1, Math.round(1 + p.crush * (sr / 4000 - 1))) : 1;
        const atk = p.attack > 0 ? 1 / ms(p.attack, sr) : 1, dec = Math.exp(-4.6 / ms(p.decay, sr)), rel = Math.exp(-4.6 / ms(p.release, sr));
        for (const v of this.voices) {
          if (!v.alive) continue;
          for (let i = i0; i < i1; i++) {
            v.age++;
            // envelope: attack, decay to sustain, release (volume moves in 16 steps like an old sound chip)
            if (v.gate) { if (v.stage === 0) { v.env += atk; if (v.env >= 1) { v.env = 1; v.stage = 1; } } else v.env = p.sustain + (v.env - p.sustain) * dec; }
            else { v.env *= rel; if (v.env < 0.002) { v.alive = false; break; } }
            const semi = (arp.length > 1 ? arp[Math.floor(v.age / arpStep) % arp.length] : 0) + p.sweep * (v.age / sr)
              + (p.vibDepth > 0 && v.age > p.vibDelay * 0.001 * sr ? Math.sin(TAU * p.vibRate * (v.age / sr)) * p.vibDepth * 0.5 : 0);
            const f0 = mtof(v.key + semi + v.fine / 100);
            let s;
            if (p.wave === 0) { v.ph = (v.ph + f0 / sr) % 1; s = v.ph < duty ? 1 : -1; }
            else if (p.wave === 1) { v.ph = (v.ph + f0 / sr) % 1; s = Math.round((4 * Math.abs(v.ph - 0.5) - 1) * 15) / 15; }   // 32-step triangle
            else {
              v.nclk += Math.min(f0 * 4, sr) / sr;
              while (v.nclk >= 1) {
                v.nclk -= 1;
                const tap = p.wave === 3 ? 6 : 1, b = (v.lfsr & 1) ^ ((v.lfsr >> tap) & 1);
                v.lfsr = (v.lfsr >> 1) | (b << (p.wave === 3 ? 6 : 14));
                if (p.wave === 3) v.lfsr &= 0x7f;
                v.nval = v.lfsr & 1 ? 1 : -1;
              }
              s = v.nval;
            }
            if (hold > 1) { if (v.hold-- <= 0) { v.hold = hold - 1; v.hv = s; } s = v.hv; }
            const e = Math.round(v.env * 15) / 15;
            let out = s * e * v.vel;
            out = Math.round(out * levels * 0.5) / (levels * 0.5);       // amplitude resolution
            out *= p.gain * 0.5;
            L[i] += out * v.pan[0]; R[i] += out * v.pan[1];
          }
        }
      }
    }
    const chipPresets = {
      'Pulse lead': { wave: 0, duty: 1, bits: 4, vibDepth: 0.35, decay: 1500, sustain: 0.7 },
      'Arp chord': { wave: 0, duty: 2, arp: 1, arpRate: 20, decay: 2000, sustain: 0.8 },
      'Triangle bass': { wave: 1, bits: 4, decay: 800, sustain: 0.8, release: 40 },
      'Hi-hat': { wave: 3, decay: 60, sustain: 0, release: 20, bits: 3 },
      'Snare noise': { wave: 2, decay: 160, sustain: 0, release: 30, sweep: -12 },
      'Laser': { wave: 0, duty: 2, sweep: -18, decay: 300, sustain: 0, bits: 5 },
    };

    // =================================================================================================== Additive
    const MAXP = 64;
    const SHAPES = ['Saw', 'Square', 'Triangle', 'Organ', 'Bell', 'Hollow', 'Strings'];
    const shapeAmp = (kind, n) => {
      switch (kind) {
        case 0: return 1 / n;
        case 1: return n % 2 ? 1 / n : 0;
        case 2: return n % 2 ? (((n - 1) / 2) % 2 ? -1 : 1) / (n * n) * 8 / 1 : 0;
        case 3: return [1, 0.8, 0.9, 0.5, 0.35, 0.3, 0.12, 0.2, 0.08][n - 1] || 0;
        case 4: return n < 12 ? Math.exp(-0.28 * n) * (n % 3 === 0 ? 0.6 : 1) * 1.6 : 0;
        case 5: return n % 2 ? 1 / Math.sqrt(n) : 0.04 / n;
        default: return Math.exp(-Math.pow((n - 6) / 6, 2)) * 0.9 + 0.5 / n;
      }
    };
    const addSchema = [
      def('partials', 'Partials', 1, MAXP, 32, { int: true, group: 'Spectrum' }),
      choice('shapeA', 'Spectrum A', SHAPES, 0, { group: 'Spectrum' }),
      choice('shapeB', 'Spectrum B', SHAPES, 1, { group: 'Spectrum' }),
      def('morph', 'Morph A → B', 0, 1, 0, { group: 'Spectrum' }),
      def('slope', 'Tilt', -2, 3, 0, { group: 'Shaping' }),
      def('odd', 'Odd partials', 0, 1, 1, { group: 'Shaping' }),
      def('even', 'Even partials', 0, 1, 1, { group: 'Shaping' }),
      def('fmFreq', 'Formant centre', 1, 40, 8, { unit: 'harmonic', group: 'Formant' }),
      def('fmWidth', 'Formant width', 0.5, 20, 4, { unit: 'harmonics', group: 'Formant' }),
      def('fmGain', 'Formant gain', 0, 24, 0, { unit: 'dB', group: 'Formant' }),
      def('stretch', 'Inharmonicity', 0, 0.05, 0, { step: 0.0005, group: 'Character' }),
      def('spread', 'Partial detune', 0, 30, 0, { unit: 'cents', group: 'Character' }),
      def('hfDecay', 'High partials fade', 0, 1, 0.25, { group: 'Character' }),
      def('width', 'Stereo width', 0, 1, 0.5, { group: 'Character' }),
      def('tone', 'Tone', 200, 20000, 14000, { unit: 'Hz', curve: 'log', group: 'Output' }),
      def('attack', 'Attack', 1, 5000, 8, { unit: 'ms', curve: 'log', group: 'Envelope' }),
      def('decay', 'Decay', 5, 5000, 600, { unit: 'ms', curve: 'log', group: 'Envelope' }),
      def('sustain', 'Sustain', 0, 1, 0.8, { group: 'Envelope' }),
      def('release', 'Release', 5, 8000, 300, { unit: 'ms', curve: 'log', group: 'Envelope' }),
      def('poly', 'Polyphony', 1, 8, 6, { int: true, group: 'Output' }),
      def('gain', 'Gain', 0, 1.5, 0.7, { group: 'Output' }),
    ];
    class AddVoice {
      constructor() { this.alive = false; this.c = new Float64Array(MAXP); this.s = new Float64Array(MAXP); this.cr = new Float64Array(MAXP); this.sr_ = new Float64Array(MAXP); this.amp = new Float64Array(MAXP); this.a = new ADSR(); this.lp = [0, 0]; }
    }
    class Additive {
      constructor(sr) {
        this.sr = sr; this.p = defaults(addSchema);
        this.voices = Array.from({ length: 8 }, () => new AddVoice());
        this.counter = 0; this.noise = new Noise(4242); this.st = new Float64Array(MAXP);
      }
      get active() { return this.voices.some((v) => v.alive); }
      setParam(id, v) { this.p[id] = v; }
      allOff() { for (const v of this.voices) v.alive = false; }
      chokeAll() { for (const v of this.voices) if (v.alive) v.a.release(); }
      noteOn(ev) {
        const p = this.p, sr = this.sr;
        let v = null, n = 0, oldest = null;
        for (const x of this.voices) { if (x.alive) { n++; if (!oldest || x.time < oldest.time) oldest = x; } else if (!v) v = x; }
        if (!v || n >= p.poly) { if (!oldest) return; v = oldest; }
        v.alive = true; v.key = ev.key; v.time = ++this.counter; v.age = 0; v.vel = 0.35 + 0.65 * ev.vel; v.pan = panGain(ev.pan);
        const f0 = mtof(ev.key + (ev.fine || 0) / 100);
        v.np = 0;
        for (let n2 = 1; n2 <= MAXP; n2++) {
          const f = f0 * n2 * Math.sqrt(1 + p.stretch * n2 * n2) * Math.pow(2, (this.noise.next() * p.spread) / 1200);
          if (n2 > p.partials || f > sr * 0.45) { v.cr[n2 - 1] = 1; v.sr_[n2 - 1] = 0; v.amp[n2 - 1] = 0; continue; }
          const w = (TAU * f) / sr;
          v.cr[n2 - 1] = Math.cos(w); v.sr_[n2 - 1] = Math.sin(w);
          v.c[n2 - 1] = Math.cos(n2 * 0.37); v.s[n2 - 1] = Math.sin(n2 * 0.37);        // fixed start phases: repeatable attack
          v.np = n2;
        }
        v.a.v = 0; v.a.trigger(); v.lp[0] = v.lp[1] = 0;
      }
      noteOff(key) { for (const v of this.voices) if (v.alive && v.key === key && v.a.stage !== 4) v.a.release(); }
      // spectrum of one voice for the next slice: shape (morph, tilt, odd/even, formant), normalised to a constant loudness
      // so extreme settings cannot explode, then the high partials fade with the age of the note
      _amps(v) {
        const p = this.p, t = v.age / this.sr, st = this.st;
        let e2 = 0;
        for (let n = 1; n <= v.np; n++) {
          let a = (1 - p.morph) * shapeAmp(p.shapeA, n) + p.morph * shapeAmp(p.shapeB, n);
          a *= Math.pow(n, -p.slope) * (n % 2 ? p.odd : p.even);
          if (p.fmGain > 0) a *= 1 + (Math.pow(10, p.fmGain / 20) - 1) * Math.exp(-0.5 * Math.pow((n - p.fmFreq) / p.fmWidth, 2));
          st[n - 1] = a; e2 += a * a;
        }
        const scale = 1.28 / Math.max(Math.sqrt(e2), 0.3);
        for (let n = 1; n <= v.np; n++) v.amp[n - 1] = st[n - 1] * scale * (p.hfDecay > 0 ? Math.exp(-t * p.hfDecay * 1.8 * (n - 1) / 8) : 1);
      }
      process(L, R, i0, i1) {
        const p = this.p, sr = this.sr;
        const aInc = 1 / ms(p.attack, sr), dCo = Math.exp(-4.6 / ms(p.decay, sr)), rCo = Math.exp(-4.6 / ms(p.release, sr));
        const lpA = 1 - Math.exp((-TAU * p.tone) / sr), w = p.width;
        for (const v of this.voices) {
          if (!v.alive) continue;
          this._amps(v);
          const np = v.np, c = v.c, s = v.s, cr = v.cr, sn = v.sr_, amp = v.amp;
          for (let i = i0; i < i1; i++) {
            let l = 0, r = 0;
            for (let n = 0; n < np; n++) {
              const cn = c[n] * cr[n] - s[n] * sn[n], sv = s[n] * cr[n] + c[n] * sn[n];
              c[n] = cn; s[n] = sv;
              const x = sv * amp[n];
              if (n & 1) { l += x * (1 - w * 0.5); r += x * (1 + w * 0.5); } else { l += x * (1 + w * 0.5); r += x * (1 - w * 0.5); }
            }
            const am = v.a.next(aInc, dCo, p.sustain, rCo);
            if (v.a.stage === 0) { v.alive = false; break; }
            v.lp[0] += lpA * (l - v.lp[0]); v.lp[1] += lpA * (r - v.lp[1]);
            const g = am * v.vel * p.gain * 0.5;
            L[i] += v.lp[0] * g * v.pan[0]; R[i] += v.lp[1] * g * v.pan[1];
          }
          v.age += i1 - i0;
          for (let n = 0; n < np; n++) { const m = Math.hypot(c[n], s[n]) || 1; c[n] /= m; s[n] /= m; }     // keep the rotators on the unit circle
        }
      }
    }
    const addPresets = {
      'Glass bell': { shapeA: 4, shapeB: 4, partials: 24, stretch: 0.012, hfDecay: 0.7, attack: 2, decay: 1800, sustain: 0.05, release: 900 },
      'Morphing pad': { shapeA: 6, shapeB: 5, morph: 0.5, partials: 40, spread: 6, hfDecay: 0.1, attack: 700, release: 1500, width: 0.9 },
      'Vocal formant': { shapeA: 0, shapeB: 0, partials: 48, fmFreq: 5, fmWidth: 2.2, fmGain: 18, slope: 0.3, attack: 40 },
      'Hollow reed': { shapeA: 5, shapeB: 1, morph: 0.3, partials: 32, hfDecay: 0.15, even: 0.1 },
      'Drawbar-ish': { shapeA: 3, shapeB: 3, partials: 9, hfDecay: 0, attack: 4, release: 60 },
    };

    return {
      instruments: {
        acid: { schema: acidSchema, meta: { name: 'Acid Bass', kind: 'bass', rootDefault: 36, description: 'Monophonic bass with a resonant ladder filter, accent (velocity above 80%) and slide (overlap two notes)' }, create: (sr) => new Acid(sr), presets: acidPresets },
        trio: { schema: trioSchema, meta: { name: 'Tri-Osc', kind: 'synth', rootDefault: 60, description: 'Three oscillators with sync, ring modulation and FM, a multimode filter and two envelopes' }, create: (sr) => new Trio(sr), presets: trioPresets },
        chip: { schema: chipSchema, meta: { name: 'Chip', kind: 'chip', rootDefault: 60, description: 'Console-style pulse, triangle and noise voices with arpeggio, sweep, vibrato and bit reduction' }, create: (sr) => new Chip(sr), presets: chipPresets },
        additive: { schema: addSchema, meta: { name: 'Additive', kind: 'additive', rootDefault: 60, description: 'Up to 64 partials with tilt, odd/even balance, a formant, inharmonicity and a morph between two spectra' }, create: (sr) => new Additive(sr), presets: addPresets },
      },
    };
  },
});
