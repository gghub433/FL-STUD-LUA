// Export through Web Audio, for projects with WAM plugins: a plugin exists only as a Web Audio node, so the render
// worker (plain Engine, no Web Audio) cannot play it. Here the same engine runs as an AudioWorklet in an
// OfflineAudioContext with the plugins wired to it exactly as live (host/wam-host.js), faster than real time.
// The engine stops the transport at the end and reports when the tail has rung out ('offline' message in the
// processor), so the result matches the worker's: { left, right, sampleRate, frames, report } or per-stem results.
import { ENGINE_NODE_OPTIONS } from '../audio-host.js';
import { WamRig, wamUses } from '../wam-host.js';
import { clone, currentArrangement, songLength, patternLength } from '../../core/project.js';
import { usedTracks } from '../../core/offline.js';
import { applyTarget } from '../../core/loudness.js';
import { PPQ } from '../../core/constants.js';

// env: { workletUrl, moduleHooks: [(ctx) => Promise], liveState(owner) => Promise<state|null> }
export function renderWithWebAudio(job, { onProgress } = {}, env) {
  let cancelled = false;
  const promise = (async () => {
    const o = job.opts || {};
    // the plugins' current state, not the one saved a few seconds ago
    const project = clone(job.project);
    if (env.liveState) for (const u of wamUses(project)) { const s = await env.liveState(u.owner); if (s) u.data.state = s; }
    if (job.stems) {
      const tracks = usedTracks(project), stems = [];
      for (let i = 0; i < tracks.length; i++) {
        const r = await renderOnce(project, job, tracks[i], (f) => onProgress && onProgress((i + f) / tracks.length), env, () => cancelled);
        if (!r) return null;
        stems.push({ track: tracks[i], left: r.left, right: r.right, sampleRate: r.sampleRate, frames: r.frames, report: finish(r, o) });
      }
      return { stems };
    }
    const r = await renderOnce(project, job, null, (f) => onProgress && onProgress(f), env, () => cancelled);
    if (!r) return null;
    return { result: { left: r.left, right: r.right, sampleRate: r.sampleRate, frames: r.frames, report: finish(r, o) } };
  })();
  return { promise, cancel: () => { cancelled = true; } };
}

function finish(r, o) {
  if (!r.frames) return null;
  return applyTarget(r.left, r.right, r.sampleRate, o.target || 'off', o.ceiling ?? -1, r.loudness);
}

async function renderOnce(project0, job, soloTrack, progress, env, isCancelled) {
  const o = job.opts || {};
  const sr = o.sampleRate || 44100, mode = o.mode === 'pat' ? 'pat' : 'song';
  const p = clone(project0);
  p.settings.metronome = 0;
  if (soloTrack != null) {
    for (const t of p.mixer.tracks) t.solo = 0;
    if (soloTrack > 0) p.mixer.tracks[soloTrack].solo = 1;
  }
  const from = o.from || 0;
  const end = o.to != null ? o.to : mode === 'song' ? songLength(p, currentArrangement(p)) : patternLength(p, p.patterns[p.currentPattern]);
  if (end <= from) return { left: new Float32Array(0), right: new Float32Array(0), sampleRate: sr, frames: 0 };
  const tail = o.tail === 'auto' ? 'auto' : (o.tail ?? 4);
  const tailSec = tail === 'auto' ? 20 : tail;
  // a generous length from the project tempo; if the body did not fit (tempo automation), it is rendered again, longer
  let bodySec = ((end - from) / (p.tempo * PPQ / 60)) * 1.15 + 1;
  for (let attempt = 0; attempt < 4; attempt++) {
    const frames = Math.ceil((bodySec + tailSec + 1) * sr);
    const r = await renderLength(p, job, { sr, mode, from, end, tail, frames }, progress, env);
    if (isCancelled()) return null;
    if (r.done) return r;
    bodySec *= 2;
  }
  throw new Error('The song did not end while rendering (is the tempo extremely slow?)');
}

async function renderLength(p, job, { sr, mode, from, end, tail, frames }, progress, env) {
  const oc = new OfflineAudioContext({ numberOfChannels: 2, length: frames, sampleRate: sr });
  await oc.audioWorklet.addModule(env.workletUrl);
  for (const f of env.moduleHooks || []) { try { await f(oc); } catch (err) { console.warn('[export] module', err); } }
  const node = new AudioWorkletNode(oc, 'stepwise-engine', ENGINE_NODE_OPTIONS);
  node.connect(oc.destination, 0, 0);
  let done = null, doneResolve;
  const doneP = new Promise((r) => { doneResolve = r; });
  const pongs = new Map();
  node.port.onmessage = (e) => {
    const m = e.data;
    if (m.t === 'offlineDone') { done = m; doneResolve(m); }
    else if (m.t === 'pong' && pongs.has(m.id)) { pongs.get(m.id)(); pongs.delete(m.id); }
    else if (m.t === 'state' && progress) progress(Math.max(0, Math.min(0.99, (m.tick - from) / (end - from))));
  };
  const send = (m) => node.port.postMessage(m);
  const ping = () => new Promise((r) => { const id = Math.random(); pongs.set(id, r); send({ t: 'ping', id }); });
  await ping();                                                     // the engine processor exists
  const rig = new WamRig(oc, node, send);
  const uses = wamUses(p);
  if (uses.length) {
    await rig.init();
    for (const u of uses) {
      try { await rig.attach(u.owner, u.kind, u.url, u.state); } catch (err) { throw new Error(`WAM plugin “${u.name || u.url}” could not be loaded for the export: ${err.message || err}`); }
    }
  }
  send({ t: 'init', project: p });
  for (const s of job.samples || []) send({ t: 'sample', id: s.id, rate: s.rate, channels: s.channels });
  send({ t: 'offline', end, tail });
  send({ t: 'play', mode, from });
  await ping();                                                     // everything above has been applied
  const buf = await oc.startRendering();
  if (!done) await Promise.race([doneP, new Promise((r) => setTimeout(r, 1500))]);
  rig.close();
  if (!done || done.bodyFrames == null) return { done: false };
  const n = Math.min(buf.length, done.frames);
  if (progress) progress(1);
  return { done: true, left: buf.getChannelData(0).slice(0, n), right: buf.getChannelData(1).slice(0, n), sampleRate: sr, frames: n, bodyFrames: done.bodyFrames, loudness: done.loudness };
}
