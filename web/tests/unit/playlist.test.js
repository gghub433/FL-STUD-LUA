import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createChannel, createNote, createClip, createPattern, currentArrangement, barTicks, normalize, clone, nextId } from '../../src/core/project.js';
import { resolveOverlaps, splitClip, trimLeft, spanOf, defaultClipLength } from '../../src/core/playlist-ops.js';
import { Engine } from '../../src/core/engine.js';
import { collectFactorySamples } from '../../src/core/factory.js';
import { STEP, PPQ } from '../../src/core/constants.js';
import { oneChannelProject, renderSong, onsets, peak, SR } from './helpers.js';

let id = 1000;
const newId = () => ++id;
const C = (track, s, l, o = 0, extra = {}) => ({ id: newId(), type: 'pattern', track, s, l, ref: 1, o, mute: 0, ...extra });

test('placing a clip over others trims, splits and removes what is underneath', () => {
  const a = C(1, 0, 384), b = C(1, 384, 384), c = C(2, 0, 384);
  const placed = C(1, 192, 384);                          // covers the right half of a and the left half of b
  const out = resolveOverlaps([a, b, c, placed], [placed], newId);
  const t1 = out.filter((x) => x.track === 1).sort((x, y) => x.s - y.s);
  assert.deepEqual(t1.map((x) => [x.s, x.l, x.o]), [[0, 192, 0], [192, 384, 0], [576, 192, 192]]);
  assert.equal(out.filter((x) => x.track === 2).length, 1, 'other tracks untouched');

  const big = C(1, 0, 1000), small = C(1, 300, 100);
  const o2 = resolveOverlaps([big, small], [small], newId).filter((x) => x.track === 1).sort((x, y) => x.s - y.s);
  assert.deepEqual(o2.map((x) => [x.s, x.l, x.o]), [[0, 300, 0], [300, 100, 0], [400, 600, 400]], 'a clip dropped inside another splits it in two');
  assert.equal(new Set(o2.map((x) => x.id)).size, 3);

  const under = C(1, 100, 50), cover = C(1, 0, 400);
  assert.equal(resolveOverlaps([under, cover], [cover], newId).length, 1, 'fully covered clips vanish');
});

test('fades stay with the first and last piece of a split clip', () => {
  const a = C(1, 0, 1000, 0, { fi: 0.1, fo: 0.2 }), mid = C(1, 400, 100);
  const out = resolveOverlaps([a, mid], [mid], newId).filter((x) => x.track === 1).sort((x, y) => x.s - y.s);
  assert.equal(out[0].fi, 0.1); assert.equal(out[0].fo, undefined);
  assert.equal(out[2].fi, undefined); assert.equal(out[2].fo, 0.2);
});

test('splitClip cuts content in place; trimLeft keeps content aligned', () => {
  const c = C(1, 100, 400, 50);
  const r = splitClip(c, 300, newId);
  assert.deepEqual([c.s, c.l, c.o, r.s, r.l, r.o], [100, 200, 50, 300, 200, 250]);
  assert.equal(splitClip(c, 100, newId), null);
  const t = C(1, 100, 400, 0);
  trimLeft(t, 150);
  assert.deepEqual([t.s, t.l, t.o], [150, 350, 50]);
  const audio = C(1, 100, 400, 20);
  trimLeft(audio, 0);                                    // cannot extend before the source start
  assert.deepEqual([audio.s, audio.l, audio.o], [80, 420, 0]);
  const pat = C(1, 100, 400, 20);
  trimLeft(pat, 0, 96);                                  // patterns loop, so they can
  assert.equal(pat.s, 0); assert.equal(pat.l, 500); assert.equal(pat.o, ((20 - 100) % 96 + 96) % 96);
  assert.deepEqual(spanOf([C(1, 0, 10), C(5, 40, 10)]), { s: 0, e: 50, t0: 1, t1: 5 });
});

test('default clip lengths: pattern = its length, audio = sample duration at the tempo', () => {
  const { p } = oneChannelProject('kick-punch', [0]);
  assert.equal(defaultClipLength(p, 'pattern', 1), barTicks(p.timeSig));
  p.tempo = 120;
  assert.equal(defaultClipLength(p, 'audio', 0, { length: SR, rate: SR }), 2 * PPQ);   // 1 s = 2 beats
});

test('normalize keeps clip.use and still limits tracks to 1..500', () => {
  const p = createProject();
  const ch = createChannel(p, 'audio', { name: 'a', sample: { id: 'factory:kick-punch', name: 'k' } });
  p.channels.push(ch);
  const arr = currentArrangement(p);
  arr.clips.push({ ...createClip(p, 'audio', 3, 0, 96, ch.id), use: 'stretch:factory:kick-punch:2.0000:0.00' }, { ...createClip(p, 'audio', 9999, 0, 96, ch.id) });
  const q = normalize(JSON.parse(JSON.stringify(p)));
  const clips = currentArrangement(q).clips;
  assert.equal(clips[0].use, 'stretch:factory:kick-punch:2.0000:0.00');
  assert.equal(clips[1].track, 500);
});

test('pattern-length markers change how pattern clips repeat', () => {
  const { p, ch } = oneChannelProject('kick-punch', [0]);
  p.tempo = 120;
  const arr = currentArrangement(p), bar = barTicks(p.timeSig);
  arr.clips.push(createClip(p, 'pattern', 1, 0, 4 * bar, 1));
  arr.markers.push({ id: 900, t: 0, type: 'patlen', name: '', num: 4, den: 4, len: bar / 2 });   // half-bar patterns
  const r = renderSong(p, { tail: 0.3 });
  const on = onsets(r.left, 0.05, 3000);
  assert.equal(on.length, 8, `eight repeats of a half-bar pattern in four bars, got ${on.length}`);
  on.forEach((o, i) => assert.ok(Math.abs(o - i * SR) < 100, `repeat ${i} at ${o}`));
  void ch;
});

function perfEngine() {
  const { p, ch } = oneChannelProject('kick-punch', [0]);
  p.tempo = 120; p.settings.metronome = 0;
  const arr = currentArrangement(p);
  const clip = createClip(p, 'pattern', 1, 0, 384, 1);
  arr.clips.push(clip);
  const e = new Engine(SR);
  e.setProject(clone(p));
  for (const [sid, s] of collectFactorySamples(p, SR)) e.addSample(sid, s.rate, s.channels);
  const run = (sec) => { const n = Math.round(sec * SR), L = new Float32Array(n), R = new Float32Array(n); for (let o = 0; o < n; o += 128) e.process(L.subarray(o, Math.min(n, o + 128)), R.subarray(o, Math.min(n, o + 128)), Math.min(128, n - o)); return L; };
  return { e, run, clip, p, ch };
}

test('performance mode: a launched clip starts on the quantize boundary and loops until stopped', () => {
  const { e, run, clip } = perfEngine();
  e.play('perf', 0);
  const quiet = run(0.25);
  assert.ok(peak(quiet) < 1e-4, 'nothing plays before a clip is launched');
  e.perfLaunch(clip.id, 384);                         // next bar boundary: 2 s
  assert.equal(e.perf[0].start, 384);
  const out = run(6.0);                                // 0.25 .. 6.25 s
  const on = onsets(out, 0.05, 4000).map((o) => (o + 0.25 * SR) / SR);
  assert.ok(on.length >= 3, `repeated: ${on}`);
  assert.ok(Math.abs(on[0] - 2) < 0.01, `first hit on the bar line: ${on[0]}`);
  assert.ok(Math.abs(on[1] - 4) < 0.01 && Math.abs(on[2] - 6) < 0.01, `loops every bar: ${on}`);
  e.perfStop(1, 384);                                  // stop at the next bar line (8 s)
  const after = run(5);                                // 6.25 .. 11.25 s
  const hits = onsets(after, 0.05, 4000).map((o) => (o + 6.25 * SR) / SR);
  assert.equal(hits.length, 0, `nothing after the stop boundary (the cycle that would start at 8 s is cancelled): ${hits}`);
});

test('performance mode: launching another clip on the same track replaces the first at the boundary', () => {
  const { e, run, clip, p, ch } = perfEngine();
  const arr = e.project.playlist.arrangements[0];
  // second pattern: hit on step 4 instead of step 0
  const pat2 = createPattern(e.project, 2, 'B');
  pat2.notes[ch.id] = [createNote(e.project, STEP * 8, STEP, 60, 127)];
  const clip2 = { id: 77, type: 'pattern', track: 1, s: 0, l: 384, ref: 2, o: 0, mute: 0 };
  arr.clips.push(clip2);
  e.dirty = true;
  e.play('perf', 0);
  e.perfLaunch(clip.id, 0);
  run(0.1);
  e.perfLaunch(77, 384);                               // at 2 s
  assert.equal(e.perf.find((x) => x.clip.id === clip.id).stop, 384, 'first clip is ended where the second starts');
  const out = run(4.2);                                // 0.1 .. 4.3 s
  const on = onsets(out, 0.05, 4000).map((o) => (o + 0.1 * SR) / SR);
  // kick on beat 0 of bar 1 (0 s) is before our window; pattern B hits at 1 s into each of its bars: 3 s
  assert.ok(on.some((t) => Math.abs(t - 3) < 0.01), `B plays after the switch: ${on}`);
  assert.ok(!on.some((t) => Math.abs(t - 2) < 0.01), `A does not start another cycle at the switch: ${on}`);
  void p;
});

// ---- audio clips -------------------------------------------------------------------------
import { renderOffline } from '../../src/core/offline.js';
import { firstSound } from './helpers.js';

function audioProject({ clip = {}, tempo = 120 } = {}) {
  const p = createProject();
  p.tempo = tempo;
  const ch = createChannel(p, 'audio', { name: 'a', sample: { id: 'test:burst', name: 'burst' }, mixer: 0 });
  p.channels.push(ch);
  // 1 s sample: silence, a 50 ms 1 kHz burst at 0.8 s
  const n = SR, data = new Float32Array(n);
  for (let i = 0; i < SR * 0.05; i++) data[Math.round(SR * 0.8) + i] = 0.8 * Math.sin((2 * Math.PI * 1000 * i) / SR);
  const arr = currentArrangement(p);
  arr.clips.push({ ...createClip(p, 'audio', 1, 0, 2 * PPQ, ch.id), ...clip });      // 2 beats = 1 s at 120 bpm
  const samples = new Map([['test:burst', { rate: SR, channels: [data] }]]);
  return { p, ch, samples, data };
}
const renderA = (p, samples) => renderOffline(p, samples, { mode: 'song', sampleRate: SR, tail: 0.1 });

test('audio clip plays the sample from its start at the clip position', () => {
  const { p, samples } = audioProject();
  currentArrangement(p).clips[0].s = PPQ * 2;                      // starts at 1 s
  const r = renderA(p, samples);
  const at = firstSound(r.left, 0, 0.05);
  assert.ok(Math.abs(at - SR * 1.8) < SR * 0.002, `burst at 1.8 s, got ${at / SR}`);
});

test('reversed audio clip plays its window backwards (the burst moves to the start)', () => {
  const { p, samples } = audioProject({ clip: { rev: 1 } });
  const r = renderA(p, samples);
  const at = firstSound(r.left, 0, 0.05);
  // burst occupies 0.8..0.85 s; reversed it occupies 0.15..0.2 s
  assert.ok(at > SR * 0.14 && at < SR * 0.17, `reversed burst starts near 0.15 s, got ${at / SR}`);
});

test('clip offset skips into the sample; gain and fades shape the level', () => {
  const a = audioProject({ clip: { o: PPQ * 1.5, l: PPQ * 0.5 } });         // window 0.75..1.0 s
  const r = renderA(a.p, a.samples);
  const at = firstSound(r.left, 0, 0.05);
  assert.ok(Math.abs(at - SR * 0.05) < SR * 0.003, `burst now at 0.05 s, got ${at / SR}`);
  const g0 = audioProject(), g1 = audioProject({ clip: { gain: -6 } });
  const p0 = peak(renderA(g0.p, g0.samples).left), p1 = peak(renderA(g1.p, g1.samples).left);
  assert.ok(Math.abs(p1 / p0 - 0.5012) < 0.02, `-6 dB halves the level: ${p1 / p0}`);
  const f = audioProject({ clip: { fo: Math.round(PPQ * 0.8) } });         // fade-out (ticks) over the last 0.4 s: the burst (0.8..0.85 s) is inside it
  const pf = peak(renderA(f.p, f.samples).left);
  assert.ok(Math.abs(pf / p0 - 0.5) < 0.05, `linear fade-out: the burst starts with 0.2 s of the 0.4 s fade left, so about half level: ${pf / p0}`);
});

test('clip.use points the clip at a derived (stretched) sample', () => {
  const { p, samples } = audioProject({ clip: { use: 'test:long', l: 4 * PPQ } });
  const long = new Float32Array(2 * SR); for (let i = 0; i < SR * 0.1; i++) long[Math.round(SR * 1.6) + i] = 0.8 * Math.sin((2 * Math.PI * 1000 * i) / SR);
  samples.set('test:long', { rate: SR, channels: [long] });
  const r = renderA(p, samples);
  const at = firstSound(r.left, 0, 0.05);
  assert.ok(Math.abs(at - SR * 1.6) < SR * 0.003, `uses the derived sample, burst at 1.6 s, got ${at / SR}`);
});

test('clip pitch resamples (+12 st halves the duration)', () => {
  const { p, samples } = audioProject({ clip: { pitch: 12, l: 2 * PPQ } });
  const r = renderA(p, samples);
  const at = firstSound(r.left, 0, 0.05);
  assert.ok(Math.abs(at - SR * 0.4) < SR * 0.004, `burst moves to 0.4 s, got ${at / SR}`);
});
