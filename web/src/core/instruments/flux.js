// Flux: a preset synth. Pick a sound from the library (basses, leads, pads, keys, plucks, brass, bells, effects) and
// shape it with eight macro knobs; each macro moves several settings of the sound at once (Brightness opens the filter,
// Space adds reverb and delay, and so on). Underneath is the Sub Synth engine with a built-in chorus, delay and reverb.
// The macros sit at the middle (0.5) for the preset as designed; turning one moves its settings down or up from there.
import { def, choice, defaults, schemaMap } from '../schema.js';
import { schema as SUB_SCHEMA, create as createSub } from './subsynth.js';
import { create as createReverb } from '../effects/reverb.js';
import { create as createDelay } from '../effects/delay.js';
import { createChorus } from '../effects/modulation.js';
import { clamp } from '../dsp.js';

// ------------------------------------------------------------------------------------------------ macros
// a target: [setting, how, down, up] — how: 'oct' doubles a frequency per unit, 'mul' doubles a time per unit, 'add' adds
const M = {
  bright: ['Brightness', [['cutoff', 'oct', -3, 2.5], ['fenv', 'add', -0.15, 0.2]]],
  res: ['Resonance', [['res', 'add', -0.2, 0.6]]],
  attack: ['Attack', [['aa', 'mul', -2, 7], ['fa', 'mul', -2, 6]]],
  release: ['Release', [['ar', 'mul', -3, 4], ['fr', 'mul', -3, 4]]],
  move: ['Movement', [['l1cut', 'add', -1.5, 3], ['l1amp', 'add', -0.3, 0.3]]],
  width: ['Width', [['unidet', 'add', -18, 40], ['unispread', 'add', -0.6, 0.3]]],
  space: ['Space', [['fx.reverb', 'add', -0.5, 0.6], ['fx.delay', 'add', -0.4, 0.45]]],
  chorus: ['Chorus', [['fx.chorus', 'add', -0.6, 0.7]]],
  decay: ['Decay', [['ad', 'mul', -2.5, 3], ['fd', 'mul', -2.5, 3]]],
  sub: ['Sub', [['o2level', 'add', -0.6, 0.5]]],
  drive: ['Punch', [['fenv', 'add', -0.3, 0.5], ['fd', 'mul', -1.5, 0.5]]],
  vibrato: ['Vibrato', [['l2pitch', 'add', -0.3, 0.6]]],
  glide: ['Glide', [['glide', 'add', -200, 400]]],
  noise: ['Air', [['noise', 'add', -0.2, 0.35]]],
};
const DEFAULT_MACROS = ['bright', 'res', 'attack', 'release', 'move', 'width', 'space', 'chorus'];

// ------------------------------------------------------------------------------------------------ presets
// s: Sub Synth settings that differ from its defaults; fx: chorus / delay / reverb amounts 0..1 (+ delay division)
const P = (name, cat, s, fx = {}, macros = DEFAULT_MACROS) => ({ name, cat, s, fx: { chorus: 0, delay: 0, reverb: 0.15, div: 5, fb: 0.35, decay: 2.2, ...fx }, macros });
const SAW = 0, SQR = 1, TRI = 2, SIN = 3, NOISE = 4;
const LP12 = 0, LP24 = 1, HP = 2, BP = 3;
export const PRESETS = [
  P('Warm Pad', 'Pads', { o1wave: SAW, o2wave: SAW, o2fine: -9, o2level: 0.6, cutoff: 1400, res: 0.15, fenv: 0.2, aa: 0.9, ad: 1.5, as: 0.85, ar: 1.8, fa: 1.2, fd: 2, fs: 0.6, fr: 1.5, uni: 4, unidet: 22, l1rate: 0.25, l1cut: 0.4, gain: 0.55 }, { chorus: 0.5, reverb: 0.55, delay: 0.15, decay: 4 }),
  P('Glass Pad', 'Pads', { o1wave: TRI, o2wave: SIN, o2oct: 1, o2level: 0.4, ftype: LP12, cutoff: 5200, res: 0.25, fenv: 0, aa: 1.4, ad: 2, as: 0.8, ar: 2.5, uni: 3, unidet: 12, l1rate: 0.15, l1amp: 0.15, gain: 0.6 }, { chorus: 0.6, reverb: 0.7, delay: 0.25, decay: 6 }),
  P('Dark Choir', 'Pads', { o1wave: SAW, o2wave: TRI, o2oct: -1, o2level: 0.5, ftype: BP, cutoff: 900, res: 0.45, fenv: 0.1, aa: 1.2, ad: 1, as: 0.9, ar: 2, uni: 5, unidet: 15, unispread: 0.9, l1rate: 0.3, l1cut: 0.6, noise: 0.05, gain: 0.7 }, { chorus: 0.7, reverb: 0.6, decay: 5 }, ['bright', 'res', 'attack', 'release', 'move', 'width', 'space', 'noise']),
  P('Sunrise Strings', 'Pads', { o1wave: SAW, o2wave: SAW, o2fine: 12, o2level: 0.7, ftype: LP12, cutoff: 3200, res: 0.1, fenv: 0.15, aa: 0.45, ad: 1, as: 0.9, ar: 0.9, uni: 6, unidet: 18, l2rate: 5.2, l2pitch: 0.08, l2fade: 0.6, gain: 0.38 }, { chorus: 0.4, reverb: 0.45, decay: 3 }, ['bright', 'res', 'attack', 'release', 'vibrato', 'width', 'space', 'chorus']),
  P('Supersaw Lead', 'Leads', { o1wave: SAW, o2wave: SAW, o2fine: 5, o2level: 0.7, cutoff: 6000, res: 0.15, fenv: 0.15, aa: 0.003, ad: 0.6, as: 0.8, ar: 0.3, uni: 7, unidet: 28, unispread: 0.8, gain: 0.45 }, { chorus: 0.2, delay: 0.35, reverb: 0.3, div: 4 }),
  P('Square Lead', 'Leads', { o1wave: SQR, o2wave: SQR, o2oct: 1, o2level: 0.25, o1pw: 0.4, cutoff: 4200, res: 0.2, fenv: 0.25, aa: 0.002, ad: 0.3, as: 0.7, ar: 0.15, l2rate: 5.5, l2pitch: 0.1, l2fade: 0.4, mono: 1, glide: 60, gain: 0.5 }, { delay: 0.3, reverb: 0.2, div: 5 }, ['bright', 'res', 'attack', 'release', 'vibrato', 'glide', 'space', 'chorus']),
  P('Soft Sine Lead', 'Leads', { o1wave: SIN, o2wave: TRI, o2oct: 1, o2level: 0.2, ftype: LP12, cutoff: 3500, res: 0, fenv: 0, aa: 0.02, ad: 0.5, as: 0.9, ar: 0.35, l2rate: 5, l2pitch: 0.15, l2fade: 0.5, gain: 0.75 }, { delay: 0.4, reverb: 0.35, div: 6 }, ['bright', 'res', 'attack', 'release', 'vibrato', 'glide', 'space', 'chorus']),
  P('Acid Line', 'Leads', { o1wave: SAW, o2level: 0, ftype: LP24, cutoff: 420, res: 0.62, fenv: 0.7, fa: 0.001, fd: 0.18, fs: 0, fr: 0.1, aa: 0.001, ad: 0.25, as: 0.6, ar: 0.06, mono: 1, legato: 1, glide: 45, gain: 0.16 }, { delay: 0.2, reverb: 0.05, div: 3 }, ['bright', 'res', 'drive', 'decay', 'glide', 'width', 'space', 'chorus']),
  P('Deep Sub', 'Basses', { o1wave: SIN, o2wave: TRI, o2oct: 0, o2level: 0.25, ftype: LP12, cutoff: 600, res: 0, fenv: 0.1, aa: 0.003, ad: 0.5, as: 0.9, ar: 0.12, mono: 1, glide: 20, gain: 0.95 }, { reverb: 0 }, ['bright', 'res', 'attack', 'release', 'sub', 'glide', 'drive', 'chorus']),
  P('Reese Bass', 'Basses', { o1wave: SAW, o2wave: SAW, o2fine: 22, o2level: 0.8, cutoff: 900, res: 0.25, fenv: 0.1, aa: 0.004, ad: 0.6, as: 0.9, ar: 0.15, uni: 3, unidet: 14, unispread: 0.3, l1rate: 0.35, l1cut: 0.5, mono: 1, gain: 0.4 }, { reverb: 0.05 }, ['bright', 'res', 'attack', 'release', 'move', 'width', 'sub', 'chorus']),
  P('Pluck Bass', 'Basses', { o1wave: SQR, o2wave: SIN, o2oct: -1, o2level: 0.6, cutoff: 500, res: 0.3, fenv: 0.6, fa: 0.001, fd: 0.15, fs: 0.05, aa: 0.001, ad: 0.3, as: 0.3, ar: 0.08, mono: 1, gain: 0.5 }, { reverb: 0.03 }, ['bright', 'res', 'drive', 'decay', 'sub', 'glide', 'space', 'chorus']),
  P('Wobble Bass', 'Basses', { o1wave: SAW, o2wave: SQR, o2oct: -1, o2level: 0.6, cutoff: 700, res: 0.4, fenv: 0, aa: 0.003, ad: 0.5, as: 1, ar: 0.1, l1sync: 1, l1div: 5, l1cut: 2.5, mono: 1, gain: 0.2 }, { reverb: 0.05 }, ['bright', 'res', 'attack', 'release', 'move', 'width', 'sub', 'chorus']),
  P('Electric Piano', 'Keys', { o1wave: SIN, o2wave: SIN, o2oct: 2, o2level: 0.18, ftype: LP12, cutoff: 3800, res: 0, fenv: 0.2, fa: 0.001, fd: 0.6, fs: 0.2, aa: 0.002, ad: 1.6, as: 0.2, ar: 0.35, l1rate: 4.5, l1amp: 0.18, gain: 0.85 }, { chorus: 0.35, reverb: 0.3 }, ['bright', 'res', 'attack', 'release', 'move', 'decay', 'space', 'chorus']),
  P('Bright Keys', 'Keys', { o1wave: TRI, o2wave: SQR, o2oct: 1, o2level: 0.2, o2pw: 0.3, ftype: LP12, cutoff: 5000, res: 0.1, fenv: 0.3, fa: 0.001, fd: 0.4, fs: 0.3, aa: 0.002, ad: 1.1, as: 0.35, ar: 0.3, gain: 0.7 }, { chorus: 0.25, reverb: 0.3, delay: 0.1 }, ['bright', 'res', 'attack', 'release', 'decay', 'width', 'space', 'chorus']),
  P('Organ Pad', 'Keys', { o1wave: SIN, o2wave: SIN, o2oct: 1, o2level: 0.6, ftype: LP12, cutoff: 6000, res: 0, fenv: 0, aa: 0.01, ad: 0.5, as: 1, ar: 0.2, l1rate: 6, l1amp: 0.12, gain: 0.6 }, { chorus: 0.55, reverb: 0.35 }),
  P('Glass Pluck', 'Plucks', { o1wave: TRI, o2wave: SIN, o2oct: 1, o2level: 0.5, ftype: LP12, cutoff: 2400, res: 0.2, fenv: 0.55, fa: 0.001, fd: 0.25, fs: 0, aa: 0.001, ad: 0.45, as: 0, ar: 0.3, gain: 0.8 }, { delay: 0.35, reverb: 0.35, div: 6 }, ['bright', 'res', 'decay', 'release', 'move', 'width', 'space', 'chorus']),
  P('Future Pluck', 'Plucks', { o1wave: SAW, o2wave: SAW, o2fine: 10, o2level: 0.7, cutoff: 1100, res: 0.25, fenv: 0.75, fa: 0.001, fd: 0.2, fs: 0, aa: 0.001, ad: 0.35, as: 0, ar: 0.25, uni: 5, unidet: 20, gain: 0.55 }, { delay: 0.3, reverb: 0.4, div: 5 }, ['bright', 'res', 'decay', 'release', 'move', 'width', 'space', 'chorus']),
  P('Marimba', 'Plucks', { o1wave: SIN, o2wave: SIN, o2oct: 2, o2semi: 0, o2level: 0.25, ftype: LP12, cutoff: 4000, res: 0, fenv: 0, aa: 0.001, ad: 0.35, as: 0, ar: 0.25, gain: 0.95 }, { reverb: 0.25 }, ['bright', 'res', 'decay', 'release', 'move', 'width', 'space', 'chorus']),
  P('Brass Section', 'Brass', { o1wave: SAW, o2wave: SAW, o2fine: -6, o2level: 0.7, cutoff: 900, res: 0.1, fenv: 0.55, fa: 0.06, fd: 0.4, fs: 0.5, aa: 0.04, ad: 0.5, as: 0.85, ar: 0.25, uni: 3, unidet: 10, l2rate: 5.5, l2pitch: 0.05, l2fade: 0.5, gain: 0.55 }, { reverb: 0.3 }, ['bright', 'res', 'attack', 'release', 'vibrato', 'width', 'space', 'chorus']),
  P('Synth Horn', 'Brass', { o1wave: SQR, o1pw: 0.35, o2wave: SAW, o2level: 0.5, cutoff: 1300, res: 0.2, fenv: 0.45, fa: 0.03, fd: 0.3, fs: 0.4, aa: 0.02, ad: 0.4, as: 0.8, ar: 0.2, gain: 0.55 }, { reverb: 0.25, delay: 0.15 }),
  P('Crystal Bell', 'Bells', { o1wave: SIN, o2wave: SIN, o2oct: 1, o2semi: 7, o2fine: 3, o2level: 0.45, ftype: LP12, cutoff: 8000, res: 0, fenv: 0, aa: 0.001, ad: 2.2, as: 0, ar: 1.8, gain: 0.7 }, { reverb: 0.55, delay: 0.25, decay: 4, div: 6 }, ['bright', 'res', 'decay', 'release', 'move', 'width', 'space', 'chorus']),
  P('Music Box', 'Bells', { o1wave: TRI, o2wave: SIN, o2oct: 2, o2level: 0.3, ftype: LP12, cutoff: 6000, res: 0, fenv: 0, aa: 0.001, ad: 0.9, as: 0, ar: 0.8, gain: 0.8 }, { reverb: 0.45, chorus: 0.2, decay: 3 }, ['bright', 'res', 'decay', 'release', 'move', 'width', 'space', 'chorus']),
  P('Rising Sweep', 'Effects', { o1wave: NOISE, o1level: 0.5, o2wave: SAW, o2level: 0.3, ftype: BP, cutoff: 300, res: 0.6, fenv: 0.9, fa: 3, fd: 0.5, fs: 1, aa: 1.5, ad: 1, as: 1, ar: 1.5, gain: 0.6 }, { reverb: 0.6, delay: 0.3, decay: 5 }, ['bright', 'res', 'attack', 'release', 'move', 'width', 'space', 'noise']),
  P('Laser Zap', 'Effects', { o1wave: SAW, o2wave: SQR, o2level: 0.4, cutoff: 9000, res: 0.5, fenv: -0.8, fa: 0.001, fd: 0.2, fs: 0, aa: 0.001, ad: 0.25, as: 0, ar: 0.2, l1rate: 12, l1pitch: 3, gain: 0.45 }, { delay: 0.3, reverb: 0.2, div: 2 }, ['bright', 'res', 'decay', 'release', 'move', 'width', 'space', 'chorus']),
];
export const PRESET_NAMES = PRESETS.map((p) => p.name);
export const CATEGORIES = [...new Set(PRESETS.map((p) => p.cat))];
export const macroNames = (preset) => (PRESETS[preset] || PRESETS[0]).macros.map((k) => M[k][0]);

export const schema = [
  choice('preset', 'Preset', PRESET_NAMES, 0, { group: 'Sound' }),
  ...Array.from({ length: 8 }, (_, i) => def(`m${i + 1}`, `Macro ${i + 1}`, 0, 1, 0.5, { group: 'Macros' })),
  def('gain', 'Volume', 0, 1.5, 1, { group: 'Sound' }),
];
export const meta = { id: 'flux', name: 'Flux', kind: 'synth', rootDefault: 60, description: 'Preset synth: pick a sound, shape it with eight macro knobs' };
export const paramMap = schemaMap(schema);

const SUB = schemaMap(SUB_SCHEMA);
const SUB_DEFAULTS = defaults(SUB_SCHEMA);

// the Sub Synth settings and effect amounts for a preset with the macros at the given positions
export function resolve(preset, macros) {
  const pr = PRESETS[preset] || PRESETS[0];
  const s = { ...SUB_DEFAULTS, ...pr.s };
  const fx = { ...pr.fx };
  pr.macros.forEach((k, i) => {
    const m = macros[i] === undefined ? 0.5 : macros[i];
    const amt = m < 0.5 ? (m - 0.5) * 2 : (m - 0.5) * 2;        // -1..1
    for (const [id, how, down, up] of M[k][1]) {
      const d = amt < 0 ? -amt * down : amt * up;
      if (id.startsWith('fx.')) { const f = id.slice(3); fx[f] = clamp(fx[f] + d, 0, 1); continue; }
      const sd = SUB.get(id);
      if (!sd) continue;
      let v = s[id];
      if (how === 'oct' || how === 'mul') v *= Math.pow(2, d); else v += d;
      s[id] = clamp(v, sd.min, sd.max);
    }
  });
  return { s, fx };
}

const dB = (amt) => (amt <= 0.001 ? -60 : -30 + 30 * Math.sqrt(amt));    // effect amount → wet level

class Flux {
  constructor(sr, host) {
    this.sr = sr; this.host = host;
    this.p = defaults(schema);
    this.engine = createSub(sr, host);
    this.chorus = createChorus(sr); this.delay = createDelay(sr, host); this.reverb = createReverb(sr);
    this.fx = { chorus: 0, delay: 0, reverb: 0 };
    this.bufL = new Float32Array(128); this.bufR = new Float32Array(128);
    this.tail = 0;              // samples of effect tail still to play after the last voice ended
    this.dirty = true;
  }
  get active() { return this.engine.active || this.tail > 0; }
  setParam(id, v) { this.p[id] = v; this.dirty = true; }
  _apply() {
    this.dirty = false;
    const macros = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => this.p[`m${i}`]);
    const { s, fx } = resolve(this.p.preset, macros);
    for (const k in s) this.engine.setParam(k, s[k]);
    this.engine.setParam('gain', s.gain * this.p.gain);
    this.fx = fx;
    const c = this.chorus; c.setParam('dry', 0); c.setParam('wet', dB(fx.chorus) - 3); c.setParam('depth', 0.55);
    const d = this.delay; d.setParam('sync', 1); d.setParam('division', fx.div); d.setParam('feedback', fx.fb); d.setParam('pingpong', 1); d.setParam('dry', 0); d.setParam('wet', dB(fx.delay) - 4);
    const r = this.reverb; r.setParam('decay', fx.decay); r.setParam('dry', 0); r.setParam('wet', dB(fx.reverb) - 2);
    // how long the effects ring after the notes stop
    this.tailLen = Math.round(this.sr * Math.min(12, (fx.reverb > 0.001 ? fx.decay : 0) + (fx.delay > 0.001 ? 2.5 : 0) + 0.1));
  }
  allOff() { this.engine.allOff(); this.tail = 0; }
  chokeAll() { this.engine.chokeAll(); }
  noteOn(ev) { if (this.dirty) this._apply(); this.engine.noteOn(ev); }
  noteOff(key) { this.engine.noteOff(key); }
  process(L, R, i0, i1) {
    if (this.dirty) this._apply();
    const n = i1 - i0;
    if (this.bufL.length < n) { this.bufL = new Float32Array(n); this.bufR = new Float32Array(n); }
    const bl = this.bufL.subarray(0, n), br = this.bufR.subarray(0, n);
    bl.fill(0); br.fill(0);
    if (this.engine.active) { this.engine.process(bl, br, 0, n); this.tail = this.tailLen; } else this.tail = Math.max(0, this.tail - n);
    const fx = this.fx;
    if (fx.chorus > 0.001) this.chorus.process(bl, br, n);
    if (fx.delay > 0.001) this.delay.process(bl, br, n);
    if (fx.reverb > 0.001) this.reverb.process(bl, br, n);
    for (let i = 0; i < n; i++) { L[i0 + i] += bl[i]; R[i0 + i] += br[i]; }
  }
}

export function create(sr, host) { return new Flux(sr, host); }
