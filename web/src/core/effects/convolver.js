// Convolution reverb. Non-uniform partitioned FFT convolution, zero added latency:
//   head: first 1024 IR samples, 8 partitions of 128 (FFT 256), processed every block
//   tail: the rest in partitions of 1024 (FFT 2048), computed once per 1024 input samples and
//         played one chunk later - exactly where the tail begins in the impulse response.
// The impulse response is a sample from the sample bank (slot.extra.irId).
import { def, bool, defaults } from '../schema.js';
import { FFT } from '../fft.js';
import { Biquad, dbToGain, DelayLine } from '../dsp.js';
import { BLOCK } from '../constants.js';

export const schema = [
  def('predelay', 'Pre-delay', 0, 500, 0, { unit: 'ms' }),
  def('trim', 'IR length', 0.1, 8, 4, { unit: 's', curve: 'log' }),
  def('gain', 'IR gain', -24, 12, 0, { unit: 'dB' }),
  bool('reverse', 'Reverse IR', 0),
  def('lowcut', 'Low cut', 20, 1000, 60, { unit: 'Hz', curve: 'log' }),
  def('highcut', 'High cut', 1000, 20000, 14000, { unit: 'Hz', curve: 'log' }),
  def('dry', 'Dry', -60, 6, 0, { unit: 'dB' }),
  def('wet', 'Wet', -60, 6, -6, { unit: 'dB' }),
];

export const meta = { id: 'convolver', name: 'Convolution Reverb', category: 'Space', description: 'Reverb from an impulse response (load any audio file)' };

const HB = BLOCK, HN = 256, HP = 8, HEAD = HB * HP;   // head
const TB = 1024, TN = 2048;                            // tail
const headFFT = new FFT(HN), tailFFT = new FFT(TN);

class Chan {
  constructor() {
    this.xPrev = new Float32Array(HB);
    this.hRe = []; this.hIm = [];           // head IR partitions
    this.fRe = []; this.fIm = [];           // head frequency delay line
    this.fPos = 0;
    this.tRe = []; this.tIm = [];           // tail IR partitions
    this.tfRe = []; this.tfIm = [];         // tail FDL
    this.tPos = 0;
    this.tIn = new Float32Array(TB * 2);    // [previous chunk | current chunk]
    this.tFill = 0;
    this.tPlay = new Float32Array(TB);
    this.tIdx = 0;
    this.re = new Float32Array(TN); this.im = new Float32Array(TN);
    this.aRe = new Float32Array(TN); this.aIm = new Float32Array(TN);
  }

  load(ir) {
    const len = ir.length;
    this.hRe = []; this.hIm = []; this.fRe = []; this.fIm = []; this.fPos = 0;
    for (let k = 0; k < HP; k++) {
      const re = new Float32Array(HN), im = new Float32Array(HN);
      for (let i = 0; i < HB; i++) { const j = k * HB + i; re[i] = j < len ? ir[j] : 0; }
      headFFT.transform(re, im);
      this.hRe.push(re); this.hIm.push(im);
      this.fRe.push(new Float32Array(HN)); this.fIm.push(new Float32Array(HN));
    }
    this.tRe = []; this.tIm = []; this.tfRe = []; this.tfIm = []; this.tPos = 0;
    const tailLen = Math.max(0, len - HEAD + (HEAD - TB));  // tail starts at sample TB (aligned with the 1 chunk delay)
    const parts = len > TB ? Math.ceil((len - TB) / TB) : 0;
    void tailLen;
    for (let k = 0; k < parts; k++) {
      const re = new Float32Array(TN), im = new Float32Array(TN);
      for (let i = 0; i < TB; i++) { const j = TB + k * TB + i; re[i] = j < len ? ir[j] : 0; }
      tailFFT.transform(re, im);
      this.tRe.push(re); this.tIm.push(im);
      this.tfRe.push(new Float32Array(TN)); this.tfIm.push(new Float32Array(TN));
    }
    this.tIn.fill(0); this.tFill = 0; this.tPlay.fill(0); this.tIdx = 0; this.xPrev.fill(0);
  }

  clear() {
    this.xPrev.fill(0); this.tIn.fill(0); this.tFill = 0; this.tPlay.fill(0); this.tIdx = 0;
    for (const a of [...this.fRe, ...this.fIm, ...this.tfRe, ...this.tfIm]) a.fill(0);
  }

  // x: Float32Array(128) in, out: Float32Array(128)
  block(x, out) {
    // ---- head: uniform partitioned overlap-save ----
    const re = this.re, im = this.im;
    re.set(this.xPrev, 0); re.set(x, HB); im.fill(0, 0, HN);
    this.xPrev.set(x);
    headFFT.transform(re.subarray(0, HN), im.subarray(0, HN));
    const slot = this.fPos;
    this.fRe[slot].set(re.subarray(0, HN)); this.fIm[slot].set(im.subarray(0, HN));
    const aRe = this.aRe, aIm = this.aIm;
    aRe.fill(0, 0, HN); aIm.fill(0, 0, HN);
    for (let k = 0; k < HP; k++) {
      const idx = (slot - k + HP * 4) % HP;
      const xr = this.fRe[idx], xi = this.fIm[idx], hr = this.hRe[k], hi = this.hIm[k];
      for (let b = 0; b <= HN / 2; b++) {
        aRe[b] += xr[b] * hr[b] - xi[b] * hi[b];
        aIm[b] += xr[b] * hi[b] + xi[b] * hr[b];
      }
    }
    for (let b = 1; b < HN / 2; b++) { aRe[HN - b] = aRe[b]; aIm[HN - b] = -aIm[b]; }
    headFFT.transform(aRe.subarray(0, HN), aIm.subarray(0, HN), true);
    const sc = 1 / HN;
    for (let i = 0; i < HB; i++) out[i] = aRe[HB + i] * sc;
    this.fPos = (slot + 1) % HP;

    // ---- tail: add the previously computed chunk ----
    if (this.tRe.length) {
      for (let i = 0; i < HB; i++) out[i] += this.tPlay[this.tIdx + i];
      this.tIdx += HB;
      this.tIn.set(x, TB + this.tFill);
      this.tFill += HB;
      if (this.tFill >= TB) this.tailChunk();
    }
  }

  tailChunk() {
    const re = this.re, im = this.im;
    re.set(this.tIn.subarray(0, TN)); im.fill(0, 0, TN);
    tailFFT.transform(re, im);
    const slot = this.tPos, P = this.tRe.length;
    this.tfRe[slot].set(re); this.tfIm[slot].set(im);
    const aRe = this.aRe, aIm = this.aIm;
    aRe.fill(0); aIm.fill(0);
    for (let k = 0; k < P; k++) {
      const idx = (slot - k + P * 4) % P;
      const xr = this.tfRe[idx], xi = this.tfIm[idx], hr = this.tRe[k], hi = this.tIm[k];
      for (let b = 0; b <= TN / 2; b++) {
        aRe[b] += xr[b] * hr[b] - xi[b] * hi[b];
        aIm[b] += xr[b] * hi[b] + xi[b] * hr[b];
      }
    }
    for (let b = 1; b < TN / 2; b++) { aRe[TN - b] = aRe[b]; aIm[TN - b] = -aIm[b]; }
    tailFFT.transform(aRe, aIm, true);
    const sc = 1 / TN;
    for (let i = 0; i < TB; i++) this.tPlay[i] = aRe[TB + i] * sc;
    this.tIdx = 0;
    this.tPos = (slot + 1) % P;
    // slide the input window: current chunk becomes the previous one
    this.tIn.copyWithin(0, TB, TB * 2);
    this.tFill = 0;
  }
}

class Convolver {
  constructor(sr, host) {
    this.sr = sr; this.host = host; this.p = defaults(schema);
    this.ch = [new Chan(), new Chan()];
    this.irId = null; this.loadedKey = ''; this.needLoad = false;
    this.pre = [new DelayLine(Math.ceil(0.52 * sr)), new DelayLine(Math.ceil(0.52 * sr))];
    this.hp = [new Biquad(), new Biquad()]; this.lp = [new Biquad(), new Biquad()];
    this.inBuf = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    this.outBuf = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    this.dirtyF = true;
    this.status = 'no impulse response';
  }

  setExtra(extra) {
    const id = extra && extra.irId ? extra.irId : null;
    if (id !== this.irId) { this.irId = id; this.needLoad = true; }
  }

  setParam(id, v) {
    this.p[id] = v;
    if (id === 'trim' || id === 'reverse' || id === 'gain') this.needLoad = true;
    this.dirtyF = true;
  }

  reset() { for (const c of this.ch) c.clear(); for (const d of this.pre) d.clear(); for (const b of [...this.hp, ...this.lp]) b.reset(); }

  loadIR() {
    const smp = this.irId ? this.host.getSample(this.irId) : null;
    if (!smp) { this.status = this.irId ? 'loading impulse response…' : 'no impulse response'; return; }
    this.needLoad = false;
    const p = this.p, sr = this.sr;
    const ratio = smp.rate / sr;
    const maxLen = Math.min(Math.floor(p.trim * sr), 8 * sr);
    const chans = [];
    for (let c = 0; c < 2; c++) {
      const src = smp.ch[Math.min(c, smp.ch.length - 1)];
      const n = Math.min(maxLen, Math.floor(src.length / ratio));
      const ir = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const pos = i * ratio, i0 = Math.floor(pos), f = pos - i0;
        const a = src[i0] || 0, b = src[i0 + 1] || 0;
        ir[p.reverse ? n - 1 - i : i] = a + (b - a) * f;
      }
      chans.push(ir);
    }
    // energy normalisation so different IRs sit at a similar level
    let e = 0;
    for (const ir of chans) for (let i = 0; i < ir.length; i++) e += ir[i] * ir[i];
    const norm = e > 0 ? (0.5 / Math.sqrt(e / 2)) * dbToGain(p.gain) : 1;
    for (const ir of chans) for (let i = 0; i < ir.length; i++) ir[i] *= norm;
    this.ch[0].load(chans[0]); this.ch[1].load(chans[1]);
    this.status = `${(chans[0].length / sr).toFixed(2)} s`;
  }

  process(L, R, n) {
    if (this.needLoad) this.loadIR();
    const p = this.p, sr = this.sr;
    if (this.dirtyF) {
      for (let c = 0; c < 2; c++) { this.hp[c].set('hp', sr, p.lowcut, 0.7071); this.lp[c].set('lp', sr, p.highcut, 0.7071); }
      this.dirtyF = false;
    }
    const dry = dbToGain(p.dry) * (p.dry <= -59.5 ? 0 : 1), wet = dbToGain(p.wet) * (p.wet <= -59.5 ? 0 : 1);
    if (!this.ch[0].hRe.length) { for (let i = 0; i < n; i++) { L[i] *= dry; R[i] *= dry; } return; }
    const pd = p.predelay * 0.001 * sr;
    const bufs = [L, R];
    for (let c = 0; c < 2; c++) {
      const x = bufs[c], inb = this.inBuf[c], outb = this.outBuf[c];
      // pre-delay into the 128-sample convolver block (partial blocks are zero padded: only at render end)
      for (let i = 0; i < BLOCK; i++) {
        if (i < n) { this.pre[c].write(x[i]); inb[i] = pd > 1 ? this.pre[c].read(pd) : x[i]; } else inb[i] = 0;
      }
      this.ch[c].block(inb, outb);
      for (let i = 0; i < n; i++) {
        let w = this.lp[c].process(this.hp[c].process(outb[i]));
        x[i] = x[i] * dry + w * wet;
      }
    }
  }
}

export function create(sr, host) { return new Convolver(sr, host); }
