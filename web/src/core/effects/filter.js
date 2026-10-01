// Multimode filter with tempo-syncable LFO and envelope follower modulation.
import { def, bool, choice, defaults } from '../schema.js';
import { SVF, LFO, LFO_SHAPES, SYNC_DIVS, SYNC_LABELS, fastTanh, TAU } from '../dsp.js';

export const schema = [
  choice('type', 'Type', ['Low pass', 'Band pass', 'High pass', 'Notch', 'Peak'], 0, { group: 'Filter' }),
  def('cutoff', 'Cutoff', 20, 20000, 1200, { unit: 'Hz', curve: 'log', group: 'Filter' }),
  def('res', 'Resonance', 0, 1, 0.3, { group: 'Filter' }),
  def('drive', 'Drive', 0, 24, 0, { unit: 'dB', group: 'Filter' }),
  def('lfoAmt', 'LFO amount', 0, 4, 1.2, { unit: 'oct', group: 'LFO' }),
  bool('lfoSync', 'LFO tempo sync', 1, { group: 'LFO' }),
  def('lfoRate', 'LFO rate', 0.03, 20, 1, { unit: 'Hz', curve: 'log', group: 'LFO' }),
  choice('lfoDiv', 'LFO division', SYNC_LABELS, 8, { group: 'LFO' }),
  choice('lfoShape', 'LFO shape', LFO_SHAPES, 0, { group: 'LFO' }),
  def('lfoPhase', 'Stereo phase', 0, 0.5, 0, { group: 'LFO' }),
  def('envAmt', 'Envelope follower', -4, 4, 0, { unit: 'oct', group: 'Envelope' }),
  def('envAtt', 'Env attack', 0.5, 100, 5, { unit: 'ms', curve: 'log', group: 'Envelope' }),
  def('envRel', 'Env release', 5, 1000, 120, { unit: 'ms', curve: 'log', group: 'Envelope' }),
];

export const meta = { id: 'filter', name: 'Filter', category: 'Filter', description: 'Multimode filter with LFO and envelope follower' };

class Filter {
  constructor(sr, host) {
    this.sr = sr; this.host = host; this.p = defaults(schema);
    this.f = [new SVF(), new SVF()];
    this.lfo = [new LFO(3), new LFO(4)];
    this.env = 0;
  }
  setParam(id, v) { this.p[id] = v; if (id === 'lfoShape') for (const l of this.lfo) l.shape = v; }
  reset() { for (const f of this.f) f.reset(); this.env = 0; }
  process(L, R, n) {
    const p = this.p, sr = this.sr;
    const rate = p.lfoSync ? (this.host.tempo || 120) / 60 / SYNC_DIVS[p.lfoDiv][1] : p.lfoRate;
    const inc = rate / sr;
    this.lfo[1].phase = this.lfo[0].phase + p.lfoPhase - Math.floor(this.lfo[0].phase + p.lfoPhase);
    const drive = Math.pow(10, p.drive / 20);
    const aE = Math.exp(-1 / (p.envAtt * 0.001 * sr)), rE = Math.exp(-1 / (p.envRel * 0.001 * sr));
    const CH = 8;
    for (let i = 0; i < n; i += CH) {
      const m = Math.min(CH, n - i);
      const x = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      this.env = x > this.env ? aE * this.env + (1 - aE) * x : rE * this.env + (1 - rE) * x;
      const l0 = this.lfo[0].next(inc * m), l1 = this.lfo[1].next(inc * m);
      this.lfo[1].phase = this.lfo[0].phase + p.lfoPhase; if (this.lfo[1].phase >= 1) this.lfo[1].phase -= 1;
      const e = Math.min(1, this.env * 3);
      for (let c = 0; c < 2; c++) {
        const mod = (c === 0 ? l0 : l1) * p.lfoAmt + e * p.envAmt;
        this.f[c].setup(sr, p.cutoff * Math.pow(2, mod), p.res);
      }
      for (let k = 0; k < m; k++) {
        for (let c = 0; c < 2; c++) {
          const buf = c === 0 ? L : R, f = this.f[c];
          let s = buf[i + k];
          if (p.drive > 0) s = fastTanh(s * drive) / Math.sqrt(drive);
          f.process(s);
          switch (p.type) {
            case 0: s = f.lp; break;
            case 1: s = f.bp * (0.5 + p.res); break;
            case 2: s = f.hp; break;
            case 3: s = f.lp + f.hp; break;
            default: s = s + f.bp * (p.res * 2);
          }
          buf[i + k] = s;
        }
      }
    }
    void TAU;
  }
}

export function create(sr, host) { return new Filter(sr, host); }
