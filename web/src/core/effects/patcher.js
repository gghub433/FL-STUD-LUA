// Patcher as an effect: the mixer slot's audio enters at "Audio In" (the sidechain at its second output),
// whatever is wired to "Audio Out" replaces it. The patch lives in slot.extra.patch.
import { def, defaults } from '../schema.js';
import { PatchGraph } from '../patcher/runtime.js';
import { PATCHER_MACROS as MACROS } from '../constants.js';

export const schema = Array.from({ length: MACROS }, (_, i) => def(`m${i + 1}`, `Macro ${i + 1}`, 0, 1, 0.5, { group: 'Macros' }));
export const meta = { id: 'patcher', name: 'Patcher', category: 'Modular', description: 'Modular environment: build your own effect from plugins, modulators and utilities' };

class PatcherFx {
  constructor(sr, host) { this.g = new PatchGraph(sr, host, 'effect'); this.p = defaults(schema); }
  get latency() { return this.g.latency; }
  setParam(id, v) {
    this.p[id] = v;
    if (id.charCodeAt(0) === 109) { const n = +id.slice(1); if (n >= 1 && n <= MACROS) this.g.macros[n - 1] = v; }
  }
  setExtra(extra) { if (extra && extra.patch) this.g.setPatch(extra.patch); }
  reset() { this.g.reset(); }
  process(L, R, n, ctx) { this.g.renderReplace(L, R, n, ctx); }
}
export function create(sr, host) { return new PatcherFx(sr, host); }
