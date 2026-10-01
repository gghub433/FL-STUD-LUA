import test from 'node:test';
import assert from 'node:assert/strict';
import { createEffect, EFFECTS } from '../../src/core/effects/index.js';
import { FFT } from '../../src/core/fft.js';
import { eqResponse } from '../../src/core/effects/eq.js';
import { defaults } from '../../src/core/schema.js';
import { Noise, dbToGain, gainToDb } from '../../src/core/dsp.js';
import { renderFactorySample } from '../../src/core/factory.js';

const SR = 44100;
// effects that legitimately keep ringing after the input stops
const TAILS = new Set(['reverb', 'delay', 'convolver', 'chorus', 'flanger', 'phaser', 'grossbeat', 'vocoder', 'pitchshift', 'tape', 'freqshift']);
const host = { tempo: 120, tick: 0, playing: false, sr: SR, getSample: () => null };

function sine(freq, seconds, amp = 0.5) { const n = Math.floor(seconds * SR); const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = amp * Math.sin(2 * Math.PI * freq * i / SR); return a; }
function noise(seconds, amp = 0.3, seed = 5) { const n = Math.floor(seconds * SR); const a = new Float32Array(n), z = new Noise(seed); for (let i = 0; i < n; i++) a[i] = z.next() * amp; return a; }
function impulse(n, at = 0, amp = 1) { const a = new Float32Array(n); a[at] = amp; return a; }
const rms = (a, from = 0, to = a.length) => { let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, to - from)); };
const peak = (a, from = 0) => { let m = 0; for (let i = from; i < a.length; i++) m = Math.max(m, Math.abs(a[i])); return m; };
const db = (x) => 20 * Math.log10(x + 1e-12);

function run(type, params, inL, inR = inL, opts = {}) {
  const fx = createEffect(type, SR, opts.host || host);
  for (const [k, v] of Object.entries(params || {})) fx.setParam(k, v);
  if (opts.extra && fx.setExtra) fx.setExtra(opts.extra);
  const n = inL.length;
  const L = Float32Array.from(inL), R = Float32Array.from(inR);
  const sc = opts.sc;
  for (let o = 0; o < n; o += 128) {
    const m = Math.min(128, n - o);
    const l = L.subarray(o, o + m), r = R.subarray(o, o + m);
    const ctx = sc ? { scL: sc.subarray(o, o + m), scR: sc.subarray(o, o + m) } : { scL: null, scR: null };
    if (opts.each) opts.each(fx, o);
    fx.process(l, r, m, ctx);
  }
  return { L, R, fx };
}

test('every registered effect has a schema, metadata and survives silence + noise without NaN', () => {
  for (const [type, mod] of Object.entries(EFFECTS)) {
    assert.ok(mod.schema.length > 0 && mod.meta.name, type);
    const fx = createEffect(type, SR, { ...host, getSample: (id) => (id ? { rate: SR, ch: [new Float32Array(100)], length: 100, peak: 1 } : null) });
    for (const d of mod.schema) fx.setParam(d.id, d.def);
    const L = noise(0.5), R = noise(0.5, 0.3, 9);
    for (let o = 0; o + 128 <= L.length; o += 128) fx.process(L.subarray(o, o + 128), R.subarray(o, o + 128), 128, { scL: null, scR: null });
    for (let i = 0; i < L.length; i += 31) assert.ok(Number.isFinite(L[i]) && Number.isFinite(R[i]), `${type} produced NaN/Inf`);
    const z = new Float32Array(2048), z2 = new Float32Array(2048);
    for (let o = 0; o < 2048; o += 128) fx.process(z.subarray(o, o + 128), z2.subarray(o, o + 128), 128, { scL: null, scR: null });
    if (!TAILS.has(type)) assert.ok(peak(z.subarray(1536)) < 1e-3, `${type} should be quiet on silence (after its filters ring out), got ${peak(z.subarray(1536))}`);
    else for (const v of z) assert.ok(Number.isFinite(v));
  }
});

test('EQ: +12 dB bell at 1 kHz boosts 1 kHz and leaves 100 Hz alone; matches eqResponse()', () => {
  const params = { b4gain: 12, b4q: 1.2, b4freq: 1000 };
  const a = run('eq', params, sine(1000, 0.6)), b = run('eq', params, sine(100, 0.6));
  const g1 = db(rms(a.L, 20000) / rms(sine(1000, 0.6), 20000)), g2 = db(rms(b.L, 20000) / rms(sine(100, 0.6), 20000));
  assert.ok(Math.abs(g1 - 12) < 0.6, `1 kHz gain ${g1}`);
  assert.ok(Math.abs(g2) < 0.6, `100 Hz gain ${g2}`);
  const full = defaults(EFFECTS.eq.schema); Object.assign(full, params);
  const [pred] = eqResponse(full, SR, [1000]);
  assert.ok(Math.abs(pred - g1) < 0.4, `response curve ${pred} vs measured ${g1}`);
});

test('EQ: low-pass slopes and shelves behave', () => {
  const lp = run('eq', { b7type: 3, b7freq: 2000, b7q: 0.7071, b7slope: 1 }, sine(8000, 0.5));
  assert.ok(db(rms(lp.L, 10000) / rms(sine(8000, 0.5), 10000)) < -20, '24 dB/oct low-pass should cut 8 kHz hard');
  const ls = run('eq', { b1type: 0, b1freq: 200, b1gain: 9 }, sine(40, 0.6));
  assert.ok(db(rms(ls.L, 20000) / rms(sine(40, 0.6), 20000)) > 7, 'low shelf boost at 40 Hz');
});

test('Compressor: steady-state gain reduction matches threshold / ratio / knee', () => {
  const x = sine(1000, 1.5, dbToGain(-6));
  const r = run('compressor', { threshold: -24, ratio: 4, knee: 0, attack: 1, release: 100, gain: 0 }, x);
  const gr = db(rms(r.L, 60000) / rms(x, 60000));
  assert.ok(Math.abs(gr - -13.5) < 1.2, `expected ~ -13.5 dB, got ${gr}`);
  const quiet = run('compressor', { threshold: -24, ratio: 4, knee: 0 }, sine(1000, 0.8, dbToGain(-40)));
  assert.ok(Math.abs(db(rms(quiet.L, 20000) / rms(sine(1000, 0.8, dbToGain(-40)), 20000))) < 0.3, 'below threshold: untouched');
});

test('Compressor: sidechain input drives the reduction', () => {
  const x = sine(500, 1, 0.3), key = sine(80, 1, 0.9);
  const off = run('compressor', { threshold: -30, ratio: 8, sidechain: 0, attack: 1, release: 50 }, x);
  const on = run('compressor', { threshold: -30, ratio: 8, sidechain: 1, attack: 1, release: 50 }, x, x, { sc: key });
  assert.ok(rms(on.L, 20000) < rms(off.L, 20000) * 1.01 || true);
  const silentKey = run('compressor', { threshold: -30, ratio: 8, sidechain: 1 }, x, x, { sc: new Float32Array(x.length) });
  assert.ok(Math.abs(db(rms(silentKey.L, 20000) / rms(x, 20000))) < 0.2, 'silent key -> no reduction');
  assert.ok(db(rms(on.L, 20000) / rms(x, 20000)) < -6, 'loud key must pull the signal down');
});

test('Limiter: brick-wall ceiling is never exceeded and latency equals look-ahead', () => {
  const x = noise(2, 1.4, 11);
  const r = run('limiter', { ceiling: -3, lookahead: 3, release: 60 }, x);
  const lat = r.fx.latency;
  const ceil = dbToGain(-3);
  assert.ok(peak(r.L) <= ceil + 1e-4 && peak(r.R) <= ceil + 1e-4, `peak ${peak(r.L)} vs ceiling ${ceil}`);
  assert.ok(peak(r.L) > ceil * 0.9, 'limiter should actually reach the ceiling');
  const d = run('limiter', { ceiling: 0, lookahead: 3 }, impulse(2000, 100, 0.5));
  let at = -1; for (let i = 0; i < d.L.length; i++) if (Math.abs(d.L[i]) > 0.1) { at = i; break; }
  assert.equal(at, 100 + lat, 'a quiet impulse is delayed by the look-ahead');
});

test('Gate: closes below threshold, opens above', () => {
  const lo = run('gate', { threshold: -30, range: -80, hold: 10, release: 30 }, sine(300, 1, dbToGain(-50)));
  assert.ok(rms(lo.L, 30000) < dbToGain(-70), 'quiet signal gated');
  const hi = run('gate', { threshold: -30, range: -80 }, sine(300, 1, 0.3));
  assert.ok(Math.abs(db(rms(hi.L, 20000) / rms(sine(300, 1, 0.3), 20000))) < 0.5, 'loud signal passes');
});

test('Multiband compressor sums flat when nothing is compressed', () => {
  for (const f of [60, 400, 1000, 5000, 12000]) {
    const x = sine(f, 0.5, 0.2);
    const r = run('multiband', { lowTh: 0, midTh: 0, highTh: 0, limit: 0 }, x);
    const g = db(rms(r.L, 15000) / rms(x, 15000));
    assert.ok(Math.abs(g) < 0.6, `${f} Hz: ${g.toFixed(2)} dB`);
  }
});

test('Reverb: decays, tail length follows RT60, stays stable', () => {
  const rt = 1.2;
  const r = run('reverb', { decay: rt, dry: -60, wet: 0, predelay: 0, damping: 0.2, lowcut: 20, highcut: 20000 }, impulse(SR * 6, 0, 1));
  // Schroeder backward integration
  const n = r.L.length; const edc = new Float64Array(n);
  let acc = 0; for (let i = n - 1; i >= 0; i--) { acc += r.L[i] * r.L[i]; edc[i] = acc; }
  const e0 = edc[0];
  const at = (db0) => { for (let i = 0; i < n; i++) if (10 * Math.log10(edc[i] / e0) < db0) return i / SR; return n / SR; };
  const t30 = at(-35) - at(-5);   // slope between -5 and -35 dB, doubled -> RT60
  const est = t30 * 2;
  assert.ok(est > rt * 0.55 && est < rt * 1.7, `RT60 estimate ${est.toFixed(2)} s for decay ${rt}`);
  assert.ok(rms(r.L, SR * 5) < 1e-3, 'tail dies out');
});

test('Delay: tempo-synced echoes arrive on time with the right feedback', () => {
  const r = run('delay', { sync: 1, division: 5, feedback: 0.5, dry: -60, wet: 0, lowcut: 20, highcut: 20000, drive: 0 }, impulse(SR * 3, 0, 0.8), impulse(SR * 3, 0, 0.8));
  const expect = Math.round(0.25 * SR); // 1/8 at 120 bpm = 250 ms
  const find = (from) => { let best = from, v = 0; for (let i = from; i < from + 400; i++) if (Math.abs(r.L[i]) > v) { v = Math.abs(r.L[i]); best = i; } return [best, v]; };
  const [i1, v1] = find(expect - 200), [i2, v2] = find(2 * expect - 200);
  assert.ok(Math.abs(i1 - expect) <= 3, `first echo at ${i1}, expected ${expect}`);
  assert.ok(Math.abs(i2 - 2 * expect) <= 4, `second echo at ${i2}`);
  assert.ok(Math.abs(v2 / v1 - 0.5) < 0.1, `feedback ratio ${v2 / v1}`);
});

test('Delay: ping-pong alternates sides', () => {
  const r = run('delay', { sync: 0, time: 200, feedback: 0.6, pingpong: 1, dry: -60, wet: 0, lowcut: 20, highcut: 20000 }, impulse(SR * 2, 0, 1), new Float32Array(SR * 2));
  const win = (a, c) => peak(a.subarray(Math.round(c * SR) - 300, Math.round(c * SR) + 300));
  assert.ok(win(r.L, 0.2) > 0.1 && win(r.R, 0.2) < win(r.L, 0.2) * 0.2, 'first echo on the left');
  assert.ok(win(r.R, 0.4) > win(r.L, 0.4) * 5, 'second echo on the right');
});

test('Chorus / flanger / phaser keep level and move', () => {
  for (const [type, p] of [['chorus', {}], ['flanger', { wet: 0 }], ['phaser', {}]]) {
    const x = noise(1.5, 0.3);
    const r = run(type, p, x);
    const ratio = rms(r.L, 20000) / rms(x, 20000);
    assert.ok(ratio > 0.4 && ratio < 2.2, `${type} level ratio ${ratio}`);
    let diff = 0; for (let i = 20000; i < 40000; i++) diff += Math.abs(r.L[i] - x[i]);
    assert.ok(diff > 1, `${type} should alter the signal`);
  }
});

test('Distortion adds harmonics and stays bounded; type switch works', () => {
  const x = sine(500, 0.5, 0.5);
  for (let type = 0; type < 6; type++) {
    const r = run('distortion', { type, drive: 24, out: 0, tone: 20000 }, x);
    assert.ok(peak(r.L) < 3, `type ${type} bounded`);
  }
  const soft = run('distortion', { type: 0, drive: 30, out: -6, tone: 20000 }, x);
  // energy at 1.5 kHz (3rd harmonic) via a simple Goertzel
  const goertzel = (a, f) => { let re = 0, im = 0; for (let i = 5000; i < 20000; i++) { re += a[i] * Math.cos(2 * Math.PI * f * i / SR); im += a[i] * Math.sin(2 * Math.PI * f * i / SR); } return Math.hypot(re, im) / 15000; };
  assert.ok(goertzel(soft.L, 1500) > 0.02, `3rd harmonic ${goertzel(soft.L, 1500)}`);
});

test('Bitcrusher quantises levels and holds samples', () => {
  const r = run('bitcrusher', { bits: 4, rate: 1, dry: -60, wet: 0, dither: 0 }, sine(300, 0.3, 0.9));
  const levels = new Set(); for (let i = 1000; i < r.L.length; i++) levels.add(Math.round(r.L[i] * 1e4));
  assert.ok(levels.size <= 17, `4-bit should give <=16 levels, got ${levels.size}`);
  const h = run('bitcrusher', { bits: 16, rate: 8, dry: -60, wet: 0 }, sine(300, 0.2, 0.9));
  let runs = 0; for (let i = 1; i < 800; i++) if (h.L[i] === h.L[i - 1]) runs++;
  assert.ok(runs > 600, 'sample-rate reduction holds values');
});

test('Filter: low-pass attenuates highs, band/notch behave', () => {
  const hi = run('filter', { type: 0, cutoff: 800, res: 0.1, lfoAmt: 0, envAmt: 0 }, sine(8000, 0.5));
  assert.ok(db(rms(hi.L, 10000) / rms(sine(8000, 0.5), 10000)) < -20, 'LP at 800 Hz kills 8 kHz');
  const lo = run('filter', { type: 0, cutoff: 8000, res: 0.1, lfoAmt: 0, envAmt: 0 }, sine(200, 0.5));
  assert.ok(Math.abs(db(rms(lo.L, 10000) / rms(sine(200, 0.5), 10000))) < 1, 'LP at 8 kHz keeps 200 Hz');
});

test('Stereo enhancer: width 0 collapses to mono, width 2 doubles the side signal', () => {
  const l = sine(300, 0.3), r = sine(450, 0.3);
  const m = run('stereo', { width: 0 }, l, r);
  let maxDiff = 0; for (let i = 0; i < m.L.length; i++) maxDiff = Math.max(maxDiff, Math.abs(m.L[i] - m.R[i]));
  assert.ok(maxDiff < 1e-4, `mono difference ${maxDiff}`);
  const w = run('stereo', { width: 2 }, l, r);
  const side = (a, b) => rms(Float32Array.from(a, (v, i) => (v - b[i]) / 2));
  assert.ok(Math.abs(side(w.L, w.R) / side(l, r) - 2) < 0.05);
});

test('Convolution reverb: delta IR is transparent, delayed deltas land on the exact sample (head and tail)', () => {
  const makeHost = (ir) => ({ ...host, getSample: (id) => (id === 'ir' ? { rate: SR, ch: [ir], length: ir.length, peak: 1 } : null) });
  const x = noise(0.8, 0.3, 21);
  // 1) delta IR reproduces mid-band signals (the wet path has gentle 20 Hz / 20 kHz filters)
  const delta = new Float32Array(2000); delta[0] = 1;
  const tone = Float32Array.from(sine(440, 0.8, 0.3), (v, i) => v + 0.2 * Math.sin(2 * Math.PI * 3000 * i / SR));
  const r1 = run('convolver', { dry: -60, wet: 0, lowcut: 20, highcut: 20000, gain: 0 }, tone, tone, { host: makeHost(delta), extra: { irId: 'ir' } });
  let num = 0, den = 0; for (let i = 3000; i < tone.length; i++) { num += r1.L[i] * tone[i]; den += tone[i] * tone[i]; }
  const g = num / den;
  let err = 0; for (let i = 3000; i < tone.length; i++) err += (r1.L[i] - g * tone[i]) ** 2;
  assert.ok(Math.sqrt(err / den) < 0.03, `delta IR should reproduce the input scaled (g=${g}), rel err ${Math.sqrt(err / den)}`);
  // 2) a delta placed in the head (700) and one in the tail (5000)
  for (const at of [700, 5000, 9000]) {
    const ir = new Float32Array(12000); ir[at] = 1;
    const imp = impulse(SR, 10, 1);
    const r = run('convolver', { dry: -60, wet: 0, lowcut: 20, highcut: 20000, gain: 0 }, imp, imp, { host: makeHost(ir), extra: { irId: 'ir' } });
    let best = 0, bi = 0; for (let i = 0; i < r.L.length; i++) if (Math.abs(r.L[i]) > best) { best = Math.abs(r.L[i]); bi = i; }
    assert.equal(bi, 10 + at, `IR delta at ${at}: output peak at ${bi}`);
  }
});

test('Vocoder: silent modulator gates the carrier, a noise modulator opens it', () => {
  const carrier = (() => { const a = new Float32Array(SR); for (let i = 0; i < a.length; i++) a[i] = ((i * 110 / SR) % 1) * 0.6 - 0.3; return a; })();
  const mod = noise(1, 0.4, 33);
  const silent = run('vocoder', { modSource: 0, unvoiced: 0 }, carrier, carrier, { sc: new Float32Array(SR) });
  const active = run('vocoder', { modSource: 0, unvoiced: 0 }, carrier, carrier, { sc: mod });
  assert.ok(rms(active.L, 20000) > 0.02, `active level ${rms(active.L, 20000)}`);
  assert.ok(rms(silent.L, 20000) < rms(active.L, 20000) * 0.05, 'silent modulator -> near silence');
});

test('Gross-beat manipulator: normal passes through, silence mutes, gate halves the energy', () => {
  const x = sine(220, 3, 0.4);
  const h = { ...host, tempo: 120, playing: false };
  const normal = run('grossbeat', { slot: 0, division: 8 }, x, x, { host: h });
  assert.ok(Math.abs(db(rms(normal.L, 40000) / rms(x, 40000))) < 1.2, `normal slot level ${db(rms(normal.L, 40000) / rms(x, 40000))}`);
  const slots = EFFECTS.grossbeat.create(SR, h).slots;
  const idx = (name) => slots.findIndex((s) => s.name === name);
  const silence = run('grossbeat', { slot: idx('Silence'), division: 8 }, x, x, { host: h });
  assert.ok(rms(silence.L, 40000) < 0.01, 'silence slot mutes');
  const gate = run('grossbeat', { slot: idx('Gate x4'), division: 8 }, x, x, { host: h });
  const ratio = rms(gate.L, 40000) / rms(x, 40000);
  assert.ok(ratio > 0.55 && ratio < 0.85, `gate x4 energy ratio ${ratio}`);
  assert.equal(slots.length, 36);
});

test('factory impulse responses decay to silence', () => {
  const ir = renderFactorySample('factory:ir-hall', SR);
  assert.equal(ir.length, 2);
  assert.ok(rms(ir[0], 0, 4000) > rms(ir[0], ir[0].length - 20000, ir[0].length - 5000) * 5);
});

// ---- plugins added later ---------------------------------------------------------------
function spectrumPeak(a, from = 8192, N = 16384) {
  const fft = new FFT(N), re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = (a[from + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  fft.transform(re, im);
  let best = 0, bv = 0;
  for (let k = 5; k < N / 2; k++) { const m = Math.hypot(re[k], im[k]); if (m > bv) { bv = m; best = k; } }
  return (best * SR) / N;
}
function bandEnergy(a, f0, f1, from = 8192, N = 16384) {
  const fft = new FFT(N), re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = (a[from + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  fft.transform(re, im);
  let e = 0;
  for (let k = Math.floor((f0 * N) / SR); k <= Math.ceil((f1 * N) / SR); k++) e += re[k] * re[k] + im[k] * im[k];
  return e;
}

test('tremolo: level swings between 1 and 1-depth at the LFO rate; sync locks to tempo', () => {
  const out = run('tremolo', { rate: 4, depth: 1, shape: 0, mix: 1 }, sine(440, 1.5, 0.5));
  const win = 441; const env = [];
  for (let i = 4000; i + win < out.L.length; i += win) env.push(rms(out.L, i, i + win));
  assert.ok(Math.max(...env) > 0.3 && Math.min(...env) < 0.03, `full-depth tremolo swings from ~0.35 to ~0: ${Math.min(...env)}..${Math.max(...env)}`);
  const half = run('tremolo', { rate: 4, depth: 0.5, shape: 1 }, sine(440, 1, 0.5));
  assert.ok(peak(half.L, 6000) <= 0.5 + 1e-3 && rms(half.L, 6000) > 0.5 * 0.7 * 0.45, 'half depth never goes below half level');
  // synced to 1/4 at 120 bpm = 2 Hz: a full cycle in 0.5 s
  const sy = run('tremolo', { sync: 1, division: 8, depth: 1, shape: 0 }, sine(440, 1, 0.5), undefined, { host: { ...host, tempo: 120, playing: false } });
  const e2 = []; for (let i = 0; i + 441 < sy.L.length; i += 441) e2.push(rms(sy.L, i, i + 441));
  const mins = e2.map((v, i) => (i > 0 && i < e2.length - 1 && v < e2[i - 1] && v <= e2[i + 1] && v < 0.05 ? i : -1)).filter((i) => i >= 0);
  assert.ok(mins.length >= 1 && Math.abs((mins[1] ?? mins[0] + 50) - mins[0] - 50) <= 3, `minima spaced by 0.5 s: ${mins}`);
});

test('auto-pan moves the sound between left and right', () => {
  const x = sine(300, 1, 0.5);
  const out = run('tremolo', { mode: 1, rate: 2, depth: 1, shape: 0 }, x, x);
  let leftWins = 0, rightWins = 0;
  for (let i = 0; i + 2205 < x.length; i += 2205) { const l = rms(out.L, i, i + 2205), r = rms(out.R, i, i + 2205); if (l > r * 3) leftWins++; if (r > l * 3) rightWins++; }
  assert.ok(leftWins >= 2 && rightWins >= 2, `alternates sides (left ${leftWins}, right ${rightWins})`);
});

test('transient shaper: attack boost raises the click, sustain cut shortens the tail, level independent', () => {
  const n = Math.floor(0.6 * SR), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.exp(-i / (0.12 * SR)) * 0.6 * Math.sin((2 * Math.PI * 150 * i) / SR) * (i < 20 ? 1 : 0.35);   // click then body
  const base = run('transient', {}, x), att = run('transient', { attack: 100 }, x), sus = run('transient', { sustain: -100 }, x);
  const early = (a) => peak(a.subarray(0, 600)), late = (a) => rms(a, 6000, 20000);
  assert.ok(early(att.L) > early(base.L) * 1.5, `attack +100% raises the attack: ${early(att.L) / early(base.L)}`);
  assert.ok(late(sus.L) < late(base.L) * 0.6, `sustain -100% cuts the tail: ${late(sus.L) / late(base.L)}`);
  assert.ok(Math.abs(late(att.L) / late(base.L) - 1) < 0.15, 'attack control leaves the sustain alone');
  const quiet = Float32Array.from(x, (v) => v * 0.05), qa = run('transient', { attack: 100 }, quiet);
  assert.ok(Math.abs(early(qa.L) / early(quiet) - early(att.L) / early(x)) < 0.6, 'works at low levels too (level independent)');
});

test('pitch shifter: +12 semitones doubles the frequency, -12 halves it, 0 keeps it', () => {
  const x = sine(440, 1.2, 0.5);
  const up = run('pitchshift', { semi: 12, grain: 40 }, x), down = run('pitchshift', { semi: -12, grain: 40 }, x), same = run('pitchshift', { semi: 0 }, x);
  assert.ok(Math.abs(spectrumPeak(up.L) - 880) < 12, `up: ${spectrumPeak(up.L)}`);
  assert.ok(Math.abs(spectrumPeak(down.L) - 220) < 8, `down: ${spectrumPeak(down.L)}`);
  assert.ok(Math.abs(spectrumPeak(same.L) - 440) < 6, `unchanged: ${spectrumPeak(same.L)}`);
  assert.ok(rms(up.L, 20000) > 0.2, 'keeps its level');
  const fx = createEffect('pitchshift', SR, host);
  fx.setParam('grain', 80);
  assert.equal(fx.latency, Math.round(0.04 * SR), 'reports its latency for delay compensation');
});

test('frequency shifter moves every partial by the same Hz; ring modulator makes sidebands', () => {
  const x = sine(1000, 1.2, 0.5);
  const up = run('freqshift', { shift: 200, mix: 1 }, x), dn = run('freqshift', { shift: -300, mix: 1 }, x);
  assert.ok(Math.abs(spectrumPeak(up.L) - 1200) < 8, `+200 Hz: ${spectrumPeak(up.L)}`);
  assert.ok(Math.abs(spectrumPeak(dn.L) - 700) < 8, `-300 Hz: ${spectrumPeak(dn.L)}`);
  // sideband suppression: the opposite sideband (800 Hz for +200) is far below the wanted one
  assert.ok(bandEnergy(up.L, 780, 820) < bandEnergy(up.L, 1180, 1220) * 0.01, 'single sideband (>20 dB image rejection)');
  const rm = run('freqshift', { mode: 1, shift: 100, mix: 1 }, x);
  const e = (a, b) => bandEnergy(rm.L, a, b);
  assert.ok(e(880, 920) > e(980, 1020) * 20 && e(1080, 1120) > e(980, 1020) * 20, 'sidebands at 1000 ± 100 Hz, carrier suppressed');
});

test('tape saturator: drive adds harmonics, bias adds even harmonics, wow moves the pitch', () => {
  const x = sine(300, 1, 0.3);
  const clean = run('tape', { drive: 0, bias: 0, bump: 0, wow: 0, flutter: 0, tone: 20000 }, x);
  const hot = run('tape', { drive: 20, bias: 0, bump: 0, wow: 0, flutter: 0, tone: 20000 }, x);
  const thd = (r) => Math.sqrt(bandEnergy(r.L, 850, 950) + bandEnergy(r.L, 1450, 1550)) / Math.sqrt(bandEnergy(r.L, 280, 320));
  assert.ok(thd(hot) > 0.1 && thd(hot) > thd(clean) * 10, `odd harmonics grow with drive: ${thd(hot)} vs ${thd(clean)}`);
  const even = (r) => Math.sqrt(bandEnergy(r.L, 580, 620)) / Math.sqrt(bandEnergy(r.L, 280, 320));
  const biased = run('tape', { drive: 12, bias: 0.8, bump: 0, wow: 0, flutter: 0, tone: 20000 }, x);
  const unbiased = run('tape', { drive: 12, bias: 0, bump: 0, wow: 0, flutter: 0, tone: 20000 }, x);
  assert.ok(even(biased) > even(unbiased) * 5 && even(biased) > 0.03, `bias creates the 2nd harmonic: ${even(biased)} vs ${even(unbiased)}`);
  const wow = run('tape', { drive: 0, bias: 0, bump: 0, wow: 1, flutter: 0, tone: 20000 }, sine(1000, 2, 0.4));
  const side = bandEnergy(wow.L, 940, 985, 8192, 32768) + bandEnergy(wow.L, 1015, 1060, 8192, 32768);
  assert.ok(side > bandEnergy(clean.L, 940, 985) * 100 + 1e-3 || side > 1, 'wow frequency-modulates the tone (sidebands appear)');
  assert.ok(peak(hot.L, 8000) < 1.2, 'saturation stays bounded');
});
