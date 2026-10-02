import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createInstrument } from '../../src/core/instruments/index.js';
import { createEffect } from '../../src/core/effects/index.js';
import {
  defaultPatch, emptyPatch, addNode, connect, disconnect, wireProblem, removeNodes, setExposed, duplicateNodes, normalizePatch, getNode,
  portsOf, nodeInfo, modPort, patchSampleIds, projectPatchSampleIds, NODE_TYPES, MAX_NODES,
} from '../../src/core/patcher/spec.js';
import { createProject, createChannel, createFxSlot, normalize, createNote } from '../../src/core/project.js';
import { renderOffline } from '../../src/core/offline.js';

const SR = 44100;
const host = () => ({ tempo: 120, tick: 0, playing: false, sr: SR, getSample: () => null });
const peak = (a, f = 0, t = a.length) => { let m = 0; for (let i = Math.floor(f); i < t; i++) m = Math.max(m, Math.abs(a[i])); return m; };
const rms = (a, f = 0, t = a.length) => { let s = 0; for (let i = f; i < t; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, t - f)); };
const crossings = (a, f = 4000) => { let n = 0; for (let i = f + 1; i < a.length; i++) if (a[i - 1] <= 0 && a[i] > 0) n++; return n; };

// instrument-style render in 128-frame blocks with events at sample offsets
function render(inst, n, events = []) {
  const L = new Float32Array(n), R = new Float32Array(n);
  const ev = [...events].sort((a, b) => a.at - b.at);
  for (let b = 0; b < n; b += 128) {
    const e = Math.min(n, b + 128);
    let pos = b;
    for (const x of ev) if (x.at >= b && x.at < e) { if (x.at > pos) { inst.process(L, R, pos, x.at); pos = x.at; } x.fn(); }
    if (pos < e) inst.process(L, R, pos, e);
  }
  return { L, R };
}

// a patch builder: nodes by name, returns { patch, n } with helper to wire by names
function build(kind, defs, wires) {
  const patch = emptyPatch(), n = {};
  for (const [name, type, opts] of defs) { const node = addNode(patch, type, opts); assert.ok(node, `node ${name}`); n[name] = node; }
  for (const [a, ap, b, bp] of wires) assert.ok(connect(patch, [n[a].id, ap], [n[b].id, bp]), `wire ${a}.${ap} -> ${b}.${bp}`);
  return { patch, n };
}
const sineOrgan = { ref: 'organ', params: { d0: 0, d1: 0, d2: 8, d3: 0, d4: 0, d5: 0, d6: 0, d7: 0, d8: 0, perc: 0, click: 0, vibrato: 0, rotary: 0, drive: 0, release: 20 } };
const patcherInst = (patch) => { const i = createInstrument('patcher', SR, host()); i.setData({ patch }); return i; };
const on = (inst, key, extra = {}) => () => inst.noteOn({ key, vel: 1, pan: 0, fine: 0, rel: 64, ...extra });
const off = (inst, key) => () => inst.noteOff(key);

test('the default instrument patch (Note In -> SubSynth -> Audio Out) plays notes and falls silent after the release', () => {
  const inst = createInstrument('patcher', SR, host());
  inst.setData({ patch: defaultPatch('instrument') });
  const { L } = render(inst, SR * 3, [{ at: 0, fn: on(inst, 69) }, { at: 10000, fn: off(inst, 69) }]);
  assert.ok(peak(L, 2000, 9000) > 0.05, 'audible while held');
  assert.ok(peak(L, Math.floor(SR * 2.8)) < 1e-4, 'silent after release');
  assert.equal(inst.active, false, 'channel reports idle so the engine can skip it');
});

test('module entry order does not matter (spec.js, runtime.js, instruments and effects each as the first import)', () => {
  for (const entry of ['patcher/spec.js', 'patcher/runtime.js', 'instruments/index.js', 'effects/index.js', 'project.js']) {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `import('${new URL(`../../src/core/${entry}`, import.meta.url).href}').then(() => console.log('ok'))`], { encoding: 'utf8' });
    assert.equal(out.trim(), 'ok', entry);
  }
});

test('wiring rules: kinds must match, no duplicates, no loops, exposed parameters take control wires', () => {
  const { patch, n } = build('instrument', [['nin', 'noteIn'], ['lfo', 'lfo'], ['g', 'gain'], ['out', 'audioOut'], ['g2', 'gain']], []);
  assert.match(wireProblem(patch, [n.nin.id, 'notes'], [n.g.id, 'in']), /note into audio/);
  assert.ok(connect(patch, [n.g.id, 'out'], [n.g2.id, 'in']));
  assert.match(wireProblem(patch, [n.g.id, 'out'], [n.g2.id, 'in']), /Already/);
  assert.match(wireProblem(patch, [n.g2.id, 'out'], [n.g.id, 'in']), /loop/);
  assert.match(wireProblem(patch, [n.g.id, 'out'], [n.g.id, 'in']), /itself/);
  assert.match(wireProblem(patch, [n.lfo.id, 'out'], [n.g.id, modPort('level')]), /Unknown port/);
  assert.ok(setExposed(patch, n.g.id, 'level', true));
  assert.ok(portsOf(n.g).ins.some((p) => p.id === 'p:level' && p.type === 'ctl'));
  const w = connect(patch, [n.lfo.id, 'out'], [n.g.id, modPort('level')]);
  assert.ok(w);
  setExposed(patch, n.g.id, 'level', false);
  assert.equal(patch.wires.some((x) => x.id === w.id), false, 'hiding a parameter drops its wires');
  assert.equal(addNode(patch, 'noteIn'), null, 'single Note In per patch');
  removeNodes(patch, [n.g.id]);
  assert.equal(patch.wires.some((x) => x.from[0] === n.g.id || x.to[0] === n.g.id), false);
  const dup = duplicateNodes(patch, [n.g2.id, n.nin.id]);
  assert.equal(dup.length, 1, 'unique nodes are not duplicated');
  disconnect(patch, 12345);
  while (patch.nodes.length < MAX_NODES) addNode(patch, 'gain');
  assert.equal(addNode(patch, 'gain'), null, 'node limit');
});

test('normalizePatch repairs or drops garbage and never throws', () => {
  const junk = [null, 5, 'x', {}, { nodes: 3 }, { nodes: [null, 1, { id: 1, type: 'nope' }, { id: 2, type: 'inst', ref: 'patcher' }, { id: 3, type: 'fx', ref: 'reverb', params: { size: 1e9, bogus: 1 }, mods: ['size', 'nope', 'size'] },
    { id: 3, type: 'gain' }, { id: 4, type: 'noteIn' }, { id: 5, type: 'noteIn' }, { id: 6, type: 'gain', x: NaN, y: 1e9 }, { id: 7, type: 'gain' }],
  wires: [{ from: [4, 'notes'], to: [3, 'in'] }, { from: [3, 'out'], to: [6, 'in'] }, { from: [6, 'out'], to: [7, 'in'] }, { from: [7, 'out'], to: [6, 'in'] }, { from: [99, 'x'], to: [1, 'y'] }, 'junk', { from: 1 }] }];
  for (const j of junk) { const p = normalizePatch(j, 'instrument'); assert.ok(Array.isArray(p.nodes) && Array.isArray(p.wires)); }
  const p = normalizePatch(junk[junk.length - 1]);
  assert.deepEqual(p.nodes.map((x) => x.id).sort(), [3, 4, 6, 7], 'unknown plugin types, nested patchers and duplicates are dropped');
  assert.equal(p.nodes.filter((x) => x.type === 'noteIn').length, 1);
  const fx = getNode(p, 3);
  assert.deepEqual(fx.mods, ['size']);
  assert.ok(fx.params.size <= nodeInfo(fx).params.find((d) => d.id === 'size').max, 'parameters are clamped');
  assert.equal(getNode(p, 6).y, 5000);
  assert.equal(p.wires.length, 2, 'the feedback wire and the dangling wires are removed');
  assert.ok(p.next > 7);
  // idempotent
  assert.deepEqual(normalizePatch(JSON.parse(JSON.stringify(p))), p);
});

test('Transpose shifts the pitch (and the note-off still matches)', () => {
  const mk = (semis) => build('instrument', [['nin', 'noteIn'], ['t', 'transpose', { params: { semis } }], ['o', 'inst', sineOrgan], ['out', 'audioOut']],
    [['nin', 'notes', 't', 'notes'], ['t', 'notes', 'o', 'notes'], ['o', 'out', 'out', 'in']]);
  const run = (semis, key) => { const inst = patcherInst(mk(semis).patch); return render(inst, SR, [{ at: 0, fn: on(inst, key) }, { at: SR * 0.7, fn: off(inst, key) }]); };
  const a = crossings(run(0, 69).L), b = crossings(run(12, 57).L), c = crossings(run(0, 57).L);
  assert.ok(Math.abs(a - b) <= 2, `57+12 == 69 (${a} vs ${b})`);
  assert.ok(Math.abs(a - 2 * c) <= 4, `octave ratio (${a} vs 2*${c})`);
  const inst = patcherInst(mk(7).patch);
  const r = render(inst, SR, [{ at: 0, fn: on(inst, 60) }, { at: 5000, fn: off(inst, 60) }]);
  assert.ok(peak(r.L, SR - 2000) < 1e-3, 'released');
});

test('Note filter splits the keyboard; Chord stacks notes; Velocity node rewrites velocities', () => {
  const { patch, n } = build('instrument', [['nin', 'noteIn'], ['f', 'noteFilter', { params: { lo: 60, hi: 72 } }], ['o', 'inst', sineOrgan], ['out', 'audioOut']],
    [['nin', 'notes', 'f', 'notes'], ['f', 'notes', 'o', 'notes'], ['o', 'out', 'out', 'in']]);
  const inst = patcherInst(patch);
  const lo = render(inst, 8000, [{ at: 0, fn: on(inst, 48) }]);
  assert.ok(peak(lo.L) < 1e-6, 'key 48 is outside the window');
  const hi = render(inst, 8000, [{ at: 0, fn: on(inst, 64) }]);
  assert.ok(peak(hi.L) > 0.02, 'key 64 passes');
  n.f.params.invert = 1;
  inst.setData({ patch: JSON.parse(JSON.stringify(patch)) });
  inst.allOff();
  const inv = render(inst, 4000, [{ at: 0, fn: on(inst, 48) }]);
  assert.ok(peak(inv.L) > 0.02, 'inverted: 48 passes');

  const c = build('instrument', [['nin', 'noteIn'], ['ch', 'chord', { params: { chord: 1, octaves: 2 } }], ['o', 'inst', sineOrgan], ['out', 'audioOut']],
    [['nin', 'notes', 'ch', 'notes'], ['ch', 'notes', 'o', 'notes'], ['o', 'out', 'out', 'in']]);
  const ci = patcherInst(c.patch);
  render(ci, 2000, [{ at: 0, fn: on(ci, 60) }]);
  const organ = ci.g.nodes.get(c.n.o.id).inst;
  assert.equal(organ.voices.filter((v) => v.alive).length, 6, 'major triad over two octaves = 6 voices');
  render(ci, SR / 2, [{ at: 0, fn: off(ci, 60) }]);
  assert.equal(organ.voices.filter((v) => v.alive && !v.released).length, 0, 'one note-off releases the whole chord');

  const vel = build('instrument', [['nin', 'noteIn'], ['v', 'velocity', { params: { mode: 1, fixed: 0.25 } }], ['o', 'inst', sineOrgan], ['out', 'audioOut']],
    [['nin', 'notes', 'v', 'notes'], ['v', 'notes', 'o', 'notes'], ['o', 'out', 'out', 'in']]);
  const vi = patcherInst(vel.patch);
  const quiet = render(vi, 8000, [{ at: 0, fn: on(vi, 69) }]);
  const loud = render(patcherInst(build('instrument', [['nin', 'noteIn'], ['o', 'inst', sineOrgan], ['out', 'audioOut']], [['nin', 'notes', 'o', 'notes'], ['o', 'out', 'out', 'in']]).patch), 8000, [{ at: 0, fn: (() => null) }]);
  assert.ok(peak(quiet.L) > 0.005 && peak(quiet.L) < 0.6, 'fixed velocity 0.25 plays quieter than full');
  assert.ok(loud.L.length === 8000);
});

test('a macro wired to an exposed parameter controls it (and automation of the macro works through setParam)', () => {
  const { patch, n } = build('instrument', [['nin', 'noteIn'], ['o', 'inst', sineOrgan], ['m', 'macro', { params: { n: 3 } }], ['g', 'gain'], ['out', 'audioOut']],
    [['nin', 'notes', 'o', 'notes'], ['o', 'out', 'g', 'in'], ['g', 'out', 'out', 'in']]);
  assert.ok(setExposed(patch, n.g.id, 'level', true));
  assert.ok(connect(patch, [n.m.id, 'out'], [n.g.id, modPort('level')]));
  const inst = patcherInst(patch);
  inst.noteOn({ key: 69, vel: 1, pan: 0, fine: 0 });
  inst.setParam('m3', 1);
  const full = rms(render(inst, 20000).L, 14000);
  inst.setParam('m3', 0.5);
  const half = rms(render(inst, 20000).L, 14000);
  inst.setParam('m3', 0);
  const none = rms(render(inst, 20000).L, 14000);
  assert.ok(full > 0.02, 'macro at 1 = level 2.0 (full range)');
  assert.ok(Math.abs(half / full - 0.5) < 0.05, `macro at 0.5 halves the level (${(half / full).toFixed(3)})`);
  assert.ok(none < 1e-4, 'macro at 0 mutes');
});

test('LFO modulates a parameter (tremolo), envelope follows notes, follower measures audio, math and map shape control signals', () => {
  const { patch, n } = build('instrument', [['nin', 'noteIn'], ['o', 'inst', sineOrgan], ['l', 'lfo', { params: { rate: 4, depth: 1, offset: 0.5 } }], ['g', 'gain'], ['out', 'audioOut']],
    [['nin', 'notes', 'o', 'notes'], ['o', 'out', 'g', 'in'], ['g', 'out', 'out', 'in']]);
  setExposed(patch, n.g.id, 'level', true);
  connect(patch, [n.l.id, 'out'], [n.g.id, modPort('level')]);
  const inst = patcherInst(patch);
  inst.noteOn({ key: 69, vel: 1, pan: 0, fine: 0 });
  const { L } = render(inst, SR);
  const env = []; for (let b = 8000; b + 441 < L.length; b += 441) env.push(peak(L, b, b + 441));
  assert.ok(Math.max(...env) > 3 * Math.min(...env) + 0.01, `amplitude swings (${Math.min(...env).toFixed(3)}..${Math.max(...env).toFixed(3)})`);

  // envelope -> level: silent before the note, rises while held, decays after release
  const e = build('instrument', [['nin', 'noteIn'], ['o', 'inst', sineOrgan], ['en', 'env', { params: { attack: 5, decay: 100, sustain: 0.5, release: 100 } }], ['g', 'gain'], ['out', 'audioOut']],
    [['nin', 'notes', 'o', 'notes'], ['nin', 'notes', 'en', 'notes'], ['o', 'out', 'g', 'in'], ['g', 'out', 'out', 'in']]);
  setExposed(e.patch, e.n.g.id, 'level', true);
  connect(e.patch, [e.n.en.id, 'out'], [e.n.g.id, modPort('level')]);
  const ei = patcherInst(e.patch);
  const r = render(ei, SR * 2, [{ at: 0, fn: on(ei, 69) }, { at: SR, fn: off(ei, 69) }]);
  assert.ok(rms(r.L, 22050, 40000) > 0.01, 'sustain level audible');
  assert.ok(rms(r.L, SR + 22050, SR + 30000) < rms(r.L, 22050, 40000) * 0.1, 'envelope released');

  // follower + math + map: control chain driven by audio level
  const f = build('effect', [['in', 'audioIn'], ['fo', 'follower', { params: { attack: 1, release: 50, boost: 0 } }], ['m', 'map', { params: { outLo: 0, outHi: 1, curve: 0 } }], ['g', 'gain'], ['out', 'audioOut']],
    [['in', 'out', 'fo', 'in'], ['fo', 'out', 'g', 'in'], ['g', 'out', 'out', 'in'], ['fo', 'level', 'm', 'in']]);
  const fx = createEffect('patcher', SR, host());
  fx.setExtra({ patch: f.patch });
  const L2 = new Float32Array(4096).fill(0.5), R2 = new Float32Array(4096).fill(0.5);
  fx.process(L2, R2, 128, {});
  assert.ok(peak(L2, 0, 128) > 0.49, 'follower passes the audio through');
  const fo = fx.g.nodes.get(f.n.fo.id), mp = fx.g.nodes.get(f.n.m.id);
  for (let i = 0; i < 20; i++) { L2.fill(0.5); R2.fill(0.5); fx.process(L2, R2, 128, {}); }
  assert.ok(fo.co.level > 0.45 && fo.co.level < 0.55, `level of a 0.5 signal (${fo.co.level})`);
  assert.ok(Math.abs(mp.co.out - fo.co.level) < 1e-9, 'map with defaults is the identity');
});

test('Math node operations', () => {
  const g = (op, a, b) => {
    const { patch, n } = build('effect', [['m', 'math', { params: { op, a, b } }]], []);
    const fx = createEffect('patcher', SR, host()); fx.setExtra({ patch });
    fx.process(new Float32Array(128), new Float32Array(128), 128, {});
    return fx.g.nodes.get(n.m.id).co.out;
  };
  assert.ok(Math.abs(g(0, 0.25, 0.5) - 0.75) < 1e-9);
  assert.ok(Math.abs(g(1, 0.75, 0.25) - 0.5) < 1e-9);
  assert.ok(Math.abs(g(2, 0.5, 0.5) - 0.25) < 1e-9);
  assert.equal(g(3, 0.3, 0.6), 0.3);
  assert.equal(g(4, 0.3, 0.6), 0.6);
  assert.ok(Math.abs(g(5, 0.2, 0.6) - 0.4) < 1e-9);
  assert.ok(Math.abs(g(8, 0.2, 0) - 0.8) < 1e-9);
  assert.equal(g(9, 0.6, 0.3), 1);
  assert.equal(g(0, 0.9, 0.9), 1, 'results are clamped to 0..1');
});

test('Effect Patcher: default is transparent, gain node scales, hosted effects and parallel paths sum, sidechain reaches the patch', () => {
  const fx0 = createEffect('patcher', SR, host());
  const L = new Float32Array(128).map((_, i) => Math.sin(i / 5)), R = L.map((v) => v * 0.5);
  const L0 = L.slice(), R0 = R.slice();
  fx0.process(L, R, 128, { scL: null, scR: null });
  assert.deepEqual([...L], [...L0]); assert.deepEqual([...R], [...R0]);

  const { patch, n } = build('effect', [['in', 'audioIn'], ['g', 'gain', { params: { level: 0.5 } }], ['d', 'fx', { ref: 'distortion' }], ['out', 'audioOut']],
    [['in', 'out', 'g', 'in'], ['g', 'out', 'out', 'in'], ['in', 'out', 'd', 'in'], ['d', 'out', 'out', 'in']]);
  const fx = createEffect('patcher', SR, host()); fx.setExtra({ patch });
  const A = new Float32Array(128).map((_, i) => 0.6 * Math.sin(i / 4)), B = A.slice();
  fx.process(A, B, 128, {});
  assert.ok(peak(A) > 0.3 * 0.99 && Number.isFinite(peak(A)), 'both paths are summed');
  assert.notDeepEqual([...A], [...L0]);

  const sc = build('effect', [['in', 'audioIn'], ['out', 'audioOut']], [['in', 'sc', 'out', 'in']]);
  const fs = createEffect('patcher', SR, host()); fs.setExtra({ patch: sc.patch });
  const X = new Float32Array(128).fill(0.1), Y = X.slice(), S = new Float32Array(128).fill(0.7), S2 = S.slice();
  fs.process(X, Y, 128, { scL: S, scR: S2 });
  assert.ok(Math.abs(X[10] - 0.7) < 1e-6, 'sidechain signal is available at Audio In');
  const X2 = new Float32Array(128).fill(0.1), Y2 = X2.slice();
  fs.process(X2, Y2, 128, { scL: null, scR: null });
  assert.equal(peak(X2), 0, 'no sidechain routed: silence');
});

test('effect nodes keep ringing without input, bypass passes audio, latency of look-ahead effects is reported', () => {
  const { patch, n } = build('effect', [['in', 'audioIn'], ['r', 'fx', { ref: 'reverb', params: { mix: 1 } }], ['out', 'audioOut']], [['in', 'out', 'r', 'in'], ['r', 'out', 'out', 'in']]);
  const fx = createEffect('patcher', SR, host()); fx.setExtra({ patch });
  const imp = new Float32Array(128); imp[0] = 1; const imp2 = imp.slice();
  fx.process(imp, imp2, 128, {});
  let energy = 0;
  for (let b = 0; b < 50; b++) { const a = new Float32Array(128), c = new Float32Array(128); fx.process(a, c, 128, {}); energy += rms(a); }
  assert.ok(energy > 0.01, 'reverb tail continues with silent input');

  n.r.bypass = 1;
  fx.setExtra({ patch: JSON.parse(JSON.stringify(patch)) });
  const A = new Float32Array(128).fill(0.3), B = A.slice();
  fx.process(A, B, 128, {});
  assert.ok(Math.abs(A[5] - 0.3) < 1e-6, 'bypassed node passes its input');

  const lim = build('effect', [['in', 'audioIn'], ['l', 'fx', { ref: 'limiter' }], ['out', 'audioOut']], [['in', 'out', 'l', 'in'], ['l', 'out', 'out', 'in']]);
  const fl = createEffect('patcher', SR, host()); fl.setExtra({ patch: lim.patch });
  assert.ok(fl.latency > 0, `limiter look-ahead reported (${fl.latency})`);
  assert.equal(createEffect('patcher', SR, host()).latency, 0);
});

test('hosted instrument in an Effect Patcher driven by nothing stays silent; Instrument Patcher with FX tail stays active, then idles', () => {
  const { patch } = build('instrument', [['nin', 'noteIn'], ['o', 'inst', sineOrgan], ['r', 'fx', { ref: 'delay' }], ['out', 'audioOut']],
    [['nin', 'notes', 'o', 'notes'], ['o', 'out', 'r', 'in'], ['r', 'out', 'out', 'in']]);
  const inst = patcherInst(patch);
  render(inst, 3000, [{ at: 0, fn: on(inst, 60) }, { at: 1000, fn: off(inst, 60) }]);
  assert.equal(inst.active, true, 'delay tail may still ring');
  render(inst, SR * 8);
  assert.equal(inst.active, false, 'idles after the tail time');
});

test('sample-accurate: a note at frame 70 of a block starts exactly there', () => {
  const inst = patcherInst(build('instrument', [['nin', 'noteIn'], ['o', 'inst', sineOrgan], ['out', 'audioOut']], [['nin', 'notes', 'o', 'notes'], ['o', 'out', 'out', 'in']]).patch);
  const { L } = render(inst, 512, [{ at: 70, fn: on(inst, 69) }]);
  assert.equal(peak(L, 0, 70), 0);
  assert.ok(peak(L, 70, 400) > 0.01);
});

test('project integration: channel and effect slot keep their patch through normalize(); samples of sampler nodes are listed; engine renders it', () => {
  const p = createProject();
  const ch = createChannel(p, 'patcher');
  assert.ok(ch.patch && ch.patch.nodes.length === 3);
  const sm = addNode(ch.patch, 'inst', { ref: 'sampler' }); sm.sample = { id: 'user:abc', name: 'x' };
  const cv = addNode(ch.patch, 'fx', { ref: 'convolver' }); cv.extra = { irId: 'user:ir1' };
  p.channels.push(ch);
  const slot = createFxSlot('patcher');
  assert.ok(slot.extra.patch.nodes.length === 2);
  p.mixer.tracks[1].fx[0] = slot;
  const q = normalize(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(q.channels[0].patch, ch.patch);
  assert.deepEqual(q.mixer.tracks[1].fx[0].extra.patch, slot.extra.patch);
  assert.deepEqual([...patchSampleIds(ch.patch)].sort(), ['user:abc', 'user:ir1']);
  assert.deepEqual([...projectPatchSampleIds(q)].sort(), ['user:abc', 'user:ir1']);
  // broken data in a file falls back to a working default instead of crashing the loader
  const bad = JSON.parse(JSON.stringify(p)); bad.channels[0].patch = { nodes: 'x' }; bad.mixer.tracks[1].fx[0].extra = null;
  const r = normalize(bad);
  assert.equal(r.channels[0].patch.nodes.length, 3);
  assert.equal(r.mixer.tracks[1].fx[0].extra.patch.nodes.length, 2);
  assert.equal(Object.keys(NODE_TYPES).filter((t) => NODE_TYPES[t].unique).length, 3);
});

test('engine renders a project whose channel is a Patcher and whose insert has an effect Patcher (offline = live path)', () => {
  const p = createProject();
  const ch = createChannel(p, 'patcher', { mixer: 1 });
  p.channels.push(ch);
  p.patterns[1] = p.patterns[1] || { id: 1, name: 'Pattern 1', notes: {} };
  p.patterns[p.currentPattern].notes[ch.id] = [createNote(p, 0, 96, 69, 100)];
  p.mixer.tracks[1].fx[0] = createFxSlot('patcher');
  const plain = JSON.parse(JSON.stringify(p));
  const out = renderOffline(p, new Map(), { mode: 'pat', tail: 1 });
  assert.ok(peak(out.left) > 0.05, `audible ${peak(out.left)}`);
  assert.ok(Number.isFinite(rms(out.left)));
  // the same project without the effect patcher renders the same audio (default effect patch is transparent)
  plain.mixer.tracks[1].fx[0] = null;
  const ref = renderOffline(plain, new Map(), { mode: 'pat', tail: 1 });
  const n = Math.min(ref.left.length, out.left.length);
  let d = 0; for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(ref.left[i] - out.left[i]));
  assert.ok(d < 1e-6, `transparent effect patch (max diff ${d})`);
});

test('factory patches are valid, survive normalize unchanged and make sound / process audio', async () => {
  const { PATCH_PRESETS } = await import('../../src/core/patcher/presets.js');
  for (const [name, mk] of Object.entries(PATCH_PRESETS.instrument)) {
    const patch = mk();
    assert.deepEqual(normalizePatch(JSON.parse(JSON.stringify(patch)), 'instrument'), patch, name);
    const inst = patcherInst(patch);
    const r = render(inst, SR, [{ at: 0, fn: on(inst, 60) }, { at: 0, fn: on(inst, 64) }, { at: SR * 0.8, fn: off(inst, 60) }, { at: SR * 0.8, fn: off(inst, 64) }]);
    assert.ok(peak(r.L, 2000, 30000) > 0.01 && Number.isFinite(rms(r.L)), `${name} is audible (${peak(r.L)})`);
  }
  for (const [name, mk] of Object.entries(PATCH_PRESETS.effect)) {
    const patch = mk();
    assert.deepEqual(normalizePatch(JSON.parse(JSON.stringify(patch)), 'effect'), patch, name);
    const fx = createEffect('patcher', SR, host()); fx.setExtra({ patch });
    let e = 0, early = 0, late = 0;
    for (let b = 0; b < 400; b++) {
      const L = new Float32Array(128).map((_, i) => 0.5 * Math.sin((b * 128 + i) / 6)), R = L.slice();
      const S = L.map((v) => (b < 5 ? v * 1.8 : 0));                  // a loud sidechain hit at the start, then silence
      fx.process(L, R, 128, { scL: S, scR: S.slice() });
      assert.ok(L.every(Number.isFinite), `${name} finite`);
      e += rms(L);
      if (b === 4) early = rms(L);
      if (b === 399) late = rms(L);
    }
    if (name.startsWith('Sidechain')) assert.ok(early < late * 0.4, `ducks while the sidechain is loud (${early.toFixed(3)} vs ${late.toFixed(3)})`);
    assert.ok(e > 0.2, `${name} passes sound (${e.toFixed(2)})`);
  }
});
