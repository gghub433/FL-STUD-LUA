import test from 'node:test';
import assert from 'node:assert/strict';
import { createEffect } from '../../src/core/effects/index.js';
import { COLUMNS, VECTOR_POINTS } from '../../src/core/effects/scope.js';
import { tensionCurve } from '../../src/core/effects/peakctl.js';
import { MODES, CEILING } from '../../src/core/effects/polish.js';
import { createProject, createChannel, createNote, createFxSlot, normalize, clone } from '../../src/core/project.js';
import { Engine } from '../../src/core/engine.js';
import { Noise } from '../../src/core/dsp.js';
import { Store } from '../../src/app/store.js';
import * as cmd from '../../src/app/commands.js';
import { STEP } from '../../src/core/constants.js';
import { collectFactorySamples } from '../../src/core/factory.js';
import { oneChannelProject, renderPat, rms, peak, SR } from './helpers.js';

const sine = (f, s, a = 0.5, ph = 0) => Float32Array.from({ length: Math.floor(s * SR) }, (_, i) => a * Math.sin(2 * Math.PI * f * i / SR + ph));
const noise = (s, a, seed) => { const z = new Noise(seed); return Float32Array.from({ length: Math.floor(s * SR) }, () => z.next() * a); };
const constant = (s, a) => new Float32Array(Math.floor(s * SR)).fill(a);

function engineFor(p) {
  const e = new Engine(SR);
  e.setProject(clone(p));
  for (const [id, s] of collectFactorySamples(p, SR)) e.addSample(id, s.rate, s.channels);
  return e;
}

// runs an effect over L/R in 128-sample blocks; each(fx, offset) runs before every block
function run(type, params, inL, inR = inL, ctx = { scL: null, scR: null }, each = null) {
  const fx = createEffect(type, SR, { tempo: 120, tick: 0, playing: false, sr: SR, getSample: () => null });
  for (const [k, v] of Object.entries(params || {})) fx.setParam(k, v);
  const L = Float32Array.from(inL), R = Float32Array.from(inR);
  for (let o = 0; o < L.length; o += 128) {
    const m = Math.min(128, L.length - o);
    if (each) each(fx, o);
    fx.process(L.subarray(o, o + m), R.subarray(o, o + m), m, ctx);
  }
  return { L, R, fx };
}

// ---- Scope -------------------------------------------------------------------------------------------------------
test('Scope: the audio passes bit-exact, watched or not; unwatched it collects nothing', () => {
  const inL = noise(0.5, 0.8, 3), inR = sine(330, 0.5, 0.9);
  for (const watch of [false, true]) {
    const r = run('scope', {}, inL, inR, { scL: null, scR: null, watch });
    for (let i = 0; i < inL.length; i++) assert.ok(r.L[i] === inL[i] && r.R[i] === inR[i], `sample ${i} changed (watch ${watch})`);
    if (!watch) assert.equal(r.fx.view(), null, 'nothing to show while nobody watches');
  }
});

test('Scope: views carry oscilloscope columns, vectorscope points, peak / RMS and correlation', () => {
  const x = sine(500, 1.5, 0.5);
  const mono = run('scope', { time: 10, trigger: 1 }, x, x, { watch: true });
  const v = mono.fx.view();
  assert.ok(v, 'a view after half a second');
  assert.equal(v.wave.length, COLUMNS * 4); assert.equal(v.vec.length, VECTOR_POINTS * 2);
  assert.ok(Math.abs(v.peak[0] - 0.5) < 0.01 && Math.abs(v.peak[1] - 0.5) < 0.01, `peak ${v.peak}`);
  assert.ok(Math.abs(v.rms[0] - 0.5 / Math.SQRT2) < 0.02, `rms ${v.rms}`);
  assert.ok(v.corr > 0.99, `identical channels correlate: ${v.corr}`);
  // the trigger starts the window on a rising zero crossing; 10 ms = 5 periods of 500 Hz
  assert.ok(Math.abs(v.wave[0]) < 0.05 && v.wave[4 + 1] > v.wave[1], 'window starts at a rising zero crossing');
  let crossings = 0; for (let c = 1; c < COLUMNS; c++) if (v.wave[(c - 1) * 4 + 1] < 0 && v.wave[c * 4 + 1] >= 0) crossings++;
  assert.ok(crossings >= 4 && crossings <= 5, `about 5 periods in the window: ${crossings}`);
  assert.equal(mono.fx.view(), null, 'rate-limited: no second view without new audio');
  const inverted = run('scope', {}, x, x.map((s) => -s), { watch: true }).fx.view();
  assert.ok(inverted.corr < -0.99, `out of phase: ${inverted.corr}`);
  const wide = run('scope', {}, noise(0.5, 0.5, 1), noise(0.5, 0.5, 2), { watch: true }).fx.view();
  assert.ok(Math.abs(wide.corr) < 0.15, `unrelated noise: ${wide.corr}`);
  const silent = run('scope', {}, new Float32Array(SR / 4), new Float32Array(SR / 4), { watch: true }).fx.view();
  assert.equal(silent.corr, null, 'no correlation reading on silence');
});

test('Scope in the mixer: views are sent only while its slot is watched', () => {
  const { p } = oneChannelProject('kick-punch', [0, 4, 8, 12]);
  p.channels[0].mixer = 1;
  p.mixer.tracks[1].fx[0] = createFxSlot('scope');
  const e = engineFor(p);
  e.play('pat', 0);
  const L = new Float32Array(128), R = new Float32Array(128);
  const count = (blocks) => { let n = 0; for (let i = 0; i < blocks; i++) { e.process(L, R, 128); const m = e.drain(); if (m) n += m.filter((x) => x.t === 'fxview' && x.track === 1 && x.slot === 0).length; } return n; };
  assert.equal(count(400), 0, 'nobody watches: no views');
  e.watch(1, 0);
  const n = count(690);                              // 2 s
  assert.ok(n >= 40 && n <= 70, `about 30 views a second: ${n}`);
  e.watch(null);
  assert.equal(count(200), 0, 'window closed: no views');
});

// ---- Peak controller -----------------------------------------------------------------------------------------------
test('Peak controller: attack and release follow their time constants', () => {
  const att = 10, rel = 100;
  const fx = createEffect('peakctl', SR, {});
  fx.setParam('attack', att); fx.setParam('release', rel);
  const blk = (a, blocks) => { let v = 0; const L = new Float32Array(128), R = new Float32Array(128); for (let b = 0; b < blocks; b++) { L.fill(a); R.fill(a); fx.process(L, R, 128); v = fx.control(128); } return v; };
  const nAtt = Math.round((att / 1000) * SR / 128);
  const up = blk(1, nAtt);                           // one attack time of full scale
  assert.ok(Math.abs(up - (1 - Math.exp(-(nAtt * 128) / (att / 1000 * SR)))) < 0.02 && up > 0.55 && up < 0.7, `after the attack time: ${up}`);
  const top = blk(1, 200);
  assert.ok(top > 0.999, `settles at full level: ${top}`);
  const nRel = Math.round((rel / 1000) * SR / 128);
  const down = blk(0, nRel);
  assert.ok(Math.abs(down - Math.exp(-(nRel * 128) / (rel / 1000 * SR))) < 0.02, `after the release time ≈ 1/e: ${down}`);
  // a skipped (silent, inactive) track: control() alone lets the value fall the same way
  blk(1, 200);
  let v = 0; for (let b = 0; b < nRel; b++) v = fx.control(128);
  assert.ok(Math.abs(v - down) < 0.02, `release without process(): ${v} vs ${down}`);
});

test('Peak controller: base, amount, tension, input gain, RMS detector, LFO and mute', () => {
  const level = (params, x) => { let v = 0; run('peakctl', params, x, x, {}, (fx, o) => { if (o) v = fx.control(128); }); return v; };
  const half = constant(0.5, 0.25);
  assert.ok(Math.abs(level({}, half) - 0.25) < 0.01, 'linear follower');
  assert.ok(Math.abs(level({ tension: 1 }, half) - tensionCurve(0.25, 1)) < 0.01 && tensionCurve(0.25, 1) > 0.69, 'tension > 0 reacts more to quiet signals');
  assert.ok(level({ tension: -1 }, half) < 0.01, 'tension < 0 reacts less');
  assert.ok(Math.abs(level({ gain: 6.0206 }, half) - 0.5) < 0.01, '+6 dB input gain doubles the level');
  assert.ok(Math.abs(level({ base: 1, amount: -1 }, half) - 0.75) < 0.01, 'negative amount from a high base: ducking');
  assert.ok(Math.abs(level({ base: 0.3, amount: 0 }, half) - 0.3) < 1e-9, 'amount 0 = base');
  assert.ok(Math.abs(level({ detect: 1 }, sine(200, 0.5, 0.5)) - 0.5) < 0.03, 'RMS detector reads a sine by its amplitude');
  const vals = []; run('peakctl', { base: 0.5, amount: 0, lfoAmt: 1, lfoRate: 4 }, new Float32Array(SR), new Float32Array(SR), {}, (fx) => vals.push(fx.control(128)));
  assert.ok(Math.min(...vals) < 0.05 && Math.max(...vals) > 0.95, `LFO swings around the base: ${Math.min(...vals)}..${Math.max(...vals)}`);
  const muted = run('peakctl', { mute: 1 }, sine(300, 0.1), sine(300, 0.1));
  assert.ok(peak(muted.L) === 0 && peak(muted.R) === 0, 'mute silences the audio');
  const through = sine(300, 0.1), r = run('peakctl', {}, through, through);
  assert.ok(r.L.every((s, i) => s === through[i]), 'otherwise the audio passes untouched');
});

// a kick on insert 1 drives (inverted) the volume of insert 2, which carries a held organ chord: ducking
function duckProject() {
  const { p, ch } = oneChannelProject('kick-punch', [0, 4, 8, 12]);
  ch.mixer = 1;
  const organ = createChannel(p, 'organ', { name: 'Pad', mixer: 2 });
  p.channels.push(organ);
  p.patterns[1].notes[organ.id] = [createNote(p, 0, 16 * STEP, 60, 110)];
  const slot = createFxSlot('peakctl');
  Object.assign(slot.params, { base: 1, amount: -1, gain: 6, attack: 0.5, release: 120, mute: 1 });
  slot.links.push({ addr: 'mx:2:vol', min: 0, max: 0.8, inv: 0 });
  p.mixer.tracks[1].fx[0] = slot;
  return p;
}

test('Peak controller in the engine: the linked knob follows the kick (and the UI hears about it)', () => {
  const p = duckProject();
  const e = engineFor(p);
  e.play('pat', 0);
  const L = new Float32Array(128), R = new Float32Array(128), vols = [];
  let auto = 0;
  for (let i = 0; i < Math.floor((2 * SR) / 128); i++) {
    e.process(L, R, 128); vols.push(e.project.mixer.tracks[2].vol);
    const m = e.drain(); if (m) auto += m.filter((x) => x.t === 'auto' && x.values.some(([a]) => a === 'mx:2:vol')).length;
  }
  assert.ok(Math.min(...vols) < 0.25, `ducked on the hits: ${Math.min(...vols)}`);
  assert.ok(Math.max(...vols) > 0.7, `back up between hits: ${Math.max(...vols)}`);
  const at = (s) => vols[Math.floor((s * SR) / 128)];
  assert.ok(at(0.53) < at(0.95), `down right after the 2nd kick (${at(0.53)}), up before the 3rd (${at(0.95)})`);
  assert.ok(auto > 10, 'value changes are echoed to the UI');
  // bypassed: lets go of the knob
  e.setParam('mx:1:fx:0:on', 0);
  const before = e.project.mixer.tracks[2].vol;
  for (let i = 0; i < 400; i++) e.process(L, R, 128);
  assert.equal(e.project.mixer.tracks[2].vol, before, 'a bypassed controller stops driving');
});

test('Peak controller works in an offline render (export): the pad is ducked by the muted kick', () => {
  const p = duckProject();
  const r = renderPat(p, { tail: 0 });
  const plain = clone(p); plain.mixer.tracks[1].fx[0].links = [];
  const ref = renderPat(plain, { tail: 0 });
  const win = (a, s0, s1) => rms(a, Math.floor(s0 * SR), Math.floor(s1 * SR));
  // right after the hits vs. the same stretch without the link
  const duck = win(r.left, 0.52, 0.6) / win(ref.left, 0.52, 0.6), open = win(r.left, 0.9, 0.98) / win(ref.left, 0.9, 0.98);
  assert.ok(duck < 0.35, `ducked after a hit: ${duck}`);
  assert.ok(open > 0.6 && open > 4 * duck, `open again before the next hit: ${open} (ducked ${duck})`);
});

test('Peak controller links survive save/load, bad links are dropped, other effects get none; undo restores them', async () => {
  const p = duckProject();
  p.mixer.tracks[3].fx[0] = { ...createFxSlot('eq'), links: [{ addr: 'mx:2:vol', min: 0, max: 1, inv: 0 }] };
  const raw = JSON.parse(JSON.stringify(p));
  raw.mixer.tracks[1].fx[0].links.push({ addr: 7 }, null, { addr: 'y'.repeat(200), min: -3, max: 9, inv: 'x' });
  const q = normalize(raw);
  const links = q.mixer.tracks[1].fx[0].links;
  assert.deepEqual(links[0], { addr: 'mx:2:vol', min: 0, max: 0.8, inv: 0 });
  assert.equal(links.length, 2);
  assert.ok(links[1].addr.length === 80 && links[1].min === 0 && links[1].max === 1 && links[1].inv === 1, 'clamped');
  assert.equal(q.mixer.tracks[3].fx[0].links, undefined, 'only controller effects carry links');
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(q))), q, 'idempotent');

  const store = new Store({ send() {} }, { ensureProject: async () => [], ensure() {} });
  cmd.setFx(store, 1, 0, 'peakctl');
  const ch = cmd.addChannel(store, 'subsynth');
  cmd.linkFxController(store, 1, 0, `ch:${ch.id}:p:cutoff`, { min: 0.2, max: 0.9, inv: 1 });
  cmd.updateFxLink(store, 1, 0, 0, { max: 0.7 });
  assert.deepEqual(store.project.mixer.tracks[1].fx[0].links, [{ addr: `ch:${ch.id}:p:cutoff`, min: 0.2, max: 0.7, inv: 1 }]);
  await store.undo();
  assert.equal(store.project.mixer.tracks[1].fx[0].links[0].max, 0.9, 'undo the range change');
  await store.undo();
  assert.deepEqual(store.project.mixer.tracks[1].fx[0].links, [], 'undo the link');
  await store.redo(); await store.redo();
  cmd.removeChannel(store, ch.id);
  assert.deepEqual(store.project.mixer.tracks[1].fx[0].links, [], 'deleting the channel removes links to it');
  await store.undo();
  assert.equal(store.project.mixer.tracks[1].fx[0].links.length, 1, 'and undo brings them back');
  cmd.unlinkFxController(store, 1, 0, `ch:${ch.id}:p:cutoff`);
  assert.deepEqual(store.project.mixer.tracks[1].fx[0].links, []);
});

// ---- Polish -------------------------------------------------------------------------------------------------------
test('Polish never exceeds 0 dBFS on a full-scale sine, in every mode, at 100 %', () => {
  for (let mode = 0; mode < MODES.length; mode++) {
    for (const f of [40, 120, 1000, 6000, 15000]) {
      const x = sine(f, 1, 1), y = sine(f, 1, 1, 0.7);
      const r = run('polish', { amount: 100, mode }, x, y);
      const pk = Math.max(peak(r.L), peak(r.R));
      assert.ok(pk <= CEILING + 1e-6 && pk < 1, `${MODES[mode]} ${f} Hz: peak ${pk}`);
      assert.ok(pk > 0.3, `${MODES[mode]} ${f} Hz still sounds: ${pk}`);
    }
    // hot noise with peaks far above full scale
    const r = run('polish', { amount: 100, mode }, noise(1, 1.8, 4), noise(1, 1.8, 5));
    assert.ok(Math.max(peak(r.L), peak(r.R)) < 1, `${MODES[mode]}: overs are caught`);
  }
});

test('Polish: 0 % is a true bypass; the modes differ; quiet signals keep their level', () => {
  const x = sine(440, 0.5, 0.9);
  const off = run('polish', { amount: 0 }, x, x);
  assert.ok(off.L.every((s, i) => s === x[i]), '0 % leaves every sample alone');
  const n1 = noise(2, 0.2, 7), n2 = noise(2, 0.2, 8);
  const outs = MODES.map((_, mode) => run('polish', { amount: 100, mode }, n1, n2));
  const side = (r) => { let s = 0, m = 0; for (let i = SR; i < r.L.length; i++) { s += (r.L[i] - r.R[i]) ** 2; m += (r.L[i] + r.R[i]) ** 2; } return Math.sqrt(s / m); };
  assert.ok(side(outs[2]) > side(outs[0]) * 1.15, `Wide widens more than Warm: ${side(outs[2])} vs ${side(outs[0])}`);
  const hi = (r) => { let d = 0; for (let i = SR + 1; i < r.L.length; i++) d += (r.L[i] - r.L[i - 1]) ** 2; return d; };   // high-frequency energy
  assert.ok(hi(outs[1]) > hi(outs[0]) * 1.4, 'Bright is brighter than Warm');
  for (const r of outs) assert.ok(Math.abs(20 * Math.log10(rms(r.L, SR) / rms(n1, SR))) < 4, 'level stays within 4 dB');
  const q = sine(1000, 1.5, 0.05), rq = run('polish', { amount: 100, mode: 3 }, q, q);
  assert.ok(Math.abs(20 * Math.log10(rms(rq.L, SR) / rms(q, SR))) < 1.5, 'a quiet tone is not pumped up or down');
  // moving the knob does not click: no jump between neighbouring samples beyond what the signal itself does
  const s = sine(220, 1, 0.5), moved = run('polish', { amount: 0, mode: 0 }, s, s, {}, (fx, o) => fx.setParam('amount', Math.min(100, (o / SR) * 400)));
  let jump = 0; for (let i = 1; i < moved.L.length; i++) jump = Math.max(jump, Math.abs(moved.L[i] - moved.L[i - 1]));
  assert.ok(jump < 0.06, `largest step ${jump}`);
});

test('the new effects have factory presets and are offered where effects are listed', async () => {
  const { EFFECT_PRESETS } = await import('../../src/core/presets.js');
  const { EFFECTS } = await import('../../src/core/effects/index.js');
  const { canHostEffect } = await import('../../src/core/patcher/spec.js');
  for (const t of ['scope', 'peakctl', 'polish']) {
    assert.ok(Object.keys(EFFECT_PRESETS[t] || {}).length >= 3, `${t} presets`);
    assert.ok(EFFECTS[t].meta.category, `${t} category`);
  }
  assert.ok(canHostEffect('polish') && !canHostEffect('scope') && !canHostEffect('peakctl'), 'the analyser and the controller need a mixer slot');
  assert.deepEqual(createProject().mixer.tracks[0].fx.filter(Boolean), []);
});
