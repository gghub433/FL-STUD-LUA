// Factory sample pack, synthesized from code at startup (no audio files shipped).
import { renderOneShot } from './instruments/drumsynth.js';
import { Noise, Biquad, TAU, fastTanh } from './dsp.js';
import { projectPatchSampleIds } from './patcher/spec.js';

const drum = (params, seconds) => (sr) => renderOneShot(sr, params, seconds);

function finish(buf, sr, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > m) m = a; }
  const g = m > 0 ? peak / m : 1;
  const fade = Math.min(buf.length, Math.floor(0.004 * sr));
  for (let i = 0; i < buf.length; i++) {
    let x = buf[i] * g;
    const left = buf.length - 1 - i;
    if (left < fade) x *= left / fade;
    buf[i] = x;
  }
  return buf;
}

function clap(sr) {
  const n = Math.floor(0.45 * sr), nz = new Noise(303), out = new Float32Array(n);
  const bp = new Biquad().set('bp', sr, 1250, 1.1);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let env = 0;
    for (let k = 0; k < 3; k++) { const tk = k * 0.0105; if (t >= tk) env = Math.max(env, Math.exp(-(t - tk) * 190)); }
    if (t >= 0.032) env = Math.max(env, 0.65 * Math.exp(-(t - 0.032) * 16));
    out[i] = bp.process(nz.next()) * env * 3;
  }
  return finish(out, sr);
}

function rim(sr) {
  const n = Math.floor(0.09 * sr), nz = new Noise(707), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = (Math.sin(TAU * 1700 * t) * 0.6 + Math.sin(TAU * 830 * t) * 0.5) * Math.exp(-t * 85) + nz.next() * Math.exp(-t * 320) * 0.35;
  }
  return finish(out, sr);
}

function shaker(sr) {
  const n = Math.floor(0.2 * sr), nz = new Noise(808), out = new Float32Array(n);
  const hp = new Biquad().set('hp', sr, 6000, 0.7), bp = new Biquad().set('bp', sr, 9000, 0.6);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = t < 0.025 ? t / 0.025 : Math.exp(-(t - 0.025) * 26);
    out[i] = bp.process(hp.process(nz.next())) * env;
  }
  return finish(out, sr);
}

function cowbell(sr) {
  const n = Math.floor(0.5 * sr), out = new Float32Array(n);
  let p1 = 0, p2 = 0;
  const bp = new Biquad().set('bp', sr, 1800, 1.5);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    p1 += 562 / sr; p2 += 845 / sr;
    const sq = (p1 % 1 < 0.5 ? 1 : -1) + (p2 % 1 < 0.5 ? 1 : -1);
    out[i] = bp.process(sq) * (0.6 * Math.exp(-t * 9) + 0.4 * Math.exp(-t * 60));
  }
  return finish(out, sr);
}

function crash(sr) {
  const n = Math.floor(1.8 * sr), nz = new Noise(909), out = new Float32Array(n);
  const hp = new Biquad().set('hp', sr, 4500, 0.7);
  const ph = [0, 0, 0, 0, 0, 0], fr = [205.3, 304.4, 369.6, 522.7, 540, 800];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let m = 0;
    for (let k = 0; k < 6; k++) { ph[k] += (fr[k] * 2.3) / sr; m += ph[k] % 1 < 0.5 ? 1 : -1; }
    out[i] = hp.process(nz.next() * 0.8 + m / 6 * 0.5) * (Math.exp(-t * 2.4) * (t < 0.003 ? t / 0.003 : 1));
  }
  return finish(out, sr);
}

function perc(sr) {
  const n = Math.floor(0.3 * sr), out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += (420 + 380 * Math.exp(-t * 45)) / sr;
    out[i] = Math.sin(TAU * ph) * Math.exp(-t * 18);
  }
  return finish(out, sr);
}

function sub808(sr) {
  const n = Math.floor(1.8 * sr), out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += (41.2 + 70 * Math.exp(-t * 28)) / sr;
    out[i] = fastTanh(Math.sin(TAU * ph) * 1.6) * Math.exp(-t * 2.1) * (t < 0.002 ? t / 0.002 : 1);
  }
  return finish(out, sr);
}

// id, display name, category path under "Packs/FL LUA Drums"
export const FACTORY = [
  { id: 'kick-deep', name: 'Kick Deep', cat: 'Kicks', gen: drum({ type: 0, pitch: -3, pitchEnv: 0.5, pitchDecay: 60, decay: 620, click: 0.2, drive: 0.3, noise: 0.05 }, 1.6) },
  { id: 'kick-punch', name: 'Kick Punch', cat: 'Kicks', gen: drum({ type: 0, pitch: 2, pitchEnv: 0.7, pitchDecay: 30, decay: 280, click: 0.55, drive: 0.45 }, 1) },
  { id: 'kick-short', name: 'Kick Short', cat: 'Kicks', gen: drum({ type: 0, pitch: 4, pitchEnv: 0.6, pitchDecay: 22, decay: 150, click: 0.4, drive: 0.35 }, 0.6) },
  { id: 'kick-808', name: 'Kick 808 Long', cat: 'Kicks', gen: drum({ type: 0, pitch: -12, pitchEnv: 0.3, pitchDecay: 90, decay: 1500, click: 0.08, drive: 0.15, noise: 0 }, 2.2) },
  { id: 'snare-tight', name: 'Snare Tight', cat: 'Snares', gen: drum({ type: 1, pitch: 0, pitchEnv: 0.25, pitchDecay: 30, decay: 170, noise: 0.7, noiseDecay: 150, noiseColor: 0.55, click: 0.3, drive: 0.1 }, 0.8) },
  { id: 'snare-fat', name: 'Snare Fat', cat: 'Snares', gen: drum({ type: 1, pitch: -4, pitchEnv: 0.3, pitchDecay: 40, decay: 340, noise: 0.85, noiseDecay: 260, noiseColor: 0.5, click: 0.35, drive: 0.25 }, 1) },
  { id: 'clap', name: 'Clap', cat: 'Claps', gen: clap },
  { id: 'rim', name: 'Rim Shot', cat: 'Percussion', gen: rim },
  { id: 'hat-closed', name: 'Hat Closed', cat: 'Hats', gen: drum({ type: 2, decay: 45, noise: 0.5, noiseDecay: 40, tone: 0.7 }, 0.3) },
  { id: 'hat-pedal', name: 'Hat Pedal', cat: 'Hats', gen: drum({ type: 2, decay: 110, noise: 0.5, noiseDecay: 90, tone: 0.6 }, 0.4) },
  { id: 'hat-open', name: 'Hat Open', cat: 'Hats', gen: drum({ type: 2, decay: 420, noise: 0.5, noiseDecay: 380, tone: 0.65 }, 1.2) },
  { id: 'tom-low', name: 'Tom Low', cat: 'Toms', gen: drum({ type: 3, pitch: -6, decay: 520, pitchEnv: 0.35 }, 1.3) },
  { id: 'tom-mid', name: 'Tom Mid', cat: 'Toms', gen: drum({ type: 3, pitch: 0, decay: 420, pitchEnv: 0.35 }, 1.1) },
  { id: 'tom-high', name: 'Tom High', cat: 'Toms', gen: drum({ type: 3, pitch: 6, decay: 340, pitchEnv: 0.35 }, 0.9) },
  { id: 'shaker', name: 'Shaker', cat: 'Percussion', gen: shaker },
  { id: 'cowbell', name: 'Cowbell', cat: 'Percussion', gen: cowbell },
  { id: 'perc', name: 'Perc Blip', cat: 'Percussion', gen: perc },
  { id: 'crash', name: 'Crash', cat: 'Cymbals', gen: crash },
  { id: 'sub-808', name: 'Sub 808 (C1)', cat: 'Bass', gen: sub808 },
];

export const factoryId = (id) => `factory:${id}`;
export const isFactoryId = (id) => typeof id === 'string' && id.startsWith('factory:');
export const FACTORY_BY_ID = new Map(FACTORY.map((f) => [factoryId(f.id), f]));
export const isIR = (id) => typeof id === 'string' && id.startsWith('factory:ir-');

export function renderFactorySample(id, sr) {
  const f = FACTORY_BY_ID.get(id) || IR_BY_ID.get(id);
  return f ? f.gen(sr) : null; // Float32Array (mono) or [Float32Array, Float32Array] (stereo IR)
}

export const factoryName = (id) => (FACTORY_BY_ID.get(id) || IR_BY_ID.get(id) || {}).name || id;

// Map id -> { rate, channels } for every factory sample a project references (used by offline render / tests).
export function collectFactorySamples(project, sr) {
  const map = new Map();
  const need = new Set();
  for (const ch of project.channels) {
    if (ch.sample && ch.sample.id) need.add(ch.sample.id);
    if (ch.pads) for (const pad of ch.pads) for (const l of pad.layers || []) if (l.sample) need.add(l.sample.id);
  }
  for (const t of project.mixer.tracks) for (const f of t.fx) if (f && f.extra && f.extra.irId) need.add(f.extra.irId);
  projectPatchSampleIds(project, need);
  for (const id of need) {
    if (!isFactoryId(id) || map.has(id)) continue;
    const data = renderFactorySample(id, sr);
    if (data) map.set(id, { rate: sr, channels: Array.isArray(data) ? data : [data] });
  }
  return map;
}

// ---------------------------------------------------------------------------------- impulse responses
function makeIR(sr, { len, rt60, pre = 0, taps = [], f0 = 14000, f1 = 1800, seed = 1, spread = 1 }) {
  const n = Math.floor(len * sr);
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) {
    const nz = new Noise(seed * 977 + c * 131);
    let lp = 0;
    const start = Math.floor(pre * sr);
    for (let i = start; i < n; i++) {
      const t = (i - start) / sr;
      const fc = f0 * Math.pow(f1 / f0, Math.min(1, t / rt60));
      const a = 1 - Math.exp((-TAU * fc) / sr);
      lp += a * (nz.next() - lp);
      const dens = Math.min(1, t * 40); // sparse early field -> dense tail
      out[c][i] = lp * Math.exp((-6.9078 * t) / rt60) * dens * 3;
    }
    for (const [ms, g] of taps) {
      const pos = start + Math.floor((ms * (c === 0 ? 1 : 1 + 0.07 * spread) * sr) / 1000);
      if (pos < n) out[c][pos] += g * (c === 0 ? 1 : -0.9);
    }
  }
  let m = 0;
  for (const c of out) for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(c[i]));
  for (const c of out) { for (let i = 0; i < n; i++) c[i] *= 0.9 / m; const f = Math.min(n, Math.floor(0.05 * sr)); for (let i = 0; i < f; i++) c[n - 1 - i] *= i / f; }
  return out;
}

export const IRS = [
  { id: 'ir-ambience', name: 'IR Tight Ambience', cat: 'Impulse responses', gen: (sr) => makeIR(sr, { len: 0.45, rt60: 0.25, pre: 0.002, taps: [[7, 0.8], [13, 0.5], [21, 0.3]], seed: 1 }) },
  { id: 'ir-small-room', name: 'IR Small Room', cat: 'Impulse responses', gen: (sr) => makeIR(sr, { len: 0.9, rt60: 0.5, pre: 0.003, taps: [[9, 0.9], [17, 0.6], [26, 0.45], [38, 0.3]], seed: 2 }) },
  { id: 'ir-plate', name: 'IR Bright Plate', cat: 'Impulse responses', gen: (sr) => makeIR(sr, { len: 2.4, rt60: 1.8, f0: 18000, f1: 6000, seed: 3 }) },
  { id: 'ir-hall', name: 'IR Concert Hall', cat: 'Impulse responses', gen: (sr) => makeIR(sr, { len: 3.4, rt60: 2.4, pre: 0.018, taps: [[24, 0.7], [41, 0.5], [67, 0.4]], seed: 4 }) },
  { id: 'ir-large-hall', name: 'IR Large Hall', cat: 'Impulse responses', gen: (sr) => makeIR(sr, { len: 5, rt60: 3.8, pre: 0.03, taps: [[35, 0.6], [62, 0.45], [95, 0.35]], f0: 11000, f1: 1200, seed: 5 }) },
  { id: 'ir-cathedral', name: 'IR Cathedral', cat: 'Impulse responses', gen: (sr) => makeIR(sr, { len: 7, rt60: 6, pre: 0.045, taps: [[48, 0.5], [90, 0.4], [140, 0.3]], f0: 9000, f1: 900, seed: 6 }) },
];
export const IR_BY_ID = new Map(IRS.map((f) => [`factory:${f.id}`, f]));
