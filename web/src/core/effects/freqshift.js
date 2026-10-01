// Frequency shifter / ring modulator. The shifter builds an analytic signal with a 90-degree
// all-pass pair (12-pole polyphase IIR Hilbert transformer) and rotates it by the shift frequency,
// moving every partial by the same number of Hz (unlike a pitch shifter, harmonic relations break).
import { def, bool, choice, defaults } from '../schema.js';
import { TAU } from '../dsp.js';

export const schema = [
  choice('mode', 'Mode', ['Frequency shift', 'Ring modulator'], 0),
  def('shift', 'Shift', -2000, 2000, 100, { unit: 'Hz', curve: 'pow', skew: 1 }),
  def('feedback', 'Feedback', 0, 0.8, 0),
  bool('stereo', 'Opposite on right', 0),
  def('mix', 'Mix', 0, 1, 1),
];
export const meta = { id: 'freqshift', name: 'Frequency Shifter', category: 'Pitch', description: 'Shift all partials by a fixed number of Hz, or ring-modulate' };

const A = [0.6923878, 0.9360654322959, 0.9882295226860, 0.9987488452737];
const B = [0.4021921162426, 0.8561710882420, 0.9722909545651, 0.9952884791278];

class Chain {
  constructor(co) { this.a = co.map((c) => c * c); this.x1 = new Float64Array(4); this.x2 = new Float64Array(4); this.y1 = new Float64Array(4); this.y2 = new Float64Array(4); }
  reset() { this.x1.fill(0); this.x2.fill(0); this.y1.fill(0); this.y2.fill(0); }
  process(x) {
    let v = x;
    for (let k = 0; k < 4; k++) {
      const y = this.a[k] * (v + this.y2[k]) - this.x2[k];
      this.x2[k] = this.x1[k]; this.x1[k] = v; this.y2[k] = this.y1[k]; this.y1[k] = y;
      v = y;
    }
    return v;
  }
}

class Hilbert {            // returns the in-phase signal (q) and its Hilbert transform (i)
  constructor() { this.a = new Chain(A); this.b = new Chain(B); this.prev = 0; this.q = 0; this.i = 0; }
  reset() { this.a.reset(); this.b.reset(); this.prev = 0; }
  process(x) { const a = this.a.process(x); this.i = this.prev; this.prev = a; this.q = this.b.process(x); }
}

class FreqShift {
  constructor(sr) { this.sr = sr; this.p = defaults(schema); this.hl = new Hilbert(); this.hr = new Hilbert(); this.ph = 0; this.fbL = 0; this.fbR = 0; }
  setParam(id, v) { this.p[id] = v; }
  reset() { this.hl.reset(); this.hr.reset(); this.fbL = this.fbR = 0; }
  process(L, R, n) {
    const p = this.p, inc = p.shift / this.sr, ring = p.mode === 1;
    for (let i = 0; i < n; i++) {
      this.ph += inc; this.ph -= Math.floor(this.ph);
      const c = Math.cos(TAU * this.ph), s = Math.sin(TAU * this.ph);
      const inL = L[i] + this.fbL * p.feedback, inR = R[i] + this.fbR * p.feedback;
      let wl, wr;
      if (ring) { wl = inL * s; wr = inR * (p.stereo ? -s : s); }
      else {
        this.hl.process(inL); this.hr.process(inR);
        wl = this.hl.q * c - this.hl.i * s;
        wr = p.stereo ? this.hr.q * c + this.hr.i * s : this.hr.q * c - this.hr.i * s;
      }
      this.fbL = wl; this.fbR = wr;
      L[i] += (wl - L[i]) * p.mix; R[i] += (wr - R[i]) * p.mix;
    }
  }
}
export function create(sr) { return new FreqShift(sr); }
