// Event compiler + cursor. Patterns and the playlist are compiled into one sorted event
// array; the engine walks it with a cursor, converting tick positions to sample offsets
// inside each block, so timing is sample-accurate and independent of any JS timer.
import { STEP } from './constants.js';
import { patternLength } from './project.js';

export const EV_OFF = 0, EV_ON = 1, EV_AUDIO_ON = 2, EV_AUDIO_OFF = 3;

const byTime = (a, b) => a.t - b.t || a.k - b.k;

function swingShift(s, swing) {
  if (swing <= 0) return 0;
  if (s % STEP === 0 && ((s / STEP) & 1) === 1) return Math.round(swing * STEP * 0.5);
  return 0;
}

function pushNote(events, ch, n, base, endLimit, swing, notes) {
  if (n.mute) return;
  const shift = swingShift(n.s, swing);
  const t = base + n.s + shift;
  let end = base + n.s + n.l + shift;
  if (end > endLimit) end = endLimit;
  if (end <= t) end = t + 1;
  events.push({
    t, k: EV_ON, ch, key: n.k, vel: n.v / 127, pan: (n.pan || 0) / 64, rel: n.rel === undefined ? 64 : n.rel,
    fine: n.fine || 0, mx: n.mx === undefined ? 128 : n.mx, my: n.my === undefined ? 128 : n.my,
    slide: n.slide ? 1 : 0, len: end - t, nid: n.id,
  });
  events.push({ t: end, k: EV_OFF, ch, key: n.k, nid: n.id });
}

export class Sequencer {
  constructor() {
    this.events = [];
    this.idx = 0;
    this.length = 0;            // pattern length in ticks (pattern mode) or song end (song mode)
    this.autos = new Map();     // target addr -> [{ s, e, ch }] sorted by s
    this.audioClips = [];       // [{ s, e, clip }] for seeking into the middle of an audio clip
  }

  compilePattern(project, patId, swing = 0) {
    const pat = project.patterns[patId];
    this.events = []; this.autos = new Map(); this.audioClips = []; this.idx = 0;
    if (!pat) { this.length = 0; return; }
    const len = patternLength(project, pat);
    this.length = len;
    for (const key of Object.keys(pat.notes)) {
      const ch = +key;
      for (const n of pat.notes[key]) if (n.s < len) pushNote(this.events, ch, n, 0, len, swing);
    }
    this.events.sort(byTime);
  }

  compileSong(project, arr, swing = 0) {
    this.events = []; this.autos = new Map(); this.audioClips = []; this.idx = 0;
    const soloed = new Set();
    for (const k of Object.keys(arr.tracks)) if (arr.tracks[k].solo) soloed.add(+k);
    const muted = (track) => (arr.tracks[track]?.mute ? true : soloed.size > 0 && !soloed.has(track));
    const chById = new Map(project.channels.map((c) => [c.id, c]));
    let end = 0;
    for (const clip of arr.clips) {
      end = Math.max(end, clip.s + clip.l);
      if (clip.mute || muted(clip.track)) continue;
      const clipEnd = clip.s + clip.l;
      if (clip.type === 'pattern') {
        const pat = project.patterns[clip.ref];
        if (!pat) continue;
        const plen = patternLength(project, pat);
        const k0 = Math.floor(clip.o / plen), k1 = Math.ceil((clip.o + clip.l) / plen);
        for (let k = k0; k < k1; k++) {
          const base = clip.s - clip.o + k * plen;
          for (const key of Object.keys(pat.notes)) {
            const ch = +key;
            for (const n of pat.notes[key]) {
              if (n.s >= plen) continue;
              const t = base + n.s;
              if (t < clip.s || t >= clipEnd) continue;
              pushNote(this.events, ch, n, base, clipEnd, swing);
            }
          }
        }
      } else if (clip.type === 'audio') {
        const ch = chById.get(clip.ref);
        if (!ch) continue;
        this.events.push({ t: clip.s, k: EV_AUDIO_ON, ch: clip.ref, clip, offset: 0 });
        this.events.push({ t: clipEnd, k: EV_AUDIO_OFF, ch: clip.ref, clip });
        this.audioClips.push({ s: clip.s, e: clipEnd, clip, ch: clip.ref });
      } else if (clip.type === 'automation') {
        const ch = chById.get(clip.ref);
        if (!ch || !ch.target || !ch.points.length) continue;
        let list = this.autos.get(ch.target);
        if (!list) { list = []; this.autos.set(ch.target, list); }
        list.push({ s: clip.s, e: clipEnd, o: clip.o, ch });
      }
    }
    for (const list of this.autos.values()) list.sort((a, b) => a.s - b.s);
    this.events.sort(byTime);
    this.length = end;
  }

  seek(tick) {
    // first event with t >= tick
    let lo = 0, hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].t < tick) lo = mid + 1; else hi = mid;
    }
    this.idx = lo;
  }

  // Event at the cursor if it starts before `tickEnd`, advancing the cursor; otherwise null.
  next(tickEnd) {
    if (this.idx < this.events.length && this.events[this.idx].t < tickEnd) return this.events[this.idx++];
    return null;
  }

  // Audio clips covering `tick` (used to start playback in the middle of a clip).
  audioActiveAt(tick) {
    const out = [];
    for (const a of this.audioClips) if (a.s < tick && tick < a.e) out.push(a);
    return out;
  }
}
