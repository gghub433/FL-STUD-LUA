// Starts the render worker. Returns { promise, cancel }. promise resolves to { result } or { stems }, or
// null when cancelled; it rejects with the worker's error.
// projects with WAM plugins render through Web Audio instead (the plugins exist only there); app/wam.js sets this up
let webAudioRenderer = null;
export function useWebAudioRenderer(fn) { webAudioRenderer = fn; }
const usesWam = (p) => p.channels.some((c) => c.type === 'wam' && c.wam && c.wam.url) || p.mixer.tracks.some((t) => t.fx.some((s) => s && s.type === 'wam' && s.extra && s.extra.wam && s.extra.wam.url));

export function renderInWorker(job, { onProgress } = {}) {
  if (webAudioRenderer && usesWam(job.project)) return webAudioRenderer(job, { onProgress });
  const worker = new Worker(new URL('../../worker/render-worker.js', import.meta.url), { type: 'module' });
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'progress') { if (onProgress) onProgress(m.f, m.text); }
      else if (m.t === 'done') { worker.terminate(); resolve(m.stems ? { stems: m.stems } : { result: m.result }); }
      else if (m.t === 'error') { worker.terminate(); reject(new Error(m.message)); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'The render worker failed')); };
  });
  worker.postMessage(job);
  return { promise, cancel: () => { worker.terminate(); settle.resolve(null); } };
}
