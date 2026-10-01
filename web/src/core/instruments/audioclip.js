// Playback of playlist audio clips (one player per audio channel). Not a note instrument:
// the sequencer starts/stops clips; each clip has an offset into the sample, fades, reverse,
// gain and a resample pitch. Time-stretched clips are rendered by the host into a derived
// sample, so the audio thread only ever resamples.
import { hermite, dbToGain } from '../dsp.js';

class ClipVoice {
  constructor() { this.alive = false; }
}

export class AudioClipPlayer {
  constructor(sr, host) {
    this.sr = sr;
    this.host = host;
    this.voices = [];
    for (let i = 0; i < 16; i++) this.voices.push(new ClipVoice());
  }

  get active() { for (const v of this.voices) if (v.alive) return true; return false; }
  setParam() {}
  noteOn() {}
  noteOff() {}
  allOff() { for (const v of this.voices) v.alive = false; }
  chokeAll() { for (const v of this.voices) if (v.alive) v.stop = true; }

  // spec: { clipId, sampleId, startSrc (source frame), lenFrames (output frames), gain (linear),
  //         fadeIn, fadeOut (output frames), rev, rate (resample ratio) , norm }
  start(spec) {
    const smp = this.host.getSample(spec.sampleId);
    if (!smp) return;
    let v = this.voices.find((x) => !x.alive);
    if (!v) v = this.voices[0];
    v.alive = true; v.stop = false; v.stopGain = 1;
    v.clipId = spec.clipId;
    v.l = smp.ch[0]; v.r = smp.ch[1] || smp.ch[0]; v.len = smp.length;
    v.rev = !!spec.rev;
    v.inc = (smp.rate / this.sr) * (spec.rate || 1) * (v.rev ? -1 : 1);
    v.pos = spec.startSrc;
    v.left = spec.lenFrames;
    v.total = spec.lenFrames;
    v.gain = spec.gain * (spec.norm && smp.peak > 0 ? 1 / smp.peak : 1);
    v.fadeIn = Math.max(spec.fadeIn || 0, 24);
    v.fadeOut = Math.max(spec.fadeOut || 0, 24);
  }

  stopClip(clipId) {
    for (const v of this.voices) if (v.alive && v.clipId === clipId) v.stop = true;
  }

  process(L, R, i0, i1) {
    for (const v of this.voices) {
      if (!v.alive) continue;
      const lData = v.l, rData = v.r, len = v.len, mono = lData === rData;
      for (let i = i0; i < i1; i++) {
        if (v.left <= 0 || v.pos < 0 || v.pos >= len) { v.alive = false; break; }
        const done = v.total - v.left;
        let g = v.gain;
        if (done < v.fadeIn) g *= done / v.fadeIn;
        if (v.left < v.fadeOut) g *= v.left / v.fadeOut;
        if (v.stop) { v.stopGain -= 1 / (0.003 * this.sr); if (v.stopGain <= 0) { v.alive = false; break; } g *= v.stopGain; }
        const sl = hermite(lData, v.pos, len);
        const sr_ = mono ? sl : hermite(rData, v.pos, len);
        L[i] += sl * g; R[i] += sr_ * g;
        v.pos += v.inc; v.left--;
      }
    }
  }
}

export const meta = { id: 'audio', name: 'Audio clip', kind: 'audio' };
export const schema = [];
export function create(sr, host) { return new AudioClipPlayer(sr, host); }
export { dbToGain };
