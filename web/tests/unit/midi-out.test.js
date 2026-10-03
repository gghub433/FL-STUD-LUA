import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/core/engine.js';
import { createProject, createChannel, createNote } from '../../src/core/project.js';
import { PPQ, STEP } from '../../src/core/constants.js';
import { registerPack, controllerScripts, unregisterPack } from '../../src/core/packs.js';
import fs from 'node:fs';

const SR = 48000;
function setup({ tempo = 120, notes = [[0, 60], [4, 64], [8, 67]] } = {}) {
  const p = createProject(); p.tempo = tempo;
  const ch = createChannel(p, 'midiout', { name: 'Synth', port: 'Hardware' });
  ch.params.channel = 3; ch.params.program = 5; ch.params.transpose = 12;
  p.channels.push(ch);
  p.patterns[1].notes[ch.id] = notes.map(([s, k]) => createNote(p, s * STEP, STEP * 2, k, 100));
  const e = new Engine(SR);
  e.host.midiQueue = [];
  e.setProject(p);
  return { e, p, ch };
}
const run = (e, blocks) => { const L = new Float32Array(128), R = new Float32Array(128); for (let i = 0; i < blocks; i++) e.process(L, R, 128); };

test('MIDI Out: notes leave with the frame they belong to, on their MIDI channel, transposed; program on play; offs on stop', () => {
  const { e, ch } = setup();
  e.play('pat', 0);
  run(e, Math.ceil(SR / 128));                                      // one second = two beats at 120 BPM
  const q = e.host.midiQueue;
  assert.deepEqual(q[0], { port: 'Hardware', data: [0xc2, 4], frame: 0 }, 'program change first');
  const ons = q.filter((m) => (m.data[0] & 0xf0) === 0x90);
  assert.deepEqual(ons.map((m) => m.data), [[0x92, 72, 100], [0x92, 76, 100], [0x92, 79, 100]]);
  const step = (STEP / PPQ) * 0.5 * SR;                             // frames per step at 120 BPM
  ons.forEach((m, i) => assert.ok(Math.abs(m.frame - i * 4 * step) <= 1, `note ${i} at frame ${m.frame}, expected ${i * 4 * step}`));
  const offs = q.filter((m) => (m.data[0] & 0xf0) === 0x80);
  assert.ok(Math.abs(offs[0].frame - 2 * step) <= 1, 'note off after two steps');
  q.length = 0;
  e.noteOn(ch.id, 50, 0.5);                                         // live note from the keyboard
  assert.deepEqual(q.map((m) => m.data), [[0x92, 62, 64]], 'live note');
  e.stop();
  const offs2 = q.slice(1).map((m) => m.data);
  assert.ok(offs2.every((d) => d[0] === 0x82) && offs2.some((d) => d[1] === 62), `stop releases every held note: ${JSON.stringify(offs2)}`);
});

test('MIDI clock: 24 per quarter note in time, Start / Stop, song position and Continue', () => {
  const { e } = setup({ notes: [] });
  e.clockOut = true;
  e.play('pat', 0);
  run(e, Math.ceil(SR / 128));
  const q = e.host.midiQueue.filter((m) => m.clock);
  assert.deepEqual(q[0].data, [0xfa], 'Start');
  const clocks = q.filter((m) => m.data[0] === 0xf8);
  assert.ok(clocks.length >= 48 && clocks.length <= 49, `${clocks.length} clocks in one second at 120 BPM`);
  const per = SR / 48;                                              // frames between clocks
  for (let i = 1; i < 40; i++) assert.ok(Math.abs(clocks[i].frame - clocks[0].frame - i * per) <= 1, `clock ${i} on time`);
  e.host.midiQueue.length = 0;
  e.stop();
  assert.deepEqual(e.host.midiQueue.filter((m) => m.clock).map((m) => m.data), [[0xfc]], 'Stop');
  // starting in the middle of the song: song position (in sixteenths) then Continue
  e.host.midiQueue.length = 0;
  e.play('pat', PPQ * 2 + PPQ / 4 * 3);
  const st = e.host.midiQueue.filter((m) => m.clock).slice(0, 2).map((m) => m.data);
  assert.deepEqual(st, [[0xf2, 11, 0], [0xfb]]);
  // no clock without the setting, no queue offline
  const off = setup({ notes: [] }).e; off.play('pat', 0); run(off, 50);
  assert.equal(off.host.midiQueue.filter((m) => m.clock).length, 0);
});

test('controller scripts: packs register them; broken ones are refused', () => {
  const src = fs.readFileSync(new URL('../../packs/controllers.flpack.js', import.meta.url), 'utf8');
  let info;
  globalThis.__flluaRegisterPack = (d) => { info = registerPack(d); };
  new Function(src)();
  assert.equal(info.plugins.filter((p) => p.kind === 'controller').length, 3);
  assert.ok(controllerScripts.has('fllua-controllers.knobs'));
  const calls = [];
  const api = { channelParams: () => ['ch:1:p:cutoff', 'ch:1:p:res'], setParam: (a, v) => calls.push([a, v]), mixerVolume: (t, v) => calls.push([t, v]), channels: () => [{ id: 9, type: 'fpc' }], noteOn: (k, v, c) => calls.push(['on', k, c]), noteOff: () => {} };
  const knobs = controllerScripts.get('fllua-controllers.knobs').create(api);
  assert.equal(knobs.onMidi([0xb0, 22, 127]), true);
  assert.equal(knobs.onMidi([0xb0, 1, 127]), false, 'other CCs pass through');
  const pads = controllerScripts.get('fllua-controllers.pads').create(api);
  assert.equal(pads.onMidi([0x99, 36, 100]), true);
  assert.equal(pads.onMidi([0x90, 36, 100]), false, 'only MIDI channel 10');
  assert.deepEqual(calls, [['ch:1:p:res', 1], ['on', 36, 9]]);
  unregisterPack('fllua-controllers');
  assert.equal(controllerScripts.has('fllua-controllers.knobs'), false);
  const bad = (controllers) => () => registerPack({ id: 'bad-ctl', name: 'Bad', version: '1.0.0', plugins: () => ({ controllers }) });
  assert.throws(bad({ x1: { meta: { name: 'X' } } }), /create\(api\) is missing/);
  assert.throws(bad({ x1: { meta: { name: 'X' }, create: () => ({ onMidi() { throw new Error('boom'); } }) } }), /boom/);
});
