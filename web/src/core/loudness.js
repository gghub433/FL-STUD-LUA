// Loudness metering after ITU-R BS.1770-4 / EBU R128, used by the live master meter (in the AudioWorklet),
// by Export (in the render worker) and by the tests:
//   momentary (400 ms), short-term (3 s), integrated (gated: −70 LUFS absolute, −10 LU relative),
//   loudness range (EBU Tech 3342: short-term values, −20 LU relative gate, 95th − 10th percentile),
//   true peak (4× oversampled, BS.1770 Annex 2) and stereo correlation.
// Gating blocks are 400 ms long and start every 100 ms (75 % overlap). Their energies go into fine histograms
// (0.02 LU bins holding exact energy sums), so the meter runs for hours in constant memory.

const LO = -70, HI = 10, STEP = 0.02, BINS = Math.round((HI - LO) / STEP);
const lufs = (energy) => (energy > 0 ? -0.691 + 10 * Math.log10(energy) : -Infinity);
const dB = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);

// K-weighting: a high shelf (head effect) then the RLB high-pass, for any sample rate (coefficients as in libebur128)
export function kWeighting(sr) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / sr);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = { b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / sr);
  a0 = 1 + K / Q + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

// 4× interpolator for true peak: windowed sinc, 16 taps per phase; phase 0 is the input itself (delayed)
const TP_TAPS = 16, TP_DELAY = 8;
const TP_PHASES = (() => {
  const N = 4 * TP_TAPS + 1, c = 2 * TP_TAPS, beta = 5.5;
  const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 60; k++) { t *= (x / (2 * k)) ** 2; s += t; if (t < 1e-14 * s) break; } return s; };
  const h = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    const x = (j - c) / 4, r = (j - c) / c;
    h[j] = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0(beta);
  }
  const out = [];
  for (let q = 1; q < 4; q++) {
    const taps = new Float64Array(TP_TAPS);
    let sum = 0;
    for (let k = 0; k < TP_TAPS; k++) { taps[k] = h[q + 4 * k]; sum += taps[k]; }
    for (let k = 0; k < TP_TAPS; k++) taps[k] /= sum;                 // unity gain at DC for every phase
    out.push(taps);
  }
  return out;
})();

class Histogram {
  constructor() { this.e = new Float64Array(BINS); this.n = new Float64Array(BINS); this.count = 0; this.energy = 0; }
  clear() { this.e.fill(0); this.n.fill(0); this.count = 0; this.energy = 0; }
  add(energy) {
    const l = lufs(energy);
    if (!(l > LO)) return false;                                         // absolute gate
    const i = Math.min(BINS - 1, Math.floor((l - LO) / STEP));
    this.e[i] += energy; this.n[i]++; this.count++; this.energy += energy;
    return true;
  }
  // first bin whose centre lies above a loudness threshold
  from(threshold) { return Math.max(0, Math.min(BINS, Math.ceil((threshold - LO) / STEP - 0.5))); }
  centre(i) { return LO + (i + 0.5) * STEP; }
}

export class LoudnessMeter {
  constructor(sr, opts = {}) {
    this.sr = sr;
    this.truePeakOn = opts.truePeak !== false;
    this.sub = Math.max(1, Math.round(sr * 0.1));                        // 100 ms
    const [s, hp] = kWeighting(sr);
    this.k = [s.b0, s.b1, s.b2, s.a1, s.a2, hp.b0, hp.b1, hp.b2, hp.a1, hp.a2];
    this.ring = new Float64Array(30);                                    // energies of the last 30 sub-blocks (3 s)
    this.blocks = new Histogram();                                       // 400 ms gating blocks -> integrated
    this.shorts = new Histogram();                                       // 3 s values -> loudness range
    this.tpL = new Float64Array(TP_TAPS * 2); this.tpR = new Float64Array(TP_TAPS * 2);
    this.corrK = Math.exp(-1 / (0.3 * sr));                             // correlation averaged over ~300 ms
    this.reset();
  }

  reset() {
    this.zL = new Float64Array(4); this.zR = new Float64Array(4);        // biquad states (shelf z1 z2, high-pass z1 z2)
    this.ring.fill(0); this.filled = 0; this.acc = 0; this.pos = 0;
    this.tpL.fill(0); this.tpR.fill(0); this.tpPos = 0;
    this.sLR = 0; this.sLL = 0; this.sRR = 0;
    this.m = -Infinity; this.s = -Infinity;
    this.resetIntegrated();
  }

  // integrated, range and the maxima start over (the live meter does this whenever playback starts)
  resetIntegrated() {
    this.blocks.clear(); this.shorts.clear();
    this.since = 0;                                                      // sub-blocks since the reset: older audio is not counted
    this.iCache = -Infinity; this.lraCache = 0; this.dirty = false;
    this.mMax = -Infinity; this.sMax = -Infinity; this.tp = 0; this.peak = 0;
  }

  process(L, R, n, off = 0) {
    const k = this.k, zL = this.zL, zR = this.zR, sub = this.sub;
    const [b0, b1, b2, a1, a2, c0, c1, c2, d1, d2] = k;
    let acc = this.acc, pos = this.pos;
    let sLR = this.sLR, sLL = this.sLL, sRR = this.sRR;
    const ck = this.corrK, cj = 1 - ck;
    let peak = this.peak;
    for (let i = 0; i < n; i++) {
      const l = L[off + i], r = R[off + i];
      // transposed direct form II, two biquads per channel
      let y = b0 * l + zL[0]; zL[0] = b1 * l - a1 * y + zL[1]; zL[1] = b2 * l - a2 * y;
      let yl = c0 * y + zL[2]; zL[2] = c1 * y - d1 * yl + zL[3]; zL[3] = c2 * y - d2 * yl;
      y = b0 * r + zR[0]; zR[0] = b1 * r - a1 * y + zR[1]; zR[1] = b2 * r - a2 * y;
      const yr = c0 * y + zR[2]; zR[2] = c1 * y - d1 * yr + zR[3]; zR[3] = c2 * y - d2 * yr;
      acc += yl * yl + yr * yr;
      sLR = ck * sLR + cj * l * r; sLL = ck * sLL + cj * l * l; sRR = ck * sRR + cj * r * r;
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > peak) peak = al;
      if (ar > peak) peak = ar;
      if (++pos === sub) { this._subBlock(acc); acc = 0; pos = 0; }
    }
    // denormals: the filters decay towards zero in silence
    for (let j = 0; j < 4; j++) { if (Math.abs(zL[j]) < 1e-25) zL[j] = 0; if (Math.abs(zR[j]) < 1e-25) zR[j] = 0; }
    this.acc = acc; this.pos = pos; this.peak = peak;
    this.sLR = sLR; this.sLL = sLL; this.sRR = sRR;
    if (this.truePeakOn) this._truePeak(L, R, n, off);
    else if (peak > this.tp) this.tp = peak;
  }

  _truePeak(L, R, n, off) {
    const T = TP_TAPS, bl = this.tpL, br = this.tpR, [p1, p2, p3] = TP_PHASES;
    let pos = this.tpPos, tp = this.tp;
    for (let i = 0; i < n; i++) {
      // each input is written twice so the last T inputs are always contiguous: bl[pos .. pos+T-1], newest first
      pos = pos === 0 ? T - 1 : pos - 1;
      const l = L[off + i], r = R[off + i];
      bl[pos] = l; bl[pos + T] = l; br[pos] = r; br[pos + T] = r;
      let q1 = 0, q2 = 0, q3 = 0, u1 = 0, u2 = 0, u3 = 0;
      for (let j = 0; j < T; j++) {
        const x = bl[pos + j], y = br[pos + j];
        q1 += p1[j] * x; q2 += p2[j] * x; q3 += p3[j] * x;
        u1 += p1[j] * y; u2 += p2[j] * y; u3 += p3[j] * y;
      }
      const m = Math.max(Math.abs(bl[pos + TP_DELAY]), Math.abs(br[pos + TP_DELAY]), Math.abs(q1), Math.abs(q2), Math.abs(q3), Math.abs(u1), Math.abs(u2), Math.abs(u3));
      if (m > tp) tp = m;
    }
    this.tpPos = pos; this.tp = tp;
  }

  _subBlock(sum) {
    const ring = this.ring, sub = this.sub;
    ring.copyWithin(0, 1); ring[29] = sum;
    if (this.filled < 30) this.filled++;
    const f = this.filled, fresh = ++this.since;
    if (f >= 4) {
      const e = (ring[26] + ring[27] + ring[28] + ring[29]) / (4 * sub);
      this.m = lufs(e);
      if (fresh >= 4) {
        if (this.m > this.mMax) this.mMax = this.m;
        if (this.blocks.add(e)) this.dirty = true;
      }
    }
    let s = 0;
    for (let j = 30 - f; j < 30; j++) s += ring[j];
    const es = s / (f * sub);
    this.s = f >= 4 ? lufs(es) : -Infinity;
    if (f === 30 && fresh >= 30) {
      if (this.s > this.sMax) this.sMax = this.s;
      if (this.shorts.add(es)) this.dirty = true;
    }
  }

  _update() {
    if (!this.dirty) return;
    this.dirty = false;
    // integrated: mean energy of the blocks above −70 LUFS, then again over those above (that mean − 10 LU)
    const b = this.blocks;
    if (!b.count) this.iCache = -Infinity;
    else {
      const g = lufs(b.energy / b.count) - 10;
      let e = 0, c = 0;
      for (let i = b.from(g); i < BINS; i++) { e += b.e[i]; c += b.n[i]; }
      this.iCache = c ? lufs(e / c) : -Infinity;
    }
    // loudness range: short-term values above (their mean − 20 LU); 95th minus 10th percentile
    const s = this.shorts;
    this.lraCache = 0;
    if (s.count) {
      const i0 = s.from(lufs(s.energy / s.count) - 20);
      let total = 0;
      for (let i = i0; i < BINS; i++) total += s.n[i];
      if (total > 1) {
        const lo = Math.round((total - 1) * 0.1), hi = Math.round((total - 1) * 0.95);
        let acc = 0, l10 = null, l95 = null;
        for (let i = i0; i < BINS && l95 === null; i++) {
          acc += s.n[i];
          if (l10 === null && acc > lo) l10 = s.centre(i);
          if (acc > hi) l95 = s.centre(i);
        }
        this.lraCache = Math.max(0, l95 - l10);
      }
    }
  }

  get momentary() { return this.m; }
  get shortTerm() { return this.s; }
  get integrated() { this._update(); return this.iCache; }
  get range() { this._update(); return this.lraCache; }
  get truePeak() { return dB(this.tp); }                                 // dBTP, maximum since the last reset
  get samplePeak() { return dB(this.peak); }
  get correlation() { const d = Math.sqrt(this.sLL * this.sRR); return d > 1e-12 ? Math.max(-1, Math.min(1, this.sLR / d)) : 0; }

  // compact form for the worklet -> UI message: [M, S, I, LRA, TPmax, Mmax, Smax, correlation]
  snapshot(out = new Array(8)) {
    out[0] = this.m; out[1] = this.s; out[2] = this.integrated; out[3] = this.range;
    out[4] = this.truePeak; out[5] = this.mMax; out[6] = this.sMax; out[7] = this.correlation;
    return out;
  }

  stats() {
    return { integrated: this.integrated, range: this.range, truePeak: this.truePeak, samplePeak: this.samplePeak, momentaryMax: this.mMax, shortTermMax: this.sMax };
  }
}

export function measureLoudness(L, R, sr, opts) {
  const m = new LoudnessMeter(sr, opts);
  const step = 8192;
  for (let i = 0; i < L.length; i += step) m.process(L, R, Math.min(step, L.length - i), i);
  return m.stats();
}

// Export targets: 'peak' scales the loudest sample to −0.1 dBFS; a number is an integrated loudness in LUFS,
// reached by a plain gain, with a look-ahead limiter at the true-peak ceiling only where the gain would clip.
export const LOUDNESS_TARGETS = [
  ['off', 'Off'],
  ['peak', 'Peak −0.1 dBFS'],
  [-14, '−14 LUFS (streaming: Spotify, YouTube, Tidal)'],
  [-16, '−16 LUFS (Apple Music, podcasts)'],
  [-23, '−23 LUFS (EBU R128 broadcast)'],
  [-9, '−9 LUFS (loud club master)'],
];

// True-peak limiter for a whole buffer, in place and without delay. The detector is the 4× oversampled signal,
// so the peaks between samples are held under the ceiling as well. Gain smoothing as in the mixer's Limiter:
// m[j] = min(t[j .. j+W]) and g[s] = mean(m[s-W+1 .. s]) never exceed t[s] = ceiling / peak(s).
// opts: gain (applied first), meter (gets the output), write (false = only measure what it would produce)
export function limitInPlace(l, r, sr, ceilingDb, { gain = 1, meter = null, write = true, lookMs = 1.5, relMs = 60 } = {}) {
  const n = l.length, T = TP_TAPS, D = TP_DELAY, [p1, p2, p3] = TP_PHASES;
  const ML = new Float32Array(512), MR = new Float32Array(512);
  let mk = 0;
  const ceil = Math.pow(10, ceilingDb / 20), W = Math.max(2, Math.round(lookMs * 0.001 * sr));
  const rCo = Math.exp(-1 / (relMs * 0.001 * sr));
  const bl = new Float64Array(2 * T), br = new Float64Array(2 * T);
  const cap = 2 * W + 4, t = new Float64Array(cap), m = new Float64Array(cap).fill(1), dq = new Float64Array(cap);
  let pos = 0, qh = 0, qt = 0, sum = W, rel = 1, ivPrev = 0;
  for (let k = 0; k < n + D + W; k++) {
    // 1) oversample: at step k the filter yields x[k-D] and the points between x[k-D] and x[k-D+1]
    pos = pos === 0 ? T - 1 : pos - 1;
    const xl = k < n ? l[k] * gain : 0, xr = k < n ? r[k] * gain : 0;
    bl[pos] = xl; bl[pos + T] = xl; br[pos] = xr; br[pos + T] = xr;
    let q1 = 0, q2 = 0, q3 = 0, u1 = 0, u2 = 0, u3 = 0;
    for (let j = 0; j < T; j++) {
      const x = bl[pos + j], y = br[pos + j];
      q1 += p1[j] * x; q2 += p2[j] * x; q3 += p3[j] * x;
      u1 += p1[j] * y; u2 += p2[j] * y; u3 += p3[j] * y;
    }
    const iv = Math.max(Math.abs(q1), Math.abs(q2), Math.abs(q3), Math.abs(u1), Math.abs(u2), Math.abs(u3));
    const s0 = k - D;                                         // the sample the detector now knows everything about
    if (s0 < 0) { ivPrev = iv; continue; }
    const a = Math.max(Math.abs(bl[pos + D]), Math.abs(br[pos + D]), iv, ivPrev);
    ivPrev = iv;
    const tg = a > ceil ? ceil / a : 1;
    // 2) sliding minimum over W+1 detector values, then the box average
    const p = s0 % cap;
    t[p] = tg;
    while (qt > qh && t[dq[(qt - 1) % cap] % cap] >= tg) qt--;
    dq[qt % cap] = s0; qt++;
    while (dq[qh % cap] < s0 - W) qh++;
    const s = s0 - W;
    if (s < 0) continue;
    const si = s % cap, oi = (((s - W) % cap) + cap) % cap;
    sum += t[dq[qh % cap] % cap] - m[oi];
    m[si] = t[dq[qh % cap] % cap];
    let g = sum / W;
    if (g > 1) g = 1;
    if (g < rel) rel = g; else rel = rCo * rel + (1 - rCo) * g;
    const go = g < rel ? g : rel;
    if (s >= n) continue;
    const ol = l[s] * gain * go, or = r[s] * gain * go;
    if (write) { l[s] = ol; r[s] = or; }
    if (meter) { ML[mk] = ol; MR[mk] = or; if (++mk === 512) { meter.process(ML, MR, mk); mk = 0; } }
  }
  if (meter && mk) meter.process(ML, MR, mk);
}

// Brings a rendered file to the target; returns a report of the loudness before and after
export function applyTarget(l, r, sr, target, ceilingDb = -1, before = null) {
  const pre = before || measureLoudness(l, r, sr);
  const report = { target, before: pre, gain: 0, limited: false, after: pre };
  if (target === 'off' || target == null) return report;
  let gainDb;
  if (target === 'peak') {
    if (!(pre.samplePeak > -120)) return report;
    gainDb = -0.1 - pre.samplePeak;
  } else {
    if (!Number.isFinite(pre.integrated)) return report;               // silence: nothing to measure
    gainDb = target - pre.integrated;
  }
  report.gain = gainDb;
  if (target === 'peak' || pre.truePeak + gainDb <= ceilingDb) {
    const g = Math.pow(10, gainDb / 20);
    for (let i = 0; i < l.length; i++) { l[i] *= g; r[i] *= g; }
    report.after = shift(pre, gainDb);
    return report;
  }
  // the gain alone would clip: limit, and since limiting takes some loudness away, find the gain that still
  // reaches the target (measured dry runs), then write the result
  report.limited = true;
  let c = ceilingDb - 0.1, g = gainDb;
  for (let pass = 0; pass < 5; pass++) {
    const meter = new LoudnessMeter(sr);
    limitInPlace(l, r, sr, c, { gain: Math.pow(10, g / 20), meter, write: false });
    const st = meter.stats();
    const over = st.truePeak - ceilingDb, short = target - st.integrated;
    if (over <= 0 && Math.abs(short) <= 0.1) break;
    if (over > 0) c -= over + 0.05;
    if (Number.isFinite(short)) g = Math.min(gainDb + 24, g + short);
  }
  const meter = new LoudnessMeter(sr);
  limitInPlace(l, r, sr, c, { gain: Math.pow(10, g / 20), meter });
  report.gain = g;
  report.after = meter.stats();
  return report;
}

const shift = (s, g) => ({ integrated: s.integrated + g, range: s.range, truePeak: s.truePeak + g, samplePeak: s.samplePeak + g, momentaryMax: s.momentaryMax + g, shortTermMax: s.shortTermMax + g });

export const fmtLufs = (v, unit = ' LUFS') => (Number.isFinite(v) ? `${v.toFixed(1)}${unit}` : `−∞${unit}`).replace('-', '−');
