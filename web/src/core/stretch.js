// WSOLA time stretching + pitch shifting (pure functions, offline use on the main thread / in tests).
//
// Time stretch: overlap-add of Hann-windowed frames. Output frames advance by a fixed synthesis hop;
// the analysis position advances by hop/ratio and is nudged within +-tolerance to the offset whose
// waveform best continues the previous frame (cross-correlation on a 4x decimated copy, then refined).
// Pitch shift = time stretch by the pitch ratio followed by resampling back to the original duration.

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

function stretchChannel(x, ratio, frame, search) {
  const hop = frame >> 1;
  const outLen = Math.max(1, Math.round(x.length * ratio));
  const out = new Float32Array(outLen + frame * 2);
  const norm = new Float32Array(outLen + frame * 2);
  const win = hann(frame);
  const D = 4;
  // decimated copy for the coarse search
  const dec = new Float32Array(Math.floor(x.length / D));
  for (let i = 0; i < dec.length; i++) { let s = 0; for (let k = 0; k < D; k++) s += x[i * D + k] || 0; dec[i] = s / D; }

  const anaHop = hop / ratio;
  let prevPos = 0;          // input position of the previous frame start
  const frames = Math.ceil(outLen / hop) + 1;
  for (let m = 0; m < frames; m++) {
    let pos = Math.round(m * anaHop);
    if (m > 0) {
      // natural continuation of the previous frame is at prevPos + hop; find the best match near the target
      const ref = prevPos + hop;
      const lo = Math.max(0, pos - search), hi = Math.min(x.length - frame, pos + search);
      if (hi > lo && ref + frame < x.length) {
        let best = pos, bv = -Infinity;
        const cl = Math.floor(frame / D / 2);               // correlate half a frame
        const r0 = Math.floor(ref / D);
        for (let c = Math.floor(lo / D); c <= Math.floor(hi / D); c++) {
          let sum = 0;
          for (let k = 0; k < cl; k++) sum += (dec[r0 + k] || 0) * (dec[c + k] || 0);
          if (sum > bv) { bv = sum; best = c * D; }
        }
        // refine at full resolution around the coarse winner
        let rb = best, rv = -Infinity;
        for (let c = Math.max(lo, best - D); c <= Math.min(hi, best + D); c++) {
          let sum = 0;
          for (let k = 0; k < frame >> 1; k += 2) sum += (x[ref + k] || 0) * (x[c + k] || 0);
          if (sum > rv) { rv = sum; rb = c; }
        }
        pos = rb;
      }
    }
    pos = Math.min(Math.max(0, pos), Math.max(0, x.length - 1));
    const o = m * hop;
    for (let i = 0; i < frame; i++) {
      const v = x[pos + i];
      if (v === undefined) break;
      out[o + i] += v * win[i]; norm[o + i] += win[i];
    }
    prevPos = pos;
  }
  const res = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) res[i] = norm[i] > 1e-4 ? out[i] / norm[i] : 0;
  return res;
}

function resample(x, factor) { // factor > 1 plays faster (shorter)
  const n = Math.max(1, Math.floor(x.length / factor));
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * factor, i0 = Math.floor(p), f = p - i0;
    const a = x[i0] || 0, b = x[i0 + 1] || 0;
    y[i] = a + (b - a) * f;
  }
  return y;
}

// channels: Float32Array[]; ratio = new length / old length (>1 slower); semitones shifts pitch.
export function stretchAudio(channels, { ratio = 1, semitones = 0, rate = 44100 } = {}) {
  const frame = rate >= 40000 ? 2048 : 1024;
  const search = frame >> 1;
  const pr = Math.pow(2, semitones / 12);
  const total = ratio * pr;
  return channels.map((c) => {
    let y = Math.abs(total - 1) > 1e-4 ? stretchChannel(c, total, frame, search) : c.slice();
    if (Math.abs(pr - 1) > 1e-4) y = resample(y, pr);
    return y;
  });
}
