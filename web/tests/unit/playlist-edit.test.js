// Playlist editing: auto crossfades of overlapping audio clips, takes of a loop recording, consolidate / render to
// audio clip. Everything is checked on the audio the engine makes, the same engine that plays live and exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createChannel, createClip, createNote, createFxSlot, currentArrangement, normalize, clone } from '../../src/core/project.js';
import { resolveOverlaps, audioCrossfades, xfadeKeep, XFADE_SEC, loopPasses, switchTake, splitAtRange, freeTrack } from '../../src/core/playlist-ops.js';
import { consolidateSources, prepareRender, renderedLength, applyConsolidate } from '../../src/core/consolidate.js';
import { xfadeIn, xfadeOut } from '../../src/core/instruments/audioclip.js';
import { renderOffline } from '../../src/core/offline.js';
import { Engine } from '../../src/core/engine.js';
import { collectFactorySamples } from '../../src/core/factory.js';
import { PPQ, STEP } from '../../src/core/constants.js';
import { SR, peak } from './helpers.js';

let id = 5000;
const newId = () => ++id;
const A = (track, s, l, o = 0, extra = {}) => ({ id: newId(), type: 'audio', track, s, l, ref: 1, o, mute: 0, ...extra });
const P = (track, s, l, o = 0) => ({ id: newId(), type: 'pattern', track, s, l, ref: 1, o, mute: 0 });

// ---- auto crossfade --------------------------------------------------------------------------------------------

test('crossfade curves are equal power and continuous', () => {
  assert.equal(xfadeIn(0), 0); assert.equal(xfadeOut(0), 1);
  assert.ok(Math.abs(xfadeIn(1) - 1) < 1e-12 && Math.abs(xfadeOut(1)) < 1e-12, 'ends meet the clips on either side');
  let prevIn = 0, prevOut = 1;
  for (let i = 1; i <= 1000; i++) {
    const f = i / 1000, gi = xfadeIn(f), go = xfadeOut(f);
    assert.ok(Math.abs(gi * gi + go * go - 1) < 1e-12, `power stays 1 at ${f}`);
    assert.ok(gi >= prevIn && go <= prevOut, 'monotonic');
    assert.ok(gi - prevIn < 0.002 && prevOut - go < 0.002, 'no jumps');
    prevIn = gi; prevOut = go;
  }
});

test('audioCrossfades: a clip starting inside an earlier one crossfades from its start; muted and same-start clips do not', () => {
  const a = A(1, 0, 400), b = A(1, 380, 400), c = A(2, 0, 400), d = A(2, 390, 100, 0, { mute: 1 }), e = A(3, 0, 200), f = A(3, 0, 300);
  const x = audioCrossfades([a, b, c, d, e, f], (cl) => !cl.mute);
  assert.deepEqual(x.get(a.id), { xoAt: 380, xo: 20 });
  assert.deepEqual(x.get(b.id), { xi: 20 });
  assert.ok(!x.has(c.id) && !x.has(d.id), 'a muted clip does not take part');
  assert.ok(!x.has(e.id) && !x.has(f.id), 'clips that start together both play');
  const pat = P(4, 0, 400), aud = A(4, 300, 400);
  assert.equal(audioCrossfades([pat, aud]).size, 0, 'only audio clips crossfade');
});

test('placing an audio clip over another keeps a short overlap at both edges (auto crossfade); patterns and keep 0 are unchanged', () => {
  const under = A(1, 0, 1000), over = A(1, 400, 200);
  const out = resolveOverlaps([under, over], [over], newId, 10).filter((c) => c.id !== over.id).sort((x, y) => x.s - y.s);
  assert.deepEqual(out.map((c) => [c.s, c.l, c.o]), [[0, 410, 0], [590, 410, 590]], 'the clip underneath reaches 10 ticks under each edge');
  const plain = resolveOverlaps([A(1, 0, 1000, 0, { id: 1 }), { ...over }], [over], newId, 0).filter((c) => c.id !== over.id);
  assert.deepEqual(plain.map((c) => [c.s, c.l]).sort((x, y) => x[0] - y[0]), [[0, 400], [600, 400]]);
  const pu = P(1, 0, 1000), po = P(1, 400, 200);
  assert.deepEqual(resolveOverlaps([pu, po], [po], newId, 10).filter((c) => c.id !== po.id).map((c) => [c.s, c.l]).sort((x, y) => x[0] - y[0]), [[0, 400], [600, 400]], 'patterns never overlap');
  const tiny = A(1, 500, 6), big = A(1, 0, 1000);
  const t2 = resolveOverlaps([big, tiny], [tiny], newId, 10).filter((c) => c.id !== tiny.id).sort((x, y) => x.s - y.s);
  assert.deepEqual(t2.map((c) => [c.s, c.l]), [[0, 503], [503, 497]], 'at most half of a short clip on each side');
  const end = A(1, 0, 192), late = A(1, 180, 192);
  assert.deepEqual(resolveOverlaps([end, late], [late], newId, 10).find((c) => c.id === end.id).l, 190, 'dropped over the end: 10 ticks stay under it');
  const start = A(1, 100, 192, 50), early = A(1, 0, 104);
  const st2 = resolveOverlaps([start, early], [early], newId, 10).find((c) => c.id === start.id);
  assert.deepEqual([st2.s, st2.l, st2.o], [100, 192, 50], 'over the start: the 4 ticks under it stay');
  const p = createProject(); p.tempo = 120;
  assert.equal(xfadeKeep(p), Math.ceil(XFADE_SEC * 2 * PPQ));
  p.settings.xfade = 0;
  assert.equal(xfadeKeep(p), 0);
});

// two audio clips on one track at 120 BPM (192 ticks = 1 s): A plays `a` from 0 to 1 s, B plays `b` from tick bStart
// (180: 62.5 ms of overlap); levels are constant so the output shows the gain of each clip
const B_AT = 180, frameOf = (tick) => Math.ceil((tick / (2 * PPQ)) * SR);
function xfadeProject({ a = 0.5, b = 0.5, xfade = 1, bStart = B_AT } = {}) {
  const p = createProject();
  p.tempo = 120; p.settings.xfade = xfade;
  const mk = (name, v) => { const ch = createChannel(p, 'audio', { name, sample: { id: `test:${name}`, name }, mixer: 0 }); p.channels.push(ch); return [ch, new Float32Array(2 * SR).fill(v)]; };
  const [ca, da] = mk('a', a), [cb, db] = mk('b', b);
  const arr = currentArrangement(p), beat = 2 * PPQ;                          // 1 s = 2 beats at 120 BPM
  arr.clips.push(createClip(p, 'audio', 1, 0, beat, ca.id), createClip(p, 'audio', 1, bStart, beat, cb.id));
  const samples = new Map([[`test:a`, { rate: SR, channels: [da] }], [`test:b`, { rate: SR, channels: [db] }]]);
  return { p, samples };
}
const renderX = (o) => { const { p, samples } = xfadeProject(o); return renderOffline(p, samples, { mode: 'song', sampleRate: SR, tail: 0 }).left; };

test('overlapping audio clips crossfade with equal power over the overlap, capped at 50 ms, in the engine', () => {
  const onlyA = renderX({ b: 0 }), onlyB = renderX({ a: 0 }), both = renderX();
  const ref = onlyA[Math.round(0.5 * SR)];                                   // the level of one clip on its own
  assert.ok(ref > 0.3, `clip level ${ref}`);
  const x0 = frameOf(B_AT), x1 = x0 + Math.round(XFADE_SEC * SR);
  let worst = 0, jump = 0;
  for (let i = x0 - 200; i < x1 + 200; i++) {
    const ga = onlyA[i] / ref, gb = onlyB[i] / ref;
    worst = Math.max(worst, Math.abs(ga * ga + gb * gb - 1));
    jump = Math.max(jump, Math.abs(onlyA[i] - onlyA[i - 1]), Math.abs(onlyB[i] - onlyB[i - 1]));
  }
  assert.ok(worst < 0.01, `power is constant through the crossfade: ${worst}`);
  assert.ok(jump < ref * 0.002, `no step anywhere: ${jump}`);
  assert.ok(Math.abs(onlyA[x0 + Math.round(0.025 * SR)] / ref - Math.SQRT1_2) < 0.01, 'half way: -3 dB each');
  assert.ok(Math.abs(onlyA[x1 + 50]) < 1e-6, 'A is silent after the 50 ms crossfade (B covers it)');
  assert.ok(Math.abs(onlyB[x1 + 50] / ref - 1) < 1e-3 && Math.abs(onlyB[x0 - 10]) < 1e-6, 'B at full level after it, silent before');
  // the mix of two uncorrelated-level signals keeps its power; with equal signals the sum peaks at √2 in the middle
  assert.ok(peak(both.subarray(x0, x1)) < ref * 1.42 + 1e-3);
  // off: A plays to its end, B starts on its own
  const off = renderX({ b: 0, xfade: 0 });
  assert.ok(Math.abs(off[x1 + 50] / ref - 1) < 1e-3, 'auto crossfade off: A keeps playing under B');
});

test('a short overlap gives a short crossfade; playback starting inside a crossfade has the same gains as from the start', () => {
  const shortA = renderX({ b: 0, bStart: 190 });                             // 2 ticks = 10.4 ms of overlap
  const x0 = frameOf(190), ref = shortA[Math.round(0.5 * SR)], half = Math.round((1 / 192) * SR);
  assert.ok(Math.abs(shortA[x0 + half] / ref - Math.SQRT1_2) < 0.02, `half way through 10 ms: ${shortA[x0 + half] / ref}`);
  assert.ok(Math.abs(shortA[x0 + 2 * half + 30]) < 1e-6, 'and done at the end of the overlap');
  // live: the engine starts at a tick inside the crossfade (seek / loop start) and must give the same samples
  const { p, samples } = xfadeProject({ b: 0 });
  const full = renderOffline(p, samples, { mode: 'song', sampleRate: SR, tail: 0 }).left;
  const from = B_AT + 4;                                                     // ~21 ms into the crossfade
  const e = new Engine(SR);
  e.setProject(clone(p));
  for (const [sid, s] of samples) e.addSample(sid, s.rate, s.channels);
  e.play('song', from);
  const L = new Float32Array(SR / 10), R = new Float32Array(SR / 10);
  for (let o = 0; o < L.length; o += 128) e.process(L.subarray(o, o + 128), R.subarray(o, o + 128), 128);
  const off0 = (from / (2 * PPQ)) * SR, at = (i) => { const j = Math.floor(i), f = i - j; return full[j] * (1 - f) + full[j + 1] * f; };
  for (const k of [200, 600, 1000]) assert.ok(Math.abs(L[k] - at(off0 + k)) < 0.005, `same gain ${k} frames in: ${L[k]} vs ${at(off0 + k)}`);
  assert.ok(L[600] > 0.05 && L[600] < at(off0 - 2000) * 0.9, 'and that is inside the fade');
});

// ---- takes -----------------------------------------------------------------------------------------------------

test('loopPasses: one take per pass over the loop, from the loop start, with pre-roll, count-in and latency', () => {
  const ls = 384, le = 768, L = 384;
  // starts at the loop start, three full passes and a bit
  let r = loopPasses({ start: ls, trim: 5, total: 5 + 3 * L + 50, ls, le });
  assert.deepEqual(r, { pad: 0, passes: [5, 5 + L, 5 + 2 * L] }, 'a last pass shorter than a beat is the stop, not a take');
  r = loopPasses({ start: ls, trim: 5, total: 5 + 3 * L + 200, ls, le });
  assert.equal(r.passes.length, 4, 'a longer last pass is a take');
  // pre-roll from 0: the first pass covers the whole loop too
  r = loopPasses({ start: 0, lead: 384, trim: 3, total: 3 + 384 + 2 * 384 + L, ls, le });
  assert.deepEqual(r.passes, [3 + 384 + 384, 3 + 384 + 768]);
  // started inside the loop: the first pass is padded with silence
  r = loopPasses({ start: ls + 100, trim: 4, total: 4 + (le - ls - 100) + L, ls, le });
  assert.deepEqual(r, { pad: 96, passes: [0, 96 + 4 + 284] });
  // never came round: a plain recording
  assert.equal(loopPasses({ start: ls, total: L - 10, ls, le }), null);
  assert.equal(loopPasses({ start: ls, total: 2 * L, ls: 10, le: 10 }), null);
});

test('switching takes moves the clip window by the distance between passes; trims, stretch and slices keep it right', () => {
  const tempo = 120, sec = 60 / (tempo * PPQ);
  const takes = [{ id: 1, t: 10 * sec }, { id: 2, t: 394 * sec }, { id: 3, t: 778 * sec }];
  const c = A(1, 384, 384, 778, { takes, take: 3 });
  assert.ok(switchTake(c, 1, tempo));
  assert.deepEqual([c.s, c.l, c.o, c.take], [384, 384, 10, 1]);
  assert.ok(!switchTake(c, 1, tempo), 'already the active take');
  assert.ok(!switchTake(c, 99, tempo), 'unknown take');
  // trimmed from the left by 100 ticks: the window of every take starts 100 ticks later
  c.s += 100; c.l -= 100; c.o += 100;
  switchTake(c, 2, tempo);
  assert.equal(c.o, 494);
  // a slice keeps working: both halves switch on their own
  const right = { ...c, id: newId(), s: c.s + 100, l: c.l - 100, o: c.o + 100 };
  switchTake(right, 3, tempo);
  assert.equal(right.o, 978);
  // time-stretched 2x: the passes are twice as far apart in the clip
  const st = A(1, 0, 768, 1556, { takes, take: 3, stretch: 2 });
  switchTake(st, 2, tempo);
  assert.equal(st.o, 1556 - 768);
  // nothing recorded before the start: the clip starts later instead of reading before the recording
  const early = A(1, 384, 384, 300, { takes, take: 2 });
  switchTake(early, 1, tempo);
  assert.deepEqual([early.s, early.l, early.o], [384 + 84, 300, 0]);
});

test('takes, the active take and the auto crossfade setting survive save / load', () => {
  const p = createProject();
  const ch = createChannel(p, 'audio', { name: 'rec', sample: { id: 'user:abc', name: 'rec' } });
  p.channels.push(ch);
  const arr = currentArrangement(p);
  arr.clips.push({ ...createClip(p, 'audio', 2, 384, 384, ch.id), o: 400, takes: [{ id: 900, t: 0.1 }, { id: 901, t: 2.1 }, { id: 902, t: 4.1 }], take: 901 });
  arr.clips.push({ ...createClip(p, 'audio', 3, 0, 384, ch.id), takes: [{ id: 910, t: 0 }], take: 910 });      // one take = a plain clip
  arr.clips.push({ ...createClip(p, 'audio', 4, 0, 384, ch.id), takes: [{ id: 920, t: -5 }, null, 'x', { id: 920, t: 1e9 }], take: 777 });
  p.settings.xfade = 0;
  const q = normalize(JSON.parse(JSON.stringify(p)));
  const [c1, c2, c3] = [...currentArrangement(q).clips].sort((a, b) => a.track - b.track);
  assert.deepEqual(c1.takes, [{ id: 900, t: 0.1 }, { id: 901, t: 2.1 }, { id: 902, t: 4.1 }]);
  assert.equal(c1.take, 901);
  assert.equal(c2.takes, undefined, 'a single take is dropped');
  assert.equal(c3.takes.length, 2);
  assert.ok(c3.takes[0].t === 0 && c3.takes[1].t === 1e6, 'offsets are clamped');
  assert.notEqual(c3.takes[0].id, c3.takes[1].id, 'duplicate ids are renumbered');
  assert.equal(c3.take, c3.takes[1].id, 'an unknown active take falls back to the newest');
  assert.equal(q.settings.xfade, 0);
  assert.equal(normalize(JSON.parse(JSON.stringify(createProject()))).settings.xfade, 1, 'auto crossfade is on by default');
  assert.equal(JSON.stringify(normalize(JSON.parse(JSON.stringify(q)))), JSON.stringify(q), 'normalize is idempotent');
});

// ---- consolidate ------------------------------------------------------------------------------------------------

test('range helpers: splitAtRange cuts at the edges, freeTrack finds room', () => {
  const a = P(1, 0, 1000), b = P(2, 300, 100), c = P(3, 2000, 100);
  const { clips, inner } = splitAtRange([a, b, c], [a.id, b.id, c.id], 200, 600, newId);
  assert.deepEqual(clips.filter((x) => x.track === 1).map((x) => [x.s, x.l, x.o]), [[0, 200, 0], [200, 400, 200], [600, 400, 600]]);
  assert.deepEqual(inner.map((x) => [x.track, x.s, x.l]).sort(), [[1, 200, 400], [2, 300, 100]]);
  assert.equal(freeTrack(clips, 200, 400, 1), 3);
  assert.equal(freeTrack(clips, 200, 400, 2), 3);
  assert.equal(freeTrack(clips, 1900, 50, 3), 3);
});

const BAR = 4 * PPQ;
// kick on insert 2 (delay + look-ahead limiter: tails and delay compensation), snare audio clip on insert 3,
// a master with its own level and EQ: the consolidated clip must sound exactly like the clips it replaces
function songProject() {
  const p = createProject();
  p.tempo = 120;
  const kick = createChannel(p, 'sampler', { name: 'Kick', sample: { id: 'factory:kick-punch', name: 'k' }, mixer: 2 });
  const snare = createChannel(p, 'audio', { name: 'Snare', sample: { id: 'factory:snare-tight', name: 's' }, mixer: 3 });
  p.channels.push(kick, snare);
  p.patterns[1].notes[kick.id] = [1, 5, 9, 13].map((st) => createNote(p, st * STEP, STEP, 60, 110));
  p.mixer.tracks[2].fx[0] = createFxSlot('delay');
  p.mixer.tracks[2].fx[1] = createFxSlot('limiter');
  p.mixer.tracks[0].vol = 0.6; p.mixer.tracks[0].eqLowG = 4;
  const arr = currentArrangement(p);
  arr.clips.push(createClip(p, 'pattern', 1, 0, 3 * BAR, 1), createClip(p, 'audio', 2, BAR + PPQ, PPQ * 2, snare.id));
  return p;
}
const renderAll = (p, samples) => renderOffline(p, samples, { mode: 'song', sampleRate: SR, tail: 3, ring: true });   // notes ring past the song end
function consolidateOffline(p, samples, opts) {
  const arr = currentArrangement(p), sources = consolidateSources(arr, opts);
  const r = renderOffline(prepareRender(p, sources.map((c) => c.id), opts), samples, { mode: 'song', sampleRate: SR, from: opts.s, to: opts.e, tail: opts.tail, align: true, ring: true });
  const len = renderedLength(r.left, r.right, SR, { s: opts.s, e: opts.e, tempo: p.tempo, tail: opts.tail });
  samples.set('user:render', { rate: SR, channels: [r.left.slice(0, len.frames), r.right.slice(0, len.frames)] });
  const q = clone(p);
  const made = applyConsolidate(q, currentArrangement(q), { s: opts.s, e: opts.e, sources: sources.map((c) => c.id), track: opts.track ?? null, remove: !!opts.remove, sample: { id: 'user:render', name: 'render' }, l: len.ticks });
  return { q, made, sources, len };
}
function sameSound(a, b, what) {
  const n = Math.min(a.left.length, b.left.length), ref = peak(a.left);
  let d = 0;
  for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(a.left[i] - b.left[i]), Math.abs(a.right[i] - b.right[i]));
  assert.ok(ref > 0.05, `${what}: there is sound (${ref})`);
  assert.ok(d < ref * 2e-3, `${what}: same audio, largest difference ${d} of ${ref}`);
}

test('consolidate the selected clips: one audio clip on a free track sounds like them; originals muted or removed', () => {
  const p = songProject(), samples = collectFactorySamples(p, SR);
  const before = renderAll(p, samples);
  const arr = currentArrangement(p), ids = arr.clips.map((c) => c.id);
  const { q, made, len } = consolidateOffline(p, samples, { s: 0, e: 3 * BAR, ids, mode: 'clips', tail: 2 });
  assert.ok(len.ticks > 3 * BAR, 'the delay tail is part of the clip');
  const qa = currentArrangement(q);
  assert.equal(made.clip.s, 0); assert.equal(made.clip.o, 0); assert.equal(made.clip.track, 3, 'first free track below the originals');
  assert.equal(made.channel.mixer, 0, 'the clip plays into the master');
  assert.ok(qa.clips.filter((c) => ids.includes(c.id)).every((c) => c.mute === 1), 'originals muted');
  sameSound(before, renderAll(q, samples), 'consolidated');
  // remove: the originals go and the clip takes the top track
  const r2 = consolidateOffline(p, samples, { s: 0, e: 3 * BAR, ids, mode: 'clips', tail: 2, remove: true });
  assert.equal(currentArrangement(r2.q).clips.length, 1);
  assert.equal(r2.made.clip.track, 1);
  sameSound(before, renderAll(r2.q, samples), 'consolidated, originals removed');
});

test('consolidate a time range of the whole mix: clips are cut at the range edges, the inside replaced', () => {
  const p = songProject(), samples = collectFactorySamples(p, SR);
  const before = renderAll(p, samples);
  const s = BAR, e = 2 * BAR;
  const { q, made, sources } = consolidateOffline(p, samples, { s, e, mode: 'mix', tail: 2 });
  assert.equal(sources.length, 2);
  const qa = currentArrangement(q);
  const pats = qa.clips.filter((c) => c.type === 'pattern').sort((a, b) => a.s - b.s);
  assert.deepEqual(pats.map((c) => [c.s, c.l, c.o, c.mute]), [[0, BAR, 0, 0], [BAR, BAR, BAR, 1], [2 * BAR, BAR, 2 * BAR, 0]]);
  assert.equal(made.clip.s, s);
  sameSound(before, renderAll(q, samples), 'range consolidated');
  // only the selected clip in that range: the rest keeps playing as it was
  const pat = currentArrangement(p).clips.find((c) => c.type === 'pattern');
  const r2 = consolidateOffline(p, samples, { s, e, ids: [pat.id], mode: 'clips', tail: 2 });
  assert.equal(r2.sources.length, 1);
  assert.equal(currentArrangement(r2.q).clips.filter((c) => c.type === 'audio' && c.ref !== r2.made.channel.id)[0].mute, 0, 'the snare is not touched');
  sameSound(before, renderAll(r2.q, samples), 'selected clip in a range');
});

test('render a playlist track: the clip takes its place on the same track, muted originals move to a free track', () => {
  const p = songProject(), samples = collectFactorySamples(p, SR);
  const before = renderAll(p, samples);
  const arr = currentArrangement(p), pat = arr.clips.find((c) => c.type === 'pattern');
  const { q, made } = consolidateOffline(p, samples, { s: pat.s, e: pat.s + pat.l, track: 1, mode: 'clips', tail: 2 });
  const qa = currentArrangement(q);
  assert.equal(made.clip.track, 1);
  const moved = qa.clips.find((c) => c.id === pat.id);
  assert.ok(moved.mute === 1 && moved.track === 3, `original muted on a free track: ${JSON.stringify(moved)}`);
  sameSound(before, renderAll(q, samples), 'track render');
  // the master's own automation is left out of the render and keeps working on the clip
  const auto = createChannel(p, 'automation', { name: 'fade', target: 'master:vol', points: [{ t: 0, v: 0.7, type: 'single' }, { t: 3 * BAR, v: 0.2, type: 'single' }], len: 3 * BAR });
  p.channels.push(auto);
  arr.clips.push(createClip(p, 'automation', 9, 0, 3 * BAR, auto.id));
  const withAuto = renderAll(p, samples);
  const r2 = consolidateOffline(p, samples, { s: 0, e: 3 * BAR, ids: [pat.id, arr.clips.find((c) => c.type === 'audio').id], mode: 'clips', tail: 2 });
  sameSound(withAuto, renderAll(r2.q, samples), 'master automation applies once');
});
