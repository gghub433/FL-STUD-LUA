import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../src/core/engine.js';
import { createProject, createChannel, createNote, createFxSlot, normalize } from '../../src/core/project.js';
import { PPQ, STEP } from '../../src/core/constants.js';
import { renderOffline } from '../../src/core/offline.js';

const SR = 48000;
// stands in for the AudioWorklet: the plugin processors of the host group and the engine node's extra channels
function rig(e) {
  const events = [];
  const proc = { scheduleEvents: (...ev) => events.push(...ev) };
  e.host.wam = { group: { processors: new Map([['synth-1', proc], ['fx-1', proc]]) }, ports: new Map() };
  const extIn = Array.from({ length: 32 }, () => new Float32Array(128));
  const extOut = Array.from({ length: 32 }, () => new Float32Array(128));
  e.host.extIn = extIn; e.host.extOut = extOut;
  return { events, extIn, extOut };
}

function setup() {
  const p = createProject(); p.tempo = 120;
  const ch = createChannel(p, 'wam', { name: 'Ext synth', mixer: 1, wam: { url: 'https://example.invalid/synth/index.js', name: 'Synth' } });
  p.channels = [ch];
  p.patterns[1].notes[ch.id] = [createNote(p, 0, STEP * 2, 60, 100), createNote(p, STEP * 4, STEP, 64, 50)];
  return { p, ch };
}

test('WAM data survives saving and loading; slots get an instance id', () => {
  const { p, ch } = setup();
  ch.wam.state = { parameterValues: { level: { id: 'level', value: 0.3 } } };
  p.mixer.tracks[2].fx[0] = createFxSlot('wam');
  const id = p.mixer.tracks[2].fx[0].extra.wam.id;
  assert.match(id, /^w[a-z0-9]+$/);
  const q = normalize(JSON.parse(JSON.stringify(p)));
  assert.equal(q.channels[0].type, 'wam');
  assert.equal(q.channels[0].wam.url, 'https://example.invalid/synth/index.js');
  assert.equal(q.channels[0].wam.state.parameterValues.level.value, 0.3);
  assert.equal(q.mixer.tracks[2].fx[0].extra.wam.id, id);
});

test('WAM instrument: notes go to the plugin processor one block ahead, its sound comes back into the mixer', () => {
  const { p, ch } = setup();
  const e = new Engine(SR);
  e.setProject(p);
  const { events, extIn } = rig(e);
  e.frameOffset = 1000 - e.frame;                    // the audio clock is 1000 frames further than the engine
  e.wamPort(`ch:${ch.id}`, { port: 3, instanceId: 'synth-1' });
  extIn[6].fill(0.25); extIn[7].fill(-0.25);       // what the plugin plays on port 3
  e.play('pat', 0);
  const L = new Float32Array(128), R = new Float32Array(128);
  e.process(L, R, 128);
  const on = events.find((x) => x.type === 'wam-midi');
  assert.deepEqual(on.data.bytes, [0x90, 60, 100]);
  assert.ok(Math.abs(on.time - (1000 + 128) / SR) < 1e-9, `scheduled one block ahead: ${on.time}`);
  assert.ok(Math.abs(L[64]) > 0.05 && Math.sign(L[64]) === -Math.sign(R[64]), `plugin audio reaches the master: ${L[64]} ${R[64]}`);
  // note off after two steps, second note with its velocity
  const frames = Math.ceil(((STEP * 5) / PPQ) * 0.5 * SR / 128);
  for (let i = 0; i < frames; i++) e.process(L, R, 128);
  const midi = events.filter((x) => x.type === 'wam-midi').map((x) => x.data.bytes);
  assert.deepEqual(midi.slice(0, 3), [[0x90, 60, 100], [0x80, 60, 0], [0x90, 64, 50]]);
  // unlinked: silent, no events
  e.wamPort(`ch:${ch.id}`, null);
  events.length = 0;
  e.noteOn(ch.id, 70, 1);
  e.process(L, R, 128);
  assert.equal(events.length, 0);
});

test('WAM effect: the slot sends its signal out, takes the plugin result back and reports one block of latency', () => {
  const p = createProject();
  const ch = createChannel(p, 'drums', { name: 'Kick', mixer: 1 });
  p.channels = [ch];
  p.mixer.tracks[1].fx[0] = createFxSlot('wam');
  const id = p.mixer.tracks[1].fx[0].extra.wam.id;
  const e = new Engine(SR);
  e.setProject(p);
  const { extIn, extOut } = rig(e);
  assert.equal(e.mixer.tracks[1].fx[0].delay, 0, 'no latency until linked');
  e.wamPort(`fx:${id}`, { port: 5, instanceId: 'fx-1', latency: 64 });
  assert.equal(e.mixer.tracks[1].fx[0].delay, 128 + 64, 'one block plus the plugin delay');
  extIn[10].fill(0.5); extIn[11].fill(0.5);       // the plugin returns a constant
  e.noteOn(ch.id, 60, 1);
  const L = new Float32Array(128), R = new Float32Array(128);
  let sent = 0;
  for (let i = 0; i < 4; i++) { e.process(L, R, 128); sent = Math.max(sent, ...extOut[10].map(Math.abs)); }
  assert.ok(sent > 0.01, `the kick was sent to the plugin (${sent})`);
  assert.ok(L.some((v) => Math.abs(v) > 0.1), 'the plugin result is what the track plays');
});

test('the offline renderer (no Web Audio) leaves WAM channels silent and WAM slots transparent', () => {
  const { p } = setup();
  const r = renderOffline(p, new Map(), { sampleRate: SR, mode: 'pat', tail: 0 });
  assert.ok(r.frames > 0 && r.left.every((v) => v === 0));
});
