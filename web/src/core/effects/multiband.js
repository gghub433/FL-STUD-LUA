// Multiband compressor: 3 bands split by Linkwitz-Riley (LR4) crossovers, a compressor per
// band and a brick-wall style output limiter. The low band is passed through the allpass
// equivalent of the second crossover so the bands sum back flat.
import { def, defaults } from '../schema.js';
import { Biquad, dbToGain } from '../dsp.js';

const BANDS = ['low', 'mid', 'high'];
export const schema = [
  def('xLow', 'Crossover low/mid', 40, 1000, 180, { unit: 'Hz', curve: 'log', group: 'Main' }),
  def('xHigh', 'Crossover mid/high', 800, 12000, 3200, { unit: 'Hz', curve: 'log', group: 'Main' }),
  def('limit', 'Output limit', -12, 0, -0.5, { unit: 'dB', group: 'Main' }),
  def('limitRel', 'Limiter release', 10, 500, 60, { unit: 'ms', curve: 'log', group: 'Main' }),
  def('out', 'Output gain', -12, 12, 0, { unit: 'dB', group: 'Main' }),
];
for (const b of BANDS) {
  const g = `Band ${b}`;
  schema.push(
    def(`${b}Th`, `${b} threshold`, -60, 0, -20, { unit: 'dB', group: g }),
    def(`${b}Ratio`, `${b} ratio`, 1, 20, 3, { curve: 'log', group: g }),
    def(`${b}Att`, `${b} attack`, 0.1, 100, 10, { unit: 'ms', curve: 'log', group: g }),
    def(`${b}Rel`, `${b} release`, 10, 1500, 140, { unit: 'ms', curve: 'log', group: g }),
    def(`${b}Gain`, `${b} gain`, -12, 12, 0, { unit: 'dB', group: g }),
  );
}

export const meta = { id: 'multiband', name: 'Multiband Compressor', category: 'Dynamics', description: '3-band compressor with output limiter' };

// LR4 = two cascaded 2nd-order Butterworth sections
class LR4 {
  constructor() { this.a = new Biquad(); this.b = new Biquad(); }
  set(type, sr, f) { this.a.set(type, sr, f, 0.7071); this.b.set(type, sr, f, 0.7071); }
  process(x) { return this.b.process(this.a.process(x)); }
  reset() { this.a.reset(); this.b.reset(); }
}

class Chan {
  constructor() {
    this.lp1 = new LR4(); this.hp1 = new LR4(); this.lp2 = new LR4(); this.hp2 = new LR4();
    this.apL = new LR4(); this.apH = new LR4();       // allpass pair on the low band
  }
}

class Multiband {
  constructor(sr) {
    this.sr = sr;
    this.p = defaults(schema);
    this.ch = [new Chan(), new Chan()];
    this.dirty = true;
    this.gr = [0, 0, 0];
    this.limG = 1;
    this.bb = [[0, 0, 0], [0, 0, 0]];
    this.meters = [0, 0, 0, 0];
  }
  setParam(id, v) { this.p[id] = v; if (id === 'xLow' || id === 'xHigh') this.dirty = true; }
  reset() { for (const c of this.ch) for (const k in c) c[k].reset(); this.gr = [0, 0, 0]; this.limG = 1; }

  configure() {
    const { sr, p } = this;
    for (const c of this.ch) {
      c.lp1.set('lp', sr, p.xLow); c.hp1.set('hp', sr, p.xLow);
      c.lp2.set('lp', sr, p.xHigh); c.hp2.set('hp', sr, p.xHigh);
      c.apL.set('lp', sr, p.xHigh); c.apH.set('hp', sr, p.xHigh);
    }
    this.dirty = false;
  }

  process(L, R, n) {
    if (this.dirty) this.configure();
    const p = this.p, sr = this.sr;
    const co = BANDS.map((b) => ({
      th: p[`${b}Th`], slope: 1 / p[`${b}Ratio`] - 1,
      a: Math.exp(-1 / (p[`${b}Att`] * 0.001 * sr)), r: Math.exp(-1 / (p[`${b}Rel`] * 0.001 * sr)),
      gain: dbToGain(p[`${b}Gain`]),
    }));
    const outG = dbToGain(p.out), lim = dbToGain(p.limit);
    const limR = Math.exp(-1 / (p.limitRel * 0.001 * sr));
    const gr = this.gr;
    let limG = this.limG, minLim = 1;
    const bb = this.bb;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) {
        const x = c === 0 ? L[i] : R[i];
        const ch = this.ch[c];
        const low = ch.lp1.process(x), rest = ch.hp1.process(x);
        bb[c][0] = ch.apL.process(low) + ch.apH.process(low); // phase-align the low band
        bb[c][1] = ch.lp2.process(rest);
        bb[c][2] = ch.hp2.process(rest);
      }
      let sl = 0, sr_ = 0;
      for (let b = 0; b < 3; b++) {
        const lv = Math.max(Math.abs(bb[0][b]), Math.abs(bb[1][b]));
        const db = 20 * Math.log10(lv + 1e-9);
        const over = db - co[b].th;
        const target = over > 0 ? co[b].slope * over : 0;
        gr[b] = target < gr[b] ? co[b].a * gr[b] + (1 - co[b].a) * target : co[b].r * gr[b] + (1 - co[b].r) * target;
        const g = Math.pow(10, gr[b] / 20) * co[b].gain;
        sl += bb[0][b] * g; sr_ += bb[1][b] * g;
      }
      sl *= outG; sr_ *= outG;
      // output limiter (instant attack, smooth release)
      const pk = Math.max(Math.abs(sl), Math.abs(sr_));
      const need = pk > lim ? lim / pk : 1;
      limG = need < limG ? need : limR * limG + (1 - limR) * need;
      if (limG > 1) limG = 1;
      L[i] = sl * limG; R[i] = sr_ * limG;
      if (limG < minLim) minLim = limG;
    }
    this.limG = limG;
    this.meters[0] = gr[0]; this.meters[1] = gr[1]; this.meters[2] = gr[2];
    this.meters[3] = 20 * Math.log10(minLim + 1e-9);
  }
}

export function create(sr) { return new Multiband(sr); }
