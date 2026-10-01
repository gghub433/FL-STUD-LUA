// Tick <-> bar:beat:tick conversion with time-signature change markers.
import { PPQ } from './constants.js';

export class TimeMap {
  // sigs: [{ t, num, den }] ; the first entry is the project time signature at tick 0
  constructor(timeSig, markers = []) {
    const list = [{ t: 0, num: timeSig.num, den: timeSig.den }];
    for (const m of markers) if (m.type === 'timesig' && m.t > 0) list.push({ t: m.t, num: m.num, den: m.den });
    list.sort((a, b) => a.t - b.t);
    // drop duplicates at the same tick (last wins)
    this.segs = [];
    for (const s of list) {
      if (this.segs.length && this.segs[this.segs.length - 1].t === s.t) this.segs.pop();
      this.segs.push({ ...s });
    }
    let barOffset = 0;
    for (let i = 0; i < this.segs.length; i++) {
      const s = this.segs[i];
      s.barLen = Math.round((s.num * PPQ * 4) / s.den);
      s.beatLen = Math.round((PPQ * 4) / s.den);
      s.barOffset = barOffset;
      if (i + 1 < this.segs.length) barOffset += Math.round((this.segs[i + 1].t - s.t) / s.barLen);
    }
  }

  seg(tick) {
    let lo = 0;
    for (let i = this.segs.length - 1; i >= 0; i--) if (this.segs[i].t <= tick) { lo = i; break; }
    return this.segs[lo];
  }

  barLenAt(tick) { return this.seg(tick).barLen; }
  beatLenAt(tick) { return this.seg(tick).beatLen; }

  // 1-based bar / beat plus ticks inside the beat
  bbt(tick) {
    const t = Math.max(0, tick);
    const s = this.seg(t);
    const local = t - s.t;
    const barIdx = Math.floor(local / s.barLen);
    const inBar = local - barIdx * s.barLen;
    const beat = Math.floor(inBar / s.beatLen);
    return { bar: s.barOffset + barIdx + 1, beat: beat + 1, tick: Math.floor(inBar - beat * s.beatLen), sig: s };
  }

  // tick of the first beat of a 1-based bar
  barStart(bar) {
    let seg = this.segs[0];
    for (const s of this.segs) if (s.barOffset + 1 <= bar) seg = s;
    return seg.t + (bar - 1 - seg.barOffset) * seg.barLen;
  }

  // next beat boundary strictly greater than tick (used by the metronome)
  nextBeat(tick) {
    const s = this.seg(Math.max(0, tick));
    const local = Math.max(0, tick) - s.t;
    const k = Math.floor(local / s.beatLen) + 1;
    let t = s.t + k * s.beatLen;
    const i = this.segs.indexOf(s);
    const next = this.segs[i + 1];
    if (next && t >= next.t) t = next.t;
    return t;
  }

  // smallest beat boundary >= tick (tick >= 0)
  atOrAfterBeat(tick) {
    const s = this.seg(tick);
    const k = Math.ceil((tick - s.t) / s.beatLen - 1e-9);
    let t = s.t + k * s.beatLen;
    const next = this.segs[this.segs.indexOf(s) + 1];
    if (next && t >= next.t) t = next.t;
    return t;
  }

  isBarStart(tick) {
    const s = this.seg(tick);
    return (tick - s.t) % s.barLen === 0;
  }
}
