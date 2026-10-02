// Offline render in a module Worker: the same Engine that runs in the AudioWorklet renders the project
// as fast as the CPU allows without blocking the page. Cancelling terminates the worker.
import { renderOffline, renderStems } from '../core/offline.js';
import { installPackHook } from '../core/packs.js';

installPackHook(self, { smoke: false });

// installed plugin packs are evaluated here first, so projects that use them render exactly as they sound
self.onmessage = async (e) => {
  const { project, samples, opts, stems, packs = [] } = e.data;
  try {
    for (const p of packs) { const url = URL.createObjectURL(new Blob([p.source], { type: 'text/javascript' })); try { await import(url); } finally { URL.revokeObjectURL(url); } }
  } catch (err) { self.postMessage({ t: 'error', message: `A plugin pack could not be loaded: ${err && err.message || err}` }); return; }
  const map = new Map(samples.map((s) => [s.id, { rate: s.rate, channels: s.channels }]));
  const progress = (f) => self.postMessage({ t: 'progress', f });
  try {
    if (stems) {
      const res = renderStems(project, map, { ...opts, onProgress: progress });
      const out = res.map((r) => ({ track: r.track, left: r.left, right: r.right, sampleRate: r.sampleRate, frames: r.frames }));
      self.postMessage({ t: 'done', stems: out }, out.flatMap((r) => [r.left.buffer, r.right.buffer]));
    } else {
      const r = renderOffline(project, map, { ...opts, onProgress: progress });
      self.postMessage({ t: 'done', result: { left: r.left, right: r.right, sampleRate: r.sampleRate, frames: r.frames } }, [r.left.buffer, r.right.buffer]);
    }
  } catch (err) {
    self.postMessage({ t: 'error', message: String(err && err.message || err) });
  }
};
