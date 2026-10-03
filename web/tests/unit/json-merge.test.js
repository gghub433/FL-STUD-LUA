import test from 'node:test';
import assert from 'node:assert/strict';
import { diffOps, applyOps } from '../../src/core/json-merge.js';

const copy = (v) => JSON.parse(JSON.stringify(v));
const base = () => ({
  tempo: 120,
  channels: [{ id: 1, name: 'Kick', vol: 0.8 }, { id: 2, name: 'Snare', vol: 0.7 }, { id: 3, name: 'Hat', vol: 0.5 }],
  mixer: { selected: 1, tracks: [{ vol: 0.8, fx: [null, { type: 'eq' }] }] },
  points: [[0, 1], [10, 0.5]],
});

test('diffOps + applyOps turn a into b', () => {
  const a = base(), b = copy(a);
  b.tempo = 128; b.channels[1].name = 'Clap'; b.channels.splice(0, 1); b.channels.push({ id: 9, name: 'Bass', vol: 1 });
  b.mixer.tracks[0].fx[0] = { type: 'reverb' }; delete b.mixer.selected; b.points.push([20, 0]);
  const ops = diffOps(a, b);
  assert.deepEqual(applyOps(copy(a), ops), b);
  assert.ok(ops.some((o) => o.rm === 1) && ops.some((o) => o.add && o.add.id === 9), 'item-level ops for an id-keyed array');
  assert.deepEqual(diffOps(a, copy(a)), [], 'no change, no ops');
});

test('two people changing different items of the same list both keep their work, in either order', () => {
  const a = base();
  const mine = copy(a); mine.channels.push({ id: 64, name: 'Anna synth', vol: 1 }); mine.channels[0].name = 'Kick 2';
  const theirs = copy(a); theirs.channels.push({ id: 65, name: 'Boris pluck', vol: 1 }); theirs.channels[2].vol = 0.1; theirs.channels.splice(1, 1);
  const m = diffOps(a, mine), t = diffOps(a, theirs);
  const x = applyOps(applyOps(copy(a), m), t), y = applyOps(applyOps(copy(a), t), m);
  for (const r of [x, y]) {
    const names = r.channels.map((c) => c.name);
    assert.ok(names.includes('Anna synth') && names.includes('Boris pluck') && names.includes('Kick 2') && !names.includes('Snare'), names.join());
    assert.equal(r.channels.find((c) => c.id === 3).vol, 0.1);
  }
});

test('a change to an item someone removed is dropped; reordering keeps unknown items', () => {
  const a = base();
  const del = copy(a); del.channels = del.channels.filter((c) => c.id !== 2);
  const edit = copy(a); edit.channels[1].vol = 0.2;
  const r = applyOps(applyOps(copy(a), diffOps(a, del)), diffOps(a, edit));
  assert.deepEqual(r.channels.map((c) => c.id), [1, 3]);
  const order = copy(a); order.channels.reverse();
  const added = copy(a); added.channels.push({ id: 7, name: 'New' });
  const r2 = applyOps(applyOps(copy(a), diffOps(a, added)), diffOps(a, order));
  assert.deepEqual(r2.channels.map((c) => c.id), [3, 2, 1, 7]);
});

test('ops are idempotent (sending a pending change again does no harm); skip leaves personal keys out', () => {
  const a = base(), b = copy(a); b.channels.push({ id: 5, name: 'X' }); b.mixer.selected = 9; b.tempo = 99;
  const ops = diffOps(a, b, (p) => p.length === 2 && p[0] === 'mixer' && p[1] === 'selected');
  const once = applyOps(copy(a), ops), twice = applyOps(applyOps(copy(a), ops), ops);
  assert.deepEqual(once, twice);
  assert.equal(once.mixer.selected, 1, 'skipped');
  assert.equal(once.tempo, 99);
});
