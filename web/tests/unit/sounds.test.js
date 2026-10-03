import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerPack, packSounds, renderPackSound } from '../../src/core/packs.js';
import { INSTRUMENTS } from '../../src/core/instruments/index.js';
import { create as createMulti, defaultZone, autoRanges } from '../../src/core/instruments/multisampler.js';
import { detectPitch, keyFromName } from '../../src/core/pitch-detect.js';
import { createProject, createChannel, createNote, normalize } from '../../src/core/project.js';
import { renderOffline } from '../../src/core/offline.js';
import { collectFactorySamples } from '../../src/core/factory.js';
import { STEP } from '../../src/core/constants.js';

const SR = 44100;
const load = (file) => { const src = fs.readFileSync(new URL(`../../packs/${file}`, import.meta.url), 'utf8'); let info; globalThis.__flluaRegisterPack = (d) => { info = registerPack(d); }; new Function(src)(); return info; };
const tone = (hz, sec = 1, shape = 'sine') => { const x = new Float32Array(Math.round(SR * sec)); for (let i = 0; i < x.length; i++) { const ph = (hz * i / SR) % 1; x[i] = shape === 'saw' ? 2 * ph - 1 : Math.sin(2 * Math.PI * ph); x[i] *= 0.5; } return x; };
const peak = (a) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i])); return m; };
function f0(x, from = 0.1, len = 0.2) {
  const a = Math.floor(from * SR), d = x.subarray(a, a + Math.floor(len * SR));
  let prev = Infinity, bestLag = 0;
  // first strong autocorrelation peak (avoids picking a multiple of the period)
  const ac = (lag) => { let s = 0; for (let i = 0; i + lag < d.length; i++) s += d[i] * d[i + lag]; return s; };
  const z = ac(0);
  for (let lag = 20; lag < SR / 40; lag++) { const v = ac(lag); if (v > 0.8 * z && v >= prev) { bestLag = lag; while (ac(bestLag + 1) > ac(bestLag)) bestLag++; break; } prev = v; }
  return SR / bestLag;
}

test('pitch detection and note names in file names', () => {
  for (const [hz, key] of [[220, 57], [261.63, 60], [82.41, 40], [880, 81]]) {
    const r = detectPitch([tone(hz, 1, 'saw')], SR);
    assert.ok(r && Math.abs(r.key - key) < 0.1, `${hz} Hz -> ${r && r.key}`);
  }
  assert.equal(detectPitch([new Float32Array(SR)], SR), null, 'silence');
  assert.equal(keyFromName('Piano C4.wav'), 60); assert.equal(keyFromName('harp_F#3'), 54); assert.equal(keyFromName('Strings-Bb2.flac'), 46);
  assert.equal(keyFromName('kick.wav'), null);
});

test('Multisampler: zones by key and velocity, pitched from their root; loops; auto ranges', () => {
  const samples = { a: { rate: SR, ch: [tone(220)], length: SR }, b: { rate: SR, ch: [tone(440)], length: SR } };
  const host = { getSample: (id) => samples[id] || null };
  const m = createMulti(SR, host);
  const zones = autoRanges([defaultZone({ id: 'a', name: 'A3' }, { root: 57 }), defaultZone({ id: 'b', name: 'A4' }, { root: 69 })]);
  assert.deepEqual(zones.map((z) => [z.lo, z.hi]), [[0, 63], [64, 127]]);
  m.setData({ zones });
  const play = (key, vel = 0.8, n = SR / 2) => { m.allOff(); m.noteOn({ key, vel, fine: 0 }); const L = new Float32Array(n), R = new Float32Array(n); for (let b = 0; b < n; b += 128) m.process(L, R, b, Math.min(n, b + 128)); return L; };
  assert.ok(Math.abs(f0(play(57)) - 220) < 2, 'A3 plays its own zone');
  assert.ok(Math.abs(f0(play(60)) - 261.6) < 3, 'C4 is A3 pitched up three semitones');
  assert.ok(Math.abs(f0(play(69)) - 440) < 3, 'A4 zone');
  // velocity layers
  m.setData({ zones: [defaultZone({ id: 'a', name: 'soft' }, { vhi: 64 }), defaultZone({ id: 'b', name: 'hard' }, { vlo: 65 })] });   // both rooted at C4
  assert.ok(Math.abs(f0(play(60, 0.3)) - 220) < 2, 'soft layer');
  assert.ok(Math.abs(f0(play(60, 0.9)) - 440) < 3, 'hard layer');
  // no zone, no sound; loop keeps a short sample going
  m.setData({ zones: [defaultZone({ id: 'a', name: 'x' }, { lo: 0, hi: 10 })] });
  assert.equal(peak(play(60)), 0);
  samples.c = { rate: SR, ch: [tone(220, 0.1)], length: SR * 0.1 };
  m.setData({ zones: [defaultZone({ id: 'c', name: 'short' }, { loop: 1, root: 57 })] });
  const long = play(57, 0.8, SR);
  assert.ok(peak(long.subarray(SR * 0.8)) > 0.1, 'still sounding after 0.8 s thanks to the loop');
});

test('Multisampler in a project: zones survive normalisation and render offline', () => {
  const p = createProject();
  const ch = createChannel(p, 'multi', { name: 'Keys', zones: [defaultZone({ id: 'factory:sub-808', name: 'Sub' }, { root: 24 })] });
  p.channels.push(ch);
  p.patterns[1].notes[ch.id] = [createNote(p, 0, STEP * 4, 36, 110)];
  const q = normalize(JSON.parse(JSON.stringify(p)));
  assert.equal(q.channels[0].zones[0].sample.id, 'factory:sub-808');
  assert.equal(q.channels[0].zones[0].root, 24);
  const r = renderOffline(q, collectFactorySamples(q, SR), { mode: 'pat', sampleRate: SR, tail: 0.2 });
  assert.ok(peak(r.left) > 0.05, 'plays the factory sample through its zone');
});

test('sound packs: 52 sounds register, render at any rate and play from projects', () => {
  const info = load('sounds.flpack.js');
  assert.equal(info.sounds, 52);
  assert.equal([...packSounds.keys()].filter((k) => k.startsWith('pack:fllua-sounds:')).length, 52);
  const d = renderPackSound('pack:fllua-sounds:kick-909', 48000);
  assert.ok(d[0].length === Math.floor(48000 * 0.6) && peak(d[0]) > 0.8);
  const p = createProject();
  const ch = createChannel(p, 'sampler', { name: 'Clap', sample: { id: 'pack:fllua-sounds:clap-707', name: 'Clap 707' } });
  p.channels.push(ch);
  p.patterns[1].notes[ch.id] = [createNote(p, 0, STEP, 60, 110)];
  const r = renderOffline(p, collectFactorySamples(p, SR), { mode: 'pat', sampleRate: SR, tail: 0.2 });
  assert.ok(peak(r.left) > 0.1, 'renders');
  const bad = () => registerPack({ id: 'bad-snd', name: 'Bad', version: '1.0.0', sounds: () => ({ X: { 'boom': { name: 'Boom', gen: () => new Float32Array(10).fill(NaN) } } }) });
  assert.throws(bad, /NaN/);
});

test('drum machines and keys: every drum on its GM note, keys in tune', () => {
  load('drum-machines.flpack.js'); load('keys.flpack.js');
  for (const t of ['fllua-drum-machines.dm-8', 'fllua-drum-machines.dm-9']) {
    const inst = INSTRUMENTS[t].create(SR, {});
    for (const key of [36, 38, 39, 42, 46, 45, 49, 51]) {
      inst.allOff(); inst.noteOn({ key, vel: 0.9, fine: 0 });
      const L = new Float32Array(SR / 4), R = new Float32Array(SR / 4);
      for (let b = 0; b < L.length; b += 128) inst.process(L, R, b, b + 128);
      assert.ok(peak(L) > 0.05 && peak(L) < 2, `${t} note ${key}: ${peak(L)}`);
    }
  }
  for (const t of ['strings', 'piano', 'choir', 'epiano']) {
    const inst = INSTRUMENTS[`fllua-keys.${t}`].create(SR, {});
    inst.noteOn({ key: 57, vel: 0.8, fine: 0 });
    const L = new Float32Array(SR), R = new Float32Array(SR);
    for (let b = 0; b < L.length; b += 128) inst.process(L, R, b, b + 128);
    assert.ok(Math.abs(f0(L, 0.5, 0.25) - 220) < 3, `${t}: ${f0(L, 0.5, 0.25)}`);
  }
});
