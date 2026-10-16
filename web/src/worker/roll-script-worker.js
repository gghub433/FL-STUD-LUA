// Runs one user piano roll script away from the page: the page sends the source once ('load') and then the notes and
// parameter values of every run ('run'). The script sees only that plain data and the helpers of core/roll-scripts.js,
// never the page or the project. The page terminates the worker when a run takes too long and checks every note
// that comes back before it writes anything (app/roll-scripts.js).
import { loadScript, execute, scriptInfo } from '../core/roll-scripts.js';

let def = null, url = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.t === 'load') {
    try {
      ({ def, url } = await loadScript(m.source, { toUrl: (s) => URL.createObjectURL(new Blob([s], { type: 'text/javascript' })) }));
      self.postMessage({ t: 'loaded', id: m.id, info: scriptInfo(def) });
    } catch (err) {
      self.postMessage({ t: 'failed', id: m.id, error: String(err && err.message || err) });
    }
  } else if (m.t === 'run') {
    const r = def ? execute(def, m.input, m.values, { url }) : { ok: false, error: 'The script is not loaded' };
    try { self.postMessage({ t: 'result', id: m.id, ...r }); } catch (err) { self.postMessage({ t: 'result', id: m.id, ok: false, error: `Script error: ${err.message}` }); }
  }
};
