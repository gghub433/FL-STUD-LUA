// FL LUA Sounds: a sample library made entirely by code (nothing recorded, nothing copied). The samples are rendered
// the first time a project or the Browser needs them, at the engine's sample rate, and kept like any other sample.
//   Kicks, Snares, Claps, Hats & cymbals, Percussion   drum machine style one-shots (909 / 808 / 707 flavours)
//   Bass (C2), Synth (C4)                             tonal one-shots: load into a Sampler and play them from the keyboard
//   Vocal (C4)                                        formant-synthesised vowels and a choir
//   FX                                                risers, downlifters, impacts, sweeps, vinyl
//   Loops (120 BPM)                                   two-bar drum and percussion loops for the Playlist
globalThis.__flluaRegisterPack({
  id: 'fllua-sounds',
  name: 'FL LUA Sounds',
  version: '1.0.0',
  author: 'FL LUA',
  license: 'MIT',
  description: 'Fifty samples made by code: drum-machine kicks, snares, claps, hats, percussion, basses, synth stabs and pads, vocal vowels, FX and 120 BPM loops.',
  api: 1,
  sounds(api) {
    const { TAU, Biquad, Noise, fastTanh } = api.dsp;
    const mtof = (k) => 440 * Math.pow(2, (k - 69) / 12);

    // ---- helpers -------------------------------------------------------------------------------------------
    const buf = (sr, sec) => new Float32Array(Math.max(1, Math.floor(sr * sec)));
    function finish(x, peak = 0.89) {
      const chs = Array.isArray(x) ? x : [x];
      let m = 0;
      for (const c of chs) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > m) m = a; }
      const g = m > 0 ? peak / m : 1;
      for (const c of chs) {
        const fade = Math.min(c.length, 256);
        for (let i = 0; i < c.length; i++) { c[i] *= g; const left = c.length - 1 - i; if (left < fade) c[i] *= left / fade; }
      }
      return x;
    }
    const env = (t, a, d) => (t < a ? t / a : Math.exp(-(t - a) / d));
    // sine with an exponential pitch drop (kicks, toms, congas)
    function drop(sr, sec, f0, f1, fall, decay, { click = 0, drive = 1, seed = 1 } = {}) {
      const out = buf(sr, sec), nz = new Noise(seed);
      let ph = 0;
      for (let i = 0; i < out.length; i++) {
        const t = i / sr, f = f1 + (f0 - f1) * Math.exp(-t / fall);
        ph += f / sr;
        let s = Math.sin(TAU * ph) * Math.exp(-t / decay) * Math.min(1, t * 2000);
        s += nz.next() * click * Math.exp(-t * 400);
        out[i] = drive > 1 ? fastTanh(s * drive) : s;
      }
      return out;
    }
    // band of filtered noise with an envelope
    function noiseHit(sr, sec, type, f, q, a, d, seed = 3) {
      const out = buf(sr, sec), nz = new Noise(seed), bq = new Biquad().set(type, sr, f, q);
      for (let i = 0; i < out.length; i++) { const t = i / sr; out[i] = bq.process(nz.next()) * env(t, a, d); }
      return out;
    }
    // six detuned square waves: the classic analog-drum-machine metal
    function metal(sr, sec, base, decay, { hp = 7000, open = false, seed = 5 } = {}) {
      const out = buf(sr, sec), ratios = [2, 3, 4.16, 5.43, 6.79, 8.21], ph = new Float64Array(6), nz = new Noise(seed);
      const h1 = new Biquad().set('hp', sr, hp, 0.7), h2 = new Biquad().set('hp', sr, hp, 0.7), bp = new Biquad().set('bp', sr, hp * 1.4, 0.8);
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        let m = 0;
        for (let k = 0; k < 6; k++) { ph[k] += (base * ratios[k]) / sr; m += ph[k] % 1 < 0.5 ? 1 : -1; }
        const e = open ? Math.exp(-t / decay) * (0.6 + 0.4 * Math.exp(-t * 30)) : Math.exp(-t / decay);
        out[i] = h2.process(h1.process(bp.process(m / 6 * 0.8 + nz.next() * 0.35))) * e * Math.min(1, t * 4000);
      }
      return out;
    }
    const mix = (...parts) => { const n = Math.max(...parts.map(([x]) => x.length)), out = new Float32Array(n); for (const [x, g] of parts) for (let i = 0; i < x.length; i++) out[i] += x[i] * g; return out; };
    function saws(sr, sec, keys, { detune = 12, voices = 3, cutoff = 2400, cutEnv = 0, cutDecay = 0.3, res = 0.7, a = 0.005, d = 0.6, sustain = 0, rel = 0.3, len = sec, stereo = false, seed = 9 } = {}) {
      const chs = stereo ? [buf(sr, sec), buf(sr, sec)] : [buf(sr, sec)];
      chs.forEach((out, c) => {
        const osc = [];
        let s0 = seed + c * 7;
        for (const k of keys) for (let v = 0; v < voices; v++) { s0 = (s0 * 16807) % 2147483647; osc.push({ f: mtof(k) * Math.pow(2, ((v - (voices - 1) / 2) * detune / Math.max(1, voices - 1)) / 1200), ph: (s0 % 1000) / 1000 }); }
        const f1 = new Biquad(), f2 = new Biquad();
        for (let i = 0; i < out.length; i++) {
          const t = i / sr;
          if ((i & 31) === 0) { const fc = cutoff + cutEnv * Math.exp(-t / cutDecay); f1.set('lp', sr, fc, res); f2.set('lp', sr, fc, 0.6); }
          let s = 0;
          for (const o of osc) { o.ph += o.f / sr; if (o.ph >= 1) o.ph -= 1; s += 2 * o.ph - 1; }
          s /= Math.sqrt(osc.length);
          const amp = t < a ? t / a : t < len ? sustain + (1 - sustain) * Math.exp(-(t - a) / d) : (sustain + (1 - sustain) * Math.exp(-(len - a) / d)) * Math.exp(-(t - len) / rel);
          out[i] = f2.process(f1.process(s)) * amp;
        }
      });
      return stereo ? chs : chs[0];
    }
    function fm(sr, sec, key, { ratio = 3.5, index = 3, idxDecay = 0.4, decay = 1.2, a = 0.002 } = {}) {
      const out = buf(sr, sec), f = mtof(key);
      let pc = 0, pm = 0;
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        pm += (f * ratio) / sr; pc += f / sr;
        const I = index * Math.exp(-t / idxDecay);
        out[i] = Math.sin(TAU * pc + I * Math.sin(TAU * pm)) * env(t, a, decay);
      }
      return out;
    }
    // vowel: a band-limited glottal pulse train with vibrato through three formant resonators
    const VOWELS = { a: [[800, 1], [1150, 0.5], [2900, 0.25]], o: [[450, 1], [800, 0.4], [2830, 0.1]], e: [[400, 1], [1600, 0.45], [2700, 0.3]], i: [[300, 1], [2300, 0.35], [3000, 0.25]], u: [[325, 1], [700, 0.25], [2530, 0.06]] };
    function vowel(sr, sec, key, v, { voices = 1, spread = 9, seed = 21, a = 0.08, rel = 0.25 } = {}) {
      const out = buf(sr, sec), forms = VOWELS[v].map(([f, g]) => ({ bq: new Biquad().set('bp', sr, f, f / 90), g }));
      const nz = new Noise(seed);
      const vs = Array.from({ length: voices }, (_, k) => ({ ph: k / voices, det: voices > 1 ? ((k / (voices - 1)) - 0.5) * spread : 0, vib: 4.6 + k * 0.37 }));
      const f0 = mtof(key), hmax = Math.max(1, Math.floor(sr * 0.45 / f0));
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        let src = 0;
        for (const o of vs) {
          o.ph += f0 * Math.pow(2, (o.det + 18 * Math.sin(TAU * o.vib * t) * Math.min(1, t * 2)) / 1200) / sr;
          if (o.ph >= 1) o.ph -= 1;
          // band-limited impulse train (Dirichlet kernel), tilted like a glottal source
          const x = TAU * o.ph, den = Math.sin(x / 2);
          src += (Math.abs(den) < 1e-6 ? hmax : Math.sin((hmax + 0.5) * x) / (2 * den) - 0.5) / hmax;
        }
        src = src / voices + nz.next() * 0.02;
        let y = 0;
        for (const fm_ of forms) y += fm_.bq.process(src) * fm_.g;
        out[i] = y * Math.min(1, t / a) * (t > sec - rel ? Math.max(0, (sec - t) / rel) : 1);
      }
      return out;
    }
    // places one-shots on a grid: hits = [[sample, step, gain]], 16 steps per bar at `bpm`
    function loop(sr, bpm, bars, hits) {
      const step = 60 / bpm / 4, out = buf(sr, bars * 16 * step);
      for (const [x, s, g] of hits) { const o = Math.round(s * step * sr); for (let i = 0; i < x.length && o + i < out.length; i++) out[o + i] += x[i] * g; }
      return finish(out);
    }

    // ---- drums -----------------------------------------------------------------------------------------------
    const kick909 = (sr) => finish(drop(sr, 0.6, 280, 52, 0.035, 0.22, { click: 0.6, drive: 1.6 }));
    const snare909 = (sr) => finish(mix([drop(sr, 0.35, 330, 185, 0.03, 0.09), 0.8], [noiseHit(sr, 0.35, 'hp', 1800, 0.6, 0.001, 0.12, 11), 0.9], [noiseHit(sr, 0.35, 'bp', 5200, 0.9, 0.001, 0.06, 12), 0.4]));
    const clap = (sr, big) => {
      const out = buf(sr, big ? 1.1 : 0.5), nz = new Noise(31), bp = new Biquad().set('bp', sr, 1150, 1.3), lp = new Biquad().set('lp', sr, 6000, 0.7);
      for (let i = 0; i < out.length; i++) {
        const t = i / sr;
        let e = 0;
        for (let k = 0; k < 4; k++) { const tk = k * 0.0095; if (t >= tk) e = Math.max(e, Math.exp(-(t - tk) * 210)); }
        if (t >= 0.03) e = Math.max(e, 0.7 * Math.exp(-(t - 0.03) * (big ? 4.5 : 15)));
        out[i] = lp.process(bp.process(nz.next())) * e * 3;
      }
      return finish(out);
    };
    const hatC = (sr) => finish(metal(sr, 0.25, 41, 0.035));
    const hatO = (sr) => finish(metal(sr, 0.9, 41, 0.28, { open: true }));

    return {
      Kicks: {
        'kick-909': { name: 'Kick 909', gen: kick909 },
        'kick-808': { name: 'Kick 808 Boom', gen: (sr) => finish(drop(sr, 2, 150, 46, 0.05, 0.75, { drive: 1.3 })) },
        'kick-tech': { name: 'Kick Techno', gen: (sr) => finish(drop(sr, 0.5, 360, 48, 0.025, 0.16, { click: 0.9, drive: 3 })) },
        'kick-lofi': { name: 'Kick Lo-fi', gen: (sr) => { const x = drop(sr, 0.5, 200, 55, 0.04, 0.15, { click: 0.3 }); const lp = new Biquad().set('lp', sr, 900, 0.9); for (let i = 0; i < x.length; i++) x[i] = Math.round(lp.process(x[i]) * 24) / 24; return finish(x); } },
        'kick-soft': { name: 'Kick Soft', gen: (sr) => finish(drop(sr, 0.7, 110, 50, 0.06, 0.25)) },
      },
      Snares: {
        'snare-909': { name: 'Snare 909', gen: snare909 },
        'snare-trap': { name: 'Snare Trap', gen: (sr) => finish(mix([drop(sr, 0.6, 260, 200, 0.02, 0.07), 0.5], [noiseHit(sr, 0.6, 'hp', 2500, 0.7, 0.001, 0.2, 13), 1])) },
        'snare-brush': { name: 'Snare Brush', gen: (sr) => finish(noiseHit(sr, 0.5, 'bp', 3200, 0.5, 0.03, 0.12, 14)) },
        'snare-rim': { name: 'Rim Click', gen: (sr) => finish(mix([drop(sr, 0.08, 1800, 1700, 1, 0.015), 1], [noiseHit(sr, 0.08, 'hp', 3000, 0.7, 0.0005, 0.006, 15), 0.6])) },
      },
      Claps: {
        'clap-707': { name: 'Clap 707', gen: (sr) => clap(sr, false) },
        'clap-big': { name: 'Clap Big Room', gen: (sr) => clap(sr, true) },
        'snap': { name: 'Finger Snap', gen: (sr) => finish(mix([noiseHit(sr, 0.15, 'bp', 2400, 2, 0.0005, 0.02, 16), 1], [drop(sr, 0.15, 1400, 1300, 1, 0.01), 0.3])) },
      },
      'Hats & cymbals': {
        'hat-909-closed': { name: 'Hat 909 Closed', gen: hatC },
        'hat-909-open': { name: 'Hat 909 Open', gen: hatO },
        'hat-trap': { name: 'Hat Trap Tick', gen: (sr) => finish(metal(sr, 0.12, 48, 0.018, { hp: 9000 })) },
        'ride': { name: 'Ride', gen: (sr) => finish(mix([metal(sr, 2.5, 63, 0.9, { hp: 5000, seed: 6 }), 1], [drop(sr, 2.5, 3400, 3400, 1, 0.6), 0.08])) },
        'crash': { name: 'Crash 909', gen: (sr) => finish(mix([metal(sr, 2.5, 37, 0.8, { hp: 4500, seed: 7 }), 0.7], [noiseHit(sr, 2.5, 'hp', 5000, 0.5, 0.001, 0.7, 17), 0.8])) },
        'splash': { name: 'Splash', gen: (sr) => finish(mix([metal(sr, 1.2, 52, 0.3, { hp: 6500, seed: 8 }), 0.7], [noiseHit(sr, 1.2, 'hp', 6500, 0.5, 0.001, 0.3, 18), 0.8])) },
      },
      Percussion: {
        'conga-high': { name: 'Conga High', gen: (sr) => finish(mix([drop(sr, 0.5, 480, 330, 0.02, 0.12), 1], [noiseHit(sr, 0.5, 'bp', 2500, 1, 0.0005, 0.008, 19), 0.3])) },
        'conga-low': { name: 'Conga Low', gen: (sr) => finish(mix([drop(sr, 0.6, 320, 210, 0.025, 0.16), 1], [noiseHit(sr, 0.6, 'bp', 1800, 1, 0.0005, 0.008, 20), 0.3])) },
        'bongo': { name: 'Bongo', gen: (sr) => finish(drop(sr, 0.3, 700, 520, 0.01, 0.06)) },
        'clave': { name: 'Clave', gen: (sr) => finish(drop(sr, 0.15, 2500, 2500, 1, 0.025)) },
        'woodblock': { name: 'Woodblock', gen: (sr) => finish(mix([drop(sr, 0.2, 1100, 1000, 0.01, 0.03), 1], [drop(sr, 0.2, 2700, 2600, 0.01, 0.015), 0.4])) },
        'tambourine': { name: 'Tambourine', gen: (sr) => finish(mix([metal(sr, 0.4, 290, 0.09, { hp: 6000, seed: 9 }), 1], [noiseHit(sr, 0.4, 'hp', 8000, 0.6, 0.002, 0.08, 22), 0.6])) },
        'triangle': { name: 'Triangle', gen: (sr) => { const x = buf(sr, 2.5); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = (Math.sin(TAU * 1580 * t) + 0.5 * Math.sin(TAU * 4290 * t) + 0.3 * Math.sin(TAU * 7010 * t)) * Math.exp(-t * 1.6); } return finish(x); } },
        'cowbell-808': { name: 'Cowbell 808', gen: (sr) => { const x = buf(sr, 0.6), bp = new Biquad().set('bp', sr, 2600, 1.2); let a = 0, b = 0; for (let i = 0; i < x.length; i++) { const t = i / sr; a += 540 / sr; b += 800 / sr; x[i] = bp.process((a % 1 < 0.5 ? 1 : -1) + (b % 1 < 0.5 ? 1 : -1)) * (0.7 * Math.exp(-t * 7) + 0.3 * Math.exp(-t * 60)); } return finish(x); } },
      },
      'Bass (C2)': {
        'bass-reese': { name: 'Reese Bass', gen: (sr) => finish(saws(sr, 2.2, [36], { voices: 2, detune: 28, cutoff: 900, res: 0.9, a: 0.005, d: 9, sustain: 1, len: 1.8, rel: 0.3 })) },
        'bass-acid': { name: 'Acid Stab', gen: (sr) => finish(saws(sr, 0.6, [36], { voices: 1, cutoff: 300, cutEnv: 3200, cutDecay: 0.12, res: 6, d: 0.25, sustain: 0.4, len: 0.35, rel: 0.08 })) },
        'bass-sub': { name: 'Sub Sine', gen: (sr) => { const x = buf(sr, 1.6); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = Math.sin(TAU * mtof(36) * t) * Math.min(1, t * 300) * (t < 1.3 ? 1 : Math.max(0, (1.6 - t) / 0.3)); } return finish(x); } },
        'bass-fm': { name: 'FM Bass', gen: (sr) => finish(fm(sr, 1, 36, { ratio: 1, index: 4, idxDecay: 0.15, decay: 0.5 })) },
      },
      'Synth (C4)': {
        'stab-minor': { name: 'Chord Stab Minor', gen: (sr) => finish(saws(sr, 0.9, [60, 63, 67, 70], { voices: 2, detune: 14, cutoff: 800, cutEnv: 5000, cutDecay: 0.15, d: 0.2, sustain: 0.25, len: 0.4, rel: 0.25, stereo: true })) },
        'stab-major': { name: 'Chord Stab Major', gen: (sr) => finish(saws(sr, 0.9, [60, 64, 67, 71], { voices: 2, detune: 14, cutoff: 900, cutEnv: 5000, cutDecay: 0.15, d: 0.2, sustain: 0.25, len: 0.4, rel: 0.25, stereo: true })) },
        'pluck': { name: 'Pluck', gen: (sr) => finish(saws(sr, 0.8, [60], { voices: 3, detune: 10, cutoff: 400, cutEnv: 6000, cutDecay: 0.06, d: 0.18, stereo: true })) },
        'bell': { name: 'FM Bell', gen: (sr) => finish(fm(sr, 3, 60, { ratio: 3.5, index: 4, idxDecay: 0.6, decay: 1.4 })) },
        'pad': { name: 'Warm Pad', gen: (sr) => finish(saws(sr, 4.5, [60, 64, 67], { voices: 4, detune: 22, cutoff: 1500, a: 0.9, d: 9, sustain: 1, len: 3.6, rel: 0.8, stereo: true })) },
        'brass': { name: 'Brass Stab', gen: (sr) => finish(saws(sr, 0.9, [60, 67], { voices: 3, detune: 12, cutoff: 700, cutEnv: 2500, cutDecay: 0.2, a: 0.03, d: 0.3, sustain: 0.6, len: 0.5, rel: 0.2, stereo: true })) },
        'lead': { name: 'Saw Lead', gen: (sr) => finish(saws(sr, 1.2, [60], { voices: 5, detune: 25, cutoff: 3500, res: 1, a: 0.005, d: 9, sustain: 1, len: 1, rel: 0.15, stereo: true })) },
      },
      'Vocal (C4)': {
        'vox-ah': { name: 'Vox Ah', gen: (sr) => finish(vowel(sr, 2, 60, 'a')) },
        'vox-oh': { name: 'Vox Oh', gen: (sr) => finish(vowel(sr, 2, 60, 'o')) },
        'vox-ee': { name: 'Vox Ee', gen: (sr) => finish(vowel(sr, 2, 60, 'i')) },
        'vox-ooh': { name: 'Vox Ooh', gen: (sr) => finish(vowel(sr, 2, 60, 'u')) },
        'choir': { name: 'Choir Aah', gen: (sr) => finish([vowel(sr, 3.5, 60, 'a', { voices: 6, spread: 16, seed: 41, a: 0.4, rel: 0.6 }), vowel(sr, 3.5, 60, 'a', { voices: 6, spread: 18, seed: 43, a: 0.45, rel: 0.6 })]) },
      },
      FX: {
        'riser': { name: 'Riser 4 s', gen: (sr) => { const x = buf(sr, 4), nz = new Noise(51), bq = new Biquad(); let ph = 0; for (let i = 0; i < x.length; i++) { const t = i / sr, u = t / 4; if ((i & 63) === 0) bq.set('bp', sr, 300 * Math.pow(30, u), 2); ph += (110 * Math.pow(8, u)) / sr; x[i] = (bq.process(nz.next()) * 1.6 + (2 * (ph % 1) - 1) * 0.25) * u * u; } return finish(x); } },
        'downlifter': { name: 'Downlifter', gen: (sr) => { const x = buf(sr, 2.5), nz = new Noise(52), bq = new Biquad(); for (let i = 0; i < x.length; i++) { const t = i / sr, u = t / 2.5; if ((i & 63) === 0) bq.set('bp', sr, 8000 * Math.pow(0.02, u), 1.5); x[i] = bq.process(nz.next()) * (1 - u) * Math.min(1, t * 50); } return finish(x); } },
        'impact': { name: 'Impact', gen: (sr) => finish(mix([drop(sr, 3, 90, 32, 0.3, 0.9, { drive: 1.5 }), 1], [noiseHit(sr, 3, 'lp', 1200, 0.7, 0.001, 0.5, 53), 0.7])) },
        'sweep': { name: 'White Noise Sweep', gen: (sr) => { const x = buf(sr, 2), nz = new Noise(54), bq = new Biquad(); for (let i = 0; i < x.length; i++) { const t = i / sr, u = t / 2; if ((i & 63) === 0) bq.set('lp', sr, 200 + 12000 * Math.sin(Math.PI * u), 4); x[i] = bq.process(nz.next()) * Math.sin(Math.PI * u); } return finish(x); } },
        'laser': { name: 'Laser Zap', gen: (sr) => finish(drop(sr, 0.35, 4000, 200, 0.05, 0.12)) },
        'vinyl': { name: 'Vinyl Crackle (loop)', gen: (sr) => { const x = buf(sr, 4), nz = new Noise(55), lp = new Biquad().set('lp', sr, 4000, 0.7); for (let i = 0; i < x.length; i++) { const r = nz.next(); x[i] = lp.process(r * 0.03 + (Math.abs(r) > 0.9993 ? Math.sign(r) * 0.9 : 0)); } return finish(x, 0.5); } },
      },
      'Loops (120 BPM)': {
        'loop-house': { name: 'House Beat 120', gen: (sr) => { const k = kick909(sr), h = hatC(sr), o = hatO(sr), c = clap(sr, false); const hits = []; for (let b = 0; b < 2; b++) { for (let s = 0; s < 16; s += 4) hits.push([k, b * 16 + s, 1]); for (const s of [4, 12]) hits.push([c, b * 16 + s, 0.7]); for (const s of [2, 6, 10, 14]) hits.push([o, b * 16 + s, 0.35]); for (let s = 0; s < 16; s++) hits.push([h, b * 16 + s, s % 2 ? 0.18 : 0.28]); } return loop(sr, 120, 2, hits); } },
        'loop-break': { name: 'Breakbeat 120', gen: (sr) => { const k = kick909(sr), s_ = snare909(sr), h = hatC(sr); const hits = []; for (let b = 0; b < 2; b++) { for (const s of [0, 10]) hits.push([k, b * 16 + s, 1]); if (b) hits.push([k, 16 + 7, 0.8]); for (const s of [4, 12]) hits.push([s_, b * 16 + s, 0.8]); hits.push([s_, b * 16 + 15, 0.35]); for (let s = 0; s < 16; s += 2) hits.push([h, b * 16 + s, 0.3]); } return loop(sr, 120, 2, hits); } },
        'loop-hats': { name: 'Hat Groove 120', gen: (sr) => { const h = hatC(sr), o = hatO(sr); const hits = []; for (let s = 0; s < 32; s++) hits.push([s % 8 === 6 ? o : h, s, s % 4 === 2 ? 0.5 : s % 2 ? 0.25 : 0.4]); return loop(sr, 120, 2, hits); } },
        'loop-perc': { name: 'Percussion 120', gen: (sr) => { const hi = drop(sr, 0.5, 480, 330, 0.02, 0.12), lo = drop(sr, 0.6, 320, 210, 0.025, 0.16), cl = drop(sr, 0.15, 2500, 2500, 1, 0.025); const hits = []; for (let b = 0; b < 2; b++) { for (const s of [0, 3, 6, 10, 12]) hits.push([cl, b * 16 + s, 0.4]); for (const s of [2, 7, 11]) hits.push([hi, b * 16 + s, 0.7]); for (const s of [4, 14]) hits.push([lo, b * 16 + s, 0.8]); } return loop(sr, 120, 2, hits); } },
      },
    };
  },
});
