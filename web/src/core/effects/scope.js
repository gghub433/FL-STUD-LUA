// Scope: an analyser that lets the audio through untouched. While its effect window is open the mixer
// marks the slot as watched (ctx.watch) and the effect keeps a short history of the signal, peak / RMS
// levels and the stereo correlation; view() hands the UI a decimated snapshot (oscilloscope columns,
// vectorscope points, meters) at most ~30 times a second. The spectrum comes from the mixer's analyser
// tap on the same slot. Unwatched, process() returns at once, so a Scope left in a chain costs nothing.
import { def, bool, choice, defaults } from '../schema.js';

export const VIEWS = ['All', 'Oscilloscope', 'Spectrum', 'Vectorscope'];
export const schema = [
  choice('view', 'View', VIEWS, 0),
  def('time', 'Time window', 2, 200, 20, { unit: 'ms', curve: 'log' }),
  bool('trigger', 'Trigger', 1),
  def('zoom', 'Display gain', 0, 24, 0, { unit: 'dB' }),
  def('floor', 'Spectrum floor', -120, -36, -90, { unit: 'dB' }),
  def('tilt', 'Spectrum tilt', 0, 6, 0, { unit: 'dB/oct' }),
  bool('hold', 'Peak hold', 1),
];
export const meta = { id: 'scope', name: 'Scope', category: 'Analysis', mixerOnly: true, description: 'Oscilloscope, spectrum, peak / RMS meters and vectorscope; the sound passes unchanged' };

export const COLUMNS = 256;          // oscilloscope columns per view (min / max of L and R each)
export const VECTOR_POINTS = 512;    // vectorscope points per view
const MAX_TIME = 0.2;                // longest oscilloscope window (s), matches the 'time' parameter

class Scope {
  constructor(sr) {
    this.sr = sr; this.p = defaults(schema);
    let n = 1024;
    while (n < 2 * MAX_TIME * sr + 4096) n <<= 1;       // a full window plus one window to look back for the trigger
    this.ringL = new Float32Array(n); this.ringR = new Float32Array(n);
    this.mask = n - 1;
    this.w = 0;                 // samples written (absolute count; the ring index is w & mask)
    this.since = 0;             // samples since the last view
    this.coef = 1 - Math.exp(-1 / (0.3 * sr));                        // 300 ms integration for RMS and correlation
    this.reset();
  }
  setParam(id, v) { this.p[id] = v; }
  reset() { this.pkL = 0; this.pkR = 0; this.msL = 0; this.msR = 0; this.mLR = 0; }

  process(L, R, n, ctx) {
    if (!ctx || !ctx.watch) return;              // nobody is looking: pure pass-through
    const rl = this.ringL, rr = this.ringR, mask = this.mask, k = this.coef;
    let w = this.w, pkL = this.pkL, pkR = this.pkR, msL = this.msL, msR = this.msR, mLR = this.mLR;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      rl[w & mask] = l; rr[w & mask] = r; w++;
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > pkL) pkL = al;
      if (ar > pkR) pkR = ar;
      msL += (l * l - msL) * k; msR += (r * r - msR) * k; mLR += (l * r - mLR) * k;
    }
    this.w = w; this.pkL = pkL; this.pkR = pkR; this.msL = msL; this.msR = msR; this.mLR = mLR;
    this.since += n;
  }

  // Snapshot for the window, or null when too little has been collected since the last one.
  // { wave: Float32Array(4·COLUMNS) [minL, maxL, minR, maxR]…, vec: Float32Array(2·VECTOR_POINTS) [L, R]…,
  //   peak: [L, R] since the last view, rms: [L, R], corr: -1..1 (null on silence) }
  view() {
    if (this.since < this.sr / 32 || this.w < 2) return null;
    this.since = 0;
    const rl = this.ringL, rr = this.ringR, mask = this.mask, end = this.w;
    const span = Math.max(8, Math.min(Math.round(this.p.time * 0.001 * this.sr), Math.floor((mask + 1 - 4096) / 2)));
    // oscilloscope: the window ends at the newest sample, or starts at the last rising zero crossing that leaves a full window
    let start = end - span;
    if (this.p.trigger) {
      const lo = Math.max(1, end - 2 * span);
      for (let i = end - span; i > lo; i--) {
        const a = rl[(i - 1) & mask] + rr[(i - 1) & mask], b = rl[i & mask] + rr[i & mask];
        if (a < 0 && b >= 0) { start = i; break; }
      }
    }
    if (start < 0) start = 0;
    const wave = new Float32Array(COLUMNS * 4);
    for (let c = 0; c < COLUMNS; c++) {
      const a = start + Math.floor((c * span) / COLUMNS), b = Math.max(a + 1, start + Math.floor(((c + 1) * span) / COLUMNS));
      let nl = Infinity, xl = -Infinity, nr = Infinity, xr = -Infinity;
      for (let i = a; i < b; i++) {
        const l = rl[i & mask], r = rr[i & mask];
        if (l < nl) nl = l; if (l > xl) xl = l;
        if (r < nr) nr = r; if (r > xr) xr = r;
      }
      wave[c * 4] = nl; wave[c * 4 + 1] = xl; wave[c * 4 + 2] = nr; wave[c * 4 + 3] = xr;
    }
    // vectorscope: the newest samples, every other one (about 23 ms at 44.1 kHz)
    const vec = new Float32Array(VECTOR_POINTS * 2);
    const v0 = end - VECTOR_POINTS * 2;
    for (let j = 0; j < VECTOR_POINTS; j++) { const i = v0 + j * 2; vec[j * 2] = i >= 0 ? rl[i & mask] : 0; vec[j * 2 + 1] = i >= 0 ? rr[i & mask] : 0; }
    const e = Math.sqrt(this.msL * this.msR);
    const out = { wave, vec, peak: [this.pkL, this.pkR], rms: [Math.sqrt(this.msL), Math.sqrt(this.msR)], corr: e > 1e-9 ? Math.max(-1, Math.min(1, this.mLR / e)) : null };
    this.pkL = 0; this.pkR = 0;
    return out;
  }
}

export function create(sr) { return new Scope(sr); }
