import test from 'node:test';
import assert from 'node:assert/strict';
import { readMidi, writeMidi } from '../../src/core/midi-file.js';
import { importMidi, instrumentFor, gmDrumPads, midiParts } from '../../src/core/midi-import.js';
import { createProject, currentArrangement, normalize } from '../../src/core/project.js';
import { demoProject } from '../../src/core/demo.js';
import { renderOffline } from '../../src/core/offline.js';
import { collectFactorySamples } from '../../src/core/factory.js';
import { PPQ } from '../../src/core/constants.js';

// minimal Standard MIDI File writer: tracks = [{ name, program, ch, notes: [[tick, len, key, vel]] }], ppq 480
function smf(tracks, { bpm = 100, format = 1 } = {}) {
  const vlq = (n) => { const b = [n & 127]; while ((n >>= 7)) b.push((n & 127) | 128); return b.reverse(); };
  const be = (n, w) => Array.from({ length: w }, (_, i) => (n >> (8 * (w - 1 - i))) & 255);
  const chunk = (t, b) => [...Buffer.from(t), ...be(b.length, 4), ...b];
  const us = Math.round(60000000 / bpm);
  const out = [...chunk('MThd', [...be(format, 2), ...be(tracks.length, 2), ...be(480, 2)])];
  tracks.forEach((t, i) => {
    const ev = [];
    if (i === 0) ev.push([0, [0xff, 0x51, 3, ...be(us, 3)]], [0, [0xff, 0x58, 4, 3, 2, 24, 8]]);
    if (t.name) ev.push([0, [0xff, 0x03, t.name.length, ...Buffer.from(t.name)]]);
    if (t.program != null) ev.push([0, [0xc0 | t.ch, t.program]]);
    for (const [s, l, k, v] of t.notes) { ev.push([s, [0x90 | t.ch, k, v]], [s + l, [0x80 | t.ch, k, 0]]); }
    ev.sort((a, b) => a[0] - b[0]);
    let last = 0; const bytes = [];
    for (const [tk, data] of ev) { bytes.push(...vlq(tk - last), ...data); last = tk; }
    bytes.push(0, 0xff, 0x2f, 0);
    out.push(...chunk('MTrk', bytes));
  });
  return Uint8Array.from(out);
}

test('MIDI import: one channel, pattern, mixer insert and playlist clip per track; GM instruments and drums', () => {
  const bytes = smf([
    { name: 'Keys', program: 4, ch: 0, notes: [[0, 960, 60, 90], [960, 960, 64, 80], [1920, 1920, 67, 100]] },
    { name: 'Bass', program: 33, ch: 1, notes: [[0, 480, 36, 110], [1440, 480, 43, 100]] },
    { ch: 9, notes: [[0, 120, 36, 120], [480, 120, 38, 100], [240, 60, 42, 70], [720, 60, 46, 70]] },
  ]);
  const midi = readMidi(bytes);
  assert.equal(midi.tempo, 100);
  assert.deepEqual(midi.tracks[0].programs, { 0: 4 });
  const p = createProject();
  const r = importMidi(p, midi, { name: 'song', setTempo: true });
  assert.equal(p.tempo, 100);
  assert.deepEqual(p.timeSig, { num: 3, den: 4 });
  assert.deepEqual(p.channels.map((c) => [c.name, c.type, c.mixer]), [['Keys', 'fm', 1], ['Bass', 'subsynth', 2], ['Drums', 'fpc', 3]]);
  assert.equal(p.mixer.tracks[2].name, 'Bass');
  const notes = r.patterns.map((pt, i) => pt.notes[r.channels[i].id]);
  assert.deepEqual(notes[0].map((n) => [n.s, n.l, n.k, n.v]), [[0, PPQ * 2, 60, 90], [PPQ * 2, PPQ * 2, 64, 80], [PPQ * 4, PPQ * 4, 67, 100]], 'ticks rescaled from 480 to 96 PPQ');
  const arr = currentArrangement(p);
  assert.equal(arr.clips.length, 3);
  assert.deepEqual(arr.clips.map((c) => c.track), [1, 2, 3]);
  assert.ok(arr.clips.every((c) => c.s === 0 && c.l === r.length && c.l % (PPQ * 3) === 0), 'clips start together and last whole 3/4 bars');
  const kit = p.channels[2].pads;
  const pad = (note) => kit.find((x) => x.note === note);
  assert.equal(pad(36).layers[0].sample.id, 'factory:kick-punch');
  assert.equal(pad(42).choke, pad(46).choke, 'hats choke each other');
  // a second import goes after the first, on new playlist tracks
  const r2 = importMidi(p, midi, { name: 'again' });
  assert.equal(r2.start, r.length);
  assert.deepEqual(currentArrangement(p).clips.slice(-3).map((c) => c.track), [4, 5, 6]);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(p))).channels.length, 6, 'the project survives normalisation');
});

test('type-0 files are split by MIDI channel; program families map to instruments', () => {
  const bytes = smf([{ name: 'All', ch: 0, notes: [[0, 480, 60, 100]] }]);
  const midi = readMidi(bytes);
  midi.tracks[0].notes.push({ s: 0, l: 48, k: 36, v: 100, ch: 9 }, { s: 96, l: 48, k: 40, v: 100, ch: 2 });
  const parts = midiParts(midi);
  assert.equal(parts.length, 3);
  assert.equal(parts.filter((x) => x.drums).length, 1);
  assert.equal(instrumentFor(0), 'fm'); assert.equal(instrumentFor(19), 'organ'); assert.equal(instrumentFor(25), 'pluck');
  assert.equal(instrumentFor(48), 'wavetable'); assert.equal(instrumentFor(undefined), 'subsynth');
  assert.equal(gmDrumPads().filter((x) => x.layers.length).length, 34);
  assert.throws(() => importMidi(createProject(), { tracks: [{ name: 'x', notes: [] }] }), /no notes/);
});

test('round trip: the demo exported as MIDI and imported again plays the same notes', () => {
  const src = demoProject();
  const midi = readMidi(writeMidi(src, { mode: 'song' }));
  const p = createProject();
  p.tempo = src.tempo;
  importMidi(p, midi, { instrument: 'subsynth' });
  const total = (proj) => Object.values(proj.patterns).reduce((a, pt) => a + Object.values(pt.notes).reduce((b, l) => b + l.length, 0), 0);
  const exported = midi.tracks.reduce((a, t) => a + t.notes.length, 0);
  assert.equal(total(p), exported);
  const r = renderOffline(p, collectFactorySamples(p, 44100), { sampleRate: 44100, tail: 0.5 });
  let pk = 0; for (let i = 0; i < r.left.length; i += 3) pk = Math.max(pk, Math.abs(r.left[i]));
  assert.ok(r.frames > 44100 * 10 && pk > 0.05, `renders: ${r.frames} frames, peak ${pk}`);
});
