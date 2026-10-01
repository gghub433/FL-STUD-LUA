// Spectrum analyser used for the EQ display and the mixer's per-track analyser.
// Collects the mono mix of whatever is tapped, and every `hop` samples produces 1024 magnitude bins in dB.
import { FFT, hann } from './fft.js';

const N = 2048;
const fft = new FFT(N);
const win = hann(N);

export class Analyzer {
  constructor(hop = 1536) {
    this.ring = new Float32Array(N);
    this.w = 0;
    this.since = 0;
    this.hop = hop;
    this.re = new Float32Array(N);
    this.im = new Float32Array(N);
    this.smooth = new Float32Array(N / 2).fill(-120);
  }

  reset() { this.ring.fill(0); this.smooth.fill(-120); this.since = 0; }

  push(L, R, n) {
    const r = this.ring;
    for (let i = 0; i < n; i++) { r[this.w] = (L[i] + R[i]) * 0.5; this.w = (this.w + 1) & (N - 1); }
    this.since += n;
  }

  get ready() { return this.since >= this.hop; }

  // Returns a fresh Float32Array(1024) of dB values (smoothed: fast attack, slower release).
  compute() {
    this.since = 0;
    const { re, im, ring } = this;
    for (let i = 0; i < N; i++) { re[i] = ring[(this.w + i) & (N - 1)] * win[i]; im[i] = 0; }
    fft.transform(re, im);
    const out = new Float32Array(N / 2);
    const norm = 4 / N;
    for (let k = 0; k < N / 2; k++) {
      const db = 20 * Math.log10(Math.hypot(re[k], im[k]) * norm + 1e-9);
      const prev = this.smooth[k];
      const v = db > prev ? db : prev + (db - prev) * 0.35;
      this.smooth[k] = v;
      out[k] = v;
    }
    return out;
  }
}
