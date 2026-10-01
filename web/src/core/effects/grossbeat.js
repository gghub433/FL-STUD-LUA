// Time / volume manipulator in the style of a "gross beat" effect.
//
// 36 slots, each holding two drawable curves over one cycle (cycle length = tempo-synced division):
//   time curve   y(phase): which part of the cycle's audio is played at this phase
//                (y = phase is normal playback, flat = freeze/stutter, slope < 1 = slow-down, descending = reverse)
//   volume curve v(phase): gain
// `lookback` slots read from the previous cycle (needed for reverse, which requires the future otherwise).
// Switching the `slot` parameter (automatable, instant) crossfades over a few milliseconds.
import { def, choice, defaults } from '../schema.js';
import { DelayLine, SYNC_DIVS, SYNC_LABELS } from '../dsp.js';
import { PPQ } from '../constants.js';

export const SLOTS = 36;

export const schema = [
  def('slot', 'Pattern slot', 0, SLOTS - 1, 0, { int: true }),
  choice('division', 'Cycle length', SYNC_LABELS, 8),
  def('smooth', 'Slot crossfade', 1, 40, 6, { unit: 'ms', curve: 'log' }),
  def('depth', 'Volume curve depth', 0, 1, 1),
];

export const meta = { id: 'grossbeat', name: 'Time & Volume Manipulator', category: 'Creative', description: '36 patterns of drawable time and volume curves' };

// ----- default slot library (generated) ------------------------------------------------------
const line = (f, n = 64) => Array.from({ length: n + 1 }, (_, i) => [i / n, f(i / n)]);
const steps = (vals) => { const pts = []; vals.forEach((v, i) => { pts.push([i / vals.length, v], [(i + 1) / vals.length - 1e-4, v]); }); return pts; };
const stut = (N) => line((x) => (x * N % 1) / N, 128);
const gate = (N, duty = 0.5) => Array.from({ length: N }, (_, i) => [
  [i / N, 1], [(i + duty) / N - 1e-4, 1], [(i + duty) / N, 0], [(i + 1) / N - 1e-4, 0],
]).flat();

export function defaultSlots() {
  const id = (x) => x;
  const one = [[0, 1], [1, 1]];
  const S = [];
  const add = (name, time, vol = one, lookback = 0) => S.push({ name, time, vol, lookback });
  add('Normal', line(id, 8));
  add('Half speed', line((x) => x * 0.5, 16));
  add('Quarter speed', line((x) => x * 0.25, 16));
  add('Reverse (previous cycle)', line((x) => 1 - x, 64), one, 1);
  for (const N of [2, 3, 4, 6, 8, 12, 16]) add(`Stutter x${N}`, stut(N));
  add('Tape stop', line((x) => x * (1 - 0.92 * x), 64));
  add('Tape start', line((x) => x * x, 64));
  add('Scratch', line((x) => Math.abs(Math.sin(x * Math.PI * 3)) * 0.9, 96), one, 1);
  add('Forward-back', line((x) => (x < 0.5 ? x * 2 : (1 - x) * 2) * 0.8, 64), one, 1);
  for (const N of [2, 4, 8, 16]) add(`Gate x${N}`, line(id, 8), gate(N, 0.5));
  add('Gate triplets', line(id, 8), gate(6, 0.5));
  add('Gate shuffle', line(id, 8), steps([1, 0, 1, 1, 0, 1, 0, 1]));
  add('Fade in', line(id, 8), [[0, 0], [1, 1]]);
  add('Fade out', line(id, 8), [[0, 1], [1, 0]]);
  add('Pump', line(id, 8), line((x) => 0.15 + 0.85 * Math.pow((x * 4) % 1, 0.6), 128));
  add('Half speed + gate', line((x) => x * 0.5, 16), gate(8, 0.6));
  add('Stutter x4 + gate', stut(4), gate(8, 0.7));
  add('Reverse + fade', line((x) => 1 - x, 64), [[0, 0], [0.3, 1], [1, 1]], 1);
  add('Slow down 3/4', line((x) => x * 0.75, 16));
  add('Stutter x6 reverse', line((x) => 1 - ((x * 6) % 1) / 6, 128), one, 1);
  add('Silence', line(id, 8), [[0, 0], [1, 0]]);
  add('Roll accel', line((x) => { const N = 2 + Math.floor(x * 14); return ((x * N) % 1) / N; }, 256));
  add('Wobble', line((x) => x * (0.7 + 0.3 * Math.sin(x * 40)), 128));
  while (S.length < SLOTS) add(`Slot ${S.length + 1}`, line(id, 8));
  return S.slice(0, SLOTS);
}

const evalCurve = (pts, x) => {
  const n = pts.length;
  if (!n) return 1;
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[n - 1][0]) return pts[n - 1][1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= x) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi];
  const t = b[0] > a[0] ? (x - a[0]) / (b[0] - a[0]) : 1;
  return a[1] + (b[1] - a[1]) * t;
};
export { evalCurve };

class GrossBeat {
  constructor(sr, host) {
    this.sr = sr; this.host = host; this.p = defaults(schema);
    this.slots = defaultSlots();
    this.dl = new DelayLine(Math.ceil(9 * sr)); this.dr = new DelayLine(Math.ceil(9 * sr));
    this.free = 0;                 // free-running tick position while the transport is stopped
    this.cur = 0; this.prev = -1; this.fade = 1;
    this.wpos = 0;
    this.meters = [0, 0];
  }
  setExtra(extra) { if (extra && Array.isArray(extra.slots) && extra.slots.length) { this.slots = extra.slots.slice(0, SLOTS); } }
  setParam(id, v) { this.p[id] = v; }
  reset() { this.dl.clear(); this.dr.clear(); this.fade = 1; this.prev = -1; }

  sample(slot, phase, cycLen, xL, xR, out) {
    const s = this.slots[Math.min(slot, this.slots.length - 1)];
    const maxY = s.lookback ? 1 : phase;
    let y = evalCurve(s.time, phase);
    if (y > maxY) y = maxY;
    if (y < 0) y = 0;
    // delay from "now" back to the source position (in samples), plus one cycle for lookback slots
    const D = (phase - y) * cycLen + (s.lookback ? cycLen : 0);
    const dd = Math.min(D, 8.9 * this.sr);
    const a = this.dl.read(dd + 1), b = this.dr.read(dd + 1);
    const v = 1 - (1 - evalCurve(s.vol, phase)) * this.p.depth;
    out[0] = a * v; out[1] = b * v;
  }

  process(L, R, n) {
    const p = this.p, sr = this.sr;
    const beats = SYNC_DIVS[p.division][1];
    const tempo = this.host.tempo || 120;
    const cycTicks = beats * PPQ;
    const cycLen = (60 / tempo) * beats * sr;           // cycle length in samples
    const tps = (tempo * PPQ) / (60 * sr);
    const playing = this.host.playing;
    let tick = playing ? this.host.tick : this.free;
    const fadeStep = 1 / Math.max(1, p.smooth * 0.001 * sr);
    const o1 = [0, 0], o2 = [0, 0];
    const slot = Math.round(p.slot);
    if (slot !== this.cur) { this.prev = this.cur; this.cur = slot; this.fade = 0; }
    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i];
      this.dl.write(xl); this.dr.write(xr);
      const phase = ((tick % cycTicks) + cycTicks) % cycTicks / cycTicks;
      this.sample(this.cur, phase, cycLen, xl, xr, o1);
      if (this.fade < 1) {
        this.sample(this.prev, phase, cycLen, xl, xr, o2);
        const f = this.fade;
        L[i] = o2[0] * (1 - f) + o1[0] * f; R[i] = o2[1] * (1 - f) + o1[1] * f;
        this.fade = Math.min(1, this.fade + fadeStep);
      } else { L[i] = o1[0]; R[i] = o1[1]; }
      tick += tps;
    }
    if (!playing) this.free = tick % (cycTicks * 64);
    this.meters[0] = ((tick % cycTicks) + cycTicks) % cycTicks / cycTicks;
  }
}

export function create(sr, host) { return new GrossBeat(sr, host); }
