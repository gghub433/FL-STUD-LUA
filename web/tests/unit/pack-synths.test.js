import test from 'node:test';
import assert from 'node:assert/strict';
import { installPackHook, loadedPacks } from '../../src/core/packs.js';
import { createInstrument, INSTRUMENTS } from '../../src/core/instruments/index.js';
import { INSTRUMENT_PRESETS } from '../../src/core/presets.js';
import { FFT } from '../../src/core/fft.js';

installPackHook();
await import('../../packs/synths.flpack.js');          // validates (self-test of every plugin) and registers

const SR = 44100, ID = 'fllua-synths';
const host = () => ({ tempo: 120, tick: 0, playing: false, sr: SR, getSample: () => null });
const make = (name, params = {}) => { const i = createInstrument(`${ID}.${name}`, SR, host()); for (const [k, v] of Object.entries(params)) i.setParam(k, v); return i; };
const note = (inst, key, vel = 0.7) => inst.noteOn({ key, vel, pan: 0, fine: 0, rel: 64 });
const peak = (a, f = 0, t = a.length) => { let m = 0; for (let i = f; i < t; i++) m = Math.max(m, Math.abs(a[i])); return m; };
const rms = (a, f = 0, t = a.length) => { let s = 0; for (let i = f; i < t; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, t - f)); };
function render(inst, n, events = []) {
  const L = new Float32Array(n), R = new Float32Array(n), ev = [...events].sort((a, b) => a.at - b.at);
  for (let b = 0; b < n; b += 128) {
    const e = Math.min(n, b + 128); let pos = b;
    for (const x of ev) if (x.at >= b && x.at < e) { if (x.at > pos) { inst.process(L, R, pos, x.at); pos = x.at; } x.fn(); }
    if (pos < e) inst.process(L, R, pos, e);
  }
  return { L, R };
}
// magnitude spectrum (linear) of a Hann-windowed chunk
function spectrum(a, from, N = 16384) {
  const fft = new FFT(N), re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = (a[from + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  fft.transform(re, im);
  const m = new Float32Array(N / 2);
  for (let k = 0; k < N / 2; k++) m[k] = Math.hypot(re[k], im[k]);
  return m;
}
const binOf = (f, N = 16384) => Math.round((f * N) / SR);
const magAt = (m, f) => { const b = binOf(f); return Math.max(m[b - 1], m[b], m[b + 1]); };
const peakFreq = (m, lo = 20) => { let best = binOf(lo), bv = 0; for (let k = binOf(lo); k < m.length; k++) if (m[k] > bv) { bv = m[k]; best = k; } return (best * SR) / 16384; };
const centroid = (m) => { let n = 0, d = 0; for (let k = 1; k < m.length; k++) { n += m[k] * k; d += m[k]; } return ((n / d) * SR) / (m.length * 2); };
// frequency from the first and last rising zero crossing of a window (precise even for short windows)
const freqOf = (a, f, t) => { const xs = []; for (let i = f + 1; i < t; i++) if (a[i - 1] <= 0 && a[i] > 0) xs.push(i - 1 + -a[i - 1] / (a[i] - a[i - 1])); return xs.length > 2 ? ((xs.length - 1) * SR) / (xs[xs.length - 1] - xs[0]) : 0; };
const crossings = (a, f, t) => { let n = 0; for (let i = f + 1; i < t; i++) if (a[i - 1] <= 0 && a[i] > 0) n++; return n; };

test('the pack is registered with four generators, presets and metadata', () => {
  const pack = loadedPacks().find((p) => p.id === ID);
  assert.ok(pack && pack.plugins.length === 4);
  for (const name of ['acid', 'trio', 'chip', 'additive']) {
    const mod = INSTRUMENTS[`${ID}.${name}`];
    assert.ok(mod && mod.meta.name && mod.meta.description && mod.schema.length > 8, name);
    assert.ok(Object.keys(INSTRUMENT_PRESETS[`${ID}.${name}`] || {}).length >= 4, `${name} presets`);
    for (const [pn, params] of Object.entries(INSTRUMENT_PRESETS[`${ID}.${name}`])) for (const k of Object.keys(params)) assert.ok(mod.schema.some((d) => d.id === k), `${name}/${pn}: unknown parameter ${k}`);
  }
});

test('every preset renders finite, audible, bounded sound', () => {
  for (const name of ['acid', 'trio', 'chip', 'additive']) {
    for (const [pn, params] of Object.entries(INSTRUMENT_PRESETS[`${ID}.${name}`])) {
      const inst = make(name, params);
      const { L, R } = render(inst, SR, [{ at: 0, fn: () => { note(inst, 45); note(inst, 52); } }, { at: SR * 0.6, fn: () => { inst.noteOff(45); inst.noteOff(52); } }]);
      assert.ok(peak(L, 500, SR * 0.5) > 0.01 && peak(L) < 4 && peak(R) < 4, `${name}/${pn}: peak ${peak(L).toFixed(3)}`);
      for (let i = 0; i < L.length; i += 7) assert.ok(Number.isFinite(L[i]) && Number.isFinite(R[i]), `${name}/${pn} finite`);
    }
  }
});

test('Acid Bass: exact pitch, monophonic, resonance and cutoff shape the sound, slide glides, accent is louder', () => {
  const inst = make('acid', { cutoff: 9000, envMod: 0, res: 0.1, drive: 0 });
  const { L } = render(inst, SR, [{ at: 0, fn: () => note(inst, 45) }]);                // A2 = 110 Hz
  const f = peakFreq(spectrum(L, 8000));
  assert.ok(Math.abs(f - 110) < 3, `A2 plays ${f.toFixed(1)} Hz`);
  const dark = make('acid', { cutoff: 150, envMod: 0, res: 0.1 }), bright = make('acid', { cutoff: 6000, envMod: 0, res: 0.1 });
  const cd = centroid(spectrum(render(dark, SR, [{ at: 0, fn: () => note(dark, 45) }]).L, 8000)), cb = centroid(spectrum(render(bright, SR, [{ at: 0, fn: () => note(bright, 45) }]).L, 8000));
  assert.ok(cd < cb * 0.5, `low cutoff is darker (${cd.toFixed(0)} vs ${cb.toFixed(0)} Hz)`);
  // resonance puts a peak at the cutoff
  const lo = make('acid', { cutoff: 800, envMod: 0, res: 0.1 }), hi = make('acid', { cutoff: 800, envMod: 0, res: 0.95 });
  const sl = spectrum(render(lo, SR, [{ at: 0, fn: () => note(lo, 45) }]).L, 8000), sh = spectrum(render(hi, SR, [{ at: 0, fn: () => note(hi, 45) }]).L, 8000);
  const around = (m) => { let x = 0; for (let k = binOf(650); k < binOf(950); k++) x = Math.max(x, m[k]); return x; };
  assert.ok(around(sh) > around(sl) * 1.5, 'resonance boosts the cutoff region');
  // envelope sweeps the cutoff down within the note
  const env = make('acid', { cutoff: 200, envMod: 1, decay: 150 });
  const e = render(env, SR, [{ at: 0, fn: () => note(env, 45) }]).L;
  assert.ok(centroid(spectrum(e, 100, 2048)) > centroid(spectrum(e, 20000, 2048)) * 1.5, 'the filter envelope closes the filter');
  // monophonic: a second key while the first is held never adds a second voice
  const mono = make('acid', { slide: 5 });
  const m = render(mono, SR / 2, [{ at: 0, fn: () => note(mono, 45) }, { at: 4000, fn: () => note(mono, 57) }]).L;
  assert.ok(peak(m, 12000) < 1.2, 'one voice');
  // slide: after the second key the pitch moves gradually (slide 400 ms), not instantly
  const sld = make('acid', { slide: 400, cutoff: 9000, envMod: 0, res: 0.1 });
  const s = render(sld, SR, [{ at: 0, fn: () => note(sld, 45) }, { at: 8000, fn: () => note(sld, 57) }]).L;
  const fz = (a, b) => (crossings(s, a, b) * SR) / (b - a);
  const f1 = fz(6000, 8000), f2 = fz(8000 + 2000, 8000 + 6000), f3 = fz(SR - 6000, SR);
  assert.ok(f1 < 125 && f2 > 125 && f2 < 215 && f3 > 190, `glides 110 -> ${f2.toFixed(0)} -> 220 Hz (${f1.toFixed(0)}, ${f3.toFixed(0)})`);
  // accent: velocity above 80 % is louder
  const ac = make('acid', { accent: 1 }), plain = make('acid', { accent: 1 });
  const a1 = render(ac, 8000, [{ at: 0, fn: () => note(ac, 45, 1) }]).L, a0 = render(plain, 8000, [{ at: 0, fn: () => note(plain, 45, 0.5) }]).L;
  assert.ok(rms(a1, 1000) > rms(a0, 1000) * 1.2, 'accented notes are louder');
  // release: silent a moment after the key goes up
  const rl = make('acid', { release: 40 });
  const r = render(rl, SR / 2, [{ at: 0, fn: () => note(rl, 45) }, { at: 8000, fn: () => rl.noteOff(45) }]).L;
  assert.ok(peak(r, 8000 + 6000) < 0.02 && rl.active === false, 'released');
});

test('Tri-Osc: oscillator tuning, levels, sync, ring modulation, FM, filter types and polyphony', () => {
  const sines = { wave1: 0, wave2: 0, wave3: 0, lvl1: 1, lvl2: 0, lvl3: 0, cutoff: 18000, res: 0, fenv: 0, track: 0, attack: 1, sustain: 1 };
  const t1 = make('trio', sines);
  const a = spectrum(render(t1, SR, [{ at: 0, fn: () => note(t1, 69) }]).L, 8000);
  assert.ok(Math.abs(peakFreq(a) - 440) < 3, 'A4');
  const t2 = make('trio', { ...sines, lvl2: 1, semi2: 12, fine2: 0 });
  const b = spectrum(render(t2, SR, [{ at: 0, fn: () => note(t2, 69) }]).L, 8000);
  assert.ok(magAt(b, 880) > magAt(b, 440) * 0.5 && magAt(b, 880) > magAt(b, 660) * 20, 'oscillator 2 an octave up');
  const t3 = make('trio', { ...sines, lvl1: 0, lvl3: 1, semi3: -12 });
  assert.ok(Math.abs(peakFreq(spectrum(render(t3, SR, [{ at: 0, fn: () => note(t3, 69) }]).L, 8000)) - 220) < 3, 'oscillator 3 an octave down');
  // ring modulation of two sines gives sum and difference tones
  const rm = make('trio', { ...sines, lvl1: 0, lvl2: 0, lvl3: 0, wave2: 0, semi2: 7, fine2: 0, lvl2_: 0, ring: 1 });
  rm.setParam('lvl1', 0.001); rm.setParam('lvl2', 0.001);
  const r = spectrum(render(rm, SR, [{ at: 0, fn: () => note(rm, 69) }]).L, 8000);
  const f1 = 440, f2 = 440 * Math.pow(2, 7 / 12);
  assert.ok(magAt(r, f1 + f2) > magAt(r, f1) * 3 && magAt(r, f2 - f1) > magAt(r, f1) * 3, 'ring modulation: sum and difference tones');
  // hard sync makes a sync sweep: the pitch stays that of oscillator 1 although oscillator 2 runs at another frequency
  const sy = make('trio', { ...sines, wave1: 2, wave2: 2, lvl1: 0, lvl2: 1, semi2: 7, sync: 1 });
  sy.setParam('lvl1', 0.0001);
  const sp = spectrum(render(sy, SR, [{ at: 0, fn: () => note(sy, 57) }]).L, 8000);
  assert.ok(Math.abs(peakFreq(sp, 60) % 220) < 8 || Math.abs((peakFreq(sp, 60) % 220) - 220) < 8, `sync locks the period to 220 Hz (peak ${peakFreq(sp, 60).toFixed(0)})`);
  // FM adds sidebands around oscillator 3
  const fm0 = make('trio', { ...sines, lvl1: 0.0001, lvl3: 1, wave3: 0, semi3: 0, fm: 0 }), fm1 = make('trio', { ...sines, lvl1: 0.0001, lvl3: 1, wave3: 0, semi3: 0, fm: 0.8 });
  fm1.setParam('lvl1', 1);
  const c0 = centroid(spectrum(render(fm0, SR, [{ at: 0, fn: () => note(fm0, 57) }]).L, 8000)), c1 = centroid(spectrum(render(fm1, SR, [{ at: 0, fn: () => note(fm1, 57) }]).L, 8000));
  assert.ok(c1 > c0 * 1.3, 'FM brightens the sound');
  // filter types
  const saw = { wave1: 2, wave2: 2, wave3: 2, lvl1: 1, lvl2: 0, lvl3: 0, res: 0, fenv: 0, track: 0, sustain: 1, attack: 1 };
  const lp = make('trio', { ...saw, ftype: 0, cutoff: 500 }), hp = make('trio', { ...saw, ftype: 1, cutoff: 3000 });
  const lpS = spectrum(render(lp, SR, [{ at: 0, fn: () => note(lp, 45) }]).L, 8000), hpS = spectrum(render(hp, SR, [{ at: 0, fn: () => note(hp, 45) }]).L, 8000);
  assert.ok(centroid(lpS) < 800 && centroid(hpS) > 2500, `low pass (${centroid(lpS).toFixed(0)} Hz) and high pass (${centroid(hpS).toFixed(0)} Hz)`);
  // polyphony and voice limit
  const pl = make('trio', { poly: 3 });
  render(pl, 2000, [{ at: 0, fn: () => { for (const k of [48, 52, 55, 60, 64]) note(pl, k); } }]);
  assert.equal(pl.voices.filter((v) => v.alive).length, 3, 'poly 3 steals the oldest voices');
  // glide
  const gl = make('trio', { ...sines, glide: 300 });
  const g = render(gl, SR, [{ at: 0, fn: () => note(gl, 57) }, { at: 8000, fn: () => { gl.noteOff(57); note(gl, 69); } }]).L;
  const mid = (crossings(g, 8000 + 3000, 8000 + 7000) * SR) / 4000;
  assert.ok(mid > 225 && mid < 435, `glide passes ${mid.toFixed(0)} Hz on the way from 220 to 440`);
});

test('Chip: pulse widths, bit reduction, noise registers, arpeggio, sweep and envelope steps', () => {
  const base = { wave: 0, attack: 0, sustain: 1, decay: 3000, bits: 8, vibDepth: 0, sweep: 0, arp: 0 };
  const sq = make('chip', { ...base, duty: 2 }), pw = make('chip', { ...base, duty: 0 });
  const s50 = spectrum(render(sq, SR, [{ at: 0, fn: () => note(sq, 69, 1) }]).L, 8000), s12 = spectrum(render(pw, SR, [{ at: 0, fn: () => note(pw, 69, 1) }]).L, 8000);   // A4 = 440 Hz
  assert.ok(magAt(s50, 440) > 20 * magAt(s50, 880), '50 % pulse has no even harmonics');
  assert.ok(magAt(s12, 880) > 0.2 * magAt(s12, 440), '12.5 % pulse is rich in even harmonics');
  // bits: the number of distinct output levels is bounded by the amplitude resolution
  const levels = (bits) => { const c = make('chip', { ...base, wave: 1, bits, sustain: 0.55 }); const { L } = render(c, 8000, [{ at: 0, fn: () => note(c, 57, 1) }]); return new Set(Array.from(L.subarray(2000), (v) => v.toFixed(5))).size; };
  assert.ok(levels(2) <= 7 && levels(8) > levels(2) * 2, `2 bits ${levels(2)} levels, 8 bits ${levels(8)} levels`);
  // noise: the short register repeats (periodic), the long one does not within the same time
  const lagCorr = (wave, lag) => { const c = make('chip', { ...base, wave, duty: 2 }); const { L } = render(c, 40000, [{ at: 0, fn: () => note(c, 69, 1) }]); const x = L.subarray(2000); let c2 = 0, e = 0; for (let i = 0; i < 8000; i++) { c2 += x[i] * x[i + lag]; e += x[i] * x[i]; } return c2 / e; };
  const period = Math.round((127 * SR) / (440 * 4));            // 127 clocks of the short register at a clock of 4 x the note frequency
  assert.ok(lagCorr(3, period) > 0.9 && Math.abs(lagCorr(2, period)) < 0.3, `short register repeats after ${period} samples (${lagCorr(3, period).toFixed(2)}), the long one does not (${lagCorr(2, period).toFixed(2)})`);
  // arpeggio walks through the chord: three different pitches over time
  const ar = make('chip', { ...base, arp: 1, arpRate: 10, duty: 2 });
  const A = render(ar, SR, [{ at: 0, fn: () => note(ar, 57, 1) }]).L;
  const fr = (t) => freqOf(A, Math.round(t * SR), Math.round((t + 0.08) * SR));
  const [p0, p1, p2] = [0.01, 0.11, 0.21].map(fr);
  assert.ok(Math.abs(p1 / p0 - 1.26) < 0.04 && Math.abs(p2 / p0 - 1.498) < 0.04, `major arpeggio ratios 1 : ${(p1 / p0).toFixed(2)} : ${(p2 / p0).toFixed(2)}`);
  // sweep: pitch moves during the note
  const sw = make('chip', { ...base, sweep: -12, duty: 2 });
  const W = render(sw, SR, [{ at: 0, fn: () => note(sw, 69, 1) }]).L;
  const fEarly = freqOf(W, 0, 4000), fLate = freqOf(W, Math.round(0.9 * SR), Math.round(0.9 * SR) + 4000);
  assert.ok(Math.abs(fEarly - 440) < 15 && Math.abs(fLate / fEarly - Math.pow(2, -10.8 / 12)) < 0.06, `sweeps down 12 semitones per second (${fEarly.toFixed(0)} -> ${fLate.toFixed(0)} Hz)`);
  // envelope: decays to sustain then releases
  const ev = make('chip', { ...base, sustain: 0.2, decay: 100, release: 50 });
  const E = render(ev, SR, [{ at: 0, fn: () => note(ev, 57, 1) }, { at: 20000, fn: () => ev.noteOff(57) }]).L;
  assert.ok(rms(E, 500, 1500) > rms(E, 15000, 19000) * 2 && peak(E, 20000 + 6000) < 0.01, 'decay then release');
});

test('Additive: partial count, tilt, odd/even, formant, inharmonicity, morph and fading highs behave like their labels', () => {
  const base = { shapeA: 0, shapeB: 0, morph: 0, slope: 0, odd: 1, even: 1, fmGain: 0, stretch: 0, spread: 0, hfDecay: 0, width: 0, tone: 20000, attack: 1, sustain: 1, partials: 32 };
  const run = (extra, key = 45, n = SR) => { const a = make('additive', { ...base, ...extra }); return render(a, n, [{ at: 0, fn: () => note(a, key, 1) }]).L; };
  const f0 = 110;
  const one = spectrum(run({ partials: 1 }), 8000);
  assert.ok(magAt(one, f0) > 50 * magAt(one, f0 * 2), 'one partial is a pure sine');
  const saw = spectrum(run({}), 8000);
  const ratio = magAt(saw, f0) / magAt(saw, f0 * 4);
  assert.ok(ratio > 3.2 && ratio < 4.8, `saw spectrum falls as 1/n (partial 4 is ${ratio.toFixed(2)}x weaker)`);
  assert.ok(magAt(saw, f0 * 32) > 0 && magAt(saw, f0 * 40) < magAt(saw, f0 * 32) * 0.2, 'partials stop at the partial count');
  const hollow = spectrum(run({ even: 0 }), 8000);
  assert.ok(magAt(hollow, f0 * 2) < magAt(hollow, f0) * 0.01 && magAt(hollow, f0 * 3) > magAt(hollow, f0) * 0.2, 'even partials off: square-like');
  const tiltDown = spectrum(run({ slope: 2 }), 8000), tiltUp = spectrum(run({ slope: -1.5 }), 8000);
  assert.ok(centroid(tiltDown) < centroid(saw) && centroid(tiltUp) > centroid(saw), 'tilt moves the balance');
  const fm = spectrum(run({ fmGain: 18, fmFreq: 10, fmWidth: 1.5 }), 8000);
  assert.ok(magAt(fm, f0 * 10) / magAt(fm, f0 * 6) > 4 * (magAt(saw, f0 * 10) / magAt(saw, f0 * 6)) * 0.6, 'the formant lifts the partials around the 10th');
  const st = spectrum(run({ stretch: 0.02 }), 8000);
  assert.ok(magAt(st, f0 * 10) < magAt(saw, f0 * 10) * 0.3 && magAt(st, f0 * 10 * Math.sqrt(1 + 0.02 * 100)) > magAt(saw, f0 * 10 * Math.sqrt(1 + 0.02 * 100)) * 2, 'inharmonicity moves partials upwards');
  // morph from saw to square halves the even partials halfway... and removes them at the end
  const mA = spectrum(run({ shapeA: 0, shapeB: 1, morph: 0 }), 8000), mB = spectrum(run({ shapeA: 0, shapeB: 1, morph: 1 }), 8000);
  assert.ok(magAt(mA, f0 * 2) > 5 * magAt(mB, f0 * 2), 'morph A -> B takes the even partials away');
  // high partials fade faster than the fundamental
  const fade = run({ hfDecay: 1, sustain: 1 }, 45, SR * 2);
  const early = spectrum(fade, 2000), late = spectrum(fade, SR * 1.5);
  assert.ok(magAt(late, f0 * 12) / magAt(late, f0) < 0.3 * (magAt(early, f0 * 12) / magAt(early, f0)), 'highs fade over time');
  // stereo width
  const wide = make('additive', { ...base, width: 1 }), mono = make('additive', { ...base, width: 0 });
  const w = render(wide, 8000, [{ at: 0, fn: () => note(wide, 45) }]), m = render(mono, 8000, [{ at: 0, fn: () => note(mono, 45) }]);
  const diff = (r) => { let d = 0; for (let i = 2000; i < 8000; i++) d += Math.abs(r.L[i] - r.R[i]); return d; };
  assert.ok(diff(w) > 20 * diff(m) + 1, 'width spreads odd and even partials left and right');
  // release ends the voice
  const rl = make('additive', { release: 40 });
  render(rl, 40000, [{ at: 0, fn: () => note(rl, 45) }, { at: 4000, fn: () => rl.noteOff(45) }]);
  assert.equal(rl.active, false);
});
