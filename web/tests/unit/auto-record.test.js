import test from 'node:test';
import assert from 'node:assert/strict';
import { thinPoints, applyRecordedAutomation } from '../../src/core/auto-record.js';
import { createProject, currentArrangement, createClip, createChannel, barTicks } from '../../src/core/project.js';
import { evalPoints } from '../../src/core/automation.js';
import { Engine } from '../../src/core/engine.js';
import { PPQ } from '../../src/core/constants.js';

const BAR = PPQ * 4;
const sweep = (t0, t1, v0, v1, n = 60) => Array.from({ length: n }, (_, i) => ({ t: t0 + ((t1 - t0) * i) / (n - 1), v: v0 + ((v1 - v0) * i) / (n - 1) }));

test('thinPoints keeps the shape with few points', () => {
  const lin = sweep(0, 1000, 0, 1, 200);
  assert.equal(thinPoints(lin).length, 2, 'a straight ramp needs two points');
  const vee = [...sweep(0, 500, 0, 1, 100), ...sweep(505, 1000, 1, 0, 100)];
  const t = thinPoints(vee);
  assert.ok(t.length >= 3 && t.length <= 5, `a V needs about three: ${t.length}`);
  for (const s of vee) assert.ok(Math.abs(evalPoints(t.map((q) => ({ ...q, type: 'single', tension: 0 })), s.t) - s.v) < 0.02, 'within tolerance');
});

test('a take with no automation yet: new channel and clip from the bar where it started, holding the old value before', () => {
  const p = createProject();
  const addr = 'mx:0:vol';
  const r = applyRecordedAutomation(p, addr, sweep(BAR * 2 + PPQ, BAR * 3 + PPQ * 2, 0.2, 0.9), { startValue: 0.5 });
  assert.equal(r.merged, false);
  assert.equal(r.channel.target, addr);
  assert.equal(r.clip.s, BAR * 2); assert.equal(r.clip.l, BAR * 2);
  const at = (songTick) => evalPoints(r.channel.points, songTick - r.clip.s);
  assert.ok(Math.abs(at(BAR * 2) - 0.5) < 1e-6 && Math.abs(at(BAR * 2 + PPQ - 2) - 0.5) < 1e-6, 'old value until the move');
  assert.ok(Math.abs(at(BAR * 2 + PPQ) - 0.2) < 0.01, 'move starts');
  assert.ok(Math.abs(at(BAR * 3 + PPQ * 2) - 0.9) < 0.01 && Math.abs(at(BAR * 4) - 0.9) < 1e-6, 'last value held to the end');
  assert.ok(r.channel.points.length < 10, `thinned: ${r.channel.points.length}`);
});

test('a take inside an existing clip replaces only that span of its curve', () => {
  const p = createProject();
  const addr = 'mx:1:vol';
  const ch = createChannel(p, 'automation', { target: addr, len: BAR * 4, points: [{ t: 0, v: 0.1, type: 'single', tension: 0, count: 4 }, { t: BAR * 4, v: 0.1, type: 'single', tension: 0, count: 4 }] });
  p.channels.push(ch);
  const arr = currentArrangement(p);
  arr.clips.push(createClip(p, 'automation', 1, BAR * 4, BAR * 4, ch.id));
  const r = applyRecordedAutomation(p, addr, sweep(BAR * 5, BAR * 6, 0.8, 0.8, 20), { startValue: 0.1 });
  assert.equal(r.merged, true);
  assert.equal(p.channels.length, 1, 'no new channel');
  const at = (song) => evalPoints(ch.points, song - BAR * 4);
  assert.ok(Math.abs(at(BAR * 4 + PPQ) - 0.1) < 0.01, 'before the take: unchanged');
  assert.ok(Math.abs(at(BAR * 5 + PPQ) - 0.8) < 0.01, 'inside the take');
  assert.ok(Math.abs(at(BAR * 7) - 0.1) < 0.01, 'after the take: unchanged');
});

test('the engine pauses automation of a touched parameter', () => {
  const p = createProject();
  p.tempo = 120;
  const addr = 'mx:0:vol';
  applyRecordedAutomation(p, addr, sweep(0, BAR * 2, 0, 1, 50), { startValue: 0 });
  const e = new Engine(44100);
  e.setProject(p);
  e.play('song', 0);
  const L = new Float32Array(128), R = new Float32Array(128);
  for (let i = 0; i < 200; i++) e.process(L, R, 128);
  const moved = p.mixer.tracks[0].vol;
  assert.ok(moved > 0.1, `automation drives the fader: ${moved}`);
  e.touch(addr, 1);
  e.setParam(addr, 0.33);
  for (let i = 0; i < 200; i++) e.process(L, R, 128);
  assert.equal(p.mixer.tracks[0].vol, 0.33, 'held by the hand');
  e.touch(addr, 0);
  for (let i = 0; i < 50; i++) e.process(L, R, 128);
  assert.ok(p.mixer.tracks[0].vol !== 0.33, 'released: automation takes over again');
  assert.equal(barTicks(p.timeSig), BAR);
});
