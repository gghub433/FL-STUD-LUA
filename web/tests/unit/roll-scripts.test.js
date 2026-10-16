import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toScriptNote, finish, execute, runScript, normalizeParams, paramValues, makeContext, scriptInput, loadScript, scriptDefinition, MAX_NOTES,
} from '../../src/core/roll-scripts.js';
import { FACTORY_SCRIPTS, FACTORY_BY_ID } from '../../src/core/roll-scripts-factory.js';
import { inScale } from '../../src/core/scales.js';

let id = 1000;
const N = (s, l, k, v = 100, extra = {}) => ({ id: ++id, s, l, k, v, ...extra });
const input = (notes, o = {}) => scriptInput({ notes, patternLength: 768, selection: false, scale: { root: 0, id: 'major' }, ...o });
const run = (sid, notes, values = {}, o = {}) => {
  const r = runScript(FACTORY_BY_ID.get(sid), input(notes, o), values);
  assert.ok(r.ok, r.error);
  return r.notes;
};
const def = (fn, params = []) => ({ name: 't', description: '', params: normalizeParams(params), run: fn });
const chord = (s, l, keys, v = 100) => keys.map((k) => N(s, l, k, v));

// ------------------------------------------------------------------------------ runner
test('roll scripts: notes go to the script with readable names and defaults and come back as project notes', () => {
  const n = N(48, 24, 62, 90, { pan: -10, rel: 30, fine: 5, mx: 0, c: 3, slide: 1 });
  const s = toScriptNote(n);
  assert.deepEqual(s, { id: n.id, time: 48, length: 24, key: 62, velocity: 90, pan: -10, release: 30, fine: 5, modX: 0, modY: 128, color: 3, slide: true, muted: false });
  const r = finish([s], [n.id]);
  assert.ok(r.ok);
  assert.deepEqual(r.notes[0], n);
  // defaults are not written (the project keeps optional fields only when they differ)
  assert.deepEqual(finish([{ time: 0, key: 60 }]).notes[0], { s: 0, l: 24, k: 60, v: 100 });
});

test('roll scripts: a note keeps its id once; copies and unknown ids become new notes', () => {
  const a = N(0, 24, 60), b = N(24, 24, 62);
  const r = finish([toScriptNote(a), { ...toScriptNote(a), key: 72 }, { time: 0, key: 50, id: 999999 }, toScriptNote(b)], [a.id, b.id]);
  assert.ok(r.ok);
  assert.deepEqual(r.notes.map((n) => n.id), [a.id, undefined, undefined, b.id]);
});

test('roll scripts: invalid notes are errors, values out of range are clamped', () => {
  const bad = (o, re) => { const r = finish([{ time: 0, key: 60 }, o]); assert.equal(r.ok, false); assert.match(r.error, re); };
  bad({ time: NaN, key: 60 }, /^Note 2: time is not a number$/);
  bad({ time: 0, key: 'C5' }, /key is not a number/);
  bad({ time: 0 }, /key is missing/);
  bad({ time: 0, key: 121 }, /^Note 2: key 121 is outside 0–120$/);
  bad({ time: 0, key: -1 }, /key -1 is outside/);
  bad({ time: -5, key: 60 }, /time is negative \(-5\)/);
  bad({ time: 0, key: 60, length: 0 }, /length must be more than 0/);
  bad({ time: 0, key: 60, velocity: Infinity }, /velocity is not a number/);
  bad(null, /^Note 2 is not an object$/);
  assert.match(finish('x').error, /must return a list/);
  assert.match(finish(new Array(MAX_NOTES + 1).fill({ time: 0, key: 60 })).error, /more than 20000 notes/);
  const r = finish([{ time: 10.4, key: 60.6, length: 0.2, velocity: 300, pan: -99, release: 999, fine: 500, modX: -3, modY: 999, color: 40, slide: 1, muted: 'yes' }]);
  assert.ok(r.ok);
  assert.deepEqual(r.notes[0], { s: 10, l: 1, k: 61, v: 127, pan: -64, rel: 127, fine: 120, mx: 0, my: 255, c: 15, slide: 1, mute: 1 });
});

test('roll scripts: run() may change ctx.notes or return a list; the caller’s notes are never touched', () => {
  const src = [N(0, 24, 60), N(24, 24, 62)];
  const copy = JSON.parse(JSON.stringify(src));
  const inp = input(src);
  let r = runScript(def((ctx) => { for (const n of ctx.notes) n.key += 12; ctx.notes.push(ctx.note({ time: 96, key: 40 })); }), inp);
  assert.ok(r.ok);
  assert.deepEqual(r.notes.map((n) => [n.k, n.id]), [[72, src[0].id], [74, src[1].id], [40, undefined]]);
  r = runScript(def((ctx) => ctx.notes.filter((n) => n.key === 62)), inp);
  assert.deepEqual(r.notes.map((n) => n.id), [src[1].id]);
  assert.deepEqual(src, copy);
  assert.deepEqual(inp.notes, copy);
});

test('roll scripts: errors thrown by a script, async runs and wrong results change nothing and explain why', () => {
  const inp = input([N(0, 24, 60)]);
  let r = runScript(def((ctx) => { ctx.notes[0].key = 1; throw new Error('boom'); }), inp);
  assert.deepEqual(r, { ok: false, error: 'Script error: boom' });
  r = runScript(def(() => { throw 'plain'; }), inp);
  assert.equal(r.error, 'Script error: plain');
  r = runScript(def(async () => []), inp);
  assert.match(r.error, /cannot be async/);
  r = runScript(def(() => 42), inp);
  assert.match(r.error, /must return a list of notes/);
  r = runScript(def((ctx) => { ctx.notes[0].key = NaN; }), inp);
  assert.match(r.error, /key is not a number/);
  // getters and functions in the output are reduced to plain values
  r = execute(def(() => [{ time: 0, get key() { return 64; }, velocity: () => 3 }]), inp, {});
  assert.ok(r.ok);
  assert.equal(r.notes[0].key, 64);
  assert.ok(Number.isNaN(r.notes[0].velocity));
});

test('roll scripts: parameters are checked, defaults filled in, values clamped', () => {
  const ps = normalizeParams([
    { id: 'a', name: 'Amount', min: 0, max: 10, value: 30 },
    { id: 'k', type: 'key' },
    { id: 'c', type: 'choice', options: ['x', ['y', 'Why'], [3, 'Three']], value: 3 },
    { id: 'b', type: 'check', value: 1 },
    { id: 't', type: 'text' },
  ]);
  assert.deepEqual(ps.map((p) => [p.type, p.value]), [['slider', 10], ['key', 0], ['choice', 3], ['check', true], ['text', '']]);
  assert.deepEqual(ps[2].options, [['x', 'x'], ['y', 'Why'], [3, 'Three']]);
  assert.equal(ps[1].max, 120);
  assert.deepEqual(paramValues(ps, { a: -4, k: 61, c: '3', b: 0, t: 'hi', zzz: 1 }), { a: 0, k: 61, c: 3, b: false, t: 'hi' });
  assert.deepEqual(paramValues(ps, { a: NaN, c: 'nope' }), { a: 10, k: 0, c: 3, b: true, t: '' });
  const err = (list, re) => assert.throws(() => normalizeParams(list), re);
  err('x', /params must be a list/);
  err([{ name: 'no id' }], /Parameter 1 needs an id/);
  err([{ id: 'a' }, { id: 'a' }], /Parameter 2: the id "a" is used twice/);
  err([{ id: 'a', type: 'dial' }], /unknown type "dial"/);
  err([{ id: 'a', type: 'choice' }], /a choice needs options/);
  err([{ id: 'a', min: 5, max: 1 }], /max is below min/);
});

test('roll scripts: context helpers (seeded random, quantize, scale, chords, note tools)', () => {
  const inp = input([N(0, 96, 60), N(1, 95, 64), N(0, 96, 67), N(200, 24, 62)], { scale: { root: 9, id: 'minor' }, timeSig: { num: 3, den: 4 } });
  const ctx = makeContext(inp, { seed: 7 });
  const again = makeContext(inp, { seed: 7 });
  const seq = [ctx.random(), ctx.random.int(1, 6), ctx.random.range(5, 6), ctx.random.pick(['a', 'b']), ctx.random.gauss()];
  assert.deepEqual(seq, [again.random(), again.random.int(1, 6), again.random.range(5, 6), again.random.pick(['a', 'b']), again.random.gauss()]);
  assert.notEqual(makeContext(inp, { seed: 8 }).random(), makeContext(inp, { seed: 7 }).random());
  assert.equal(ctx.bar, 288); assert.equal(ctx.beat, 96); assert.equal(ctx.step, 24); assert.equal(ctx.ppq, 96);
  assert.deepEqual(ctx.scale, { root: 9, id: 'minor', name: 'Natural minor (Aeolian)', intervals: [0, 2, 3, 5, 7, 8, 10] });
  assert.equal(ctx.quantize(30), 24); assert.equal(ctx.quantize(30, 48), 48); assert.equal(ctx.quantize(30, 24, 0.5), 27);
  assert.ok(ctx.inScale(69) && !ctx.inScale(70));
  assert.equal(ctx.snapToScale(70), 69); assert.equal(ctx.scaleStep(69, 2), 72);
  assert.deepEqual(ctx.scaleKeys(60, 66), [60, 62, 64, 65]);
  assert.deepEqual(ctx.scaleKeys(60, 66, 0, 'major'), [60, 62, 64, 65]);
  assert.deepEqual(ctx.chord(60, 'min'), [60, 63, 67]);
  assert.deepEqual(ctx.diatonicChord(0, 3, 48), [57, 60, 64]);          // A minor triad from A4
  assert.equal(ctx.keyName(61), 'C#5'); assert.equal(ctx.parseKey('A4'), 57); assert.equal(ctx.parseKey('X'), null);
  const groups = ctx.chords(ctx.notes);
  assert.deepEqual(groups.map((g) => [g.time, g.notes.map((n) => n.key)]), [[0, [60, 64, 67]], [200, [62]]]);
  const arp = ctx.tools.arpeggiate(groups[0].notes, { rate: 24, gate: 1 });
  assert.deepEqual(arp.map((n) => [n.time, n.key]), [[0, 60], [24, 64], [48, 67], [72, 60]]);
  assert.equal(arp.filter((n) => n.id !== undefined).length, 1);          // the first keeps its id, the rest are new
  assert.deepEqual(ctx.tools.quantize([ctx.note({ time: 13, key: 60 })], { grid: 24 }).map((n) => n.time), [24]);
  assert.deepEqual(ctx.note({ id: 5, key: 70 }).id, undefined);
});

test('roll scripts: the range is the selection in whole bars, or the whole pattern', () => {
  assert.deepEqual(scriptInput({ notes: [N(400, 24, 60), N(700, 200, 60)], selection: true, patternLength: 1536 }).range, { start: 384, end: 1152 });
  assert.deepEqual(scriptInput({ notes: [N(400, 24, 60)], selection: false, patternLength: 1536 }).range, { start: 0, end: 1536 });
  assert.deepEqual(scriptInput({ notes: [], patternLength: 0 }).range, { start: 0, end: 384 });
  assert.deepEqual(scriptInput({ notes: [N(0, 24, 60)], selection: true, timeSig: { num: 6, den: 8 } }).range, { start: 0, end: 288 });
});

test('roll scripts: user scripts load from module source; broken ones explain what is wrong', async () => {
  const { def: d } = await loadScript("export default { name: 'Up', params: [{ id: 'n', type: 'slider', min: 0, max: 12, value: 12 }], run(ctx) { for (const x of ctx.notes) x.key += ctx.params.n; } };");
  assert.equal(d.name, 'Up');
  assert.deepEqual(runScript(d, input([N(0, 24, 60)])).notes.map((n) => n.k), [72]);
  const named = await loadScript('export const params = []; export function run(ctx) { return []; }');
  assert.deepEqual(runScript(named.def, input([N(0, 24, 60)])).notes, []);
  const fn = await loadScript('export default function run(ctx) { return ctx.notes.slice(0, 1); }');
  assert.equal(typeof fn.def.run, 'function');
  await assert.rejects(loadScript('export default { run( {'), /The script could not be loaded/);
  await assert.rejects(loadScript('export default { params: [] };'), /must export its definition/);
  await assert.rejects(loadScript('   '), /The script is empty/);
  await assert.rejects(loadScript("export default { params: [{ id: 1 }], run() {} };"), /Parameter 1 needs an id/);
  assert.throws(() => scriptDefinition(null), /must export/);
  // a runtime error names the line of the script
  const { def: thrower, url } = await loadScript('export default {\n  run(ctx) {\n    return ctx.nope.length;\n  },\n};');
  const r = execute(thrower, input([]), {}, { url });
  assert.equal(r.ok, false);
  assert.match(r.error, /^Script error \(line 3\): /);
});

// ------------------------------------------------------------------------------ factory scripts
test('factory scripts: at least eight, unique ids, described, deterministic, safe on an empty roll', () => {
  assert.ok(FACTORY_SCRIPTS.length >= 8);
  assert.equal(new Set(FACTORY_SCRIPTS.map((s) => s.id)).size, FACTORY_SCRIPTS.length);
  const notes = [...chord(0, 192, [60, 64, 67]), ...chord(384, 192, [65, 69, 72]), N(96, 24, 62), N(600, 24, 71)];
  for (const s of FACTORY_SCRIPTS) {
    assert.ok(s.name && s.description && s.params.length, s.id);
    const a = runScript(s, input(notes), {}), b = runScript(s, input(notes), {});
    assert.ok(a.ok, `${s.id}: ${a.error}`);
    assert.deepEqual(a, b, `${s.id} is deterministic`);
    assert.ok(runScript(s, input([]), {}).ok, `${s.id} on no notes`);
    for (const n of a.notes) assert.ok(n.k >= 0 && n.k <= 120 && n.v >= 1 && n.v <= 127 && n.s >= 0 && n.l >= 1, s.id);
  }
});

test('Humanize: timing, velocity and length move within their amounts; chords move together', () => {
  const src = [...chord(96, 96, [60, 64, 67]), N(288, 48, 62, 80), N(480, 96, 65, 120)];
  const out = run('humanize', src, { timing: 6, velocity: 10, length: 20, chords: true, seed: 3 });
  assert.equal(out.length, src.length);
  const byId = new Map(src.map((n) => [n.id, n]));
  let moved = 0;
  for (const n of out) {
    const o = byId.get(n.id);
    assert.ok(Math.abs(n.s - o.s) <= 6 && Math.abs(n.v - o.v) <= 10 && Math.abs(n.l - o.l) <= o.l * 0.2 + 1, JSON.stringify([o, n]));
    if (n.s !== o.s || n.v !== o.v || n.l !== o.l) moved++;
  }
  assert.ok(moved >= 4, 'most notes changed');
  assert.equal(new Set(out.filter((n) => [60, 64, 67].includes(n.k)).map((n) => n.s)).size, 1, 'the chord stays together');
  assert.notDeepEqual(out, run('humanize', src, { timing: 6, velocity: 10, length: 20, chords: true, seed: 4 }));
  assert.deepEqual(run('humanize', src, { timing: 0, velocity: 0, length: 0 }).map((n) => [n.s, n.l, n.v]), src.map((n) => [n.s, n.l, n.v]));
});

test('Flam: grace notes before each note, quieter, inside the pattern', () => {
  const src = [N(0, 96, 60), N(96, 96, 62, 120)];
  let out = run('flam', src, { count: 2, spacing: 6, velocity: 50, pitch: 0, place: 'before' });
  // the note at 0 has no room before it; the one at 96 gets two grace notes at 84 and 90
  assert.equal(out.length, 4);
  assert.deepEqual(out.filter((n) => n.id === undefined).map((n) => [n.s, n.l, n.k, n.v]), [[84, 6, 62, 60], [90, 6, 62, 60]]);
  out = run('flam', src, { count: 1, spacing: 8, velocity: 60, pitch: -2, place: 'on' });
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((n) => [n.s, n.l, n.k]), [[0, 8, 58], [8, 88, 60], [96, 8, 60], [104, 88, 62]]);
});

test('Chord progression: diatonic chords on the degrees, one per bar over the pattern', () => {
  const out = run('chords', [], { root: 0, scale: 'major', progression: '1 5 6 4', size: 3, voicing: 'close', octave: 5, every: 'bar' }, { patternLength: 1536 });
  assert.equal(out.length, 12);
  const at = (t) => out.filter((n) => n.s === t).map((n) => n.k);
  assert.deepEqual([at(0), at(384), at(768), at(1152)], [[60, 64, 67], [67, 71, 74], [69, 72, 76], [65, 69, 72]]);
  assert.ok(out.every((n) => n.l === 384 && n.v === 90 && inScale(n.k, 0, 'major')));
  // sevenths, smooth voicing and a bass note; a custom progression in A minor from the piano roll's scale
  const s = run('chords', [], { progression: 'custom', custom: '1 4 5', size: 4, voicing: 'smooth', bass: true, every: '2beats' }, { scale: { root: 9, id: 'minor' }, patternLength: 384 });
  assert.equal(s.length, 10);
  assert.ok(s.every((n) => inScale(n.k, 9, 'minor')));
  const first = s.filter((n) => n.s === 0).map((n) => n.k), second = s.filter((n) => n.s === 192).map((n) => n.k);
  assert.equal(Math.min(...first), 57, 'bass note an octave under the A minor chord');
  const span = (ks) => Math.max(...ks.slice(1)) - Math.min(...ks.slice(1));
  assert.ok(span(second) <= 12, 'smooth voicing keeps the chord close');
  // a selection is filled in whole bars; with Replace off the notes stay
  const sel = [N(400, 24, 50)];
  const kept = run('chords', sel, { replace: false, every: 'bar' }, { selection: true, scale: { root: 0, id: 'chromatic' } });
  assert.equal(kept.length, 4);
  assert.ok(kept.filter((n) => n.id === undefined).every((n) => n.s === 384));
  const bad = runScript(FACTORY_BY_ID.get('chords'), input([]), { progression: 'custom', custom: '1 9' });
  assert.match(bad.error, /^Script error: Write the degrees/);
});

test('Euclidean rhythm: pulses spread evenly, rotation shifts them', () => {
  let out = run('euclid', [], { steps: 8, pulses: 3, rotation: 0, grid: 24, key: 36, velocity: 110, gate: 50 }, { patternLength: 384 });
  assert.deepEqual(out.map((n) => n.s), [0, 72, 144, 192, 264, 336]);       // x..x..x. twice
  assert.ok(out.every((n) => n.k === 36 && n.v === 110 && n.l === 12));
  out = run('euclid', [], { steps: 8, pulses: 3, rotation: 1 }, { patternLength: 384 });
  assert.deepEqual(out.slice(0, 3).map((n) => n.s), [24, 96, 168]);
  out = run('euclid', [], { steps: 4, pulses: 9 }, { patternLength: 384 });       // more pulses than steps: every step
  assert.equal(out.length, 16);
  out = run('euclid', [N(0, 24, 70)], { steps: 16, pulses: 4, replace: false }, { patternLength: 384 });
  assert.equal(out.length, 5);
});

test('Arpeggiate chords: the arpeggiator with a beat accent; single notes pass through', () => {
  const src = [...chord(0, 96, [60, 64, 67], 90), N(192, 24, 50)];
  const out = run('arpeggiate', src, { mode: 'down', rate: 24, gate: 50, octaves: 1, accent: 20 });
  assert.deepEqual(out.map((n) => [n.s, n.k, n.l]), [[0, 67, 12], [24, 64, 12], [48, 60, 12], [72, 67, 12], [192, 50, 24]]);
  assert.deepEqual(out.map((n) => n.v), [110, 90, 90, 90, 100]);
  assert.equal(run('arpeggiate', chord(0, 96, [60, 64]), { octaves: 2, rate: 12 }).length, 8);
});

test('Random melody: in the scale, inside the range, on the grid, without overlaps; the seed decides', () => {
  const v = { seed: 11, root: 2, scale: 'dorian', lo: 62, hi: 79, grid: 24, density: 80, leap: 3, long: 30 };
  const out = run('melody', [], v, { patternLength: 768 });
  assert.ok(out.length >= 12, `${out.length} notes`);
  assert.equal(out[0].s, 0);
  for (let i = 0; i < out.length; i++) {
    const n = out[i];
    assert.ok(inScale(n.k, 2, 'dorian') && n.k >= 62 && n.k <= 79 && n.s % 24 === 0 && n.s + n.l <= 768, JSON.stringify(n));
    if (i) assert.ok(out[i - 1].s + out[i - 1].l <= n.s, 'no overlap');
  }
  assert.deepEqual(out, run('melody', [], v, { patternLength: 768 }));
  assert.notDeepEqual(out, run('melody', [], { ...v, seed: 12 }, { patternLength: 768 }));
  const bad = runScript(FACTORY_BY_ID.get('melody'), input([]), { lo: 61, hi: 61, root: 0, scale: 'major' });
  assert.match(bad.error, /No key of the scale/);
});

test('Invert / Mirror: pitch around a center, backwards in time, fitted to the scale', () => {
  const src = [N(0, 24, 60), N(24, 48, 64), N(96, 24, 67)];
  assert.deepEqual(run('mirror', src, { mode: 'pitch', center: 'key', key: 60 }).map((n) => n.k), [60, 56, 53]);
  assert.deepEqual(run('mirror', src, { mode: 'pitch', center: 'middle' }).map((n) => n.k), [67, 63, 60]);
  assert.deepEqual(run('mirror', src, { mode: 'pitch', center: 'middle', inScale: true }).map((n) => n.k), [67, 62, 60]);
  assert.deepEqual(run('mirror', src, { mode: 'time' }).map((n) => [n.s, n.k]), [[96, 60], [48, 64], [0, 67]]);
  assert.deepEqual(run('mirror', src, { mode: 'both', center: 'lowest' }).map((n) => [n.s, n.k]), [[96, 60], [48, 56], [0, 53]]);
  // results that leave the keyboard come back by octaves
  assert.deepEqual(run('mirror', [N(0, 24, 118), N(0, 24, 2)], { mode: 'pitch', center: 'key', key: 0 }).map((n) => n.k), [2, 10]);
});

test('Velocity curve: ramps, waves and random values between the two velocities', () => {
  const src = [0, 24, 48, 72, 96].map((s) => N(s, 24, 60, 100));
  assert.deepEqual(run('velocity', src, { shape: 'up', from: 40, to: 120 }).map((n) => n.v), [40, 60, 80, 100, 120]);
  assert.deepEqual(run('velocity', src, { shape: 'down', from: 40, to: 120 }).map((n) => n.v), [120, 100, 80, 60, 40]);
  assert.deepEqual(run('velocity', src, { shape: 'up', from: 40, to: 120, amount: 50 }).map((n) => n.v), [70, 80, 90, 100, 110]);
  assert.deepEqual(run('velocity', src, { shape: 'triangle', from: 20, to: 100 }).map((n) => n.v), [20, 60, 100, 60, 20]);
  assert.deepEqual(run('velocity', src, { shape: 'up', from: 40, to: 120, cycles: 2 }).map((n) => n.v), [40, 80, 120, 80, 120]);
  const sine = run('velocity', src, { shape: 'sine', from: 10, to: 110 }).map((n) => n.v);
  assert.deepEqual(sine, [10, 60, 110, 60, 10]);
  const rnd = run('velocity', src, { shape: 'random', from: 30, to: 50, seed: 9 }).map((n) => n.v);
  assert.ok(rnd.every((v) => v >= 30 && v <= 50) && new Set(rnd).size > 1);
});

test('Harmonize: a second voice by scale degrees, above or below', () => {
  const src = [N(0, 24, 60, 100), N(24, 24, 62, 100), N(48, 24, 64, 100)];
  let out = run('harmonize', src, { interval: 2, dir: 'up', velocity: 50 });
  assert.equal(out.length, 6);
  assert.deepEqual(out.filter((n) => n.id === undefined).map((n) => [n.s, n.k, n.v]), [[0, 64, 50], [24, 65, 50], [48, 67, 50]]);
  out = run('harmonize', src, { interval: 7, dir: 'down', root: 2, scale: 'minor-pentatonic' });
  assert.deepEqual(out.filter((n) => n.id === undefined).map((n) => n.k), [48, 50, 52]);
  out = run('harmonize', src, { interval: 4, dir: 'down' });
  assert.deepEqual(out.filter((n) => n.id === undefined).map((n) => n.k), [53, 55, 57]);
});

test('Thin out: removes a share of the notes, keeps the beats, more amount removes more', () => {
  const src = Array.from({ length: 64 }, (_, i) => N(i * 24, 24, 60));
  const count = (amount, beats = true) => run('thin', src, { amount, beats, seed: 5 }).length;
  assert.equal(count(0), 64);
  assert.equal(count(100), 16, 'only the beats stay');
  assert.equal(count(100, false), 0);
  const half = run('thin', src, { amount: 50, beats: false, seed: 5 });
  assert.ok(half.length > 20 && half.length < 44, `${half.length}`);
  const more = new Set(run('thin', src, { amount: 70, beats: false, seed: 5 }).map((n) => n.id));
  assert.ok([...more].every((x) => half.some((n) => n.id === x)), 'a larger amount keeps a subset');
  assert.ok(run('thin', src, { amount: 60, seed: 5 }).filter((n) => n.s % 96 === 0).length === 16);
});

test('Bass from chords: the lowest chord note in the bass octave, in a rhythm', () => {
  const src = [...chord(0, 384, [60, 64, 67]), ...chord(384, 384, [65, 69, 72])];
  let out = run('bass', src, { octave: 3, rhythm: 'hold', keep: true });
  assert.equal(out.length, 8);
  assert.deepEqual(out.filter((n) => n.id === undefined).map((n) => [n.s, n.l, n.k]), [[0, 384, 36], [384, 384, 41]]);
  out = run('bass', src, { octave: 2, rhythm: 'fifth', keep: false });
  assert.equal(out.length, 8);
  assert.deepEqual(out.map((n) => n.k), [24, 31, 24, 31, 29, 36, 29, 36]);
  assert.ok(out.every((n) => n.l === Math.round(96 * 0.9)));
  assert.equal(run('bass', src, { rhythm: 'eighths', keep: false }).length, 16);
});
