// Offline rendering with the very same Engine used live. Used by Export (WAV/FLAC/OGG/MP3),
// stems per mixer track, "Rendered" audio clips and the unit tests.
import { BLOCK, MAX_INSERT } from './constants.js';
import { Engine } from './engine.js';
import { clone, currentArrangement, songLength, patternLength } from './project.js';
import { LoudnessMeter } from './loudness.js';

// samples: Map id -> { rate, channels: [Float32Array, ...] }
// opts: { sampleRate=44100, mode='song'|'pat', from=0, to=null (ticks), tail=4 (seconds) | 'auto',
//         soloTrack=null, measure=false (adds .loudness: integrated, range, true peak…), onProgress(frac), shouldCancel() }
export function renderOffline(project, samples, opts = {}) {
  const sr = opts.sampleRate || 44100;
  const mode = opts.mode === 'pat' ? 'pat' : 'song';
  const p = clone(project);
  p.settings.metronome = 0;
  if (opts.soloTrack != null) {
    for (const t of p.mixer.tracks) t.solo = 0;
    if (opts.soloTrack > 0) p.mixer.tracks[opts.soloTrack].solo = 1;
  }
  const eng = new Engine(sr);
  eng.noLoop = true;
  if (opts.measure) eng.meter = new LoudnessMeter(sr);
  eng.setProject(p);
  for (const [id, s] of samples) eng.addSample(id, s.rate, s.channels);

  const from = opts.from || 0;
  let end;
  if (opts.to != null) end = opts.to;
  else if (mode === 'song') end = songLength(p, currentArrangement(p));
  else end = patternLength(p, p.patterns[p.currentPattern]);
  if (end <= from) return { left: new Float32Array(0), right: new Float32Array(0), sampleRate: sr, frames: 0 };

  eng.play(mode, from);

  const est = Math.ceil(((end - from) / (p.tempo * 96 / 60 / sr)) + sr * 12);
  let capacity = Math.max(est, BLOCK * 8);
  let L = new Float32Array(capacity), R = new Float32Array(capacity);
  let n = 0;
  const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
  const grow = () => {
    capacity *= 2;
    const nl = new Float32Array(capacity), nr = new Float32Array(capacity);
    nl.set(L.subarray(0, n)); nr.set(R.subarray(0, n)); L = nl; R = nr;
  };

  let blocks = 0;
  // main body: until the transport reaches `end`
  while (eng.tr.playing && eng.tr.tick < end) {
    if (n + BLOCK > capacity) grow();
    eng.process(bl, br, BLOCK);
    L.set(bl, n); R.set(br, n); n += BLOCK;
    if ((++blocks & 255) === 0) {
      if (opts.shouldCancel && opts.shouldCancel()) return null;
      if (opts.onProgress) opts.onProgress(Math.min(1, (eng.tr.tick - from) / (end - from)));
    }
    if (n > sr * 3600) break; // safety: one hour
  }
  const bodyFrames = n;
  // tail: let delays / reverbs / releases ring out
  eng.stop();
  const tailAuto = opts.tail === 'auto';
  const tailMax = Math.round((tailAuto ? 20 : (opts.tail ?? 4)) * sr);
  let quiet = 0;
  for (let t = 0; t < tailMax; t += BLOCK) {
    if (n + BLOCK > capacity) grow();
    eng.process(bl, br, BLOCK);
    L.set(bl, n); R.set(br, n); n += BLOCK;
    if (tailAuto) {
      let peak = 0;
      for (let i = 0; i < BLOCK; i++) { const a = Math.max(Math.abs(bl[i]), Math.abs(br[i])); if (a > peak) peak = a; }
      quiet = peak < 1e-4 ? quiet + BLOCK : 0;
      if (quiet > sr * 0.4) break;
    }
  }
  if (opts.onProgress) opts.onProgress(1);
  return { left: L.slice(0, n), right: R.slice(0, n), sampleRate: sr, frames: n, bodyFrames, loudness: eng.meter ? eng.meter.stats() : null };
}

// Render each used mixer track separately (FL "split mixer tracks"). Returns [{ track, left, right }].
export function renderStems(project, samples, opts = {}, tracks = null) {
  const list = tracks || usedTracks(project);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const r = renderOffline(project, samples, { ...opts, soloTrack: list[i], onProgress: opts.onProgress && ((f) => opts.onProgress((i + f) / list.length)) });
    if (!r) return null;
    out.push({ track: list[i], ...r });
  }
  return out;
}

export function usedTracks(project) {
  const used = new Set();
  for (const ch of project.channels) if (ch.type !== 'automation' && ch.type !== 'layer') used.add(ch.mixer);
  used.delete(0);
  return [...used].sort((a, b) => a - b).filter((n) => n >= 1 && n <= MAX_INSERT);
}
