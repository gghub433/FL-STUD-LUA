// Noise gate / expander with hold, hysteresis and optional sidechain key input.
import { def, choice, defaults } from '../schema.js';
import { dbToGain } from '../dsp.js';

export const schema = [
  def('threshold', 'Threshold', -80, 0, -45, { unit: 'dB' }),
  def('range', 'Range', -80, 0, -80, { unit: 'dB' }),
  def('attack', 'Attack', 0.05, 100, 1, { unit: 'ms', curve: 'log' }),
  def('hold', 'Hold', 0, 500, 40, { unit: 'ms' }),
  def('release', 'Release', 5, 2000, 150, { unit: 'ms', curve: 'log' }),
  def('hysteresis', 'Hysteresis', 0, 12, 3, { unit: 'dB' }),
  choice('sidechain', 'Key input', ['Off', 'Sidechain bus'], 0),
];

export const meta = { id: 'gate', name: 'Gate', category: 'Dynamics', description: 'Noise gate with hold and sidechain key' };

class Gate {
  constructor(sr) { this.sr = sr; this.p = defaults(schema); this.g = 0; this.open = false; this.holdLeft = 0; this.meters = [0]; }
  setParam(id, v) { this.p[id] = v; }
  reset() { this.g = 0; this.open = false; this.holdLeft = 0; }
  process(L, R, n, ctx) {
    const p = this.p, sr = this.sr;
    const th = dbToGain(p.threshold), thClose = dbToGain(p.threshold - p.hysteresis);
    const floor = dbToGain(p.range);
    const aCo = Math.exp(-1 / (p.attack * 0.001 * sr)), rCo = Math.exp(-1 / (p.release * 0.001 * sr));
    const useKey = p.sidechain === 1 && ctx && ctx.scL;
    const kL = useKey ? ctx.scL : L, kR = useKey ? ctx.scR : R;
    let g = this.g, open = this.open, hold = this.holdLeft, env = 0;
    const eCo = Math.exp(-1 / (0.002 * sr));
    for (let i = 0; i < n; i++) {
      const x = Math.max(Math.abs(kL[i]), Math.abs(kR[i]));
      env = x > env ? x : eCo * env + (1 - eCo) * x;
      if (!open && env > th) { open = true; hold = Math.round(p.hold * 0.001 * sr); }
      else if (open && env < thClose) { if (hold > 0) hold--; else open = false; }
      else if (open) hold = Math.round(p.hold * 0.001 * sr);
      const target = open ? 1 : floor;
      g = target > g ? aCo * g + (1 - aCo) * target : rCo * g + (1 - rCo) * target;
      L[i] *= g; R[i] *= g;
    }
    this.g = g; this.open = open; this.holdLeft = hold;
    this.meters[0] = 20 * Math.log10(g + 1e-9);
  }
}

export function create(sr) { return new Gate(sr); }
