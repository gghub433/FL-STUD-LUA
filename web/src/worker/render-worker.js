// Offline render in a module Worker: the same Engine that runs in the AudioWorklet renders the project
// as fast as the CPU allows without blocking the page. Cancelling terminates the worker.
import { renderOffline, renderStems } from '../core/offline.js';

self.onmessage = (e) => {
  const { project, samples, opts, stems } = e.data;
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
