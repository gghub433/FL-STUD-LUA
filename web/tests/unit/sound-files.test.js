import test from 'node:test';
import assert from 'node:assert/strict';
import { isAudioFile, isAudioDrop, cleanListing, pageOf, soundName, extOf, dirName, joinPath, SoundIndex, AUDIO_ACCEPT, AUDIO_EXTENSIONS } from '../../src/core/sound-files.js';

test('audio file filter: the seven formats in any case, no hidden files, no other files', () => {
  for (const n of ['kick.wav', 'Loop 120 BPM.MP3', 'pad.ogg', 'snare.flac', 'bass.aif', 'Vox.AIFF', 'take.m4a', 'a.b.c.wav']) assert.ok(isAudioFile(n), n);
  for (const n of ['._kick.wav', '.hidden.wav', 'readme.txt', 'kick.wav.asd', 'cover.png', 'wav', 'kit.fllua', '', null, undefined]) assert.ok(!isAudioFile(n), String(n));
  assert.equal(AUDIO_EXTENSIONS.length, 7);
  for (const e of AUDIO_EXTENSIONS) assert.ok(AUDIO_ACCEPT.includes(`.${e}`));
  // files dropped from the system: the extension, or an audio type given by the system
  assert.ok(isAudioDrop({ name: 'x.opus', type: 'audio/ogg' }));
  assert.ok(isAudioDrop({ name: 'kick.WAV', type: '' }));
  assert.ok(!isAudioDrop({ name: 'song.fllua', type: 'application/json' }));
  assert.ok(!isAudioDrop({ name: '._x.wav', type: 'audio/wav' }));
});

test('names and paths', () => {
  assert.equal(soundName('Drums/Kicks/808 Kick.wav'), '808 Kick');
  assert.equal(soundName('a.b.aiff'), 'a.b');
  assert.equal(extOf('Loop.MP3'), 'mp3');
  assert.equal(dirName('Drums/Kicks/808 Kick.wav'), 'Drums/Kicks');
  assert.equal(dirName('kick.wav'), '');
  assert.equal(joinPath('', 'Kicks'), 'Kicks');
  assert.equal(joinPath('Drums', 'Kicks'), 'Drums/Kicks');
});

test('folder listing: folders first, natural order, audio only, hidden and broken entries dropped, capped', () => {
  const raw = [
    { name: 'Kick 10.wav', dir: false }, { name: 'Kick 2.wav', dir: false }, { name: 'kick 1.WAV', dir: false },
    { name: 'Snares', dir: true }, { name: '.git', dir: true }, { name: 'notes.txt', dir: false }, { name: '._Kick 2.wav', dir: false },
    { name: 'Claps', dir: true }, { name: 'loop.mp3', dir: false }, null, { name: '', dir: false }, { dir: true },
  ];
  assert.deepEqual(cleanListing(raw).map((e) => `${e.dir ? 'D' : 'F'} ${e.name}`), ['D Claps', 'D Snares', 'F kick 1.WAV', 'F Kick 2.wav', 'F Kick 10.wav', 'F loop.mp3']);
  assert.deepEqual(cleanListing(null), []);
  const many = Array.from({ length: 50 }, (_, i) => ({ name: `s${i}.wav`, dir: false }));
  assert.equal(cleanListing(many, 20).length, 20);
  // pages of a long folder
  const list = cleanListing(many);
  assert.deepEqual(pageOf(list, 10).shown.map((e) => e.name), list.slice(0, 10).map((e) => e.name));
  assert.equal(pageOf(list, 10).hidden, 40);
  assert.equal(pageOf(list, 500).hidden, 0);
});

// a fake disk: { 'rel/path': [entries] } per root
function fakeDisk(tree, calls = []) {
  return async (root, rel) => {
    calls.push(`${root.id}:${rel}`);
    const d = tree[root.id][rel];
    if (d === 'error') throw new Error('no access');
    if (!d) throw new Error('missing');
    return cleanListing(d);
  };
}

test('index: breadth first over all roots, depth and size caps, folders that fail are skipped', async () => {
  const tree = {
    a: { '': [{ name: 'Kicks', dir: true }, { name: 'Loops', dir: true }, { name: 'top.wav', dir: false }],
      Kicks: [{ name: '808 Kick.wav', dir: false }, { name: 'Acoustic kick.flac', dir: false }, { name: 'readme.txt', dir: false }],
      Loops: [{ name: 'Deep', dir: true }, { name: 'drum loop 120.mp3', dir: false }],
      'Loops/Deep': [{ name: 'Deeper', dir: true }, { name: 'deep kick loop.ogg', dir: false }],
      'Loops/Deep/Deeper': [{ name: 'bottom.wav', dir: false }] },
    b: { '': [{ name: 'Locked', dir: true }, { name: 'clap.aif', dir: false }], Locked: 'error' },
  };
  const roots = [{ id: 'a', name: 'Pack A' }, { id: 'b', name: 'Pack B' }];
  const calls = [];
  const progress = [];
  const ix = await new SoundIndex().build(roots, fakeDisk(tree, calls), { onProgress: (i) => progress.push(i.files.length), every: 1 });
  assert.ok(ix.done && !ix.capped);
  assert.equal(ix.failed, 1);
  assert.deepEqual(ix.files.map((f) => f.rel), ['top.wav', 'clap.aif', 'Kicks/808 Kick.wav', 'Kicks/Acoustic kick.flac', 'Loops/drum loop 120.mp3', 'Loops/Deep/deep kick loop.ogg', 'Loops/Deep/Deeper/bottom.wav']);
  assert.deepEqual(calls.slice(0, 3), ['a:', 'b:', 'a:Kicks'], 'breadth first: both roots before any subfolder');
  assert.ok(progress.length >= 5 && progress.at(-1) === 7);

  const shallow = await new SoundIndex({ maxDepth: 1 }).build(roots, fakeDisk(tree));
  assert.ok(shallow.capped && !shallow.files.some((f) => f.rel.startsWith('Loops/Deep/')), 'depth cap');
  const small = await new SoundIndex({ maxFiles: 3 }).build(roots, fakeDisk(tree));
  assert.ok(small.capped && small.files.length === 3, 'file cap');
  const fewFolders = await new SoundIndex({ maxFolders: 2 }).build(roots, fakeDisk(tree));
  assert.ok(fewFolders.capped && fewFolders.folders === 2 && fewFolders.files.length === 2, 'folder cap');
});

test('index: cancelling stops the walk', async () => {
  const roots = [{ id: 'r', name: 'R' }];
  const ix = new SoundIndex();
  let n = 0;
  const list = async (root, rel) => { n++; if (n === 3) ix.cancel(); return [{ name: `d${n}`, dir: true }, { name: `f${n}.wav`, dir: false }]; };
  await ix.build(roots, list);
  assert.ok(!ix.done && ix.cancelled);
  assert.equal(n, 3);
});

test('search over the index: every word, folder names count, own-name matches first, limit and total', async () => {
  const tree = { a: { '': [{ name: 'Kicks', dir: true }, { name: 'kick drum loop.wav', dir: false }],
    Kicks: [{ name: '808.wav', dir: false }, { name: 'Hard Kick 01.wav', dir: false }, { name: 'Hard Kick 02.wav', dir: false }, { name: 'Soft kick.wav', dir: false }] } };
  const ix = await new SoundIndex().build([{ id: 'a', name: 'Vintage Pack' }], fakeDisk(tree));
  const names = (q, limit) => ix.search(q, limit).hits.map((f) => f.rel);
  assert.deepEqual(names('hard kick'), ['Kicks/Hard Kick 01.wav', 'Kicks/Hard Kick 02.wav']);
  assert.deepEqual(names('KICK'), ['kick drum loop.wav', 'Kicks/Hard Kick 01.wav', 'Kicks/Hard Kick 02.wav', 'Kicks/Soft kick.wav', 'Kicks/808.wav'], 'own-name matches first, then folder matches');
  assert.deepEqual(names('kicks 808'), ['Kicks/808.wav']);
  assert.deepEqual(names('vintage soft'), ['Kicks/Soft kick.wav'], 'the folder name of the root counts too');
  assert.deepEqual(names('snare'), []);
  assert.deepEqual(ix.search('', 10), { hits: [], total: 0 });
  const r = ix.search('kick', 2);
  assert.equal(r.hits.length, 2); assert.equal(r.total, 5);
});
