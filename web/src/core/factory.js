// Factory sample pack, synthesized from code at startup (no audio files shipped).
import { renderOneShot } from './instruments/drumsynth.js';
import { Noise, Biquad, TAU, fastTanh } from './dsp.js';

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

// id, display name, category path under "Packs/Stepwise Drums"
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

export function renderFactorySample(id, sr) {
  const f = FACTORY_BY_ID.get(id);
  return f ? f.gen(sr) : null;
}

// Map id -> { rate, channels } for every factory sample a project references (used by offline render / tests).
export function collectFactorySamples(project, sr) {
  const map = new Map();
  for (const ch of project.channels) {
    const id = ch.sample && ch.sample.id;
    if (id && isFactoryId(id) && !map.has(id)) {
      const data = renderFactorySample(id, sr);
      if (data) map.set(id, { rate: sr, channels: [data] });
    }
  }
  return map;
}
