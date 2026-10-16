// Polish: a one-knob enhancer. Amount 0..100 % scales a recipe chosen by the mode:
//   gentle 3-band compression (auto make-up from the slow average of the gain reduction, so the long-term level stays
//   about where it was while peaks and quiet passages move closer), soft saturation, mid/side widening of the mids
//   and highs with a tighter low end, and a tonal tilt (low / high band gains).
// A soft clipper on the output keeps every sample under -0.3 dBFS. At 0 % the effect is a true bypass; leaving 0 %
// crossfades in over a few milliseconds.
import { def, choice, defaults } from '../schema.js';
import { dbToGain, fastTanh } from '../dsp.js';
import { LR4 } from './multiband.js';

export const MODES = ['Warm', 'Bright', 'Wide', 'Punch'];
export const schema = [
  def('amount', 'Amount', 0, 100, 50, { unit: '%', step: 1 }),
  choice('mode', 'Mode', MODES, 0),
];
export const meta = { id: 'polish', name: 'Polish', category: 'Enhance', description: 'One-knob enhancer: multiband compression, saturation, width and tone' };

// per mode, at 100 %: comp = compression depth, sat = saturation, width = side boost of mids / highs,
// low / high = band gains (dB), slow = attack time scale (longer attacks let transients through)
export const RECIPES = [
  { comp: 0.6, sat: 0.8, width: 0.2, low: 2.5, high: -1.5, slow: 1 },     // Warm: thicker, rounder, a little darker
  { comp: 0.5, sat: 0.35, width: 0.4, low: -0.5, high: 3.5, slow: 1 },    // Bright: presence and air
  { comp: 0.4, sat: 0.25, width: 1, low: 0.5, high: 1.5, slow: 1 },       // Wide: open stereo image, bass kept centred
  { comp: 1, sat: 0.55, width: 0.15, low: 2, high: 1, slow: 2.5 },        // Punch: denser, slower attack keeps the hits
];

const X_LOW = 200, X_HIGH = 3200;                    // crossovers (Hz)
const THRESH = -22, KNEE = 12;                       // band compressors (dB)
const ATT = [0.025, 0.01, 0.004], REL = [0.22, 0.14, 0.09];
const MAKEUP_TIME = 1.5, MAKEUP = 0.9, MAKEUP_MAX = 8; // slow average of the gain reduction (s), the share given back, at most (dB)
export const CEILING = 0.966;                        // -0.3 dBFS
const KNEE_IN = 0.708;                               // the output clipper leaves everything below -3 dBFS alone

// soft clipper: identity below KNEE_IN, approaches CEILING smoothly above it, never reaches it
export function softClip(x) {
  const a = x < 0 ? -x : x;
  if (a <= KNEE_IN) return x;
  const y = KNEE_IN + (CEILING - KNEE_IN) * Math.tanh((a - KNEE_IN) / (CEILING - KNEE_IN));
  return x < 0 ? -y : y;
}

class Chan {
  constructor() { this.lp1 = new LR4(); this.hp1 = new LR4(); this.lp2 = new LR4(); this.hp2 = new LR4(); this.apL = new LR4(); this.apH = new LR4(); }
  reset() { for (const k in this) this[k].reset(); }
}

class Polish {
  constructor(sr) {
    this.sr = sr; this.p = defaults(schema);
    this.ch = [new Chan(), new Chan()];
    for (const c of this.ch) {
      c.lp1.set('lp', sr, X_LOW); c.hp1.set('hp', sr, X_LOW);
      c.lp2.set('lp', sr, X_HIGH); c.hp2.set('hp', sr, X_HIGH);
      c.apL.set('lp', sr, X_HIGH); c.apH.set('hp', sr, X_HIGH);
    }
    this.bL = [0, 0, 0]; this.bR = [0, 0, 0];
    this.ka = [0, 0, 0]; this.kr = REL.map((t) => 1 - Math.exp(-1 / (t * sr)));
    this.meters = [0, 0, 0];                         // net gain of the low / mid / high band (dB)
    this.s0 = {}; this.s1 = {};                      // settings of the last block and of this one (ramped across the block)
    this.reset();
  }
  setParam(id, v) { this.p[id] = v; }
  reset() {
    for (const c of this.ch) c.reset();
    this.gr = [0, 0, 0]; this.grSlow = [0, 0, 0];
    this.eng = -1;                                   // -1: start at the amount's state (fully in or out), no fade after a stop / at an export start
    this.fresh = true;
  }

  settings(a, o) {
    const r = RECIPES[this.p.mode] || RECIPES[0];
    o.slope = 1 / (1 + 1.5 * r.comp * a) - 1;        // ratio up to 2.5:1
    o.lowG = dbToGain(r.low * a); o.highG = dbToGain(r.high * a);
    o.sideHi = 1 + 0.9 * r.width * a; o.sideLo = 1 - 0.6 * r.width * a;
    o.drive = 1 + 1.5 * r.sat * a; o.satW = 0.6 * r.sat * a; o.slow = r.slow;
    return o;
  }

  process(L, R, n) {
    const a = this.p.amount / 100;
    const target = a > 0 ? 1 : 0;
    if (this.eng < 0) this.eng = target;
    if (target === 0 && this.eng === 0) return;                            // 0 %: untouched
    if (this.eng === 0) { for (const c of this.ch) c.reset(); this.gr.fill(0); this.grSlow.fill(0); this.fresh = true; }
    const sr = this.sr;
    // ramp from the last block's settings to this block's (no zipper noise while the knob or automation moves)
    const s0 = this.s1, s1 = this.settings(a, this.s0);
    this.s0 = s0; this.s1 = s1;
    if (this.fresh) { this.settings(a, s0); this.fresh = false; }
    const ka = this.ka, kr = this.kr;
    for (let b = 0; b < 3; b++) ka[b] = 1 - Math.exp(-1 / (ATT[b] * s1.slow * sr));
    const kSlow = 1 - Math.exp(-1 / (MAKEUP_TIME * sr)), kEng = 1 - Math.exp(-1 / (0.004 * sr));
    const cL = this.ch[0], cR = this.ch[1], bL = this.bL, bR = this.bR, gr = this.gr, grSlow = this.grSlow;
    let eng = this.eng;
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      const t = (i + 1) * inv;
      const slope = s0.slope + (s1.slope - s0.slope) * t;
      const lowG = s0.lowG + (s1.lowG - s0.lowG) * t, highG = s0.highG + (s1.highG - s0.highG) * t;
      const sideHi = s0.sideHi + (s1.sideHi - s0.sideHi) * t, sideLo = s0.sideLo + (s1.sideLo - s0.sideLo) * t;
      const drive = s0.drive + (s1.drive - s0.drive) * t, satW = s0.satW + (s1.satW - s0.satW) * t;
      const xl = L[i], xr = R[i];
      // three bands per side, the low one phase-aligned with the upper crossover so the bands sum flat
      let lo = cL.lp1.process(xl), rest = cL.hp1.process(xl);
      bL[0] = cL.apL.process(lo) + cL.apH.process(lo); bL[1] = cL.lp2.process(rest); bL[2] = cL.hp2.process(rest);
      lo = cR.lp1.process(xr); rest = cR.hp1.process(xr);
      bR[0] = cR.apL.process(lo) + cR.apH.process(lo); bR[1] = cR.lp2.process(rest); bR[2] = cR.hp2.process(rest);
      // band compressors (linked L/R) with the slow average of their reduction given back
      for (let b = 0; b < 3; b++) {
        const al = bL[b] < 0 ? -bL[b] : bL[b], ar = bR[b] < 0 ? -bR[b] : bR[b];
        const over = 20 * Math.log10((al > ar ? al : ar) + 1e-9) - THRESH;
        const want = over <= -KNEE / 2 ? 0 : over >= KNEE / 2 ? slope * over : (slope * (over + KNEE / 2) * (over + KNEE / 2)) / (2 * KNEE);
        gr[b] += (want - gr[b]) * (want < gr[b] ? ka[b] : kr[b]);
        grSlow[b] += (gr[b] - grSlow[b]) * kSlow;
        const net = gr[b] + Math.min(MAKEUP_MAX, -MAKEUP * grSlow[b]);
        const g = Math.pow(10, net * 0.05) * (b === 0 ? lowG : b === 2 ? highG : 1);
        bL[b] *= g; bR[b] *= g;
      }
      // width: mids and highs wider, lows narrower
      let m = (bL[0] + bR[0]) * 0.5, s = (bL[0] - bR[0]) * 0.5 * sideLo;
      let l = m + s, r = m - s;
      m = (bL[1] + bL[2] + bR[1] + bR[2]) * 0.5; s = (bL[1] + bL[2] - bR[1] - bR[2]) * 0.5 * sideHi;
      l += m + s; r += m - s;
      // saturation: unity gain for small signals, rounder peaks
      l += satW * (fastTanh(l * drive) / drive - l);
      r += satW * (fastTanh(r * drive) / drive - r);
      eng += (target - eng) * kEng;
      L[i] = softClip(xl + (l - xl) * eng);
      R[i] = softClip(xr + (r - xr) * eng);
    }
    this.eng = target === 0 && eng < 1e-4 ? 0 : target === 1 && eng > 0.9999 ? 1 : eng;
    for (let b = 0; b < 3; b++) this.meters[b] = gr[b] + Math.min(MAKEUP_MAX, -MAKEUP * grSlow[b]);
  }
}

export function create(sr) { return new Polish(sr); }
