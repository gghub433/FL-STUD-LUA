// Transient detection and slice helpers for the Slicer (pure functions, work on a decoded sample).
import { PPQ } from './constants.js';

// Mono mix-down of a sample's channels.
export function mono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (channels[0][i] + channels[1][i]) * 0.5;
  return out;
}

// Onset detection: energy novelty on a high-passed signal (so low rumble does not hide hits),
// adaptive threshold from a running median-ish average, minimum gap between slices.
// sensitivity 0..1 (higher = more slices). Returns sorted start frames (always begins with 0).
export function detectSlices(data, rate, { sensitivity = 0.5, minGapMs = 70, maxSlices = 64 } = {}) {
  const hop = Math.max(64, Math.round(rate * 0.004));
  const frames = Math.floor(data.length / hop);
  if (frames < 4) return [0];
  const env = new Float32Array(frames);
  let prevX = 0, hp = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      const x = data[i];
      hp = 0.95 * (hp + x - prevX); prevX = x;      // first-order high-pass
      e += hp * hp * 0.7 + x * x * 0.3;
    }
    env[f] = Math.sqrt(e / hop);
  }
  const nov = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    const a = Math.log(env[f] + 1e-4), b = Math.log(env[f - 1] + 1e-4);
    nov[f] = Math.max(0, a - b);
  }
  // adaptive threshold: mean of the surrounding novelty * factor
  const win = Math.round(0.25 * rate / hop), factor = 2.6 - sensitivity * 2.2;
  const peaks = [];
  const minGap = Math.round((minGapMs / 1000) * rate / hop);
  let last = -1e9;
  for (let f = 2; f < frames - 1; f++) {
    let sum = 0, cnt = 0;
    for (let k = Math.max(0, f - win); k < Math.min(frames, f + win); k++) { sum += nov[k]; cnt++; }
    const th = (sum / cnt) * factor + 0.04 * (1.2 - sensitivity);
    if (nov[f] > th && nov[f] >= nov[f - 1] && nov[f] >= nov[f + 1] && f - last >= minGap) {
      // step back to the true start of the attack: lowest envelope in the 3 hops before the peak
      let s = f;
      for (let k = f - 1; k >= Math.max(0, f - 3); k--) if (env[k] <= env[s]) s = k;
      peaks.push(Math.max(0, s * hop));
      last = f;
    }
  }
  const out = [0];
  for (const p of peaks) if (p - out[out.length - 1] > hop * 2) out.push(p);
  return out.slice(0, maxSlices);
}

export function evenSlices(length, n) {
  n = Math.max(1, Math.min(64, n | 0));
  return Array.from({ length: n }, (_, i) => Math.floor((i * length) / n));
}

// Guess the tempo of a loop from its length: pick a whole number of bars giving a BPM near 80..170.
export function estimateLoop(length, rate) {
  const sec = length / rate;
  let best = { bars: 1, bpm: 240 / sec, score: Infinity };
  for (const bars of [1, 2, 4, 8, 16]) {
    const bpm = (bars * 4 * 60) / sec;
    const score = Math.abs(Math.log(bpm / 125));
    if (score < best.score) best = { bars, bpm, score };
  }
  return best;
}

// Notes (start, length in ticks, key) that replay the slices in their original order.
// grid > 1 snaps the starts to that many ticks (slices are cut slightly before the transient).
export function slicesToNotes(slices, length, rate, bpm, baseKey = 60, vel = 100, grid = 1) {
  const ticksPerSec = (bpm * PPQ) / 60;
  const q = (t) => (grid > 1 ? Math.round(t / grid) * grid : Math.round(t));
  const starts = slices.map((s) => q((s / rate) * ticksPerSec));
  const endTick = q((length / rate) * ticksPerSec);
  return starts.map((t0, i) => {
    const t1 = i + 1 < starts.length ? starts[i + 1] : endTick;
    return { s: t0, l: Math.max(1, t1 - t0), k: baseKey + i, v: vel };
  });
}
