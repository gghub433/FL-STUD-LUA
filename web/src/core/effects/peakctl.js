// Peak controller: follows the level of the signal passing through it and drives the parameters linked to it,
// like the LFO / Envelope controller channels do (right-click any knob → Link to controller). The audio is left
// as it is (or muted, for a track that only feeds the controller). The links live in the slot (`slot.links`,
// [{ addr, min, max, inv }]); the engine calls control() once per block and writes the value into them, so the
// same thing happens live and in an export.
import { def, bool, choice, defaults } from '../schema.js';
import { LFO, LFO_SHAPES, dbToGain } from '../dsp.js';

export const schema = [
  def('base', 'Base', 0, 1, 0, { group: 'Main' }),
  def('amount', 'Amount', -1, 1, 1, { group: 'Main' }),
  def('tension', 'Tension', -1, 1, 0, { group: 'Main' }),
  def('gain', 'Input gain', -24, 24, 0, { unit: 'dB', group: 'Main' }),
  def('attack', 'Attack', 0.1, 500, 3, { unit: 'ms', curve: 'log', group: 'Main' }),
  def('release', 'Release', 1, 3000, 150, { unit: 'ms', curve: 'log', group: 'Main' }),
  choice('detect', 'Detector', ['Peak', 'RMS'], 0, { group: 'Main' }),
  bool('mute', 'Mute audio', 0, { group: 'Main' }),
  def('lfoAmt', 'LFO amount', 0, 1, 0, { group: 'LFO' }),
  def('lfoRate', 'LFO rate', 0.02, 20, 1, { unit: 'Hz', curve: 'log', group: 'LFO' }),
  choice('lfoShape', 'LFO shape', LFO_SHAPES, 0, { group: 'LFO' }),
];
export const meta = { id: 'peakctl', name: 'Peak controller', category: 'Control', controller: true, mixerOnly: true, description: 'Follows the level of this track and moves the knobs linked to it' };

const RMS_TIME = 0.02;                 // RMS detector integration (s)

// level (0..1 after the input gain) → 0..1 through the tension curve: > 0 reacts more to quiet signals, < 0 less
export const tensionCurve = (x, tension) => (x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(x, Math.pow(4, -tension)));

class PeakController {
  constructor(sr) {
    this.sr = sr; this.p = defaults(schema);
    this.lfo = new LFO(11);
    this.meters = [0, 0];               // [detected level after the curve, output value] for the window
    this.reset();
  }
  setParam(id, v) { this.p[id] = v; if (id === 'lfoShape') this.lfo.shape = v; }
  reset() { this.env = 0; this.ms = 0; this.fresh = false; this.value = this.p.base; }

  process(L, R, n) {
    const p = this.p, sr = this.sr;
    const ka = 1 - Math.exp(-1 / (p.attack * 0.001 * sr)), kr = 1 - Math.exp(-1 / (p.release * 0.001 * sr));
    const rms = p.detect === 1, km = 1 - Math.exp(-1 / (RMS_TIME * sr));
    let env = this.env, ms = this.ms;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      let x;
      if (rms) { ms += ((l * l + r * r) - ms) * km; x = Math.sqrt(ms); }           // sum of both squares: a full-scale sine on both sides reads 1
      else { const al = l < 0 ? -l : l, ar = r < 0 ? -r : r; x = al > ar ? al : ar; }
      env += (x - env) * (x > env ? ka : kr);
    }
    this.env = env < 1e-12 ? 0 : env; this.ms = ms;
    this.fresh = true;
    if (p.mute) { L.fill(0, 0, n); R.fill(0, 0, n); }
  }

  // advance by n samples (one engine block) and return the control value 0..1
  control(n) {
    const p = this.p, sr = this.sr;
    if (!this.fresh) {                   // the track was skipped (silent): the follower falls back as on silence
      this.env *= Math.exp(-n / (p.release * 0.001 * sr));
      this.ms *= Math.exp(-n / (RMS_TIME * sr));
    }
    this.fresh = false;
    const lvl = tensionCurve(Math.min(1, this.env * dbToGain(p.gain)), p.tension);
    let v = p.base + p.amount * lvl;
    if (p.lfoAmt > 0) { this.lfo.shape = p.lfoShape; v += p.lfoAmt * 0.5 * this.lfo.next((p.lfoRate * n) / sr); }
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    this.value = v;
    this.meters[0] = lvl; this.meters[1] = v;
    return v;
  }
}

export function create(sr) { return new PeakController(sr); }
