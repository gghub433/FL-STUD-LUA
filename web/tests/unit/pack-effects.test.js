import test from 'node:test';
import assert from 'node:assert/strict';
import { installPackHook, loadedPacks } from '../../src/core/packs.js';
import { createEffect, EFFECTS } from '../../src/core/effects/index.js';
import { EFFECT_PRESETS } from '../../src/core/presets.js';
import { FFT } from '../../src/core/fft.js';

installPackHook();
await import('../../packs/effects.flpack.js');          // validates (self-test of every plugin) and registers

const SR = 44100, ID = 'fllua-effects';
const make = (name, params = {}, tempo = 120) => { const f = createEffect(`${ID}.${name}`, SR, { sr: SR, tempo, tick: 0, playing: false, getSample: () => null }); for (const [k, v] of Object.entries(params)) f.setParam(k, v); return f; };
const sine = (f, n, amp = 0.5, from = 0) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * (i + from)) / SR));
function noise(n, amp = 0.3, seed = 7) { let s = seed; return Float32Array.from({ length: n }, () => { s = (s * 1664525 + 1013904223) >>> 0; return (s / 2147483648 - 1) * amp; }); }
const run = (fx, L, R = L.slice()) => { const l = L.slice(), r = R.slice(); for (let b = 0; b < l.length; b += 128) { const m = Math.min(128, l.length - b); fx.process(l.subarray(b, b + m), r.subarray(b, b + m), m, { scL: null, scR: null }); } return { L: l, R: r }; };
const peak = (a, f = 0, t = a.length) => { let m = 0; for (let i = f; i < t; i++) m = Math.max(m, Math.abs(a[i])); return m; };
const rms = (a, f = 0, t = a.length) => { let s = 0; for (let i = f; i < t; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, t - f)); };
function spectrum(a, from, N = 16384) {
  const fft = new FFT(N), re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = (a[from + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  fft.transform(re, im);
  const m = new Float32Array(N / 2); for (let k = 0; k < N / 2; k++) m[k] = Math.hypot(re[k], im[k]);
  return m;
}
const mag = (m, f, N = 16384) => { const b = Math.round((f * N) / SR); return Math.max(m[b - 2], m[b - 1], m[b], m[b + 1], m[b + 2]); };
const peakFreq = (m, N = 16384) => { let best = 5, bv = 0; for (let k = 5; k < m.length; k++) if (m[k] > bv) { bv = m[k]; best = k; } const a = m[best - 1], b = m[best], c = m[best + 1]; const d = a + c - 2 * b; return ((best + (d ? (a - c) / (2 * d) : 0)) * SR) / N; };
const db = (x) => 20 * Math.log10(x);

test('the pack is registered with seven effects, presets and descriptions', () => {
  const pack = loadedPacks().find((p) => p.id === ID);
  assert.ok(pack && pack.plugins.length === 7);
  for (const name of ['softclip', 'maximizer', 'hyperchorus', 'waveshaper', 'overdrive', 'delaybank', 'pitcher']) {
    const mod = EFFECTS[`${ID}.${name}`];
    assert.ok(mod && mod.meta.name && mod.meta.category && mod.meta.description, name);
    const presets = EFFECT_PRESETS[`${ID}.${name}`] || {};
    assert.ok(Object.keys(presets).length >= 4, `${name} presets`);
    for (const [pn, params] of Object.entries(presets)) {
      for (const k of Object.keys(params)) assert.ok(mod.schema.some((d) => d.id === k), `${name}/${pn}: unknown parameter ${k}`);
      const out = run(make(name, params), noise(6000), noise(6000, 0.3, 9));
      assert.ok(out.L.every(Number.isFinite) && out.R.every(Number.isFinite) && peak(out.L) < 8, `${name}/${pn} finite and bounded`);
    }
  }
});

test('Soft Clipper: bounded by the threshold, transparent when quiet, curves differ, oversampling cuts aliasing, mix 0 is dry', () => {
  const x = sine(1000, 8000, 0.9);
  const hard = run(make('softclip', { drive: 24, threshold: -6, shape: 0, os: 0 }), x);
  assert.ok(peak(hard.L) <= 0.502 && peak(hard.L) > 0.45, `limited to -6 dB (${peak(hard.L).toFixed(3)})`);
  const q = sine(1000, 8000, 0.05);
  const clean = run(make('softclip', { drive: 0, threshold: 0, shape: 0, os: 0 }), q);
  assert.ok(Math.abs(rms(clean.L, 1000) / rms(q, 1000) - 1) < 0.01, 'quiet signals pass unchanged');
  const outs = [0, 1, 2, 3].map((shape) => run(make('softclip', { drive: 12, threshold: -3, shape, os: 0 }), x).L);
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) { let d = 0; for (let i = 0; i < 4000; i++) d += Math.abs(outs[a][i] - outs[b][i]); assert.ok(d > 1, `curves ${a} and ${b} differ`); }
  // 10 kHz clipped hard: the 3rd harmonic (30 kHz) folds back to 14.1 kHz unless oversampled
  const hi = sine(10000, 16384 + 4000, 0.8);
  const aliasOf = (os) => mag(spectrum(run(make('softclip', { drive: 24, threshold: -3, shape: 3, os }), hi).L, 2000), 14100);
  assert.ok(db(aliasOf(0) / aliasOf(1)) > 6, `oversampling lowers the alias by ${db(aliasOf(0) / aliasOf(1)).toFixed(1)} dB`);
  const dry = run(make('softclip', { drive: 30, mix: 0 }), x);
  assert.ok(dry.L.every((v, i) => Math.abs(v - x[i]) < 1e-6), 'mix 0 is the dry signal');
});

test('Maximizer: louder but never above the ceiling, reports its latency, flat when idle, mix 0 is the delayed dry signal', () => {
  const n = SR * 2;
  const src = Float32Array.from({ length: n }, (_, i) => { const t = i / SR, env = Math.floor(t * 4) % 2 ? 0.08 : 0.5; return env * (Math.sin(2 * Math.PI * 90 * t) * 0.6 + Math.sin(2 * Math.PI * 1500 * t) * 0.3 + Math.sin(2 * Math.PI * 7000 * t) * 0.1); });
  const fx = make('maximizer', { amount: 0.8, mode: 3, ceiling: -0.3 });
  assert.equal(fx.latency, Math.round(SR * 0.0015), 'latency equals the look-ahead');
  const out = run(fx, src);
  assert.ok(out.L.every(Number.isFinite));
  assert.ok(peak(out.L) <= 0.9667, `ceiling holds (${peak(out.L).toFixed(4)})`);
  assert.ok(db(rms(out.L, SR / 2) / rms(src, SR / 2)) > 3, `louder by ${db(rms(out.L, SR / 2) / rms(src, SR / 2)).toFixed(1)} dB`);
  // quiet passages come up more than loud ones: the dynamic range shrinks
  const crest = (a) => rms(a, Math.round(0.30 * SR), Math.round(0.45 * SR)) / rms(a, Math.round(0.05 * SR), Math.round(0.2 * SR));
  assert.ok(crest(out.L) > crest(src) * 1.4, 'less dynamic range');
  const idle = run(make('maximizer', { amount: 0, ceiling: 0 }), noise(SR, 0.2));
  const nz = noise(SR, 0.2);
  assert.ok(Math.abs(db(rms(idle.L, 5000) / rms(nz, 5000))) < 1, 'amount 0 is transparent');
  const dry = run(make('maximizer', { amount: 1, mix: 0 }), src);
  const la = fx.latency;
  for (let i = 5000; i < 5100; i++) assert.ok(Math.abs(dry.L[i] - src[i - la]) < 1e-6, 'dry path is delayed by the same latency');
  assert.equal(peak(run(make('maximizer', { amount: 1, mode: 3, ceiling: -6 }), sine(300, SR, 0.9)).L, 3000) <= 0.5013, true, 'a -6 dB ceiling holds on a loud sine');
});

test('Hyper Chorus: mix 0 is dry, one voice is a plain delay, several voices decorrelate left and right', () => {
  const x = noise(SR, 0.3);
  assert.ok(run(make('hyperchorus', { mix: 0 }), x).L.every((v, i) => Math.abs(v - x[i]) < 1e-7), 'dry');
  const imp = new Float32Array(4000); imp[10] = 1;
  const one = run(make('hyperchorus', { voices: 1, depth: 0, delay: 12, mix: 1, lowcut: 20, highcut: 20000, spread: 0 }), imp);
  let at = 0; for (let i = 0; i < 4000; i++) if (Math.abs(one.L[i]) > Math.abs(one.L[at])) at = i;
  assert.ok(Math.abs(at - (10 + Math.round(0.012 * SR))) <= 3, `impulse comes back after 12 ms (sample ${at})`);
  assert.ok(Math.abs(one.L[at] - one.R[at]) < 0.01 * Math.abs(one.L[at]) + 1e-4, 'a single centred voice is mono');
  const many = run(make('hyperchorus', { voices: 6, spread: 1, depth: 6, mix: 1 }), x);
  let side = 0, mid = 0; for (let i = 4000; i < SR; i++) { side += (many.L[i] - many.R[i]) ** 2; mid += (many.L[i] + many.R[i]) ** 2; }
  assert.ok(side / mid > 0.15, `wide stereo image (side/mid ${(side / mid).toFixed(2)})`);
  const narrow = run(make('hyperchorus', { voices: 6, spread: 0, depth: 6, mix: 1 }), x);
  let side0 = 0; for (let i = 4000; i < SR; i++) side0 += (narrow.L[i] - narrow.R[i]) ** 2;
  assert.ok(side0 < side * 0.05, 'spread 0 keeps it centred');
  const loud = rms(many.L, 4000), ref = rms(x, 4000);
  assert.ok(loud > ref * 0.6 && loud < ref * 1.6, 'level stays comparable to the input');
});

test('Waveshaper: every curve is bounded, tanh is gentle when quiet, folding and Chebyshev make the right harmonics, DC is removed', () => {
  const x = sine(1000, 16384 + 4000, 0.8);
  for (let c = 0; c < 8; c++) { const o = run(make('waveshaper', { curve: c, drive: 30, output: 0 }), x); assert.ok(peak(o.L) < 3 && o.L.every(Number.isFinite), `curve ${c} bounded`); }
  const q = sine(1000, 8000, 0.02);
  const soft = run(make('waveshaper', { curve: 0, drive: 0, output: 0, os: 0, tone: 20000 }), q);
  assert.ok(Math.abs(rms(soft.L, 2000) / rms(q, 2000) - 1) < 0.02, 'quiet signals pass through tanh');
  const t3 = spectrum(run(make('waveshaper', { curve: 5, drive: 0, output: 0, os: 0 }), sine(1000, 16384 + 4000, 1)).L, 2000);
  assert.ok(db(mag(t3, 3000) / mag(t3, 1000)) > 20, `Chebyshev 3 turns a sine into its 3rd harmonic (${db(mag(t3, 3000) / mag(t3, 1000)).toFixed(0)} dB)`);
  const fold = spectrum(run(make('waveshaper', { curve: 2, drive: 14, output: 0, os: 0 }), x).L, 2000);
  assert.ok(mag(fold, 3000) > mag(fold, 2000) * 3, 'folding gives odd harmonics');
  const hardB = run(make('waveshaper', { curve: 1, drive: 24, bias: 1, output: 0, os: 0 }), x).L;
  let mean = 0; for (let i = 8000; i < 16000; i++) mean += hardB[i]; mean /= 8000;
  assert.ok(Math.abs(mean) < 0.05, `DC offset of an asymmetric clip is blocked (${mean.toFixed(3)})`);
  const diode = spectrum(run(make('waveshaper', { curve: 4, drive: 12, output: 0, os: 0 }), x).L, 2000);
  assert.ok(mag(diode, 2000) > 0.03 * mag(diode, 1000), 'the asymmetric diode curve adds even harmonics');
  const tone = run(make('waveshaper', { curve: 1, drive: 30, tone: 1500, os: 0 }), sine(500, 16384 + 4000, 0.9));
  const ts = spectrum(tone.L, 2000);
  assert.ok(mag(ts, 5000) < mag(ts, 500) * 0.05, 'the tone control removes the top');
});

test('Overdrive: harmonics grow with drive, asymmetry adds even harmonics, low cut tightens the bass, fuzz is bounded', () => {
  const thd = (params) => { const s = spectrum(run(make('overdrive', { level: 0, mix: 1, ...params }), sine(300, 16384 + 4000, 0.5)).L, 3000); let h = 0; for (const k of [2, 3, 4, 5, 6, 7]) h += mag(s, 300 * k) ** 2; return Math.sqrt(h) / mag(s, 300); };
  assert.ok(thd({ drive: 0.8 }) > thd({ drive: 0.1 }) * 2, `more drive, more harmonics (${thd({ drive: 0.1 }).toFixed(2)} -> ${thd({ drive: 0.8 }).toFixed(2)})`);
  const even = (color) => { const s = spectrum(run(make('overdrive', { mode: 0, drive: 0.6, color, level: 0 }), sine(300, 16384 + 4000, 0.5)).L, 3000); return mag(s, 600) / mag(s, 300); };
  assert.ok(even(1) > even(0) * 2, 'asymmetry brings the 2nd harmonic');
  const low = (cut) => rms(run(make('overdrive', { drive: 0.3, lowcut: cut, focusGain: 0 }), sine(50, SR / 2, 0.4)).L, 8000);
  assert.ok(low(300) < low(20) * 0.4, 'low cut attenuates 50 Hz');
  const lev = (l) => rms(run(make('overdrive', { level: l }), sine(500, SR / 4, 0.3)).L, 4000);
  assert.ok(Math.abs(db(lev(0) / lev(-12)) - 12) < 1, 'level is in decibels');
  for (const mode of [0, 1, 2]) assert.ok(peak(run(make('overdrive', { mode, drive: 1, level: 6 }), sine(200, SR / 4, 1)).L) < 8, `mode ${mode} bounded`);
  assert.ok(run(make('overdrive', { mix: 0 }), sine(500, 4000)).L.every((v, i) => Math.abs(v - sine(500, 4000)[i]) < 1e-7), 'mix 0 is dry');
});

test('Delay Bank: taps echo at their times with their pan and level, feedback repeats, tempo sync follows the BPM', () => {
  const imp = new Float32Array(SR * 2); imp[100] = 1;
  const free = { sync: 0, mix: 1, lowcut: 20, level1: 0, level2: -60, level3: -60, level4: -60, pan1: -1, fb1: 0, time1: 100, cut1: 20000 };
  const a = run(make('delaybank', free), imp);
  const t1 = 100 + Math.round(0.1 * SR);
  let at = 300; for (let i = 300; i < a.L.length; i++) if (Math.abs(a.L[i]) > Math.abs(a.L[at])) at = i;
  assert.ok(Math.abs(at - t1) <= 2, `tap 1 echoes at ${at} (expected ${t1})`);
  assert.ok(peak(a.R, 300) < 0.02 * peak(a.L, 300), 'panned fully left (the dry impulse passes through untouched at sample 100)');
  const fb = run(make('delaybank', { ...free, fb1: 0.5 }), imp);
  const t2 = 100 + 2 * Math.round(0.1 * SR);
  assert.ok(peak(fb.L, t2 - 50, t2 + 50) > 0.5 && peak(fb.L, t2 - 50, t2 + 50) < 0.9, 'feedback gives a second, quieter echo');
  assert.ok(peak(a.L, t2 - 50, t2 + 50) < 0.01, 'no echo without feedback');
  const two = run(make('delaybank', { ...free, level2: -6, pan2: 1, time2: 250 }), imp);
  assert.ok(peak(two.R, 100 + Math.round(0.25 * SR) - 3, 100 + Math.round(0.25 * SR) + 3) > 0.45, 'tap 2 echoes on the right at -6 dB');
  const syn = run(make('delaybank', { ...free, sync: 1, div1: 8 }, 120), imp);          // 1/4 note at 120 BPM = 0.5 s
  at = 300; for (let i = 300; i < syn.L.length; i++) if (Math.abs(syn.L[i]) > Math.abs(syn.L[at])) at = i;
  assert.ok(Math.abs(at - (100 + SR / 2)) <= 2, `1/4 at 120 BPM: ${at}`);
  const syn2 = run(make('delaybank', { ...free, sync: 1, div1: 8 }, 60), imp);
  at = 300; for (let i = 300; i < syn2.L.length; i++) if (Math.abs(syn2.L[i]) > Math.abs(syn2.L[at])) at = i;
  assert.ok(Math.abs(at - (100 + SR)) <= 2, `1/4 at 60 BPM: ${at}`);
  assert.ok(run(make('delaybank', { mix: 0 }), imp).L.every((v, i) => v === imp[i]), 'mix 0 is dry');
});

test('Pitcher: snaps a detuned voice to the nearest note of the scale, leaves in-tune notes alone, transposes, reports its latency', () => {
  const N = SR * 2;
  const shifted = (freq, params) => { const fx = make('pitcher', params); const out = run(fx, sine(freq, N, 0.5)); return { f: peakFreq(spectrum(out.L, SR + 3000)), out, fx }; };
  const near = (f, target, cents = 15) => Math.abs(1200 * Math.log2(f / target)) < cents;
  const a = shifted(450, { scale: 0, speed: 0, amount: 1 });                       // A4 + 39 cents, chromatic: snaps to A4
  assert.ok(near(a.f, 440), `450 Hz -> ${a.f.toFixed(1)} Hz (A4 = 440)`);
  const b = shifted(365, { scale: 1, key: 0, speed: 0, amount: 1 });               // F#4 - 22 cents; C major has F and G but no F#: F4 is nearer
  assert.ok(near(b.f, 349.23), `365 Hz in C major -> ${b.f.toFixed(1)} Hz (F4 = 349.2)`);
  const c = shifted(440, { scale: 1, key: 0, speed: 0.3, amount: 1 });
  assert.ok(near(c.f, 440, 6), `an in-tune A stays an A (${c.f.toFixed(1)} Hz)`);
  const d = shifted(450, { scale: 0, speed: 0, amount: 0 });
  assert.ok(near(d.f, 450, 6), 'amount 0 does not correct');
  const e = shifted(450, { scale: 0, speed: 0, amount: 0, transpose: 12 });
  assert.ok(near(e.f, 900, 8), `transpose +12 -> ${e.f.toFixed(1)} Hz`);
  const g = shifted(450, { scale: 3, key: 0, speed: 0, amount: 1 });               // C major pentatonic: C D E G A, so A is in the scale
  assert.ok(near(g.f, 440), 'pentatonic keeps A');
  const h = shifted(480, { scale: 3, key: 0, speed: 0, amount: 1 });               // B4 is not in the pentatonic scale: nearest are A4 (440) and C5 (523): 480 is B-ish -> A4 or C5
  assert.ok(near(h.f, 440, 15) || near(h.f, 523.25, 15), `out-of-scale pitch moves to a scale note (${h.f.toFixed(1)} Hz)`);
  // the corrected voice has a steady level (the grain cross-fade does not leave holes)
  const lv = []; for (let t = SR + 2000; t + 1000 < N; t += 1000) lv.push(rms(a.out.L, t, t + 1000));
  assert.ok(Math.min(...lv) > 0.5 * Math.max(...lv), 'steady level');
  // latency is reported and the dry path is aligned with it
  assert.equal(a.fx.latency, Math.round(Math.round(SR * 0.03) / 4) + 2);
  const x = sine(300, 6000, 0.4), dry = run(make('pitcher', { mix: 0 }), x);
  for (let i = 3000; i < 3100; i++) assert.ok(Math.abs(dry.L[i] - x[i - a.fx.latency]) < 1e-6, 'dry path delayed by the latency');
  // silence and noise: no detection, no blow-up
  assert.ok(peak(run(make('pitcher', {}), new Float32Array(SR / 2)).L) < 1e-6, 'silence stays silent');
  assert.ok(peak(run(make('pitcher', {}), noise(SR, 0.5)).L) < 2 && run(make('pitcher', {}), noise(SR, 0.5)).L.every(Number.isFinite), 'noise is bounded');
});
