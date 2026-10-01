// Mixer: Master (track 0) + 125 inserts. Each insert: input bus + sidechain bus -> delay ->
// 10 effect slots -> 3-band EQ -> separation / pan / fader -> routes (any track to any track
// downstream, with send levels and optional sidechain delivery) .
// Tracks are processed in topological order (sources before destinations); silent tracks
// with no effect tail are skipped so 125 inserts stay cheap.
import { BLOCK, MAX_INSERT, FX_SLOTS } from './constants.js';
import { Biquad, faderGain, DelayLine, clamp } from './dsp.js';
import { createEffect, hasEffect } from './effects/index.js';
import { Analyzer } from './analyzer.js';

const TAIL_SECONDS = 8;

class FxSlotRT {
  constructor(data, sr, host) {
    this.type = data.type;
    this.inst = createEffect(data.type, sr, host);
    this.on = data.on !== 0;
    this.mix = data.mix;
    this.dryL = new Float32Array(BLOCK);
    this.dryR = new Float32Array(BLOCK);
    for (const k in data.params) this.inst.setParam(k, data.params[k]);
    if (data.extra && this.inst.setExtra) this.inst.setExtra(data.extra);
    this.latency = this.inst.latency || 0;
  }

  // effects with look-ahead report their latency (samples) only while enabled
  get delay() { return this.on ? (this.inst.latency || 0) : 0; }
}

class TrackRT {
  constructor(n, sr) {
    this.n = n;
    this.sr = sr;
    this.inL = new Float32Array(BLOCK); this.inR = new Float32Array(BLOCK);
    this.dirL = new Float32Array(BLOCK); this.dirR = new Float32Array(BLOCK);   // channel feeds (aligned separately for PDC)
    this.ddL = null; this.ddR = null; this.directDelay = 0; this.latency = 0;
    this.scL = new Float32Array(BLOCK); this.scR = new Float32Array(BLOCK);
    this.fed = false; this.scFed = false; this.tail = 0; this.active = false;
    this.fx = new Array(FX_SLOTS).fill(null);
    this.hasFx = false;
    this.bq = { low: [new Biquad(), new Biquad()], mid: [new Biquad(), new Biquad()], high: [new Biquad(), new Biquad()] };
    this.eqDirty = true; this.eqActive = false;
    this.vol = 0.8; this.pan = 0; this.sep = 0; this.delayMs = 0;
    this.mute = false; this.audible = true; this.swapLR = false; this.invert = false;
    this.routes = [];
    this.gL = 0; this.gR = 0; this.gInit = false;
    this.peakL = 0; this.peakR = 0;
    this.dl = null; this.dr = null;
    this.params = null;
  }
}

export class Mixer {
  constructor(sr, host) {
    this.sr = sr;
    this.host = host;
    this.tracks = [];
    for (let n = 0; n <= MAX_INSERT; n++) this.tracks.push(new TrackRT(n, sr));
    this.order = [];
    this.tailBlocks = Math.ceil((TAIL_SECONDS * sr) / BLOCK);
    this.ctx = { scL: null, scR: null };
    this.soloActive = false;
    this.tap = null;                    // { track, slot } slot -1 = track output
    this.analyzer = new Analyzer();
    this.totalLatency = 0;
  }

  setTap(tap) { this.tap = tap; this.analyzer.reset(); }

  setProject(project) {
    for (let n = 0; n <= MAX_INSERT; n++) this.updateTrack(n, project.mixer.tracks[n], false);
    this.rebuild();
  }

  updateTrack(n, data, rebuild = true) {
    const t = this.tracks[n];
    t.params = data;
    t.vol = data.vol; t.pan = data.pan; t.sep = data.sep; t.delayMs = data.delay;
    t.mute = !!data.mute; t.solo = !!data.solo; t.swapLR = !!data.swapLR; t.invert = !!data.invertPhase;
    t.routes = data.routes.map((r) => ({ dest: r[0], level: r[1], sc: !!r[2], delay: 0, dl: null, dr: null }));
    t.eqDirty = true;
    for (let s = 0; s < FX_SLOTS; s++) this.updateSlot(n, s, data.fx[s]);
    if (rebuild) this.rebuild();
  }

  updateSlot(n, s, data) {
    const t = this.tracks[n];
    const cur = t.fx[s];
    if (!data || !hasEffect(data.type)) { t.fx[s] = null; }
    else if (cur && cur.type === data.type) {
      cur.on = data.on !== 0; cur.mix = data.mix;
      for (const k in data.params) cur.inst.setParam(k, data.params[k]);
      if (data.extra && cur.inst.setExtra) cur.inst.setExtra(data.extra);
    } else t.fx[s] = new FxSlotRT(data, this.sr, this.host);
    t.hasFx = t.fx.some(Boolean);
    this.latencyDirty = true;
  }

  setTrackParam(n, key, v) {
    const t = this.tracks[n];
    switch (key) {
      case 'vol': t.vol = v; break;
      case 'pan': t.pan = v; break;
      case 'sep': t.sep = v; break;
      case 'delay': t.delayMs = v; break;
      default: if (key.startsWith('eq')) t.eqDirty = true;
    }
    if (t.params && key.startsWith('eq')) t.params[key] = v;
  }

  setSlotParam(n, s, key, v) {
    const slot = this.tracks[n].fx[s];
    if (!slot) return;
    if (key === 'mix') slot.mix = v;
    else if (key === 'on') slot.on = v !== 0;
    else slot.inst.setParam(key, v);
    if (key === 'on' || key === 'lookahead') this.latencyDirty = true;
  }

  // Topological order (sources first) + solo audibility.
  rebuild() {
    const seen = new Array(MAX_INSERT + 1).fill(false), post = [];
    const visit = (n) => {
      if (seen[n]) return;
      seen[n] = true;
      for (const r of this.tracks[n].routes) visit(r.dest);
      post.push(n);
    };
    for (let n = 0; n <= MAX_INSERT; n++) visit(n);
    this.order = post.reverse().filter((n) => n !== 0);
    this.order.push(0);

    const solos = this.tracks.filter((t) => t.solo && t.n !== 0).map((t) => t.n);
    this.soloActive = solos.length > 0;
    for (const t of this.tracks) t.audible = true;
    if (this.soloActive) {
      const keep = new Set([0]);
      const down = (n) => { for (const r of this.tracks[n].routes) if (!keep.has(r.dest)) { keep.add(r.dest); down(r.dest); } };
      const up = (target) => {
        for (const t of this.tracks) if (!keep.has(t.n) && t.routes.some((r) => r.dest === target)) { keep.add(t.n); up(t.n); }
      };
      for (const s of solos) { keep.add(s); down(s); up(s); }
      for (const t of this.tracks) t.audible = keep.has(t.n);
    }
    this.computeLatency();
  }

  // Plugin delay compensation: align every signal that meets at a track input.
  computeLatency() {
    const arrival = new Array(MAX_INSERT + 1).fill(0), out = new Array(MAX_INSERT + 1).fill(0);
    for (const n of this.order) {
      const t = this.tracks[n];
      t.latency = t.fx.reduce((a, s) => a + (s ? s.delay : 0), 0);
      out[n] = arrival[n] + t.latency;
      for (const r of t.routes) if (!r.sc && out[n] > arrival[r.dest]) arrival[r.dest] = out[n];
    }
    for (const n of this.order) {
      const t = this.tracks[n];
      t.directDelay = arrival[n];
      for (const r of t.routes) r.delay = r.sc ? 0 : arrival[r.dest] - out[n];
    }
    this.totalLatency = out[0];
  }

  clearBuffers() {
    for (const t of this.tracks) {
      t.inL.fill(0); t.inR.fill(0); t.dirL.fill(0); t.dirR.fill(0);
      if (t.scFed) { t.scL.fill(0); t.scR.fill(0); }
      t.scFed = false;
      t.prevFed = t.fed; t.fed = false;
    }
  }

  // Feed a channel's output into an insert's input bus.
  feed(trackN, L, R, n, gl, gr) {
    const t = this.tracks[trackN];
    const a = t.dirL, b = t.dirR;
    for (let i = 0; i < n; i++) { a[i] += L[i] * gl; b[i] += R[i] * gr; }
    t.fed = true;
  }

  _eq(t, n) {
    const p = t.params;
    if (t.eqDirty) {
      const sr = this.sr;
      t.eqActive = Math.abs(p.eqLowG) > 0.01 || Math.abs(p.eqMidG) > 0.01 || Math.abs(p.eqHighG) > 0.01;
      for (let c = 0; c < 2; c++) {
        t.bq.low[c].set('ls', sr, p.eqLowF, 0.7071, p.eqLowG);
        t.bq.mid[c].set('peak', sr, p.eqMidF, p.eqMidQ, p.eqMidG);
        t.bq.high[c].set('hs', sr, p.eqHighF, 0.7071, p.eqHighG);
      }
      t.eqDirty = false;
    }
    if (!t.eqActive) return;
    const useLow = Math.abs(p.eqLowG) > 0.01, useMid = Math.abs(p.eqMidG) > 0.01, useHigh = Math.abs(p.eqHighG) > 0.01;
    const bufs = [t.inL, t.inR];
    for (let c = 0; c < 2; c++) {
      const x = bufs[c], lo = t.bq.low[c], mi = t.bq.mid[c], hi = t.bq.high[c];
      for (let i = 0; i < n; i++) {
        let s = x[i];
        if (useLow) s = lo.process(s);
        if (useMid) s = mi.process(s);
        if (useHigh) s = hi.process(s);
        x[i] = s;
      }
    }
  }

  process(n) {
    if (this.latencyDirty) { this.latencyDirty = false; this.computeLatency(); }
    const ctx = this.ctx;
    for (const idx of this.order) {
      const t = this.tracks[idx];
      const master = idx === 0;
      if (!master) {
        if (!t.fed && t.tail <= 0) { t.active = false; t.peakL *= 0.0; t.peakR *= 0.0; continue; }
        if (t.fed) t.tail = t.hasFx ? this.tailBlocks : 0; else t.tail--;
      }
      t.active = true;
      const L = t.inL, R = t.inR;
      // channel feeds join the routed signals, delayed so everything stays time-aligned (PDC)
      if (t.directDelay > 0) {
        if (!t.ddL || t.ddL.buf.length < t.directDelay + 8) { t.ddL = new DelayLine(t.directDelay + 8); t.ddR = new DelayLine(t.directDelay + 8); }
        for (let i = 0; i < n; i++) {
          t.ddL.write(t.dirL[i]); t.ddR.write(t.dirR[i]);
          L[i] += t.ddL.readInt(t.directDelay); R[i] += t.ddR.readInt(t.directDelay);
        }
      } else {
        const dl = t.dirL, dr = t.dirR;
        for (let i = 0; i < n; i++) { L[i] += dl[i]; R[i] += dr[i]; }
      }

      // input delay (ms)
      if (t.delayMs > 0.01) {
        if (!t.dl) { const max = Math.ceil(0.101 * this.sr); t.dl = new DelayLine(max); t.dr = new DelayLine(max); }
        const d = Math.max(1, t.delayMs * 0.001 * this.sr);
        for (let i = 0; i < n; i++) {
          t.dl.write(L[i]); t.dr.write(R[i]);
          L[i] = t.dl.read(d); R[i] = t.dr.read(d);
        }
      }

      // effect slots
      for (let s = 0; s < FX_SLOTS; s++) {
        const slot = t.fx[s];
        if (!slot || !slot.on) continue;
        const wet = slot.mix;
        if (wet < 0.999) { slot.dryL.set(L.subarray(0, n)); slot.dryR.set(R.subarray(0, n)); }
        ctx.scL = t.scFed ? t.scL : null; ctx.scR = t.scFed ? t.scR : null;
        slot.inst.process(L, R, n, ctx);
        if (wet < 0.999) {
          const dl = slot.dryL, dr = slot.dryR, d = 1 - wet;
          for (let i = 0; i < n; i++) { L[i] = dl[i] * d + L[i] * wet; R[i] = dr[i] * d + R[i] * wet; }
        }
        if (this.tap && this.tap.track === idx && this.tap.slot === s) this.analyzer.push(L, R, n);
      }

      this._eq(t, n);

      // separation, pan, fader (linear ramp to the new gain to avoid zipper noise)
      if (t.sep !== 0) {
        const width = t.sep < 0 ? 1 + t.sep : 1 + t.sep * 1.5;
        for (let i = 0; i < n; i++) {
          const m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5 * width;
          L[i] = m + s; R[i] = m - s;
        }
      }
      if (t.swapLR) for (let i = 0; i < n; i++) { const x = L[i]; L[i] = R[i]; R[i] = x; }
      const silent = t.mute || !t.audible;
      const g = silent ? 0 : faderGain(t.vol);
      const a = (clamp(t.pan, -1, 1) + 1) * 0.7853981634;
      const tl = g * Math.cos(a) * 1.41421356 * (t.invert ? -1 : 1), tr = g * Math.sin(a) * 1.41421356 * (t.invert ? -1 : 1);
      if (!t.gInit) { t.gL = tl; t.gR = tr; t.gInit = true; }
      const sl = (tl - t.gL) / n, sr_ = (tr - t.gR) / n;
      let gl = t.gL, gr = t.gR, pl = 0, pr = 0;
      for (let i = 0; i < n; i++) {
        gl += sl; gr += sr_;
        const l = L[i] * gl, r = R[i] * gr;
        L[i] = l; R[i] = r;
        const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
        if (al > pl) pl = al;
        if (ar > pr) pr = ar;
      }
      t.gL = tl; t.gR = tr;
      if (pl > t.peakL) t.peakL = pl;
      if (pr > t.peakR) t.peakR = pr;
      if (this.tap && this.tap.track === idx && this.tap.slot === -1) this.analyzer.push(L, R, n);

      if (master) continue;
      if (silent) continue;
      for (const r of t.routes) {
        const d = this.tracks[r.dest];
        const lv = r.level;
        if (r.sc) {
          const sL = d.scL, sR = d.scR;
          if (!d.scFed) { sL.fill(0); sR.fill(0); d.scFed = true; }
          for (let i = 0; i < n; i++) { sL[i] += L[i] * lv; sR[i] += R[i] * lv; }
        } else {
          const dL = d.inL, dR = d.inR;
          if (r.delay > 0) {
            if (!r.dl || r.dl.buf.length < r.delay + 8) { r.dl = new DelayLine(r.delay + 8); r.dr = new DelayLine(r.delay + 8); }
            for (let i = 0; i < n; i++) {
              r.dl.write(L[i]); r.dr.write(R[i]);
              dL[i] += r.dl.readInt(r.delay) * lv; dR[i] += r.dr.readInt(r.delay) * lv;
            }
          } else for (let i = 0; i < n; i++) { dL[i] += L[i] * lv; dR[i] += R[i] * lv; }
          d.fed = true;
        }
      }
    }
    return this.tracks[0];
  }

  // Reset effect state (called on stop so tails do not leak into the next play).
  reset() {
    for (const t of this.tracks) {
      t.tail = 0;
      for (const s of t.fx) if (s && s.inst.reset) s.inst.reset();
      if (t.dl) { t.dl.clear(); t.dr.clear(); }
      for (const k of ['low', 'mid', 'high']) for (const b of t.bq[k]) b.reset();
    }
  }

  // Peak since the last call (and reset), L/R interleaved for all tracks.
  takePeaks(out) {
    for (let n = 0; n < this.tracks.length; n++) {
      const t = this.tracks[n];
      out[n * 2] = t.peakL; out[n * 2 + 1] = t.peakR;
      t.peakL = 0; t.peakR = 0;
    }
    return out;
  }
}
