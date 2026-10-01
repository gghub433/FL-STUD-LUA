import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstrument, INSTRUMENTS } from '../../src/core/instruments/index.js';
import { FFT } from '../../src/core/fft.js';
import { detectSlices, evenSlices, estimateLoop, slicesToNotes } from '../../src/core/slice-detect.js';
import { defaultPads } from '../../src/core/instruments/fpc.js';
import { algoMatrix, ALGOS } from '../../src/core/instruments/fmsynth.js';
import { createProject, createChannel, createNote, normalize } from '../../src/core/project.js';
import { renderOffline } from '../../src/core/offline.js';
import { defaults } from '../../src/core/schema.js';

const SR = 44100;
const host = (samples = {}) => ({ tempo: 120, tick: 0, playing: false, sr: SR, getSample: (id) => samples[id] || null });
const rms = (a, f = 0, t = a.length) => { let s = 0; for (let i = f; i < t; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, t - f)); };
const peak = (a) => { let m = 0; for (const v of a) m = Math.max(m, Math.abs(v)); return m; };

function render(inst, n, events = []) { // events: [{at, fn}]
  const L = new Float32Array(n), R = new Float32Array(n);
  const ev = [...events].sort((a, b) => a.at - b.at);
  let pos = 0;
  for (const e of ev) { if (e.at > pos) { inst.process(L, R, pos, e.at); pos = e.at; } e.fn(); }
  if (pos < n) inst.process(L, R, pos, n);
  return { L, R };
}
function peakFreq(a, from = 4096) {
  const N = 16384, fft = new FFT(N), re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = (a[from + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  fft.transform(re, im);
  let best = 0, bv = 0;
  for (let k = 5; k < N / 2; k++) { const m = Math.hypot(re[k], im[k]); if (m > bv) { bv = m; best = k; } }
  return (best * SR) / N;
}
function centroid(a, from = 4096) {
  const N = 8192, fft = new FFT(N), re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = (a[from + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  fft.transform(re, im);
  let num = 0, den = 0;
  for (let k = 1; k < N / 2; k++) { const m = Math.hypot(re[k], im[k]); num += m * k; den += m; }
  return (num / den * SR) / N;
}
const on = (inst, key, extra = {}) => () => inst.noteOn({ key, vel: 1, pan: 0, fine: 0, rel: 64, ...extra });
const off = (inst, key) => () => inst.noteOff(key);

test('every instrument has schema + meta, runs headless without NaN', () => {
  for (const [type, mod] of Object.entries(INSTRUMENTS)) {
    assert.ok(mod.schema.length && mod.meta.name, type);
    const inst = createInstrument(type, SR, host());
    for (const d of mod.schema) inst.setParam(d.id, d.def);
    if (inst.setData) inst.setData(createChannel(createProject(), type));
    const r = render(inst, 8192, [{ at: 0, fn: on(inst, 60) }, { at: 3000, fn: off(inst, 60) }]);
    for (let i = 0; i < r.L.length; i += 17) assert.ok(Number.isFinite(r.L[i]) && Number.isFinite(r.R[i]), `${type} NaN`);
  }
});

test('SubSynth: oscillator pitch is exact (A4 = 440 Hz) and octave/semitone offsets work', () => {
  const s = createInstrument('subsynth', SR, host());
  s.setParam('o2level', 0); s.setParam('o1wave', 3); s.setParam('ftype', 0); s.setParam('cutoff', 20000); s.setParam('keytrack', 0); s.setParam('fenv', 0);
  const r = render(s, 30000, [{ at: 0, fn: on(s, 69) }]);
  assert.ok(Math.abs(peakFreq(r.L) - 440) < 6, `peak at ${peakFreq(r.L)}`);
  const s2 = createInstrument('subsynth', SR, host());
  for (const [k, v] of Object.entries({ o2level: 0, o1wave: 3, ftype: 0, cutoff: 20000, keytrack: 0, fenv: 0, o1oct: 1, o1semi: 7 })) s2.setParam(k, v);
  const r2 = render(s2, 30000, [{ at: 0, fn: on(s2, 69) }]);
  assert.ok(Math.abs(peakFreq(r2.L) - 440 * Math.pow(2, 19 / 12)) < 12, `octave+fifth: ${peakFreq(r2.L)}`);
});

test('SubSynth: filter removes highs; envelope releases; unison widens the image', () => {
  const mk = (cut, uni = 1) => { const s = createInstrument('subsynth', SR, host()); for (const [k, v] of Object.entries({ o1wave: 0, o2level: 0, ftype: 1, cutoff: cut, keytrack: 0, fenv: 0, res: 0, uni, unidet: 30, unispread: 1, as: 1, ar: 0.05 })) s.setParam(k, v); return s; };
  const bright = render(mk(18000), 24000, [{ at: 0, fn: on(mk(18000), 60) }]);
  const s1 = mk(18000), s2 = mk(500);
  const a = render(s1, 24000, [{ at: 0, fn: on(s1, 60) }]), b = render(s2, 24000, [{ at: 0, fn: on(s2, 60) }]);
  assert.ok(centroid(b.L) < centroid(a.L) * 0.5, `closed filter should be darker: ${centroid(b.L)} vs ${centroid(a.L)}`);
  const s3 = mk(18000);
  const c = render(s3, 40000, [{ at: 0, fn: on(s3, 60) }, { at: 12000, fn: off(s3, 60) }]);
  assert.ok(rms(c.L, 8000, 11000) > 0.02 && rms(c.L, 30000, 40000) < 1e-4, 'note decays after release');
  const s4 = mk(18000, 6), s5 = mk(18000, 1);
  const w = render(s4, 20000, [{ at: 0, fn: on(s4, 60) }]), m = render(s5, 20000, [{ at: 0, fn: on(s5, 60) }]);
  const side = (r) => rms(Float32Array.from(r.L.subarray(4000, 18000), (v, i) => v - r.R[4000 + i]));
  assert.ok(side(w) > 0.02 && side(m) < 0.005, `unison spread side energy ${side(w)} vs mono ${side(m)}`);
  void bright;
});

test('SubSynth: mono + legato glides to the new key without retriggering', () => {
  const s = createInstrument('subsynth', SR, host());
  for (const [k, v] of Object.entries({ o1wave: 3, o2level: 0, ftype: 0, cutoff: 20000, keytrack: 0, fenv: 0, mono: 1, legato: 1, glide: 200, as: 1 })) s.setParam(k, v);
  const r = render(s, 60000, [{ at: 0, fn: on(s, 60) }, { at: 20000, fn: on(s, 72) }]);
  const f1 = peakFreq(r.L, 8000), f2 = peakFreq(r.L, 60000 - 16384 - 100);
  assert.ok(Math.abs(f1 - 261.6) < 8, `first note ${f1}`);
  assert.ok(Math.abs(f2 - 523.3) < 16, `glided to the octave: ${f2}`);
  assert.equal(s.voices.filter((v) => v.alive).length, 1);
});

test('FM synth: modulation adds sidebands; ratio sets pitch; algorithms are well formed', () => {
  const mk = (idx) => { const f = createInstrument('fm', SR, host()); for (const [k, v] of Object.entries({ algo: 0, index: idx, att1: 0.001, att2: 0.001, sus1: 1, sus2: 1, lvl1: 0.9, lvl2: 0.9, fb6: 0, fb1: 0, ratio1: 1, ratio2: 2 })) f.setParam(k, v); return f; };
  // algorithm 1 is the serial chain; only op 1 is a carrier
  const a = mk(0), b = mk(1.6);
  const ra = render(a, 30000, [{ at: 0, fn: on(a, 69) }]), rb = render(b, 30000, [{ at: 0, fn: on(b, 69) }]);
  assert.ok(Math.abs(peakFreq(ra.L) - 440) < 6, `index 0 -> pure carrier ${peakFreq(ra.L)}`);
  assert.ok(centroid(rb.L) > centroid(ra.L) * 1.5, `modulation should brighten: ${centroid(rb.L)} vs ${centroid(ra.L)}`);
  for (let i = 0; i < ALGOS.length; i++) { const { m, out } = algoMatrix(i); assert.ok(out.some((x) => x > 0), `algo ${i} needs a carrier`); assert.ok(m.every((row, r) => row[r] === 0), 'no self loops in presets'); }
  // custom matrix: op2 modulating op1 should equal algorithm "two ops" with the same settings
  const c = createInstrument('fm', SR, host());
  for (const [k, v] of Object.entries({ algo: ALGOS.length, mod12: 1, out1: 1, index: 1.6, att1: 0.001, att2: 0.001, sus1: 1, sus2: 1, lvl1: 0.9, lvl2: 0.9, fb6: 0, ratio1: 1, ratio2: 2 })) c.setParam(k, v);
  const rc = render(c, 30000, [{ at: 0, fn: on(c, 69) }]);
  assert.ok(centroid(rc.L) > centroid(ra.L) * 1.5, 'custom matrix modulates');
});

test('FPC: pads trigger by note, layer, choke and mute', () => {
  const click = (f) => { const a = new Float32Array(4000); for (let i = 0; i < a.length; i++) a[i] = Math.sin(2 * Math.PI * f * i / SR) * Math.exp(-i / 800); return { rate: SR, ch: [a], length: a.length, peak: 1 }; };
  const samples = { a: click(300), b: click(900) };
  const f = createInstrument('fpc', SR, host(samples));
  const pads = defaultPads();
  pads[0].layers = [{ sample: { id: 'a' }, vol: 1, pan: 0, pitch: 0 }];
  pads[1].layers = [{ sample: { id: 'a' }, vol: 1, pan: 0, pitch: 0 }, { sample: { id: 'b' }, vol: 1, pan: 0, pitch: 0 }];
  pads[2].layers = [{ sample: { id: 'b' }, vol: 1, pan: 0, pitch: 0 }]; pads[2].choke = 1;
  pads[3].layers = [{ sample: { id: 'a' }, vol: 1, pan: 0, pitch: 0 }]; pads[3].choke = 1;
  pads[4].layers = [{ sample: { id: 'a' }, vol: 1, pan: 0, pitch: 0 }]; pads[4].mute = 1;
  f.setData({ pads });
  const one = render(f, 4000, [{ at: 0, fn: on(f, 60) }]);
  const two = render(f, 4000, [{ at: 0, fn: on(f, 61) }]);
  assert.ok(peak(one.L) > 0.1, 'pad 1 plays');
  assert.ok(rms(two.L, 0, 2000) > rms(one.L, 0, 2000) * 1.1, 'two layers are louder than one');
  // choke: long ringing samples at different pitches so the first pad's tail is easy to isolate
  const ring = (fq) => { const a = new Float32Array(30000); for (let i = 0; i < a.length; i++) a[i] = Math.sin(2 * Math.PI * fq * i / SR) * Math.exp(-i / 20000); return { rate: SR, ch: [a], length: a.length, peak: 1 }; };
  const g = createInstrument('fpc', SR, host({ lo: ring(300), hi: ring(900) }));
  const pp = defaultPads();
  pp[2].layers = [{ sample: { id: 'hi' }, vol: 1, pan: 0, pitch: 0 }]; pp[2].choke = 1;
  pp[3].layers = [{ sample: { id: 'lo' }, vol: 1, pan: 0, pitch: 0 }]; pp[3].choke = 1;
  g.setData({ pads: pp });
  const tone = (a, fq, from, to) => { let re = 0, im = 0; for (let i = from; i < to; i++) { re += a[i] * Math.cos(2 * Math.PI * fq * i / SR); im += a[i] * Math.sin(2 * Math.PI * fq * i / SR); } return Math.hypot(re, im) / (to - from); };
  const choked = render(g, 20000, [{ at: 0, fn: on(g, 62) }, { at: 800, fn: on(g, 63) }]);
  pp[3].choke = 0; g.setData({ pads: pp });
  const free = render(g, 20000, [{ at: 0, fn: on(g, 62) }, { at: 800, fn: on(g, 63) }]);
  assert.ok(tone(free.L, 900, 6000, 16000) > 0.05, 'without a shared group the first pad keeps ringing');
  assert.ok(tone(choked.L, 900, 6000, 16000) < 0.005, 'a pad in the same choke group cuts the earlier one');
  assert.ok(peak(render(f, 4000, [{ at: 0, fn: on(f, 64) }]).L) < 1e-6, 'muted pad is silent');
});

test('Slicer: detects transients, plays a single slice, estimates loop tempo', () => {
  // 4 clicks at 0, 0.5, 1.0, 1.5 s (2 s loop => 120 bpm over 4 beats)
  const n = SR * 2, a = new Float32Array(n);
  for (const t of [0, 0.5, 1.0, 1.5]) { const s = Math.floor(t * SR); for (let i = 0; i < 3000; i++) a[s + i] += Math.sin(i * 0.4) * Math.exp(-i / 500) * 0.8; }
  const slices = detectSlices(a, SR, { sensitivity: 0.6 });
  assert.equal(slices.length, 4, `slices ${slices}`);
  [0, 0.5, 1, 1.5].forEach((t, i) => assert.ok(Math.abs(slices[i] / SR - t) < 0.025, `slice ${i} at ${slices[i] / SR}`));
  const est = estimateLoop(n, SR);
  assert.ok(Math.abs(est.bpm - 120) < 1 && est.bars === 1, JSON.stringify(est));
  assert.deepEqual(evenSlices(1000, 4), [0, 250, 500, 750]);
  const notes = slicesToNotes(slices, n, SR, 120, 60, 100, 24);
  assert.deepEqual(notes.map((x) => x.s), [0, 96, 192, 288], 'quantized to the step grid');
  assert.ok(notes[0].k === 60 && notes[3].k === 63 && notes[0].l === 96);
  const sl = createInstrument('slicer', SR, host({ loop: { rate: SR, ch: [a], length: n, peak: 1 } }));
  sl.setData({ sample: { id: 'loop' }, slices, loopBpm: 120 });
  sl.setParam('tempoSync', 0); sl.setParam('mono', 0);
  const r = render(sl, SR, [{ at: 0, fn: on(sl, 62) }]);                 // third slice only
  assert.ok(peak(r.L) > 0.1 && rms(r.L, 12000, 20000) < 1e-3, 'one slice plays and stops at the next');
});

test('project model round-trips the new channel types', () => {
  const p = createProject();
  const fpc = createChannel(p, 'fpc'); fpc.pads[0].layers = [{ sample: { id: 'factory:clap', name: 'Clap' }, vol: 1, pan: 0, pitch: 0, start: 0 }]; fpc.pads[0].note = 61;
  const sl = createChannel(p, 'slicer', { sample: { id: 'x', name: 'x' }, slices: [0, 100, 250], loopBpm: 132 });
  p.channels.push(fpc, sl, createChannel(p, 'subsynth'), createChannel(p, 'fm'), createChannel(p, 'drums'));
  const back = normalize(JSON.parse(JSON.stringify(p)));
  assert.equal(back.channels[0].pads.length, 64);
  assert.equal(back.channels[0].pads[0].note, 61);
  assert.equal(back.channels[0].pads[0].layers[0].sample.id, 'factory:clap');
  assert.deepEqual(back.channels[1].slices, [0, 100, 250]);
  assert.equal(back.channels[1].loopBpm, 132);
  assert.equal(back.channels.length, 5);
});

test('synth channels play through the full engine (pattern notes)', () => {
  const p = createProject(); p.tempo = 120;
  for (const type of ['subsynth', 'fm']) {
    const ch = createChannel(p, type); p.channels.push(ch);
    p.patterns[1].notes[ch.id] = [createNote(p, 0, 96, 60, 110), createNote(p, 96, 96, 67, 110)];
  }
  const r = renderOffline(p, new Map(), { sampleRate: SR, mode: 'pat', tail: 0.5 });
  assert.ok(peak(r.left) > 0.05 && peak(r.right) > 0.05, `peak ${peak(r.left)}`);
});

// ---- Pluck / Organ / Wavetable -------------------------------------------------------------
const ev = (key, vel = 0.9, extra = {}) => ({ key, vel, pan: 0, rel: 64, fine: 0, mx: 128, my: 128, slide: 0, len: 0, nid: 0, ...extra });
const mkInst = (type, params = {}) => { const i = createInstrument(type, SR, host()); for (const [k, v] of Object.entries(params)) i.setParam(k, v); return i; };
const hz = (key) => 440 * Math.pow(2, (key - 69) / 12);

test('every registered instrument has schema + meta and renders finite, bounded audio for notes across the range', () => {
  for (const [type, mod] of Object.entries(INSTRUMENTS)) {
    assert.ok(mod.schema.length && mod.meta.name, type);
    if (['sampler', 'fpc', 'slicer', 'controller'].includes(type)) continue;          // need samples / make no sound; covered elsewhere
    const inst = mkInst(type);
    for (const k of [24, 60, 96, 120]) {
      const { L, R } = render(inst, 8192, [{ at: 0, fn: () => inst.noteOn(ev(k)) }, { at: 5000, fn: () => inst.noteOff(k) }]);
      for (let i = 0; i < L.length; i += 13) assert.ok(Number.isFinite(L[i]) && Number.isFinite(R[i]), `${type} key ${k}: NaN`);
      assert.ok(peak(L) < 4 && peak(L) > 0, `${type} key ${k}: peak ${peak(L)}`);
    }
  }
});

// fundamental by autocorrelation with parabolic refinement (spectral peaks pick a strong harmonic on plucked strings)
function f0Auto(a, from, len, fmin, fmax) {
  const lagMin = Math.floor(SR / fmax), lagMax = Math.ceil(SR / fmin);
  const r = (lag) => { let s = 0; for (let i = 0; i < len; i++) s += a[from + i] * a[from + i + lag]; return s; };
  let best = lagMin, bv = -Infinity; const vals = new Map();
  for (let lag = lagMin; lag <= lagMax; lag++) { const v = r(lag); vals.set(lag, v); if (v > bv) { bv = v; best = lag; } }
  const y0 = vals.get(best - 1) ?? bv, y2 = vals.get(best + 1) ?? bv, d = y0 - 2 * bv + y2;
  const off = d !== 0 ? (0.5 * (y0 - y2)) / d : 0;
  return SR / (best + off);
}

test('pluck: pitch is accurate over the range, decay and damping do what they say, note-off mutes', () => {
  for (const k of [36, 48, 60, 72, 84, 96]) {
    const i = mkInst('pluck', { damping: 0.2, width: 0 });
    const { L } = render(i, 20000, [{ at: 0, fn: () => i.noteOn(ev(k)) }]);
    const want = hz(k), f = f0Auto(L, 3000, 4096, want * 0.7, want * 1.4);
    assert.ok(Math.abs(Math.log2(f / want)) * 1200 < 8, `key ${k}: ${f.toFixed(2)} Hz vs ${want.toFixed(2)} Hz (${(Math.log2(f / want) * 1200).toFixed(1)} cents)`);
  }
  const short = mkInst('pluck', { decay: 0.3 }), long = mkInst('pluck', { decay: 6 });
  const a = render(short, 44100, [{ at: 0, fn: () => short.noteOn(ev(60)) }]).L, b = render(long, 44100, [{ at: 0, fn: () => long.noteOn(ev(60)) }]).L;
  assert.ok(rms(b, 30000) > rms(a, 30000) * 8, `longer decay rings on: ${rms(b, 30000)} vs ${rms(a, 30000)}`);
  const dark = mkInst('pluck', { damping: 0.9 }), bright = mkInst('pluck', { damping: 0 });
  const cd = centroid(render(dark, 20000, [{ at: 0, fn: () => dark.noteOn(ev(60)) }]).L, 2048), cb = centroid(render(bright, 20000, [{ at: 0, fn: () => bright.noteOn(ev(60)) }]).L, 2048);
  assert.ok(cb > cd * 1.3, `damping darkens the tone: ${cb} vs ${cd}`);
  const rel = mkInst('pluck', { decay: 8, release: 30 });
  const r = render(rel, 30000, [{ at: 0, fn: () => rel.noteOn(ev(55)) }, { at: 8000, fn: () => rel.noteOff(55) }]).L;
  assert.ok(rms(r, 20000, 30000) < rms(r, 4000, 8000) * 0.03, 'note-off mutes the string');
  const soft = mkInst('pluck', { velBright: 1, damping: 0.1 }), hard = mkInst('pluck', { velBright: 1, damping: 0.1 });
  const cs = centroid(render(soft, 20000, [{ at: 0, fn: () => soft.noteOn(ev(60, 0.15)) }]).L, 1024), chd = centroid(render(hard, 20000, [{ at: 0, fn: () => hard.noteOn(ev(60, 1)) }]).L, 1024);
  assert.ok(chd > cs * 1.2, `harder plucks are brighter: ${cs} -> ${chd}`);
});

test('pluck voices free themselves after the string has died', () => {
  const i = mkInst('pluck', { decay: 0.1 });
  render(i, 3000, [{ at: 0, fn: () => i.noteOn(ev(72)) }]);
  render(i, 44100 * 2, []);
  assert.equal(i.active, false);
});

test('organ: drawbars choose the partials, percussion decays, rotary and overdrive stay stable', () => {
  const only8 = mkInst('organ', { d0: 0, d1: 0, d2: 8, d3: 0, d4: 0, d5: 0, d6: 0, d7: 0, d8: 0, click: 0, drive: 0 });
  const a = render(only8, 30000, [{ at: 0, fn: () => only8.noteOn(ev(57)) }]).L;
  assert.ok(Math.abs(peakFreq(a) - hz(57)) < 4, `8' drawbar plays the key: ${peakFreq(a)}`);
  const add4 = mkInst('organ', { d0: 0, d1: 0, d2: 8, d3: 8, d4: 0, d5: 0, d6: 0, d7: 0, d8: 0, click: 0, drive: 0 });
  const b = render(add4, 30000, [{ at: 0, fn: () => add4.noteOn(ev(57)) }]).L;
  assert.ok(centroid(b) > centroid(a) * 1.4, "adding the 4' drawbar brightens the sound");
  const sub = mkInst('organ', { d0: 8, d1: 0, d2: 0, d3: 0, d4: 0, d5: 0, d6: 0, d7: 0, d8: 0, click: 0, drive: 0 });
  assert.ok(Math.abs(peakFreq(render(sub, 30000, [{ at: 0, fn: () => sub.noteOn(ev(57)) }]).L) - hz(57) / 2) < 4, "16' sounds an octave below");
  const perc = mkInst('organ', { perc: 1, percLevel: 1, percDecay: 0, click: 0, drive: 0 }), plain = mkInst('organ', { perc: 0, click: 0, drive: 0 });
  const p1 = render(perc, 44100, [{ at: 0, fn: () => perc.noteOn(ev(60)) }]).L, p0 = render(plain, 44100, [{ at: 0, fn: () => plain.noteOn(ev(60)) }]).L;
  assert.ok(rms(p1, 0, 4000) > rms(p0, 0, 4000) * 1.1 && Math.abs(rms(p1, 30000, 40000) / rms(p0, 30000, 40000) - 1) < 0.08, 'percussion adds a bite that fades');
  const rot = mkInst('organ', { rotary: 2, rotDepth: 1, drive: 0.8 });
  const r = render(rot, 20000, [{ at: 0, fn: () => { rot.noteOn(ev(48)); rot.noteOn(ev(60)); rot.noteOn(ev(64)); } }]);
  assert.ok(peak(r.L) < 3 && rms(r.L, 5000) > 0.02, 'chord through rotary + overdrive');
  const k = mkInst('organ', { release: 20 });
  render(k, 6000, [{ at: 0, fn: () => k.noteOn(ev(60)) }, { at: 2000, fn: () => k.noteOff(60) }]);
  render(k, 12000, []);
  assert.equal(k.active, false, 'released notes end');
});

test('wavetable: pitch is accurate, position morphs the spectrum, high notes do not alias', () => {
  for (const k of [36, 60, 84]) {
    const i = mkInst('wavetable', { ftype: 3, uni: 1 });
    const { L } = render(i, 30000, [{ at: 0, fn: () => i.noteOn(ev(k)) }]);
    assert.ok(Math.abs(Math.log2(peakFreq(L) / hz(k))) * 1200 < 25 || Math.abs(Math.log2(peakFreq(L) / (2 * hz(k)))) * 1200 < 25 || Math.abs(Math.log2(peakFreq(L) / (3 * hz(k)))) * 1200 < 25, `key ${k}: ${peakFreq(L)}`);
  }
  const lo = mkInst('wavetable', { table: 0, pos: 0, ftype: 3, uni: 1 }), hi = mkInst('wavetable', { table: 0, pos: 0.6, ftype: 3, uni: 1 });
  const cl = centroid(render(lo, 20000, [{ at: 0, fn: () => lo.noteOn(ev(48)) }]).L), ch = centroid(render(hi, 20000, [{ at: 0, fn: () => hi.noteOn(ev(48)) }]).L);
  assert.ok(ch > cl * 3, `position 0 (sine) vs 0.6 (saw-ish): centroid ${cl} -> ${ch}`);
  // alias check: a bright saw-like frame on a very high note must have (almost) no energy between its harmonics
  const sawI = mkInst('wavetable', { table: 0, pos: 0.66, ftype: 3, uni: 1 });
  const key = 100, f0 = hz(key);
  const { L } = render(sawI, 40000, [{ at: 0, fn: () => sawI.noteOn(ev(key, 1)) }]);
  const N = 16384, fft = new FFT(N), re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = L[8000 + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  fft.transform(re, im);
  let harm = 0, between = 0;
  for (let k = 3; k < N / 2; k++) {
    const f = (k * SR) / N, nearest = Math.round(f / f0), d = Math.abs(f - nearest * f0);
    const e = re[k] * re[k] + im[k] * im[k];
    if (d < 40) harm += e; else between += e;
  }
  assert.ok(between < harm * 0.003, `aliasing energy ${(10 * Math.log10(between / harm)).toFixed(1)} dB below the harmonics`);
});

test('wavetable: unison beats, filter envelope darkens, loudness is similar across pitches', () => {
  const one = mkInst('wavetable', { uni: 1, ftype: 3 }), five = mkInst('wavetable', { uni: 5, unidet: 40, ftype: 3 });
  const a = render(one, 30000, [{ at: 0, fn: () => one.noteOn(ev(60)) }]).L, b = render(five, 30000, [{ at: 0, fn: () => five.noteOn(ev(60)) }]).L;
  const env = (x) => { const e = []; for (let i = 8000; i + 441 < x.length; i += 441) e.push(rms(x, i, i + 441)); return Math.max(...e) / Math.max(1e-9, Math.min(...e)); };
  assert.ok(env(b) > env(a) * 1.15, `detuned unison amplitude beats: ${env(b)} vs ${env(a)}`);
  const open = mkInst('wavetable', { table: 0, pos: 0.7, ftype: 0, cutoff: 12000, fenv: 0 }), closed = mkInst('wavetable', { table: 0, pos: 0.7, ftype: 0, cutoff: 400, fenv: 0 });
  assert.ok(centroid(render(open, 20000, [{ at: 0, fn: () => open.noteOn(ev(48)) }]).L) > centroid(render(closed, 20000, [{ at: 0, fn: () => closed.noteOn(ev(48)) }]).L) * 2, 'cutoff darkens');
  const levels = [36, 60, 84, 108].map((k) => { const i = mkInst('wavetable', { table: 0, pos: 0.7, ftype: 3, uni: 1, as: 1 }); return rms(render(i, 20000, [{ at: 0, fn: () => i.noteOn(ev(k, 1)) }]).L, 8000); });
  assert.ok(Math.max(...levels) / Math.min(...levels) < 2.2, `similar loudness across the range: ${levels.map((l) => l.toFixed(3))}`);
  for (let t = 0; t < 6; t++) { const w = mkInst('wavetable', { table: t, pos: 0.5, ftype: 3 }); const r = render(w, 8000, [{ at: 0, fn: () => w.noteOn(ev(60)) }]); assert.ok(peak(r.L) > 0.05 && peak(r.L) < 1.5, `table ${t} audible and bounded: ${peak(r.L)}`); }
});

test('new instruments work inside a project render (Pluck, Organ, Wavetable)', () => {
  for (const type of ['pluck', 'organ', 'wavetable']) {
    const p = createProject(); p.tempo = 120;
    const ch = createChannel(p, type, { name: type, mixer: 0 }); p.channels.push(ch);
    p.patterns[1].notes[ch.id] = [createNote(p, 0, 96, 60, 100), createNote(p, 96, 96, 67, 100)];
    const r = renderOffline(p, new Map(), { mode: 'pat', sampleRate: SR, tail: 0.3 });
    assert.ok(peak(r.left) > 0.05 && peak(r.left) < 2, `${type}: ${peak(r.left)}`);
    const q = normalize(JSON.parse(JSON.stringify(p)));
    assert.equal(q.channels[0].type, type, 'survives save/load');
  }
});

test('factory presets only use real parameters with in-range values', async () => {
  const { INSTRUMENT_PRESETS, EFFECT_PRESETS } = await import('../../src/core/presets.js');
  const { EFFECTS } = await import('../../src/core/effects/index.js');
  const { clampParam } = await import('../../src/core/schema.js');
  const check = (kind, type, schema, sets) => {
    const byId = new Map(schema.map((d) => [d.id, d]));
    for (const [name, params] of Object.entries(sets)) {
      assert.ok(Object.keys(params).length > 0, `${kind} ${type} "${name}" is empty`);
      for (const [k, v] of Object.entries(params)) {
        const d = byId.get(k);
        assert.ok(d, `${kind} ${type} "${name}": unknown parameter ${k}`);
        assert.equal(clampParam(d, v), v, `${kind} ${type} "${name}": ${k}=${v} outside ${d.min}..${d.max}`);
      }
    }
  };
  for (const [type, sets] of Object.entries(INSTRUMENT_PRESETS)) check('instrument', type, INSTRUMENTS[type].schema, sets);
  for (const [type, sets] of Object.entries(EFFECT_PRESETS)) check('effect', type, EFFECTS[type].schema, sets);
  // every preset renders without NaN
  for (const [type, sets] of Object.entries(INSTRUMENT_PRESETS)) for (const params of Object.values(sets)) {
    const i = mkInst(type, params);
    const { L } = render(i, 6000, [{ at: 0, fn: () => i.noteOn(ev(57)) }]);
    assert.ok(peak(L) > 0 && peak(L) < 4 && L.every(Number.isFinite), `${type} preset audible and finite`);
  }
});
