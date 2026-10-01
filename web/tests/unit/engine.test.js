import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createChannel, createNote, createClip, currentArrangement, normalize, clone, barTicks } from '../../src/core/project.js';
import { demoProject } from '../../src/core/demo.js';
import { Engine } from '../../src/core/engine.js';
import { STEP, PPQ, BLOCK } from '../../src/core/constants.js';
import { collectFactorySamples } from '../../src/core/factory.js';
import { oneChannelProject, renderPat, renderSong, firstSound, onsets, peak, rms, SR } from './helpers.js';

test('step timing is sample accurate (no timer involved)', () => {
  const { p } = oneChannelProject('kick-punch', [0, 4, 8, 12]);
  const r = renderPat(p);
  const spStep = SR * 60 / 120 / 4;
  const on = onsets(r.left, 0.05, 4000);
  assert.equal(on.length, 4, `expected 4 onsets, got ${on.length}`);
  on.forEach((o, i) => assert.ok(Math.abs(o - i * 4 * spStep) <= 80, `hit ${i} at ${o}, expected ${i * 4 * spStep}`));
});

test('first note starts within a few samples of tick 0', () => {
  const { p } = oneChannelProject('kick-punch', [0]);
  const r = renderPat(p);
  assert.ok(firstSound(r.left, 0, 1e-3) < 60);
});

test('pattern renders exactly one bar of body plus tail', () => {
  const { p } = oneChannelProject('kick-punch', [0]);
  const r = renderPat(p, { tail: 0 });
  const bar = SR * 60 / 120 * 4;
  assert.ok(Math.abs(r.bodyFrames - bar) <= BLOCK, `body ${r.bodyFrames} vs ${bar}`);
});

test('tempo changes scale timing', () => {
  const a = oneChannelProject('kick-punch', [0, 8]); a.p.tempo = 120;
  const b = oneChannelProject('kick-punch', [0, 8]); b.p.tempo = 240;
  const oa = onsets(renderPat(a.p).left, 0.05, 3000), ob = onsets(renderPat(b.p).left, 0.05, 3000);
  assert.ok(Math.abs((oa[1] - oa[0]) / (ob[1] - ob[0]) - 2) < 0.02);
});

test('demo project renders finite audio with sane level', () => {
  const p = demoProject();
  const r = renderSong(p, { tail: 1 });
  assert.ok(r.frames > SR * 15, 'song too short');
  for (let i = 0; i < r.left.length; i += 97) assert.ok(Number.isFinite(r.left[i]) && Number.isFinite(r.right[i]));
  const pk = Math.max(peak(r.left), peak(r.right));
  assert.ok(pk > 0.2 && pk < 3, `peak ${pk}`);
});

test('song mode honours clip positions', () => {
  const { p, ch } = oneChannelProject('kick-punch', [0]);
  const arr = currentArrangement(p), bar = barTicks(p.timeSig);
  arr.clips.push(createClip(p, 'pattern', 1, 2 * bar, bar, 1));
  const r = renderSong(p, { tail: 0.3 });
  const on = onsets(r.left, 0.05, 4000);
  assert.equal(on.length, 1);
  assert.ok(Math.abs(on[0] - 2 * SR * 2) < 80, `onset ${on[0]}`);
});

test('muted playlist track and solo are respected', () => {
  const { p } = oneChannelProject('kick-punch', [0]);
  const arr = currentArrangement(p);
  arr.clips.push(createClip(p, 'pattern', 1, 0, 384, 1));
  arr.tracks[1] = { mute: 1 };
  assert.ok(peak(renderSong(p).left) < 1e-6);
  arr.tracks[1] = { mute: 0 }; arr.tracks[2] = { solo: 1 };
  assert.ok(peak(renderSong(p).left) < 1e-6, 'other track soloed -> silent');
});

test('mixer: mute, volume and routing through an insert', () => {
  const { p, ch } = oneChannelProject('kick-punch', [0]);
  const base = peak(renderPat(p).left);
  ch.mixer = 1;
  const viaInsert = peak(renderPat(p).left);
  assert.ok(Math.abs(viaInsert - base) / base < 0.02, 'insert at unity is transparent');
  p.mixer.tracks[1].vol = 0.4;
  assert.ok(peak(renderPat(p).left) < viaInsert * 0.5);
  p.mixer.tracks[1].vol = 0.8; p.mixer.tracks[1].mute = 1;
  assert.ok(peak(renderPat(p).left) < 1e-6);
  p.mixer.tracks[1].mute = 0;
  p.mixer.tracks[1].routes = [[2, 0.5, 0]]; p.mixer.tracks[2].routes = [[0, 1, 0]];
  const chain = peak(renderPat(p).left);
  assert.ok(Math.abs(chain / viaInsert - 0.5) < 0.03, `send level ratio ${chain / viaInsert}`);
});

test('mixer solo keeps the routing chain audible', () => {
  const { p, ch } = oneChannelProject('kick-punch', [0]);
  ch.mixer = 1;
  p.mixer.tracks[1].routes = [[2, 1, 0]]; p.mixer.tracks[2].routes = [[0, 1, 0]];
  p.mixer.tracks[2].solo = 1;
  assert.ok(peak(renderPat(p).left) > 0.1, 'feeder of a soloed track stays audible');
  p.mixer.tracks[2].solo = 0; p.mixer.tracks[3].solo = 1;
  assert.ok(peak(renderPat(p).left) < 1e-6, 'unrelated solo silences it');
});

test('equal-power panning', () => {
  const { p, ch } = oneChannelProject('kick-punch', [0]);
  ch.pan = -1;
  let r = renderPat(p);
  assert.ok(peak(r.right) < 1e-4 && peak(r.left) > 0.1);
  ch.pan = 1; r = renderPat(p);
  assert.ok(peak(r.left) < 1e-4 && peak(r.right) > 0.1);
});

test('automation clip drives a parameter (channel volume)', () => {
  const { p, ch } = oneChannelProject('kick-punch', [0, 4, 8, 12]);
  const au = createChannel(p, 'automation', { name: 'Vol auto', target: `ch:${ch.id}:vol`, len: 384 });
  au.points = [{ t: 0, v: 1, type: 'single', tension: 0, count: 4 }, { t: 384, v: 0, type: 'single', tension: 0, count: 4 }];
  p.channels.push(au);
  const arr = currentArrangement(p);
  arr.clips.push(createClip(p, 'pattern', 1, 0, 384, 1));
  arr.clips.push(createClip(p, 'automation', 2, 0, 384, au.id));
  const r = renderSong(p, { tail: 0.2 });
  const spStep = SR * 60 / 120 / 4;
  const level = (i) => peak(r.left.subarray(i * 4 * spStep | 0, (i * 4 * spStep | 0) + 3000));
  assert.ok(level(0) > level(1) && level(1) > level(2) && level(2) > level(3), 'levels should fall: ' + [0, 1, 2, 3].map(level).join(', '));
});

test('loop wrap keeps the pattern in time over many repeats (live engine)', () => {
  const { p } = oneChannelProject('kick-punch', [0]);
  p.settings.metronome = 0;
  const e = new Engine(SR);
  e.setProject(clone(p));

  
  for (const [id, s] of collectFactorySamples(p, SR)) e.addSample(id, s.rate, s.channels);
  e.play('pat', 0);
  const total = SR * 8; // 4 bars at 120 bpm
  const L = new Float32Array(total), R = new Float32Array(total);
  e.process(L, R, total);
  const on = onsets(L, 0.05, 4000);
  assert.equal(on.length, 4);
  for (let i = 1; i < on.length; i++) assert.ok(Math.abs(on[i] - on[i - 1] - SR * 2) <= 3, `bar length drift: ${on[i] - on[i - 1]}`);
});

test('normalize() repairs garbage and rejects foreign files', () => {
  assert.throws(() => normalize({}), /Not an FL LUA project/);
  assert.throws(() => normalize(null));
  const p = demoProject();
  const back = normalize(JSON.parse(JSON.stringify(p)));
  assert.equal(back.channels.length, p.channels.length);
  assert.equal(JSON.stringify(normalize(JSON.parse(JSON.stringify(back)))), JSON.stringify(back), 'normalize is idempotent');
  const bad = JSON.parse(JSON.stringify(p));
  bad.tempo = 1e9; bad.channels[0].vol = 'x'; bad.mixer.tracks[3].routes = [[3, 1, 0], [99999, 1, 0], [0, 7, 0]];
  bad.patterns[1].notes[bad.channels[0].id].push({ s: -5, l: 0, k: 9999, v: 1000 });
  const fixed = normalize(bad);
  assert.equal(fixed.tempo, 522); assert.equal(fixed.channels[0].vol, 0.8);
  assert.deepEqual(fixed.mixer.tracks[3].routes, [[0, 2, 0]]);
  const n = fixed.patterns[1].notes[fixed.channels[0].id].at(-1);
  assert.ok(n.s >= 0 && n.l >= 1 && n.k <= 120 && n.v <= 127);
});

test('routing cycles are dropped on load', () => {
  const p = demoProject();
  p.mixer.tracks[1].routes = [[2, 1, 0]]; p.mixer.tracks[2].routes = [[1, 1, 0], [0, 1, 0]];
  const fixed = normalize(JSON.parse(JSON.stringify(p)));
  assert.ok(!(fixed.mixer.tracks[1].routes.length && fixed.mixer.tracks[2].routes.some((r) => r[0] === 1)), 'cycle must be broken');
});

// ------------------------------------------------------------------ mixer integration
import { createFxSlot } from '../../src/core/project.js';
import { addFactorySampler, setSteps } from '../../src/core/demo.js';
import { renderOffline } from '../../src/core/offline.js';

function kickProject(mixer = 1) {
  const p = createProject(); p.tempo = 120;
  const ch = addFactorySampler(p, 'kick-punch', { mixer });
  setSteps(p, 1, ch, [0], 127);
  return { p, ch };
}
const rndr = (p, o = {}) => renderOffline(p, collectFactorySamples(p, SR), { mode: 'pat', sampleRate: SR, tail: 0.3, ...o });

test('effect slot on an insert changes the sound (EQ low-pass removes the hat)', () => {
  const p = createProject(); p.tempo = 120;
  const hat = addFactorySampler(p, 'hat-closed', { mixer: 1 });
  setSteps(p, 1, hat, [0], 127);
  const dry = rms(rndr(p).left);
  p.mixer.tracks[1].fx[0] = createFxSlot('eq');
  p.mixer.tracks[1].fx[0].params.b7type = 3; p.mixer.tracks[1].fx[0].params.b7freq = 300; p.mixer.tracks[1].fx[0].params.b7slope = 1;
  const wet = rms(rndr(p).left);
  assert.ok(wet < dry * 0.2, `hat rms ${dry} -> ${wet}`);
  p.mixer.tracks[1].fx[0].on = 0;
  assert.ok(Math.abs(rms(rndr(p).left) / dry - 1) < 0.02, 'bypass restores the dry sound');
  p.mixer.tracks[1].fx[0].on = 1; p.mixer.tracks[1].fx[0].mix = 0;
  assert.ok(Math.abs(rms(rndr(p).left) / dry - 1) < 0.02, 'mix = 0 is dry');
});

test('sidechain route makes a compressor duck the bass', () => {
  const build = (withSc) => {
    const p = createProject(); p.tempo = 120;
    const kick = addFactorySampler(p, 'kick-punch', { mixer: 1 });
    const bass = addFactorySampler(p, 'sub-808', { mixer: 2 });
    bass.params.loop = 1; bass.params.loopStart = 0.3; bass.params.loopEnd = 0.6; bass.params.ignoreOff = 0; bass.params.volEnvOn = 1; bass.params.volSus = 1; bass.params.volDec = 0.01;
    setSteps(p, 1, kick, [0, 8], 127);
    const list = p.patterns[1].notes[bass.id] = []; list.push({ id: 900, s: 0, l: 384, k: 60, v: 100 });
    if (withSc) {
      p.mixer.tracks[2].fx[0] = createFxSlot('compressor');
      Object.assign(p.mixer.tracks[2].fx[0].params, { threshold: -40, ratio: 20, attack: 1, release: 120, sidechain: 1 });
      p.mixer.tracks[1].routes = [[0, 0.0001, 0], [2, 1, 1]];   // kick -> sidechain bus of the bass insert (inaudible on master)
    } else p.mixer.tracks[1].routes = [[0, 0, 0]];                // baseline: bass alone, no compressor
    p.mixer.tracks[1].vol = 0.8;
    return p;
  };
  const a = rndr(build(false)), b = rndr(build(true));
  const win = (r) => rms(r.left, 2000, 9000);
  assert.ok(win(a) > 0.05, `bass should be audible without sidechain: ${win(a)}`);
  assert.ok(win(b) < win(a) * 0.5, `sidechain should duck the bass: ${win(b)} vs ${win(a)}`);
});

test('plugin delay compensation: parallel paths with different latency stay aligned', () => {
  const { p } = kickProject(1);
  p.mixer.tracks[1].routes = [[0, 1, 0], [2, 1, 0]];
  p.mixer.tracks[2].routes = [[0, 1, 0]];
  const q = clone(p); q.mixer.tracks[1].routes = [[0, 1, 0]];
  const single = peak(rndr(q).left);
  p.mixer.tracks[2].fx[0] = createFxSlot('limiter');
  p.mixer.tracks[2].fx[0].params.ceiling = 0; p.mixer.tracks[2].fx[0].params.lookahead = 5;
  const r = rndr(p);
  // aligned paths add up to roughly twice the kick; without PDC the 5 ms offset would smear them
  assert.ok(peak(r.left) > single * 1.7, `summed peak ${peak(r.left)} vs single ${single}`);
  const first = r.left.findIndex((v) => Math.abs(v) > 0.02);
  assert.ok(first >= 0 && first < 400, `onset at ${first}`);
  // the whole mix is late by exactly the limiter latency, and both paths agree
  const lat = Math.round(0.005 * SR);
  const noPdc = (() => { const q = clone(p); q.mixer.tracks[2].fx[0].on = 0; return rndr(q); })();
  const f0 = noPdc.left.findIndex((v) => Math.abs(v) > 0.02);
  assert.ok(Math.abs(first - f0 - lat) <= 3, `latency ${first - f0}, expected ${lat}`);
});

test('mixer handles all 125 inserts with effects without breaking', () => {
  const p = createProject(); p.tempo = 120;
  for (let t = 1; t <= 125; t++) {
    const ch = addFactorySampler(p, t % 2 ? 'hat-closed' : 'kick-short', { mixer: t });
    setSteps(p, 1, ch, [t % 16], 100);
    if (t % 5 === 0) p.mixer.tracks[t].fx[0] = createFxSlot('compressor');
    if (t % 7 === 0) p.mixer.tracks[t].fx[1] = createFxSlot('delay');
  }
  const r = rndr(p);
  assert.ok(r.frames > 0 && peak(r.left) > 0.05);
  for (let i = 0; i < r.left.length; i += 211) assert.ok(Number.isFinite(r.left[i]));
});
