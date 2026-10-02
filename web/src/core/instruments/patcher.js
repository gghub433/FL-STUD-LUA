// Patcher as an instrument: notes of the channel enter the patch at "Note In", the sound leaves at "Audio Out".
// The 16 macro knobs are ordinary parameters (automation, MIDI learn); the patch itself lives in channel.patch.
import { def, defaults } from '../schema.js';
import { PatchGraph } from '../patcher/runtime.js';
import { PATCHER_MACROS as MACROS } from '../constants.js';

export const schema = Array.from({ length: MACROS }, (_, i) => def(`m${i + 1}`, `Macro ${i + 1}`, 0, 1, 0.5, { group: 'Macros' }));
export const meta = { id: 'patcher', name: 'Patcher', kind: 'patcher', rootDefault: 60, description: 'Modular environment: wire generators, effects, modulators and note tools together' };

class PatcherInstrument {
  constructor(sr, host) { this.g = new PatchGraph(sr, host, 'instrument'); this.p = defaults(schema); }
  get active() { return this.g.active; }
  setParam(id, v) {
    this.p[id] = v;
    if (id.charCodeAt(0) === 109) { const n = +id.slice(1); if (n >= 1 && n <= MACROS) this.g.macros[n - 1] = v; }
  }
  setData(ch) { if (ch.patch) this.g.setPatch(ch.patch); }
  noteOn(ev) { this.g.noteOn(ev); }
  noteOff(key) { this.g.noteOff(key); }
  allOff() { this.g.allOff(); }
  chokeAll() { this.g.chokeAll(); }
  process(L, R, i0, i1) { this.g.renderAdd(L, R, i0, i1); }
}
export function create(sr, host) { return new PatcherInstrument(sr, host); }
