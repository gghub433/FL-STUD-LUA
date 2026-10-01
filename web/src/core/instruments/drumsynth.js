// Drum synthesizer: kick / snare / hat / tom with pitch envelope, body decay, noise layer,
// click transient, tone filter and drive. Also used offline to generate the factory drum pack.
import { def, bool, choice, defaults, schemaMap } from '../schema.js';
import { Noise, Biquad, fastTanh, TAU, clamp } from '../dsp.js';

export const TYPES = ['Kick', 'Snare', 'Hat', 'Tom'];

export const schema = [
  choice('type', 'Type', TYPES, 0),
  def('pitch', 'Pitch', -24, 24, 0, { unit: 'st', step: 0.01 }),
  def('pitchEnv', 'Pitch env', 0, 1, 0.5),
  def('pitchDecay', 'Pitch env decay', 2, 500, 40, { unit: 'ms', curve: 'log' }),
  def('decay', 'Decay', 20, 3000, 350, { unit: 'ms', curve: 'log' }),
  def('noise', 'Noise', 0, 1, 0.2),
  def('noiseDecay', 'Noise decay', 5, 1500, 120, { unit: 'ms', curve: 'log' }),
  def('noiseColor', 'Noise color', 0, 1, 0.5),
  def('click', 'Click', 0, 1, 0.3),
  def('tone', 'Tone', 0, 1, 0.6),
  def('drive', 'Drive', 0, 1, 0.2),
  def('gain', 'Gain', 0, 1.5, 1),
  def('poly', 'Polyphony', 1, 16, 8, { int: true }),
  bool('ignoreOff', 'Ignore note off', 1),
];
export const meta = { id: 'drums', name: 'Drum synth', kind: 'drums', rootDefault: 60 };
export const paramMap = schemaMap(schema);

// Starting points per type so switching the type gives a sensible sound.
export const TYPE_PRESETS = {
  0: { pitch: 0, pitchEnv: 0.55, pitchDecay: 45, decay: 380, noise: 0.15, noiseDecay: 25, noiseColor: 0.6, click: 0.35, tone: 0.6, drive: 0.25 },
  1: { pitch: 0, pitchEnv: 0.25, pitchDecay: 30, decay: 220, noise: 0.7, noiseDecay: 160, noiseColor: 0.55, click: 0.3, tone: 0.55, drive: 0.1 },
  2: { pitch: 0, pitchEnv: 0, pitchDecay: 10, decay: 60, noise: 0.5, noiseDecay: 60, noiseColor: 0.8, click: 0.1, tone: 0.7, drive: 0 },
  3: { pitch: 0, pitchEnv: 0.35, pitchDecay: 80, decay: 450, noise: 0.08, noiseDecay: 30, noiseColor: 0.4, click: 0.2, tone: 0.5, drive: 0.1 },
};

class DVoice {
  constructor() { this.alive = false; this.bq = new Biquad(); this.bq2 = new Biquad(); this.noise = new Noise(1); this.ph = [0, 0, 0, 0, 0, 0]; }
}

export class DrumSynth {
  constructor(sr) {
    this.sr = sr;
    this.p = defaults(schema);
    this.voices = [];
    for (let i = 0; i < 20; i++) this.voices.push(new DVoice());
    this.counter = 0;
  }

  get active() { for (const v of this.voices) if (v.alive) return true; return false; }
  setParam(id, v) { this.p[id] = v; }
  allOff() { for (const v of this.voices) v.alive = false; }
  chokeAll() { for (const v of this.voices) if (v.alive && !v.kill) v.kill = 1; }
  noteOff() {}

  noteOn(ev) {
    const p = this.p, sr = this.sr;
    let v = null, n = 0, oldest = null;
    for (const x of this.voices) {
      if (x.alive) { n++; if (!oldest || x.time < oldest.time) oldest = x; } else if (!v) v = x;
    }
    if (!v || n >= p.poly) { if (!oldest) return; v = oldest; }
    v.alive = true; v.kill = 0; v.time = ++this.counter;
    v.t = 0; v.type = p.type;
    v.vel = clamp(ev.vel, 0, 1);
    v.pan = ev.pan || 0;
    const semis = p.pitch + (ev.key - 60) + (ev.fine || 0) / 100;
    v.pitchMul = Math.pow(2, semis / 12);
    v.noise.s = (0x9e3779b9 ^ (this.counter * 2654435761)) >>> 0 || 1;
    v.ph.fill(0);
    v.lp1 = 0; v.lp2 = 0;
    // base frequencies per type
    const base = [48, 190, 0, 105][v.type];
    v.f0 = base * v.pitchMul;
    v.f1 = base * v.pitchMul * Math.pow(2, p.pitchEnv * 4);
    v.pCo = Math.exp(-4.6 / Math.max(p.pitchDecay * 0.001 * sr, 1));
    v.ampK = Math.exp(-4.6 / Math.max(p.decay * 0.001 * sr, 1));
    v.noiseK = Math.exp(-4.6 / Math.max(p.noiseDecay * 0.001 * sr, 1));
    v.amp = 1; v.nAmp = 1; v.pEnv = 1;
    v.clickLeft = Math.floor(0.0025 * sr);
    // tone filter on the noise (colour) and on the output (tone)
    const color = p.noiseColor;
    const fc = 200 * Math.pow(60, color); // 200 Hz .. 12 kHz
    v.bq.set(v.type === 2 ? 'hp' : 'bp', sr, v.type === 2 ? 5000 + 5000 * p.tone : fc, v.type === 2 ? 0.7 : 0.9);
    v.bq2.set('lp', sr, 800 * Math.pow(25, p.tone), 0.7);
    v.bq.reset(); v.bq2.reset();
    v.gl = Math.cos((clamp(v.pan, -1, 1) + 1) * 0.7853981634) * 1.41421356;
    v.gr = Math.sin((clamp(v.pan, -1, 1) + 1) * 0.7853981634) * 1.41421356;
  }

  process(L, R, i0, i1) {
    const p = this.p, sr = this.sr;
    const drive = 1 + p.drive * 8, noiseAmt = p.noise, click = p.click, gain = p.gain;
    const hatFreqs = [205.3, 304.4, 369.6, 522.7, 540, 800];
    for (const v of this.voices) {
      if (!v.alive) continue;
      const type = v.type;
      for (let i = i0; i < i1; i++) {
        const f = v.f0 + (v.f1 - v.f0) * v.pEnv;
        let s = 0;
        const dt = f / sr;
        if (type === 0 || type === 3) {
          v.ph[0] += dt; if (v.ph[0] >= 1) v.ph[0] -= 1;
          s = Math.sin(TAU * v.ph[0]) * v.amp;
          if (type === 3) { // tom: add a soft second partial
            v.ph[1] += dt * 1.58; if (v.ph[1] >= 1) v.ph[1] -= 1;
            s += Math.sin(TAU * v.ph[1]) * v.amp * v.amp * 0.25;
          }
        } else if (type === 1) { // snare: two tones
          v.ph[0] += dt; if (v.ph[0] >= 1) v.ph[0] -= 1;
          v.ph[1] += dt * 1.73; if (v.ph[1] >= 1) v.ph[1] -= 1;
          s = (Math.sin(TAU * v.ph[0]) * 0.7 + Math.sin(TAU * v.ph[1]) * 0.35) * v.amp;
        } else { // hat: six detuned square oscillators
          let m = 0;
          const k = v.pitchMul * (1 + p.tone * 0.3);
          for (let o = 0; o < 6; o++) {
            v.ph[o] += (hatFreqs[o] * k) / sr; if (v.ph[o] >= 1) v.ph[o] -= 1;
            m += v.ph[o] < 0.5 ? 1 : -1;
          }
          s = (m / 6) * v.amp * 0.6;
        }
        // noise layer
        let nz = v.noise.next();
        nz = v.bq.process(nz) * v.nAmp * noiseAmt * (type === 2 ? 1.6 : 2.2);
        s += nz;
        // click transient
        if (v.clickLeft > 0) {
          s += v.noise.next() * click * (v.clickLeft / (0.0025 * sr)) * 0.9;
          v.clickLeft--;
        }
        s = v.bq2.process(s);
        s = fastTanh(s * drive) / (drive > 1 ? Math.sqrt(drive) : 1);
        // envelopes
        v.amp *= v.ampK; v.nAmp *= v.noiseK;
        v.pEnv *= v.pCo;
        let g = v.vel * gain;
        if (v.kill) { v.kill -= 1 / (0.004 * sr); if (v.kill <= 0) { v.alive = false; break; } g *= v.kill; }
        L[i] += s * g * v.gl;
        R[i] += s * g * v.gr;
        if (v.amp < 0.0003 && v.nAmp * noiseAmt < 0.0003 && v.clickLeft <= 0) { v.alive = false; break; }
      }
    }
  }
}

export function create(sr) { return new DrumSynth(sr); }

// Offline one-shot render for the factory pack: returns Float32Array mono.
export function renderOneShot(sr, params, seconds = 1.2, key = 60) {
  const d = new DrumSynth(sr);
  for (const [k, v] of Object.entries(params)) d.setParam(k, v);
  const n = Math.floor(seconds * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  d.noteOn({ key, vel: 1, pan: 0 });
  d.process(L, R, 0, n);
  let end = n - 1;
  while (end > 0 && Math.abs(L[end]) < 1e-4) end--;
  const out = new Float32Array(Math.min(n, end + 64));
  const fade = Math.min(out.length, 256);
  for (let i = 0; i < out.length; i++) {
    let x = L[i];
    const left = out.length - 1 - i;
    if (left < fade) x *= left / fade;
    out[i] = x;
  }
  return out;
}
