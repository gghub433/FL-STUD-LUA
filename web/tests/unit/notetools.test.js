import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../../src/core/note-tools.js';
import { SCALES, CHORDS, inScale, snapToScale, scaleStep, chordKeys, diatonicChord, identifyChord, scalePitchClasses } from '../../src/core/scales.js';

let id = 100;
const newId = () => ++id;
const N = (s, l, k, v = 100, extra = {}) => ({ id: newId(), s, l, k, v, ...extra });

test('scales: every scale starts at the root, is sorted and stays within one octave', () => {
  for (const s of SCALES) {
    assert.equal(s.iv[0], 0, s.id);
    for (let i = 1; i < s.iv.length; i++) assert.ok(s.iv[i] > s.iv[i - 1] && s.iv[i] < 12, s.id);
  }
});

test('scales: membership, snapping and degree stepping', () => {
  assert.ok(inScale(64, 0, 'major'));          // E in C major
  assert.ok(!inScale(63, 0, 'major'));         // Eb is not
  assert.ok(inScale(63, 0, 'minor'));
  assert.equal(snapToScale(61, 0, 'major'), 60);   // tie goes down
  assert.equal(scaleStep(60, 1, 0, 'major'), 62);
  assert.equal(scaleStep(60, 7, 0, 'major'), 72);
  assert.equal(scaleStep(60, -1, 0, 'major'), 59);
  assert.deepEqual(scalePitchClasses(2, 'major'), [2, 4, 6, 7, 9, 11, 1]);   // D major
});

test('chords: intervals, inversions, identification', () => {
  assert.deepEqual(chordKeys(60, 'maj'), [60, 64, 67]);
  assert.deepEqual(chordKeys(60, 'maj', { inversion: 1 }), [64, 67, 72]);
  assert.deepEqual(chordKeys(60, 'maj', { inversion: -1 }), [55, 60, 64]);
  assert.deepEqual(chordKeys(60, 'm7'), [60, 63, 67, 70]);
  assert.equal(identifyChord([60, 63, 67, 70]), 'Cm7');
  assert.equal(identifyChord([64, 67, 72]), 'C/E');
  assert.equal(identifyChord([60]), null);
  assert.deepEqual(diatonicChord(0, 'major', 0), [60, 64, 67]);
  assert.deepEqual(diatonicChord(0, 'major', 1), [62, 65, 69]);           // Dm
  assert.deepEqual(diatonicChord(0, 'major', 6), [71, 74, 77]);           // Bdim
  assert.ok(CHORDS.every((c) => c.iv[0] === 0));
});

test('transpose by semitones and by scale degrees clamps to 0..120', () => {
  const a = [N(0, 24, 60), N(0, 24, 119)];
  T.transpose(a, 5);
  assert.deepEqual(a.map((n) => n.k), [65, 120]);
  const b = [N(0, 24, 60)];
  T.transpose(b, 2, { scale: 'major', root: 0 });
  assert.equal(b[0].k, 64);
});

test('quantize: full strength snaps starts, partial strength moves halfway, ends optional', () => {
  const a = [N(30, 20, 60), N(50, 20, 62)];
  T.quantize(a, { grid: 24 });
  assert.deepEqual(a.map((n) => [n.s, n.l]), [[24, 20], [48, 20]]);
  const b = [N(30, 20, 60)];
  T.quantize(b, { grid: 24, strength: 0.5 });
  assert.equal(b[0].s, 27);
  const c = [N(30, 20, 60)];
  T.quantize(c, { grid: 24, ends: true });
  assert.equal(c[0].s, 24); assert.equal(c[0].s + c[0].l, 48);
  const d = [N(1, 10, 60), N(25, 10, 60)];
  T.quantize(d, { grid: 24, swing: 1 });
  assert.equal(d[0].s, 0); assert.equal(d[1].s, 24 + 12);        // odd grid positions are pushed later
});

test('chop splits a note into equal parts without losing or overlapping time', () => {
  const out = T.chop([N(0, 96, 60)], { parts: 4 }, newId);
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((n) => n.s), [0, 24, 48, 72]);
  assert.ok(out.every((n) => n.l === 24));
  const g = T.chop([N(0, 96, 60)], { parts: 4, gate: 0.5 }, newId);
  assert.ok(g.every((n) => n.l === 12));
  assert.equal(new Set(out.map((n) => n.id)).size, 4);
});

test('glue joins touching notes of the same key only', () => {
  const out = T.glue([N(0, 24, 60), N(24, 24, 60), N(48, 24, 60), N(0, 24, 64), N(100, 10, 60)]);
  assert.equal(out.length, 3);
  const c = out.find((n) => n.k === 60 && n.s === 0);
  assert.equal(c.l, 72);
  assert.equal(T.glue([N(0, 10, 60), N(14, 10, 60)], { maxGap: 4 }).length, 1);
  assert.equal(T.glue([N(0, 10, 60), N(14, 10, 60)], {}).length, 2);
});

test('flip mirrors time and pitch inside the selection bounds', () => {
  const a = [N(0, 24, 60), N(24, 48, 64)];
  T.flip(a, 'h');
  assert.deepEqual(a.map((n) => [n.s, n.l]), [[48, 24], [0, 48]]);
  const b = [N(0, 24, 60), N(24, 24, 67)];
  T.flip(b, 'v');
  assert.deepEqual(b.map((n) => n.k), [67, 60]);
});

test('limit clamps pitch, velocity, length and trims to a time window', () => {
  const out = T.limit([N(0, 100, 30, 120), N(200, 10, 60)], { s: 10, e: 60, kmin: 40, kmax: 80, vmax: 90 });
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].s, out[0].l, out[0].k, out[0].v], [10, 50, 40, 90]);
});

test('randomize is deterministic per seed and respects ranges', () => {
  const mk = () => Array.from({ length: 20 }, (_, i) => N(i * 24, 24, 60, 80));
  const a = T.randomize(mk(), { seed: 7, velocity: 0.5, pitch: 0.5 });
  const b = T.randomize(mk(), { seed: 7, velocity: 0.5, pitch: 0.5 });
  assert.deepEqual(a.map((n) => [n.k, n.v]), b.map((n) => [n.k, n.v]));
  const c = T.randomize(mk(), { seed: 8, velocity: 0.5, pitch: 0.5 });
  assert.notDeepEqual(a.map((n) => [n.k, n.v]), c.map((n) => [n.k, n.v]));
  assert.ok(a.every((n) => n.v >= 1 && n.v <= 127 && Math.abs(n.k - 60) <= 6));
  const s = T.randomize(mk(), { seed: 3, pitch: 1, scale: 'major', root: 0 });
  assert.ok(s.every((n) => inScale(n.k, 0, 'major')), 'scale-locked randomisation stays in key');
});

test('strum staggers chord notes and keeps their common end', () => {
  const ch = chordKeys(60, 'maj').map((k) => N(96, 96, k));
  T.strum(ch, { ticks: 6, dir: 'up' });
  assert.deepEqual(ch.map((n) => n.s), [96, 102, 108]);
  assert.ok(ch.every((n) => n.s + n.l === 192));
  const d = chordKeys(60, 'maj').map((k) => N(0, 96, k));
  T.strum(d, { ticks: 6, dir: 'down' });
  assert.deepEqual(d.slice().sort((a, b) => a.s - b.s).map((n) => n.k), [67, 64, 60]);
});

test('arpeggiator fills the chord length with the chosen order', () => {
  const mk = () => chordKeys(60, 'maj').map((k) => N(0, 96, k));
  const up = T.arpeggiate(mk(), { mode: 'up', rate: 24, gate: 1 }, newId);
  assert.deepEqual(up.map((n) => n.k), [60, 64, 67, 60]);
  assert.deepEqual(up.map((n) => n.s), [0, 24, 48, 72]);
  const down = T.arpeggiate(mk(), { mode: 'down', rate: 24 }, newId);
  assert.deepEqual(down.map((n) => n.k), [67, 64, 60, 67]);
  const ud = T.arpeggiate(mk(), { mode: 'up-down', rate: 24 }, newId);
  assert.deepEqual(ud.map((n) => n.k), [60, 64, 67, 64]);
  const oct = T.arpeggiate(mk(), { mode: 'up', rate: 12, octaves: 2 }, newId);
  assert.deepEqual(oct.slice(0, 6).map((n) => n.k), [60, 64, 67, 72, 76, 79]);
  assert.ok(up.every((n) => n.s + n.l <= 96), 'never runs past the chord end');
  assert.equal(new Set(up.map((n) => n.id)).size, up.length, 'unique ids');
  // single notes pass through untouched
  const single = T.arpeggiate([N(0, 24, 60)], {}, newId);
  assert.equal(single.length, 1);
});

test('articulator applies a repeating pattern; legato fills gaps', () => {
  const a = [N(0, 24, 60), N(24, 24, 60), N(48, 24, 60)];
  T.articulate(a, [{ gate: 0.5, vel: 1.2 }, { gate: 1, vel: 0.5, slide: 1, skip: 0 }]);
  assert.deepEqual(a.map((n) => n.l), [12, 24, 12]);
  assert.equal(a[1].slide, 1);
  assert.equal(a[0].v, 120);
  const b = [N(0, 10, 60), N(50, 10, 62)];
  T.legato(b);
  assert.equal(b[0].l, 50);
});

test('claw machine and riff machine are deterministic, in range and in key', () => {
  const pool = [N(0, 24, 60), N(0, 24, 63), N(0, 24, 67)];
  const a = T.clawMachine(pool, { seed: 5, steps: 16 }, newId), b = T.clawMachine(pool, { seed: 5, steps: 16 }, newId);
  assert.deepEqual(a.map((n) => [n.s, n.k]), b.map((n) => [n.s, n.k]));
  assert.ok(a.length > 3 && a.every((n) => [60, 63, 67].includes(n.k) && n.s >= 0 && n.s < 16 * 24));
  const r1 = T.riffMachine({ seed: 11, root: 9, scale: 'minor', bars: 2 }, newId);
  const r2 = T.riffMachine({ seed: 11, root: 9, scale: 'minor', bars: 2 }, newId);
  assert.deepEqual(r1.map((n) => [n.s, n.k, n.l]), r2.map((n) => [n.s, n.k, n.l]));
  assert.ok(r1.length >= 6, `riff has notes (${r1.length})`);
  assert.ok(r1.every((n) => inScale(n.k, 9, 'minor') && n.k >= 55 && n.k <= 79 && n.s < 2 * 384));
  const r3 = T.riffMachine({ seed: 12, root: 9, scale: 'minor', bars: 2 }, newId);
  assert.notDeepEqual(r1.map((n) => n.k), r3.map((n) => n.k));
  // the first half bar repeats as the motif: same intervals in the second repetition
  const half = 192;
  const first = r1.filter((n) => n.s < half).map((n) => n.k), second = r1.filter((n) => n.s >= half && n.s < 2 * half).map((n) => n.k);
  assert.deepEqual(first, second, 'A A repetition');
});

test('duplicate/shift/scaleLengths/fitToScale', () => {
  const a = [N(0, 24, 60)];
  const d = T.duplicate(a, 96, newId);
  assert.equal(d.length, 2); assert.equal(d[1].s, 96);
  const s = [N(10, 24, 60)];
  T.shift(s, -50);
  assert.equal(s[0].s, 0);
  const l = [N(0, 24, 60), N(48, 24, 60)];
  T.scaleLengths(l, 2);
  assert.deepEqual(l.map((n) => [n.s, n.l]), [[0, 48], [96, 48]]);
  const f = [N(0, 24, 61)];
  T.fitToScale(f, 0, 'major');
  assert.ok(inScale(f[0].k, 0, 'major'));
});

test('riff machine never produces a one-note motif, for any seed', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const r = T.riffMachine({ seed, root: 9, scale: 'minor', bars: 2, density: 0.75, lo: 67, hi: 79 }, newId);
    assert.ok(r.length >= 8, `seed ${seed}: ${r.length} notes`);
    assert.ok(r.every((n) => n.k >= 67 && n.k <= 79 && inScale(n.k, 9, 'minor')), `seed ${seed} in range and key`);
  }
});

// ---- automation LFO tool ------------------------------------------------------------------
import { generateLfoPoints, thinPoints, evalPoints } from '../../src/core/automation.js';

test('LFO tool writes sine, triangle, saw and square shapes that evaluate to the wave', () => {
  const len = 384;
  const check = (shape, f, tol, opts = {}) => {
    const pts = generateLfoPoints(len, { shape, cycles: 4, amp: 1, center: 0.5, ...opts });
    assert.ok(pts.every((p, i) => p.v >= 0 && p.v <= 1 && p.t >= 0 && p.t <= len && (!i || p.t >= pts[i - 1].t)), `shape ${shape}: sorted, in range`);
    for (let t = 0; t <= len; t += 7) {
      const u = (((t / (len / 4) + (opts.phase || 0)) % 1) + 1) % 1;
      const want = 0.5 + 0.5 * f(u), got = evalPoints(pts, t);
      assert.ok(Math.abs(got - want) < tol, `shape ${shape} t=${t}: ${got} vs ${want}`);
    }
    return pts;
  };
  check(0, (u) => Math.sin(2 * Math.PI * u), 0.015);
  check(1, (u) => (u < 0.5 ? 4 * u - 1 : 3 - 4 * u), 0.04);
  check(2, (u) => 2 * u - 1, 0.05);
  check(4, (u) => (u < 0.5 ? 1 : -1), 1.01);                      // edges: just stays in range
  const sq = generateLfoPoints(len, { shape: 4, cycles: 4 });
  assert.ok(sq.every((p) => p.type === 'hold') && sq.length >= 8, 'square uses hold segments');
  const sh = generateLfoPoints(len, { shape: 0, cycles: 2, phase: 0.25, amp: 0.5, center: 0.3 });
  assert.ok(Math.abs(evalPoints(sh, 0) - (0.3 + 0.25)) < 0.02, 'phase and centre apply');
  assert.ok(Math.max(...sh.map((p) => p.v)) <= 0.55 + 1e-9 && Math.min(...sh.map((p) => p.v)) >= 0.05 - 1e-9, 'amp scales around the centre');
  const part = generateLfoPoints(len, { shape: 1, cycles: 4, from: 96, to: 192 });
  assert.ok(part[0].t === 96 && part[part.length - 1].t === 192, 'writes only inside the chosen range');
});

test('random LFO shapes are deterministic per seed; thinPoints drops collinear points only', () => {
  const a = generateLfoPoints(384, { shape: 5, cycles: 2, seed: 4 }), b = generateLfoPoints(384, { shape: 5, cycles: 2, seed: 4 }), c = generateLfoPoints(384, { shape: 5, cycles: 2, seed: 5 });
  assert.deepEqual(a, b); assert.notDeepEqual(a.map((p) => p.v), c.map((p) => p.v));
  const line = [0, 1, 2, 3, 4].map((i) => ({ t: i * 10, v: i / 4, type: 'single', tension: 0, count: 4 }));
  assert.equal(thinPoints(line).length, 2);
  const bent = [...line]; bent[2] = { ...bent[2], v: 0.9 };
  assert.equal(thinPoints(bent).length, 5);
  const held = line.map((p) => ({ ...p, type: 'hold' }));
  assert.equal(thinPoints(held).length, 5, 'curved/held segments are left alone');
});
