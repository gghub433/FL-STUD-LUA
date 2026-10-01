// FM synthesizer: 6 sine-based operators, a full 6x6 modulation matrix (+ per-operator feedback),
// per-operator ADSR, ratio/fixed-frequency tuning, velocity sensitivity and selectable waveform.
// The matrix is either one of the built-in algorithms or "Custom" (edited entry by entry).
import { def, bool, choice, defaults, schemaMap } from '../schema.js';
import { ADSR, mtof, timeCoef, TAU, clamp } from '../dsp.js';

export const OPS = 6;
export const OP_WAVES = ['Sine', 'Half sine', 'Abs sine', 'Quarter sine', 'Saw-ish'];

// [name, mods: [[modulator, carrier], ...], carriers: [...]]  (operators numbered 1..6)
export const ALGOS = [
  ['Serial 6>5>4>3>2>1', [[6, 5], [5, 4], [4, 3], [3, 2], [2, 1]], [1]],
  ['Two stacks (6>5>4) + (3>2>1)', [[6, 5], [5, 4], [3, 2], [2, 1]], [4, 1]],
  ['Three pairs 6>5, 4>3, 2>1', [[6, 5], [4, 3], [2, 1]], [5, 3, 1]],
  ['Chain 6>5>4>3 + 2 + 1', [[6, 5], [5, 4], [4, 3]], [3, 2, 1]],
  ['One modulator, five carriers', [[6, 1], [6, 2], [6, 3], [6, 4], [6, 5]], [1, 2, 3, 4, 5]],
  ['Fork 6>5>4>3 > (2, 1)', [[6, 5], [5, 4], [4, 3], [3, 2], [3, 1]], [1, 2]],
  ['Triple into 3', [[6, 3], [5, 3], [4, 3], [3, 2], [2, 1]], [1]],
  ['Pair into 4', [[6, 4], [5, 4], [4, 3], [3, 2], [2, 1]], [1]],
  ['Five into 1', [[2, 1], [3, 1], [4, 1], [5, 1], [6, 1]], [1]],
  ['Additive (no modulation)', [], [1, 2, 3, 4, 5, 6]],
  ['Chain 6>5>3 + 4>2>1', [[6, 5], [5, 3], [4, 2], [2, 1]], [3, 1]],
  ['Stack 6>5>4 + parallel 3,2,1', [[6, 5], [5, 4]], [4, 3, 2, 1]],
  ['Bell: 4>3 + 2>1 (bright)', [[4, 3], [2, 1], [6, 5]], [3, 1, 5]],
  ['Two into two', [[6, 4], [5, 3], [4, 2], [3, 1]], [2, 1]],
  ['Ladder 6>4>2, 5>3>1', [[6, 4], [4, 2], [5, 3], [3, 1]], [2, 1]],
  ['Brass: 2>1 + 6>5>4>3', [[2, 1], [6, 5], [5, 4], [4, 3]], [1, 3]],
];

// matrix[i][j] = how strongly operator j modulates operator i (0..1); out[i] = carrier mix (0..1)
export function algoMatrix(idx) {
  const m = Array.from({ length: OPS }, () => new Array(OPS).fill(0));
  const out = new Array(OPS).fill(0);
  const a = ALGOS[idx];
  if (!a) return { m, out };
  for (const [mod, car] of a[1]) m[car - 1][mod - 1] = 1;
  for (const c of a[2]) out[c - 1] = 1;
  return { m, out };
}

const algoNames = [...ALGOS.map((a, i) => `${i + 1}. ${a[0]}`), 'Custom'];

function opParams(i) {
  const g = `Op ${i}`;
  return [
    def(`ratio${i}`, `Op ${i} ratio`, 0.125, 16, i === 1 ? 1 : [1, 1, 2, 1, 3, 1][i - 1], { curve: 'log', group: g }),
    def(`fine${i}`, `Op ${i} fine`, -50, 50, 0, { unit: 'cents', group: g }),
    bool(`fixed${i}`, `Op ${i} fixed frequency`, 0, { group: g }),
    def(`hz${i}`, `Op ${i} frequency`, 1, 8000, 440, { unit: 'Hz', curve: 'log', group: g }),
    def(`lvl${i}`, `Op ${i} level`, 0, 1, i === 1 ? 0.9 : 0.45, { group: g }),
    def(`vsens${i}`, `Op ${i} velocity sensitivity`, 0, 1, 0.5, { group: g }),
    choice(`wave${i}`, `Op ${i} wave`, OP_WAVES, 0, { group: g }),
    def(`att${i}`, `Op ${i} attack`, 0.001, 8, 0.003, { unit: 's', curve: 'pow', skew: 3, group: g }),
    def(`dec${i}`, `Op ${i} decay`, 0.001, 8, i === 1 ? 0.8 : 0.5, { unit: 's', curve: 'pow', skew: 3, group: g }),
    def(`sus${i}`, `Op ${i} sustain`, 0, 1, i === 1 ? 0.6 : 0.2, { group: g }),
    def(`rel${i}`, `Op ${i} release`, 0.001, 8, 0.25, { unit: 's', curve: 'pow', skew: 3, group: g }),
    def(`fb${i}`, `Op ${i} feedback`, 0, 1, i === 6 ? 0.15 : 0, { group: g }),
  ];
}

export const schema = [
  choice('algo', 'Algorithm', algoNames, 0, { group: 'Main' }),
  def('gain', 'Gain', 0, 1.5, 0.6, { group: 'Main' }),
  def('index', 'Modulation index', 0, 3, 1, { group: 'Main' }),
  def('vibRate', 'Vibrato rate', 0.1, 12, 5, { unit: 'Hz', curve: 'log', group: 'Main' }),
  def('vibDepth', 'Vibrato depth', 0, 100, 0, { unit: 'cents', group: 'Main' }),
  def('glide', 'Glide', 0, 1000, 0, { unit: 'ms', curve: 'pow', group: 'Main' }),
  def('poly', 'Polyphony', 1, 16, 8, { int: true, group: 'Main' }),
  ...Array.from({ length: OPS }, (_, k) => opParams(k + 1)).flat(),
];
// custom matrix + carrier outputs: used when algo === ALGOS.length ("Custom")
for (let i = 1; i <= OPS; i++) {
  for (let j = 1; j <= OPS; j++) schema.push(def(`mod${i}${j}`, `Op ${j} → op ${i}`, 0, 1, 0, { group: 'Matrix' }));
  schema.push(def(`out${i}`, `Op ${i} output`, 0, 1, i === 1 ? 1 : 0, { group: 'Matrix' }));
}

export const meta = { id: 'fm', name: 'FM Synth', kind: 'synth', rootDefault: 60, description: '6-operator FM with modulation matrix and 16 algorithms' };
export const paramMap = schemaMap(schema);

function waveFn(w, ph) {
  const x = ph - Math.floor(ph);
  switch (w) {
    case 0: return Math.sin(TAU * x);
    case 1: return x < 0.5 ? Math.sin(TAU * x) : 0;
    case 2: return Math.abs(Math.sin(TAU * x));
    case 3: return x < 0.25 || (x >= 0.5 && x < 0.75) ? Math.sin(TAU * x) : 0;
    default: return Math.sin(TAU * x) + 0.5 * Math.sin(TAU * 2 * x) + 0.33 * Math.sin(TAU * 3 * x);
  }
}

class Voice {
  constructor() {
    this.alive = false;
    this.ph = new Float64Array(OPS); this.out = new Float64Array(OPS); this.prev = new Float64Array(OPS);
    this.env = Array.from({ length: OPS }, () => new ADSR());
  }
}

export class FMSynth {
  constructor(sr, host) {
    this.sr = sr; this.host = host;
    this.p = defaults(schema);
    this.voices = Array.from({ length: 18 }, () => new Voice());
    this.counter = 0;
    this.matrix = null; this.order = null; this.outs = null; this.dirty = true;
  }

  get active() { for (const v of this.voices) if (v.alive) return true; return false; }
  setParam(id, v) { this.p[id] = v; this.dirty = true; }
  allOff() { for (const v of this.voices) v.alive = false; }
  chokeAll() { for (const v of this.voices) if (v.alive) { for (const e of v.env) e.release(); v.fast = true; } }

  // Resolve the active matrix and an evaluation order (modulators before the operators they modulate).
  rebuild() {
    const p = this.p;
    let m, out;
    if (p.algo < ALGOS.length) ({ m, out } = algoMatrix(p.algo));
    else {
      m = Array.from({ length: OPS }, (_, i) => Array.from({ length: OPS }, (_, j) => p[`mod${i + 1}${j + 1}`]));
      out = Array.from({ length: OPS }, (_, i) => p[`out${i + 1}`]);
    }
    // Kahn topological order on edges j -> i (i != j); cycles fall back to index order
    const indeg = new Array(OPS).fill(0);
    for (let i = 0; i < OPS; i++) for (let j = 0; j < OPS; j++) if (i !== j && m[i][j] > 0) indeg[i]++;
    const order = [], done = new Array(OPS).fill(false);
    for (let pass = 0; pass < OPS; pass++) {
      let progressed = false;
      for (let i = 0; i < OPS; i++) {
        if (done[i] || indeg[i] > 0) continue;
        done[i] = true; order.push(i); progressed = true;
        for (let k = 0; k < OPS; k++) if (k !== i && m[k][i] > 0) indeg[k]--;
      }
      if (!progressed) break;
    }
    for (let i = 0; i < OPS; i++) if (!done[i]) order.push(i);
    this.matrix = m; this.outs = out; this.order = order; this.dirty = false;
  }

  noteOn(ev) {
    const p = this.p;
    let v = null, n = 0, oldest = null;
    for (const x of this.voices) { if (x.alive) { n++; if (!oldest || x.time < oldest.time) oldest = x; } else if (!v) v = x; }
    if (!v || n >= p.poly) { if (!oldest) return; if (!v) v = oldest; else { oldest.fast = true; for (const e of oldest.env) e.release(); } }
    v.alive = true; v.fast = false; v.released = false;
    v.key = ev.key; v.fine = ev.fine || 0; v.vel = ev.vel; v.time = ++this.counter; v.age = 0;
    v.cur = ev.key; v.target = ev.key;
    v.ph.fill(0); v.out.fill(0); v.prev.fill(0);
    for (const e of v.env) { e.v = 0; e.trigger(); }
  }

  noteOff(key) {
    for (const v of this.voices) if (v.alive && !v.released && v.key === key) { v.released = true; for (const e of v.env) e.release(); }
  }

  process(L, R, i0, i1) {
    if (this.dirty) this.rebuild();
    const p = this.p, sr = this.sr, m = this.matrix, order = this.order, outs = this.outs;
    const idx = p.index * 5;
    const opc = [];
    for (let k = 0; k < OPS; k++) {
      const n = k + 1;
      opc.push({
        ratio: p[`ratio${n}`], fine: p[`fine${n}`] / 100, fixed: p[`fixed${n}`], hz: p[`hz${n}`], lvl: p[`lvl${n}`], vs: p[`vsens${n}`], wave: p[`wave${n}`],
        aInc: 1 / Math.max(1, p[`att${n}`] * sr), dCo: timeCoef(p[`dec${n}`], sr), sus: p[`sus${n}`], rCo: timeCoef(p[`rel${n}`], sr), fb: p[`fb${n}`],
      });
    }
    const fastCo = timeCoef(0.004, sr), gain = p.gain, vibInc = p.vibRate / sr, vibD = p.vibDepth / 100;
    const glide = p.glide * 0.001;
    for (const v of this.voices) {
      if (!v.alive) continue;
      const ph = v.ph, out = v.out, prev = v.prev;
      let vib = v.vibPh || 0;
      const incs = this._incs || (this._incs = new Float64Array(OPS));
      for (let j = i0; j < i1; j++) {
        if ((j - i0) % 16 === 0 || j === i0) {
          if (glide > 0.0005) v.cur += (v.target - v.cur) * (1 - Math.exp(-16 / (glide * sr * 0.35))); else v.cur = v.target;
          const vv = vibD > 0 ? Math.sin(TAU * vib) * vibD : 0;
          const f = mtof(v.cur + v.fine / 100 + vv);
          for (let k = 0; k < OPS; k++) incs[k] = (opc[k].fixed ? opc[k].hz * Math.pow(2, opc[k].fine / 12) : f * opc[k].ratio * Math.pow(2, opc[k].fine / 12)) / sr;
        }
        vib += vibInc; if (vib >= 1) vib -= 1;
        let mixL = 0;
        for (let oi = 0; oi < OPS; oi++) {
          const k = order[oi], c = opc[k];
          let modIn = 0;
          const row = m[k];
          for (let q = 0; q < OPS; q++) if (row[q] > 0) modIn += row[q] * (q === k ? prev[q] : out[q]);
          if (c.fb > 0) modIn += c.fb * prev[k] * 0.8;
          const e = v.env[k].next(c.aInc, c.dCo, c.sus, v.fast ? fastCo : c.rCo);
          ph[k] += incs[k]; if (ph[k] >= 1) ph[k] -= 1;
          const velScale = 1 - c.vs + c.vs * v.vel;
          const o = waveFn(c.wave, ph[k] + modIn * idx / TAU) * e * c.lvl * velScale;
          prev[k] = out[k]; out[k] = o;
          mixL += o * outs[k];
        }
        let allDone = true;
        for (let k = 0; k < OPS; k++) if (outs[k] > 0 && !v.env[k].done) allDone = false;
        if (allDone) { v.alive = false; break; }
        const s = mixL * gain * 0.35;
        L[j] += s; R[j] += s;
      }
      v.vibPh = vib;
    }
  }
}

export function create(sr, host) { return new FMSynth(sr, host); }
