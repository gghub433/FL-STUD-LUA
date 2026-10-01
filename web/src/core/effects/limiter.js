// Look-ahead brick-wall limiter.
//
// Audio is delayed by W samples. With t[k] the per-sample ceiling gain (ceiling/|x|, capped at 1):
//   m[j]  = min(t[j .. j+W])                 (sliding minimum, monotonic deque)
//   g[s]  = (1/W) * sum_{j=s-W+1..s} m[j]    (box average = smooth ramps)
// Every sample s lies inside the window of each m[j] it is averaged with, so g[s] <= t[s]:
// the output can never exceed the ceiling. A release stage only slows the recovery.
import { def, defaults } from '../schema.js';
import { dbToGain } from '../dsp.js';

export const schema = [
  def('input', 'Input gain', 0, 30, 0, { unit: 'dB' }),
  def('ceiling', 'Ceiling', -12, 0, -0.3, { unit: 'dB' }),
  def('release', 'Release', 1, 1000, 80, { unit: 'ms', curve: 'log' }),
  def('lookahead', 'Look-ahead', 0.5, 10, 3, { unit: 'ms' }),
];

export const meta = { id: 'limiter', name: 'Limiter', category: 'Dynamics', description: 'Look-ahead brick-wall limiter' };

class Limiter {
  constructor(sr) {
    this.sr = sr;
    this.p = defaults(schema);
    this.W = 0;
    this.latency = 0;
    this.meters = [0, 0];
    this.alloc(Math.max(2, Math.round(this.p.lookahead * 0.001 * sr)));
  }

  alloc(W) {
    this.W = W; this.latency = W;
    this.cap = 2 * W + 4;
    this.xL = new Float32Array(this.cap); this.xR = new Float32Array(this.cap);
    this.t = new Float32Array(this.cap);
    this.m = new Float32Array(this.cap).fill(1);
    this.dq = new Float64Array(this.cap);
    this.qh = 0; this.qt = 0;
    this.count = 0; this.sum = W; this.rel = 1;
  }

  setParam(id, v) {
    this.p[id] = v;
    if (id === 'lookahead') {
      const W = Math.max(2, Math.round(v * 0.001 * this.sr));
      if (W !== this.W) this.alloc(W);
    }
  }

  reset() { this.alloc(this.W); }

  process(L, R, n) {
    const W = this.W, cap = this.cap, p = this.p;
    const inG = dbToGain(p.input), ceil = dbToGain(p.ceiling);
    const rCo = Math.exp(-1 / (p.release * 0.001 * this.sr));
    const { xL, xR, t, m, dq } = this;
    let count = this.count, sum = this.sum, rel = this.rel, qh = this.qh, qt = this.qt;
    let minG = 1;
    for (let i = 0; i < n; i++) {
      const xl = L[i] * inG, xr = R[i] * inG;
      const a = Math.max(Math.abs(xl), Math.abs(xr));
      const tg = a > ceil ? ceil / a : 1;
      const pos = count % cap;
      xL[pos] = xl; xR[pos] = xr; t[pos] = tg;

      // sliding minimum of t over the last W+1 samples
      while (qt > qh && t[dq[(qt - 1) % cap] % cap] >= tg) qt--;
      dq[qt % cap] = count; qt++;
      while (dq[qh % cap] < count - W) qh++;
      const mj = t[dq[qh % cap] % cap];

      // m[s] for s = count - W, then slide the box sum
      const s = count - W;
      const sIdx = ((s % cap) + cap) % cap;
      const oldIdx = (((s - W) % cap) + cap) % cap;
      const old = m[oldIdx];
      m[sIdx] = mj;
      sum += mj - old;
      let g = sum / W;
      if (g > 1) g = 1;
      if (g < rel) rel = g; else rel = rCo * rel + (1 - rCo) * g;
      const gOut = g < rel ? g : rel;

      // delayed audio (silence until the buffer has filled)
      if (s >= 0) { L[i] = xL[sIdx] * gOut; R[i] = xR[sIdx] * gOut; } else { L[i] = 0; R[i] = 0; }
      if (gOut < minG) minG = gOut;
      count++;
    }
    this.count = count; this.sum = sum; this.rel = rel; this.qh = qh; this.qt = qt;
    this.meters[0] = 20 * Math.log10(minG + 1e-9);
  }
}

export function create(sr) { return new Limiter(sr); }
