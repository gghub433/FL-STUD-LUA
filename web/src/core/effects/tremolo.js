// Tremolo / Auto-pan: an LFO modulates the level (tremolo) or the stereo position (auto-pan),
// free-running or locked to the song position in tempo-sync mode.
import { def, bool, choice, defaults } from '../schema.js';
import { SYNC_DIVS, SYNC_LABELS, clamp } from '../dsp.js';
import { PPQ } from '../constants.js';

export const schema = [
  choice('mode', 'Mode', ['Tremolo', 'Auto-pan'], 0),
  bool('sync', 'Tempo sync', 0),
  def('rate', 'Rate', 0.05, 25, 4, { unit: 'Hz', curve: 'log' }),
  choice('division', 'Division', SYNC_LABELS, 5),
  choice('shape', 'Shape', ['Sine', 'Triangle', 'Square', 'Saw up', 'Saw down'], 0),
  def('depth', 'Depth', 0, 1, 0.6),
  def('phase', 'Stereo phase', 0, 0.5, 0),
  def('smooth', 'Edge smoothing', 0, 1, 0.3),
  def('mix', 'Mix', 0, 1, 1),
];
export const meta = { id: 'tremolo', name: 'Tremolo / Auto-pan', category: 'Modulation', description: 'Level or pan modulation, free or tempo-synced' };

const wave = (shape, p) => {   // unipolar 0..1
  switch (shape) {
    case 1: return p < 0.5 ? 2 * p : 2 - 2 * p;
    case 2: return p < 0.5 ? 1 : 0;
    case 3: return p;
    case 4: return 1 - p;
    default: return 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
  }
};

class Tremolo {
  constructor(sr, host) { this.sr = sr; this.host = host; this.p = defaults(schema); this.ph = 0; this.sL = 1; this.sR = 1; }
  setParam(id, v) { this.p[id] = v; }
  reset() { this.ph = 0; this.sL = this.sR = 1; }
  process(L, R, n) {
    const p = this.p, sr = this.sr, h = this.host;
    let inc;
    if (p.sync) {
      const beats = SYNC_DIVS[p.division][1];
      inc = ((h.tempo || 120) / 60) / (beats * sr);
      if (h.playing) this.ph = (((h.tick || 0) / (beats * PPQ)) % 1 + 1) % 1;      // lock to the song position at the block start
    } else inc = p.rate / sr;
    const a = p.shape === 1 || p.shape === 0 ? 1 : 1 - Math.exp(-1 / (Math.max(0.0002, p.smooth * 0.012) * sr));
    const auto = p.mode === 1;
    for (let i = 0; i < n; i++) {
      const pl = this.ph, pr = (this.ph + p.phase) % 1;
      this.ph += inc; if (this.ph >= 1) this.ph -= 1;
      const wl = wave(p.shape, pl), wr = wave(p.shape, pr);
      this.sL += (wl - this.sL) * a; this.sR += (wr - this.sR) * a;
      const l = L[i], r = R[i];
      let ol, or;
      if (auto) {
        const pan = clamp(p.depth * (this.sL * 2 - 1), -1, 1), ang = (pan + 1) * 0.7853981634;
        ol = l * Math.cos(ang) * Math.SQRT2; or = r * Math.sin(ang) * Math.SQRT2;
      } else {
        ol = l * (1 - p.depth * (1 - this.sL)); or = r * (1 - p.depth * (1 - this.sR));
      }
      L[i] = l + (ol - l) * p.mix; R[i] = r + (or - r) * p.mix;
    }
  }
}
export function create(sr, host) { return new Tremolo(sr, host); }
