// Stereo delay: free time or tempo-synced, ping-pong, feedback filtering, saturation and tape wobble.
import { def, bool, choice, defaults } from '../schema.js';
import { DelayLine, dbToGain, OnePole, fastTanh, SYNC_DIVS, SYNC_LABELS } from '../dsp.js';

export const schema = [
  bool('sync', 'Tempo sync', 1, { group: 'Time' }),
  def('time', 'Time', 1, 2000, 375, { unit: 'ms', curve: 'log', group: 'Time' }),
  choice('division', 'Division', SYNC_LABELS, 5, { group: 'Time' }),
  def('offset', 'Right offset', 0.25, 2, 1, { curve: 'log', group: 'Time' }),
  def('feedback', 'Feedback', 0, 0.97, 0.4, { group: 'Time' }),
  bool('pingpong', 'Ping-pong', 0, { group: 'Time' }),
  def('lowcut', 'Feedback low cut', 20, 2000, 40, { unit: 'Hz', curve: 'log', group: 'Tone' }),
  def('highcut', 'Feedback high cut', 500, 20000, 9000, { unit: 'Hz', curve: 'log', group: 'Tone' }),
  def('drive', 'Saturation', 0, 1, 0, { group: 'Tone' }),
  def('wobble', 'Tape wobble', 0, 1, 0, { group: 'Tone' }),
  def('dry', 'Dry', -60, 6, 0, { unit: 'dB', group: 'Level' }),
  def('wet', 'Wet', -60, 6, -4, { unit: 'dB', group: 'Level' }),
];

export const meta = { id: 'delay', name: 'Delay', category: 'Space', description: 'Stereo delay with tempo sync, ping-pong and filtered feedback' };

class Delay {
  constructor(sr, host) {
    this.sr = sr; this.host = host;
    this.p = defaults(schema);
    this.dl = new DelayLine(Math.ceil(5.2 * sr)); this.dr = new DelayLine(Math.ceil(5.2 * sr));
    this.curL = 0; this.curR = 0; this.init = false;
    this.hpL = 0; this.hpR = 0; this.lpL = new OnePole(); this.lpR = new OnePole();
    this.ph = 0;
  }
  setParam(id, v) { this.p[id] = v; }
  reset() { this.dl.clear(); this.dr.clear(); this.hpL = this.hpR = 0; this.lpL.z = this.lpR.z = 0; this.init = false; }

  process(L, R, n) {
    const p = this.p, sr = this.sr;
    const ms = p.sync ? (60000 / (this.host.tempo || 120)) * SYNC_DIVS[p.division][1] : p.time;
    const tL = Math.min(ms * 0.001 * sr, 5 * sr - 4), tR = Math.min(tL * p.offset, 5 * sr - 4);
    if (!this.init) { this.curL = tL; this.curR = tR; this.init = true; }
    const dry = dbToGain(p.dry) * (p.dry <= -59.5 ? 0 : 1), wet = dbToGain(p.wet) * (p.wet <= -59.5 ? 0 : 1);
    const fb = p.feedback, pp = !!p.pingpong;
    this.lpL.setCutoff(sr, p.highcut); this.lpR.setCutoff(sr, p.highcut);
    const hpCo = 1 - Math.exp((-2 * Math.PI * p.lowcut) / sr);
    const drive = 1 + p.drive * 6;
    const smooth = 1 - Math.exp(-1 / (0.05 * sr));     // time glides (tape-like pitch bend on change)
    const wobAmt = p.wobble * 0.0025 * sr, wobInc = 0.6 / sr;
    for (let i = 0; i < n; i++) {
      this.curL += (tL - this.curL) * smooth; this.curR += (tR - this.curR) * smooth;
      this.ph += wobInc; if (this.ph >= 1) this.ph -= 1;
      const w = wobAmt * Math.sin(6.283185307 * this.ph);
      const yl = this.dl.read(Math.max(2, this.curL + w)), yr = this.dr.read(Math.max(2, this.curR - w));
      let fl = yl, fr = yr;
      if (p.drive > 0) { fl = fastTanh(fl * drive) / Math.sqrt(drive); fr = fastTanh(fr * drive) / Math.sqrt(drive); }
      this.hpL += hpCo * (fl - this.hpL); fl -= this.hpL;
      this.hpR += hpCo * (fr - this.hpR); fr -= this.hpR;
      fl = this.lpL.process(fl); fr = this.lpR.process(fr);
      const inL = L[i], inR = R[i];
      if (pp) {
        const mono = (inL + inR) * 0.5;
        this.dl.write(mono + fr * fb);
        this.dr.write(fl * fb);
      } else {
        this.dl.write(inL + fl * fb);
        this.dr.write(inR + fr * fb);
      }
      L[i] = inL * dry + yl * wet;
      R[i] = inR * dry + yr * wet;
    }
  }
}

export function create(sr, host) { return new Delay(sr, host); }
