// Tempo detection for audio (loops, songs, recordings).
//   1. onset strength: half-wave rectified change of the log energy in 4 bands (~11.6 ms hops), summed
//   2. autocorrelation of that envelope over the tempo range, weighted by a broad preference around 120 BPM
//      and helped by the harmonics of each period (a beat at T also correlates at 2T and 4T)
//   3. parabolic refinement of the best lag; the beat phase is where the onsets line up best
//   4. a loop whose length is a whole number of beats at that tempo is snapped to the exact value
// Returns { bpm, confidence 0..1, offset (frames of the first beat), beats (length in beats, when it is a loop) }.
// Half and double tempo are often equally plausible (a 174 BPM break can be felt at 87): the UI offers both, and
// fitting to the project picks the one nearest the project tempo (nearestOctave).
import { mono } from './slice-detect.js';

const BANDS = [[0, 200], [200, 1200], [1200, 5000], [5000, 20000]];
const HARM = [1, 0.8, 0.6, 0.5];

function onsetEnvelope(x, rate, hop) {
  const frames = Math.floor(x.length / hop);
  const env = new Float32Array(frames);
  // one-pole band splits (cheap, good enough to separate kick / snare / hats energy)
  const co = BANDS.map(([, hi]) => Math.exp(-2 * Math.PI * Math.min(hi, rate * 0.45) / rate));
  const lp = new Float64Array(BANDS.length), prev = new Float64Array(BANDS.length).fill(-10);
  const e = new Float64Array(BANDS.length);
  for (let f = 0; f < frames; f++) {
    e.fill(0);
    for (let i = f * hop, end = i + hop; i < end; i++) {
      const s = x[i];
      let below = 0;
      for (let b = 0; b < BANDS.length; b++) {
        lp[b] = co[b] * lp[b] + (1 - co[b]) * s;                       // low-pass at the band's top
        const band = lp[b] - below; below = lp[b];
        e[b] += band * band;
      }
    }
    let flux = 0;
    for (let b = 0; b < BANDS.length; b++) {
      const l = Math.log(1e-9 + e[b] / hop);
      const d = l - prev[b];
      if (d > 0) flux += d;
      prev[b] = l;
    }
    env[f] = flux;
  }
  // remove the slowly varying part (crescendos are not beats) and the first frame's jump
  if (frames) env[0] = 0;
  const w = Math.max(1, Math.round(0.5 * rate / hop)), out = new Float32Array(frames);
  let acc = 0;
  for (let f = 0; f < frames; f++) {
    acc += env[f]; if (f >= w) acc -= env[f - w];
    out[f] = Math.max(0, env[f] - acc / Math.min(f + 1, w));
  }
  return out;
}

export function detectTempo(channels, rate, { min = 70, max = 180, loop = null } = {}) {
  const x = Array.isArray(channels) ? mono(channels) : channels;
  const hop = Math.max(64, Math.round(rate * 0.0116));
  const fps = rate / hop;
  const env = onsetEnvelope(x, rate, hop);
  const n = env.length;
  if (n < fps * 1.5) return { bpm: 0, confidence: 0, offset: 0, beats: 0 };
  // onsets are one-frame spikes: blur them a little so the correlation at long lags (bars) does not miss by a frame
  const sm = new Float32Array(n), K = [1, 4, 6, 4, 1];
  for (let i = 0; i < n; i++) { let v = 0; for (let k = -2; k <= 2; k++) v += (env[i + k] || 0) * K[k + 2]; sm[i] = v / 16; }
  let mean = 0; for (let i = 0; i < n; i++) mean += sm[i]; mean /= n;
  const z = new Float32Array(n); for (let i = 0; i < n; i++) z[i] = sm[i] - mean;
  const lagMin = Math.max(2, Math.floor((60 / max) * fps)), lagMax = Math.min(n - 2, Math.ceil((60 / min) * fps * 4));
  const ac = new Float64Array(lagMax + 2);
  let zero = 0; for (let i = 0; i < n; i++) zero += z[i] * z[i];
  for (let lag = 1; lag <= lagMax + 1 && lag < n; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += z[i] * z[i - lag];
    ac[lag] = s / (n - lag) * n / (zero || 1);
  }
  const at = (lag) => { const i = Math.floor(lag), f = lag - i; return i + 1 < ac.length ? ac[i] * (1 - f) + ac[i + 1] * f : 0; };
  // score each tempo: its period, plus its double and quadruple (bars), with a gentle preference for 90-150 BPM
  let best = null;
  const top = Math.min(lagMax, Math.ceil((60 / min) * fps));
  for (let lag = lagMin; lag <= top; lag += 0.25) {
    const bpm = 60 * fps / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    let comb = 0;
    for (let k = 1; k <= HARM.length; k++) comb += HARM[k - 1] * at(lag * k);
    const s = comb * (0.6 + 0.4 * prior);
    if (!best || s > best.s) best = { lag, s };
  }
  if (!best || best.s <= 0) return { bpm: 0, confidence: 0, offset: 0, beats: 0 };
  // fine-tune on the 4-beat lag (four times the resolution)
  let lag = best.lag;
  const l4 = lag * 4;
  if (l4 + 1 < ac.length) {
    let bl = l4, bv = -Infinity;
    for (let d = -2; d <= 2; d += 0.05) { const v = at(l4 + d); if (v > bv) { bv = v; bl = l4 + d; } }
    if (bv > 0) lag = bl / 4;
  }
  let bpm = 60 * fps / lag;
  // phase: comb over the envelope
  let bestPh = 0, bestSum = -1;
  for (let ph = 0; ph < lag; ph += 0.5) {
    let s = 0;
    for (let t = ph; t < n; t += lag) s += env[Math.round(t)] || 0;
    if (s > bestSum) { bestSum = s; bestPh = ph; }
  }
  const confidence = Math.max(0, Math.min(1, best.s / 0.35));
  // loops: a whole number of beats over the file -> the exact tempo
  const seconds = x.length / rate;
  let beats = 0;
  const exact = (seconds * bpm) / 60, whole = Math.round(exact);
  if ((loop !== false) && whole >= 2 && Math.abs(exact - whole) / whole < 0.03 && (loop === true || whole % 4 === 0 || whole % 2 === 0)) {
    beats = whole;
    bpm = (whole * 60) / seconds;
  }
  return { bpm: Math.round(bpm * 100) / 100, confidence: Math.round(confidence * 100) / 100, offset: Math.round(bestPh * hop), beats };
}

// the tempo among bpm/2, bpm, bpm*2 closest to the project's (in ratio)
export function nearestOctave(bpm, projectTempo) {
  if (!(bpm > 0) || !(projectTempo > 0)) return bpm;
  return [bpm / 2, bpm, bpm * 2].reduce((a, b) => (Math.abs(Math.log(b / projectTempo)) < Math.abs(Math.log(a / projectTempo)) ? b : a));
}
