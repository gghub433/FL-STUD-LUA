// FL LUA Drum Machines: two analog-style drum machines synthesised in real time (no samples).
//   DM-8   long booming kick, snappy snare, clap, rim, hats, three toms, three congas, cowbell, cymbal, claves, maracas
//   DM-9   punchy kick with click and drive, bright snare, clap, rim, sharp hats, toms, crash and ride
// Every drum is on its General MIDI note (36 kick, 38 snare, 39 clap, 42/46 hats…), so MIDI files and drum
// pads play them at once. Each drum has level, tune and decay; kick, snare and hats have one more knob each.
// The closed and pedal hats choke the open hat.
globalThis.__flluaRegisterPack({
  id: 'fllua-drum-machines',
  name: 'FL LUA Drum Machines',
  version: '1.0.0',
  author: 'FL LUA',
  license: 'MIT',
  description: 'DM-8 and DM-9: analog-style drum machines synthesised in real time, on General MIDI notes, with level, tune and decay for every drum.',
  api: 1,
  plugins(api) {
    const { def, choice, defaults } = api.params;
    const { TAU, Biquad, Noise, fastTanh, clamp } = api.dsp;

    // drum id, label, GM notes, extra knob
    const DRUMS = [
      ['bd', 'Kick', [35, 36], ['attack', 'Click']],
      ['sd', 'Snare', [38, 40], ['snappy', 'Snappy']],
      ['cp', 'Clap', [39], null],
      ['rs', 'Rim', [37], null],
      ['ch', 'Closed hat', [42, 44], ['tone', 'Hat tone']],
      ['oh', 'Open hat', [46], null],
      ['lt', 'Low tom', [41, 43], null],
      ['mt', 'Mid tom', [45, 47], null],
      ['ht', 'High tom', [48, 50], null],
      ['cy', 'Cymbal', [49, 52, 55, 57], null],
      ['rd', 'Ride / cowbell', [51, 53, 56, 59], null],
      ['lc', 'Low conga', [64], null],
      ['hc', 'High conga', [62, 63], null],
      ['cl', 'Claves / maracas', [75, 70, 69], null],
    ];
    function schemaFor(defaults_) {
      const s = [choice('kit', 'Character', ['Classic', 'Hard', 'Lo-fi'], 0, { group: 'Master' }), def('drive', 'Drive', 0, 1, defaults_.drive, { group: 'Master' }), def('volume', 'Volume', -24, 6, 0, { unit: 'dB', group: 'Master' }), def('accent', 'Velocity', 0, 1, 0.6, { group: 'Master' })];
      for (const [id, label, , extra] of DRUMS) {
        s.push(def(`${id}Lvl`, `${label} level`, 0, 1.5, defaults_.lvl[id] ?? 0.8, { group: label }),
          def(`${id}Tune`, `${label} tune`, -12, 12, 0, { unit: 'st', group: label }),
          def(`${id}Dec`, `${label} decay`, 0.1, 3, 1, { curve: 'log', group: label }));
        if (extra) s.push(def(`${id}${extra[0][0].toUpperCase()}${extra[0].slice(1)}`, `${label} ${extra[1].toLowerCase()}`, 0, 1, 0.5, { group: label }));
      }
      return s;
    }
    const NOTE = new Map();
    for (const [id, , notes] of DRUMS) for (const n of notes) NOTE.set(n, id);

    // ---- one voice per drum (like the hardware): retriggering restarts it
    class Voice {
      constructor(id, sr, seed) {
        this.id = id; this.sr = sr; this.on = false; this.t = 0; this.nz = new Noise(seed);
        this.ph = new Float64Array(6); this.f = [new Biquad(), new Biquad(), new Biquad()];
      }
    }

    class DrumMachine {
      constructor(sr, model, schema) {
        this.sr = sr; this.model = model; this.schema = schema;
        this.p = defaults(schema);
        this.v = {};
        DRUMS.forEach(([id], i) => { this.v[id] = new Voice(id, sr, 101 + i * 37); });
        this.out = 0;
      }
      get active() { for (const k in this.v) if (this.v[k].on) return true; return false; }
      setParam(id, v) { this.p[id] = v; }
      allOff() { for (const k in this.v) this.v[k].on = false; }
      noteOff() {}
      chokeAll() { for (const k in this.v) this.v[k].on = false; }

      noteOn(ev) {
        const id = NOTE.get(ev.key);
        if (!id) return;
        const p = this.p, v = this.v[id], sr = this.sr, m9 = this.model === 9;
        const vel = clamp(ev.vel ?? 0.8, 0, 1);
        v.on = true; v.t = 0; v.ph.fill(0); for (const f of v.f) f.reset();
        v.gain = (p[`${id}Lvl`] ?? 0.8) * (1 - p.accent + p.accent * vel * 1.25);
        v.tune = Math.pow(2, ((p[`${id}Tune`] || 0) + (ev.fine || 0) / 100) / 12);
        v.dec = p[`${id}Dec`] || 1;
        v.alt = ev.key;                                                    // which of the drum's notes (rd: ride or cowbell, cl: claves or maracas)
        const kit = p.kit;
        if (id === 'ch') this.v.oh.on = false;                            // closed hat chokes the open one
        switch (id) {
          case 'bd': v.f0 = (m9 ? 52 : 46) * v.tune; v.pe = m9 ? 5 : 2.4; v.pt = m9 ? 0.03 : 0.045; v.ad = (m9 ? 0.2 : 0.55) * v.dec * (kit === 1 ? 0.7 : 1); v.click = p.bdAttack; v.f[0].set('lp', sr, kit === 2 ? 1500 : 6000, 0.7); break;
          case 'sd': v.f0 = (m9 ? 190 : 175) * v.tune; v.td = (m9 ? 0.05 : 0.06) * v.dec; v.nd = (m9 ? 0.07 : 0.09) * v.dec; v.snap = p.sdSnappy; v.f[0].set('hp', sr, m9 ? 1800 : 1200, 0.7); v.f[1].set('bp', sr, m9 ? 5500 : 4200, 0.8); break;
          case 'cp': v.d = (m9 ? 0.09 : 0.12) * v.dec; v.f[0].set('bp', sr, 1150 * v.tune, 1.3); v.f[1].set('lp', sr, 7000, 0.7); break;
          case 'rs': v.f0 = 1700 * v.tune; v.d = 0.018 * v.dec; break;
          case 'ch': case 'oh': {
            const tone = this.p.chTone;
            v.base = (m9 ? 44 : 40) * v.tune * (0.85 + tone * 0.3);
            v.d = (id === 'ch' ? (m9 ? 0.03 : 0.04) : (m9 ? 0.18 : 0.25)) * v.dec * (ev.key === 44 ? 2 : 1);
            v.f[0].set('bp', sr, (m9 ? 9500 : 8000) * (0.8 + tone * 0.4), 0.9); v.f[1].set('hp', sr, m9 ? 7500 : 6500, 0.7); v.f[2].set('hp', sr, 6000, 0.7);
            break;
          }
          case 'lt': case 'mt': case 'ht': { const base = { lt: 82, mt: 120, ht: 175 }[id] * (m9 ? 1.1 : 1); v.f0 = base * v.tune * (ev.key === 43 || ev.key === 47 || ev.key === 50 ? 1.12 : 1); v.d = (m9 ? 0.13 : 0.18) * v.dec; break; }
          case 'cy': v.base = 37 * v.tune; v.d = (m9 ? 0.6 : 0.8) * v.dec; v.f[0].set('bp', sr, 6500, 0.6); v.f[1].set('hp', sr, 4800, 0.7); v.f[2].set('hp', sr, 3500, 0.7); break;
          case 'rd': {
            v.bell = !m9 || ev.key === 56;
            if (v.bell) { v.f0 = 540 * v.tune; v.d = 0.12 * v.dec; v.f[0].set('bp', sr, 2600 * v.tune, 1.2); }
            else { v.base = 63 * v.tune; v.d = 0.7 * v.dec; v.f[0].set('bp', sr, 5200, 0.6); v.f[1].set('hp', sr, 4500, 0.7); v.f[2].set('hp', sr, 3000, 0.7); }
            break;
          }
          case 'lc': case 'hc': v.f0 = (id === 'lc' ? 220 : 330) * v.tune * (ev.key === 63 ? 1.25 : 1); v.d = 0.09 * v.dec; break;
          case 'cl': v.maracas = ev.key !== 75; v.f0 = 2500 * v.tune; v.d = (v.maracas ? 0.04 : 0.03) * v.dec; v.f[0].set('hp', sr, 6500, 0.7); break;
          default: break;
        }
      }

      metal(v, base) {
        const R = [2, 3, 4.16, 5.43, 6.79, 8.21], sr = this.sr;
        let m = 0;
        for (let k = 0; k < 6; k++) { v.ph[k] += (base * R[k]) / sr; if (v.ph[k] >= 1) v.ph[k] -= 1; m += v.ph[k] < 0.5 ? 1 : -1; }
        return m / 6;
      }

      process(L, R, a, b) {
        const p = this.p, sr = this.sr, dt = 1 / sr, drive = p.drive, vol = Math.pow(10, p.volume / 20) * 0.7;
        const dg = 1 + drive * 4;
        for (const key in this.v) {
          const v = this.v[key];
          if (!v.on) continue;
          for (let i = a; i < b; i++) {
            const t = v.t; v.t += dt;
            let s = 0, done = false;
            switch (v.id) {
              case 'bd': {
                v.ph[0] += (v.f0 * (1 + v.pe * Math.exp(-t / v.pt))) / sr;
                const e = Math.exp(-t / v.ad);
                s = Math.sin(TAU * v.ph[0]) * e * Math.min(1, t * 3000) + v.click * v.nz.next() * Math.exp(-t * 900) * 0.8;
                s = v.f[0].process(s); done = e < 0.0005;
                break;
              }
              case 'sd': {
                v.ph[0] += v.f0 / sr; v.ph[1] += (v.f0 * 1.78) / sr;
                const te = Math.exp(-t / v.td), ne = Math.exp(-t / v.nd);
                const n = v.nz.next();
                s = (Math.sin(TAU * v.ph[0]) * 0.7 + Math.sin(TAU * v.ph[1]) * 0.35) * te * (1 - v.snap * 0.5) + (v.f[0].process(n) * 0.9 + v.f[1].process(n) * 0.5) * ne * (0.4 + v.snap);
                done = te < 0.0005 && ne < 0.0005;
                break;
              }
              case 'cp': {
                let e = 0;
                for (let k = 0; k < 4; k++) { const tk = k * 0.0095; if (t >= tk) e = Math.max(e, Math.exp(-(t - tk) * 210)); }
                if (t >= 0.03) e = Math.max(e, 0.75 * Math.exp(-(t - 0.03) / v.d));
                s = v.f[1].process(v.f[0].process(v.nz.next())) * e * 3.2;
                done = t > 0.05 && e < 0.0005;
                break;
              }
              case 'rs': {
                v.ph[0] += v.f0 / sr; v.ph[1] += (v.f0 * 0.49) / sr;
                const e = Math.exp(-t / v.d);
                s = (Math.sin(TAU * v.ph[0]) * 0.6 + Math.sin(TAU * v.ph[1]) * 0.5) * e + v.nz.next() * Math.exp(-t * 500) * 0.3;
                done = e < 0.0005;
                break;
              }
              case 'ch': case 'oh': case 'cy': {
                const e = Math.exp(-t / v.d) * Math.min(1, t * 5000);
                s = v.f[2].process(v.f[1].process(v.f[0].process(this.metal(v, v.base) * 0.8 + v.nz.next() * (v.id === 'cy' ? 0.6 : 0.3)))) * e * (v.id === 'cy' ? 1.6 : 2.2);
                done = t > 0.01 && e < 0.0005;
                break;
              }
              case 'rd': {
                if (v.bell) {
                  v.ph[0] += v.f0 / sr; v.ph[1] += (v.f0 * 1.48) / sr;
                  const e = 0.7 * Math.exp(-t / v.d) + 0.3 * Math.exp(-t * 60);
                  s = v.f[0].process((v.ph[0] % 1 < 0.5 ? 1 : -1) + (v.ph[1] % 1 < 0.5 ? 1 : -1)) * e * 0.9;
                  done = e < 0.0005;
                } else {
                  const e = Math.exp(-t / v.d) * Math.min(1, t * 5000);
                  s = v.f[2].process(v.f[1].process(v.f[0].process(this.metal(v, v.base) + v.nz.next() * 0.2))) * e * 1.8;
                  done = t > 0.01 && e < 0.0005;
                }
                break;
              }
              case 'lt': case 'mt': case 'ht': case 'lc': case 'hc': {
                const conga = v.id === 'lc' || v.id === 'hc';
                v.ph[0] += (v.f0 * (1 + (conga ? 0.35 : 0.6) * Math.exp(-t / 0.02))) / sr;
                const e = Math.exp(-t / v.d);
                s = Math.sin(TAU * v.ph[0]) * e * Math.min(1, t * 3000) + (conga ? v.nz.next() * Math.exp(-t * 700) * 0.25 : 0);
                done = e < 0.0005;
                break;
              }
              case 'cl': {
                const e = Math.exp(-t / v.d);
                if (v.maracas) s = v.f[0].process(v.nz.next()) * (t < 0.008 ? t / 0.008 : 1) * e * 1.8;
                else { v.ph[0] += v.f0 / sr; s = Math.sin(TAU * v.ph[0]) * e; }
                done = e < 0.0005;
                break;
              }
              default: done = true;
            }
            let y = fastTanh(s * v.gain * dg) / (drive > 0 ? Math.min(dg, 2.5) : 1) * vol;
            if (p.kit === 2) y = Math.round(y * 48) / 48;                  // lo-fi: coarse samples
            L[i] += y; R[i] += y;
            if (done) { v.on = false; break; }
          }
        }
      }
    }

    const dm8Schema = schemaFor({ drive: 0.1, lvl: { bd: 1, cp: 0.7, rs: 0.6, oh: 0.6, cy: 0.5, rd: 0.6 } });
    const dm9Schema = schemaFor({ drive: 0.3, lvl: { bd: 1, sd: 0.85, cp: 0.7, rs: 0.6, oh: 0.6, cy: 0.5, rd: 0.5 } });
    const presets = (extra) => ({ Default: {}, 'Long boom': { bdDec: 2, bdAttack: 0.1, ...extra }, Tight: { bdDec: 0.5, sdDec: 0.6, chDec: 0.6, ohDec: 0.5, drive: 0.4 }, 'Lo-fi': { kit: 2, drive: 0.5, chTone: 0.2 } });
    return {
      instruments: {
        'dm-8': { schema: dm8Schema, meta: { name: 'DM-8', kind: 'drums', rootDefault: 36, description: 'Analog-style drum machine with a long booming kick, congas, cowbell and claves (General MIDI notes)' }, create: (sr) => new DrumMachine(sr, 8, dm8Schema), presets: presets({}) },
        'dm-9': { schema: dm9Schema, meta: { name: 'DM-9', kind: 'drums', rootDefault: 36, description: 'Punchy analog-style drum machine with a clicky driven kick, bright snare, crash and ride (General MIDI notes)' }, create: (sr) => new DrumMachine(sr, 9, dm9Schema), presets: presets({ bdDec: 1.6 }) },
      },
    };
  },
});
