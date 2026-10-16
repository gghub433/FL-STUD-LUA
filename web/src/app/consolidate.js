// Consolidate / render to audio clip: renders a range of the playlist in the export worker (the engine that plays
// the song) and replaces it by one audio clip. What sounds and what changes is decided in core/consolidate.js;
// the audio is kept like other renders (sample bank + Browser > Rendered).
import { renderInWorker } from '../host/export/render-client.js';
import { consolidateSources, prepareRender, renderedLength } from '../core/consolidate.js';

// opts: { s, e, ids, track, mode: 'clips' | 'mix', tail (seconds), remove }. Resolves to the new clip, or null when
// nothing in the range makes a sound (or the render was cancelled).
export async function consolidate(app, opts, { onProgress } = {}) {
  const store = app.store, project = store.project;
  const sources = consolidateSources(store.arrangement, opts);
  if (!sources.length) return null;
  await app.bank.ensureProject(project);
  const sampleRate = app.host.sampleRate || 44100, tail = Math.max(0, Math.min(10, +opts.tail || 0));
  const job = {
    project: prepareRender(project, sources.map((c) => c.id), opts),
    samples: [...app.bank.map].map(([id, e]) => ({ id, rate: e.rate, channels: e.channels })),
    opts: { mode: 'song', from: opts.s, to: opts.e, tail, sampleRate, align: true, ring: true },
    packs: app.packs ? app.packs.sources() : [],
  };
  const out = await renderInWorker(job, { onProgress }).promise;
  const r = out && out.result;
  if (!r || !r.frames) return null;
  const len = renderedLength(r.left, r.right, r.sampleRate, { s: opts.s, e: opts.e, tempo: project.tempo, tail });
  const left = r.left.slice(0, len.frames), right = r.right.slice(0, len.frames);
  const mono = left.every((v, i) => v === right[i]);
  const name = opts.track != null ? `${(store.arrangement.tracks[opts.track] || {}).name || `Track ${opts.track}`} (render)` : `Consolidated ${new Date().toLocaleTimeString()}`;
  const entry = app.bank.addPCM(name, r.sampleRate, mono ? [left] : [left, right]);
  try { await app.library.save('rendered', entry.name, { id: entry.id }); } catch (_) { /* storage unavailable */ }
  const made = app.cmd.applyConsolidate(store, {
    s: opts.s, e: opts.e, sources: sources.map((c) => c.id), track: opts.track ?? null, remove: !!opts.remove,
    sample: { id: entry.id, name: entry.name }, l: len.ticks, name: entry.name,
  });
  return made.clip;
}
