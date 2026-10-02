// Audio editing primitives for the audio editor (and usable from tests / scripts). Pure functions on
//   buf = { rate, channels: Float32Array[] }      (1 or 2 channels, all the same length)
// Ranges are [a, b) in frames. Every operation returns a NEW buffer, so the editor's undo history is just
// a list of buffers. Nothing here touches the DOM or Web Audio.
import { BLOCK } from './constants.js';
import { hermite, clamp } from './dsp.js';
import { stretchAudio } from './stretch.js';
import { createEffect } from './effects/index.js';
import { getFFT, hann } from './fft.js';
import { detectSlices, mono as monoMix } from './slice-detect.js';

export const frames = (buf) => (buf.channels.length ? buf.channels[0].length : 0);
export const seconds = (buf) => frames(buf) / buf.rate;
export const makeBuf = (rate, channels) => ({ rate, channels });
export const emptyBuf = (rate, ch = 1, n = 0) => ({ rate, channels: Array.from({ length: ch }, () => new Float32Array(n)) });
export const cloneBuf = (buf) => ({ rate: buf.rate, channels: buf.channels.map((c) => c.slice()) });

export function range(buf, a, b) {
  const n = frames(buf);
  a = clamp(Math.round(a ?? 0), 0, n); b = clamp(Math.round(b ?? n), 0, n);
  return a <= b ? [a, b] : [b, a];
}

const mapCh = (buf, fn) => ({ rate: buf.rate, channels: buf.channels.map(fn) });

// ---- cut and paste
export function slice(buf, a, b) { [a, b] = range(buf, a, b); return mapCh(buf, (c) => c.slice(a, b)); }

export function deleteRange(buf, a, b) {
  [a, b] = range(buf, a, b);
  return mapCh(buf, (c) => { const o = new Float32Array(c.length - (b - a)); o.set(c.subarray(0, a)); o.set(c.subarray(b), a); return o; });
}

export function trim(buf, a, b) { return slice(buf, a, b); }

export function conform(clip, rate, channels) {
  let out = clip.rate === rate ? clip : resample(clip, rate);
  if (out.channels.length !== channels) out = channels === 1 ? toMono(out) : toStereo(out);
  return out;
}

// mode: 'insert' (default, pushes the rest later) | 'mix' (adds to what is there) | 'overwrite'
export function insert(buf, pos, clip, mode = 'insert') {
  pos = range(buf, pos, pos)[0];
  const c = conform(clip, buf.rate, buf.channels.length), n = frames(c), total = frames(buf);
  if (mode === 'insert') {
    return { rate: buf.rate, channels: buf.channels.map((src, k) => { const o = new Float32Array(total + n); o.set(src.subarray(0, pos)); o.set(c.channels[k], pos); o.set(src.subarray(pos), pos + n); return o; }) };
  }
  const len = Math.max(total, pos + n);
  return { rate: buf.rate, channels: buf.channels.map((src, k) => {
    const o = new Float32Array(len); o.set(src);
    if (mode === 'mix') for (let i = 0; i < n; i++) o[pos + i] += c.channels[k][i]; else o.set(c.channels[k], pos);
    return o;
  }) };
}

export function replaceRange(buf, a, b, clip) { [a, b] = range(buf, a, b); return insert(deleteRange(buf, a, b), a, clip, 'insert'); }

export function insertSilence(buf, pos, n) { return insert(buf, pos, emptyBuf(buf.rate, buf.channels.length, Math.max(0, Math.round(n))), 'insert'); }

export function append(buf, clip) { return insert(buf, frames(buf), clip, 'insert'); }

// ---- level processing
function edit(buf, a, b, fn) {
  [a, b] = range(buf, a, b);
  return mapCh(buf, (c) => { const o = c.slice(); fn(o, a, b); return o; });
}

export function silence(buf, a, b) { return edit(buf, a, b, (o, x, y) => o.fill(0, x, y)); }
export function reverse(buf, a, b) { return edit(buf, a, b, (o, x, y) => { for (let i = x, j = y - 1; i < j; i++, j--) { const t = o[i]; o[i] = o[j]; o[j] = t; } }); }
export function invert(buf, a, b) { return edit(buf, a, b, (o, x, y) => { for (let i = x; i < y; i++) o[i] = -o[i]; }); }
export function gain(buf, a, b, db) { const g = Math.pow(10, db / 20); return edit(buf, a, b, (o, x, y) => { for (let i = x; i < y; i++) o[i] *= g; }); }

export function peakOf(buf, a, b) {
  [a, b] = range(buf, a, b);
  let m = 0;
  for (const c of buf.channels) for (let i = a; i < b; i++) { const v = c[i] < 0 ? -c[i] : c[i]; if (v > m) m = v; }
  return m;
}

// scales the range so that its loudest sample reaches peakDb; silent ranges stay silent
export function normalize(buf, a, b, peakDb = 0) {
  const p = peakOf(buf, a, b);
  if (p < 1e-9) return cloneBuf(buf);
  return gain(buf, a, b, peakDb - 20 * Math.log10(p));
}

// shape: 'linear' | 'exp' (slow start) | 'log' (fast start) | 'scurve'
const FADE = { linear: (t) => t, exp: (t) => t * t * t, log: (t) => 1 - (1 - t) * (1 - t) * (1 - t), scurve: (t) => t * t * (3 - 2 * t) };
export function fade(buf, a, b, dir = 'in', shape = 'linear') {
  const f = FADE[shape] || FADE.linear;
  return edit(buf, a, b, (o, x, y) => {
    const n = y - x;
    for (let i = 0; i < n; i++) { const t = n > 1 ? i / (n - 1) : 1; o[x + i] *= dir === 'in' ? f(t) : f(1 - t); }
  });
}

export function dcRemove(buf, a, b) {
  [a, b] = range(buf, a, b);
  return mapCh(buf, (c) => {
    const o = c.slice();
    if (b <= a) return o;
    let s = 0;
    for (let i = a; i < b; i++) s += c[i];
    const m = s / (b - a);
    for (let i = a; i < b; i++) o[i] -= m;
    return o;
  });
}

// ---- channels and rate
export function toMono(buf) { return buf.channels.length === 1 ? cloneBuf(buf) : { rate: buf.rate, channels: [monoMix(buf.channels).slice()] }; }
export function toStereo(buf) { return buf.channels.length === 2 ? cloneBuf(buf) : { rate: buf.rate, channels: [buf.channels[0].slice(), buf.channels[0].slice()] }; }
export function swapChannels(buf) { return buf.channels.length === 2 ? { rate: buf.rate, channels: [buf.channels[1].slice(), buf.channels[0].slice()] } : cloneBuf(buf); }

export function resample(buf, rate) {
  rate = Math.round(rate);
  if (rate === buf.rate) return cloneBuf(buf);
  const n = frames(buf), ratio = buf.rate / rate, m = Math.max(1, Math.round(n / ratio));
  return { rate, channels: buf.channels.map((c) => {
    const o = new Float32Array(m);
    // content above the new Nyquist would fold back: a cheap one-pole stack takes the edge off when going down
    let src = c;
    if (ratio > 1) { src = c.slice(); const a = Math.min(1, 1.6 / ratio); for (let pass = 0; pass < 3; pass++) { let y = 0; for (let i = 0; i < n; i++) { y += (src[i] - y) * a; src[i] = y; } } }
    for (let i = 0; i < m; i++) o[i] = hermite(src, i * ratio, n);
    return o;
  }) };
}

// ---- time and pitch
export function stretchRange(buf, a, b, { ratio = 1, semitones = 0 } = {}) {
  [a, b] = range(buf, a, b);
  if (b - a < 64) return cloneBuf(buf);
  const part = stretchAudio(buf.channels.map((c) => c.slice(a, b)), { ratio, semitones, rate: buf.rate });
  return replaceRange(buf, a, b, { rate: buf.rate, channels: part });
}

// Seamless loop: the material just before the loop start is cross-faded into the end of the loop,
// so the jump from the end back to the start has no click. len = crossfade length in frames.
export function loopCrossfade(buf, a, b, len) {
  [a, b] = range(buf, a, b);
  len = Math.min(Math.round(len), a, b - a);
  if (len < 2) return cloneBuf(buf);
  return mapCh(buf, (c) => {
    const o = c.slice();
    for (let i = 0; i < len; i++) { const t = i / (len - 1), w = Math.sin(t * Math.PI / 2); o[b - len + i] = c[b - len + i] * Math.cos(t * Math.PI / 2) + c[a - len + i] * w; }
    return o;
  });
}

export function findZeroCrossing(buf, pos, maxDist = 2048) {
  const c = buf.channels[0], n = c.length;
  pos = clamp(Math.round(pos), 0, n - 1);
  for (let d = 0; d <= maxDist; d++) {
    for (const p of [pos - d, pos + d]) if (p >= 1 && p < n && c[p - 1] <= 0 && c[p] > 0) return p;
  }
  return pos;
}

// start/end of the material above the threshold (dBFS); returns null for a silent buffer
export function audibleRange(buf, thresholdDb = -60) {
  const t = Math.pow(10, thresholdDb / 20), n = frames(buf);
  let s = -1, e = -1;
  for (let i = 0; i < n && s < 0; i++) for (const c of buf.channels) if (Math.abs(c[i]) > t) { s = i; break; }
  if (s < 0) return null;
  for (let i = n - 1; i >= 0 && e < 0; i--) for (const c of buf.channels) if (Math.abs(c[i]) > t) { e = i + 1; break; }
  return [s, e];
}
export function trimSilence(buf, thresholdDb = -60) { const r = audibleRange(buf, thresholdDb); return r ? slice(buf, r[0], r[1]) : cloneBuf(buf); }

// ---- effects: any mixer effect can be applied to a range (the engine's own DSP, run offline)
// tail = seconds appended after the range so delays and reverbs can ring out instead of being cut
export function applyEffect(buf, a, b, type, params = {}, { tail = 0, extra = null, tempo = 120 } = {}) {
  [a, b] = range(buf, a, b);
  const host = { tempo, tick: 0, playing: false, sr: buf.rate, getSample: () => null };
  const fx = createEffect(type, buf.rate, host);
  for (const k of Object.keys(params)) fx.setParam(k, params[k]);
  if (extra && fx.setExtra) fx.setExtra(extra);
  const lat = Math.round(fx.latency || 0), tailN = Math.round(tail * buf.rate), n = b - a, total = n + tailN + lat;
  const stereo = buf.channels.length === 2;
  const inL = new Float32Array(total), inR = new Float32Array(total);
  inL.set(buf.channels[0].subarray(a, b)); inR.set((stereo ? buf.channels[1] : buf.channels[0]).subarray(a, b));
  const outL = new Float32Array(total), outR = new Float32Array(total), L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
  const ctx = { scL: null, scR: null };
  for (let p = 0; p < total; p += BLOCK) {
    const m = Math.min(BLOCK, total - p);
    L.set(inL.subarray(p, p + m)); R.set(inR.subarray(p, p + m));
    fx.process(L, R, m, ctx);
    outL.set(L.subarray(0, m), p); outR.set(R.subarray(0, m), p);
  }
  const keep = n + tailN;
  const part = { rate: buf.rate, channels: stereo ? [outL.slice(lat, lat + keep), outR.slice(lat, lat + keep)] : [outL.slice(lat, lat + keep)] };
  return replaceRange(buf, a, b, part);
}

// ---- measurement
export function stats(buf, a, b) {
  [a, b] = range(buf, a, b);
  let peak = 0, sum = 0, dc = 0;
  const n = Math.max(1, (b - a) * buf.channels.length);
  for (const c of buf.channels) for (let i = a; i < b; i++) { const v = c[i]; const av = v < 0 ? -v : v; if (av > peak) peak = av; sum += v * v; dc += v; }
  const rms = Math.sqrt(sum / n);
  const db = (x) => (x > 1e-9 ? 20 * Math.log10(x) : -Infinity);
  return { frames: b - a, seconds: (b - a) / buf.rate, peak, peakDb: db(peak), rms, rmsDb: db(rms), dc: dc / n };
}

// onset-based regions (like Edison's "detect beats"): [{ a, b }, ...]
export function detectRegions(buf, { sensitivity = 0.5, minGapMs = 70, maxRegions = 64 } = {}) {
  const starts = detectSlices(monoMix(buf.channels), buf.rate, { sensitivity, minGapMs, maxSlices: maxRegions });
  const n = frames(buf);
  return starts.map((s, i) => ({ a: s, b: i + 1 < starts.length ? starts[i + 1] : n }));
}

// ---- drawing support
// Min/max pyramid so a waveform of any length can be drawn for any zoom without touching every sample.
const BASE = 32;
export class Peaks {
  constructor(channels) {
    this.channels = channels; this.n = channels[0].length;
    this.levels = [];                                     // each: { block, min: Float32Array[], max: Float32Array[] }
    let prev = null, block = BASE;
    while (block < this.n * 2 || !this.levels.length) {
      const count = Math.ceil(this.n / block), min = [], max = [];
      for (let k = 0; k < channels.length; k++) {
        const mn = new Float32Array(count), mx = new Float32Array(count);
        if (!prev) {
          const c = channels[k];
          for (let j = 0; j < count; j++) {
            let lo = 0, hi = 0;
            const e = Math.min(this.n, (j + 1) * block);
            for (let i = j * block; i < e; i++) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
            mn[j] = lo; mx[j] = hi;
          }
        } else {
          const pm = prev.min[k], px = prev.max[k], f = block / prev.block;
          for (let j = 0; j < count; j++) {
            let lo = 0, hi = 0;
            const e = Math.min(pm.length, (j + 1) * f);
            for (let i = j * f; i < e; i++) { if (pm[i] < lo) lo = pm[i]; if (px[i] > hi) hi = px[i]; }
            mn[j] = lo; mx[j] = hi;
          }
        }
        min.push(mn); max.push(mx);
      }
      prev = { block, min, max }; this.levels.push(prev);
      block *= 4;
      if (block > this.n * 4) break;
    }
  }

  // min/max of channel k for `width` columns covering frames [start, end) -> Float32Array(width * 2)
  columns(k, start, end, width) {
    const out = new Float32Array(width * 2), per = (end - start) / width, c = this.channels[k];
    let lvl = null;
    for (const l of this.levels) if (l.block <= per / 2) lvl = l;
    for (let x = 0; x < width; x++) {
      const s0 = Math.max(0, Math.floor(start + x * per)), s1 = Math.min(this.n, Math.max(s0 + 1, Math.floor(start + (x + 1) * per)));
      let lo = 0, hi = 0, any = false;
      if (!lvl) {
        for (let i = s0; i < s1; i++) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; any = true; }
      } else {
        const j0 = Math.floor(s0 / lvl.block), j1 = Math.min(lvl.min[k].length, Math.ceil(s1 / lvl.block));
        for (let j = j0; j < j1; j++) { if (lvl.min[k][j] < lo) lo = lvl.min[k][j]; if (lvl.max[k][j] > hi) hi = lvl.max[k][j]; any = true; }
      }
      out[x * 2] = any ? lo : 0; out[x * 2 + 1] = any ? hi : 0;
    }
    return out;
  }
}

// Spectrogram of frames [a, b): `columns` windows of `size` samples -> { cols, bins, data } with data in dB (floor -120)
export function spectrogram(buf, a, b, { size = 1024, columns = 400 } = {}) {
  [a, b] = range(buf, a, b);
  const m = monoMix(buf.channels), fft = getFFT(size), win = hann(size), bins = size / 2;
  const data = new Float32Array(columns * bins), re = new Float32Array(size), im = new Float32Array(size);
  for (let x = 0; x < columns; x++) {
    const centre = Math.round(a + ((x + 0.5) * (b - a)) / columns), s0 = centre - size / 2;
    for (let i = 0; i < size; i++) { const p = s0 + i; re[i] = p >= 0 && p < m.length ? m[p] * win[i] : 0; im[i] = 0; }
    fft.transform(re, im);
    for (let k = 0; k < bins; k++) data[x * bins + k] = Math.max(-120, 20 * Math.log10((Math.hypot(re[k], im[k]) * 4) / size + 1e-9));
  }
  return { cols: columns, bins, data, rate: buf.rate };
}
