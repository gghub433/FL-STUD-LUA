import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createChannel, createNote } from '../../src/core/project.js';
import { STEP } from '../../src/core/constants.js';
import * as cmd from '../../src/app/commands.js';

// the part of Store the step commands use: the project, the current pattern and edit() with an undo count
function fakeStore(steps) {
  const p = createProject();
  const ch = createChannel(p, 'sampler', { name: 'Kick' });
  p.channels.push(ch);
  const pat = p.patterns[p.currentPattern];
  pat.len = 16 * STEP;
  pat.notes[ch.id] = steps.map((s) => createNote(p, s * STEP, STEP, 60, 100));
  const store = { project: p, edits: [], get pattern() { return p.patterns[p.currentPattern]; }, edit(label, fn) { this.edits.push(label); return fn(p); } };
  return { store, ch, on: () => store.pattern.notes[ch.id].map((n) => n.s / STEP) };
}

test('step tools: rotate moves every step and wraps at the pattern end, one undo step each', () => {
  const { store, ch, on } = fakeStore([0, 4, 15]);
  cmd.rotateSteps(store, ch.id, 1);
  assert.deepEqual(on(), [0, 1, 5]);
  cmd.rotateSteps(store, ch.id, -1); cmd.rotateSteps(store, ch.id, -1);
  assert.deepEqual(on(), [3, 14, 15]);
  assert.deepEqual(store.edits, ['Rotate steps right', 'Rotate steps left', 'Rotate steps left']);
  // longer piano roll notes move along
  store.pattern.notes[ch.id].push(createNote(store.project, 8 * STEP + 5, 96, 64));
  cmd.rotateSteps(store, ch.id, 1);
  assert.ok(store.pattern.notes[ch.id].some((n) => n.s === 9 * STEP + 5 && n.l === 96));
});

test('step tools: invert turns on the empty steps and off the others; fill, clear', () => {
  const { store, ch, on } = fakeStore([0, 1, 8]);
  cmd.invertSteps(store, ch.id);
  assert.deepEqual(on(), [2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15]);
  cmd.invertSteps(store, ch.id);
  assert.deepEqual(on(), [0, 1, 8]);
  cmd.fillEvery(store, ch.id, 4);
  assert.deepEqual(on(), [0, 4, 8, 12]);
  cmd.clearChannelNotes(store, ch.id);
  assert.equal(store.pattern.notes[ch.id], undefined);
  cmd.invertSteps(store, ch.id);
  assert.equal(on().length, 16);
  assert.ok(store.pattern.notes[ch.id].every((n) => n.k === store.project.settings.stepKey && n.l === STEP));
});
