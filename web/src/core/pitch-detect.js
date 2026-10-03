// Pitch of a sample (for the Multisampler's auto-mapping and the Sampler's root key): YIN on a window taken
// after the attack, refined with parabolic interpolation. Returns { hz, key (fractional MIDI note), confidence } or null.
import { mono } from './slice-detect.js';

export function detectPitch(channels, rate, { min = 30, max = 2000 } = {}) {
  const x = Array.isArray(channels) ? mono(channels) : channels;
  const W = Math.min(4096, Math.floor(rate * 0.09));
  // the loudest stretch after the first 40 ms (attacks are noisy)
  let start = Math.min(Math.floor(rate * 0.04), Math.max(0, x.length - 2 * W));
  let best = -1;
  for (let s = start; s + 2 * W < x.length && s < rate * 1.5; s += W >> 1) {
    let e = 0; for (let i = s; i < s + W; i += 4) e += x[i] * x[i];
    if (e > best) { best = e; start = s; }
  }
  if (start + 2 * W > x.length || best <= 1e-8) return null;
  const tauMin = Math.max(2, Math.floor(rate / max)), tauMax = Math.min(W - 1, Math.ceil(rate / min));
  const d = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const v = x[start + i] - x[start + i + tau]; s += v * v; }
    d[tau] = s;
  }
  // cumulative mean normalised difference
  let run = 0; const cmnd = new Float64Array(tauMax + 1); cmnd[0] = 1;
  for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; cmnd[tau] = run > 0 ? (d[tau] * tau) / run : 1; }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < 0.15) { while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++; tau = t; break; }
  }
  if (tau < 0) { let m = Infinity; for (let t = tauMin; t <= tauMax; t++) if (cmnd[t] < m) { m = cmnd[t]; tau = t; } if (m > 0.4) return null; }
  let t = tau;
  if (tau > 1 && tau < tauMax) { const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1], den = a - 2 * b + c; if (den > 0) t = tau + 0.5 * (a - c) / den; }
  const hz = rate / t;
  return { hz, key: 69 + 12 * Math.log2(hz / 440), confidence: Math.max(0, Math.min(1, 1 - cmnd[tau])) };
}

// "Piano C4.wav", "harp_F#3", "Strings-Bb2" -> MIDI key with C4 = 60 (the usual convention of sample libraries)
export function keyFromName(name) {
  const m = /(?:^|[^A-Za-z])([A-Ga-g])([#b♯♭]?)(-?\d)(?![\d])/.exec(String(name));
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  const k = (Number(m[3]) + 1) * 12 + base + acc;
  return k >= 0 && k <= 127 ? k : null;
}
