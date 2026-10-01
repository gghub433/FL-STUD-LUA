// Channel Sampler: sample playback with start/end/loop (+crossfade), reverse, normalize,
// per-target DAHDSR envelopes + LFOs (VOL / PAN / CUT / RES / PITCH), state-variable filter,
// polyphony, note-release scaling, slide (portamento) notes, cut itself / cut groups.
//
// Tabs in the UI map to parameter groups: SMP, INS, MISC, FUNC.
import { def, bool, choice, defaults, schemaMap } from '../schema.js';
import { DAHDSR, LFO, SVF, hermite, clamp } from '../dsp.js';

export const TARGETS = ['vol', 'pan', 'cut', 'res', 'pitch'];
export const TARGET_LABEL = { vol: 'VOL', pan: 'PAN', cut: 'CUT', res: 'RES', pitch: 'PITCH' };

function buildSchema() {
  const s = [
    def('start', 'Start', 0, 1, 0, { group: 'SMP' }),
    def('end', 'End', 0, 1, 1, { group: 'SMP' }),
    choice('loop', 'Loop', ['Off', 'Forward', 'Ping-pong'], 0, { group: 'SMP' }),
    def('loopStart', 'Loop start', 0, 1, 0, { group: 'SMP' }),
    def('loopEnd', 'Loop end', 0, 1, 1, { group: 'SMP' }),
    def('xfade', 'Crossfade', 0, 500, 8, { unit: 'ms', group: 'SMP' }),
    bool('reverse', 'Reverse', 0, { group: 'SMP' }),
    bool('normalize', 'Normalize', 0, { group: 'SMP' }),
    def('root', 'Root key', 0, 120, 60, { int: true, group: 'SMP' }),
    def('fine', 'Fine tune', -100, 100, 0, { unit: 'cents', group: 'SMP' }),
    bool('stretchOn', 'Time stretch', 0, { group: 'SMP' }),
    def('stretchTime', 'Stretch time', 0.25, 4, 1, { curve: 'log', group: 'SMP' }),
    def('stretchPitch', 'Stretch pitch', -24, 24, 0, { unit: 'st', step: 0.01, group: 'SMP' }),
    choice('ftype', 'Filter', ['Off', 'LP', 'BP', 'HP', 'Notch'], 0, { group: 'INS' }),
    def('cutoff', 'Cutoff', 20, 20000, 20000, { unit: 'Hz', curve: 'log', group: 'INS' }),
    def('res', 'Resonance', 0, 1, 0, { group: 'INS' }),
    bool('volEnvOn', 'Volume envelope', 0, { group: 'INS' }),
    def('poly', 'Polyphony', 1, 32, 16, { int: true, group: 'MISC' }),
    bool('ignoreOff', 'Ignore note off', 1, { group: 'MISC' }),
    bool('cutItself', 'Cut itself', 0, { group: 'MISC' }),
    def('cutGroup', 'Cut group', 0, 8, 0, { int: true, group: 'MISC' }),
    def('cutBy', 'Cut by', 0, 8, 0, { int: true, group: 'MISC' }),
    bool('swapLR', 'Swap stereo', 0, { group: 'FUNC' }),
    bool('invert', 'Reverse polarity', 0, { group: 'FUNC' }),
    bool('mono', 'Mono', 0, { group: 'FUNC' }),
    def('fade', 'Fade stereo', -1, 1, 0, { group: 'FUNC' }),
  ];
  for (const t of TARGETS) {
    const g = 'INS';
    const L = TARGET_LABEL[t];
    const isVol = t === 'vol';
    s.push(
      def(`${t}Del`, `${L} delay`, 0, 5, 0, { unit: 's', curve: 'pow', group: g }),
      def(`${t}Att`, `${L} attack`, 0, 5, 0, { unit: 's', curve: 'pow', group: g }),
      def(`${t}Hold`, `${L} hold`, 0, 5, 0, { unit: 's', curve: 'pow', group: g }),
      def(`${t}Dec`, `${L} decay`, 0, 10, isVol ? 0.5 : 0.3, { unit: 's', curve: 'pow', group: g }),
      def(`${t}Sus`, `${L} sustain`, 0, 1, isVol ? 1 : 0.5, { group: g }),
      def(`${t}Rel`, `${L} release`, 0, 10, isVol ? 0.05 : 0.3, { unit: 's', curve: 'pow', group: g }),
      def(`${t}Amt`, `${L} env amount`, -1, 1, 0, { group: g }),
      def(`${t}LfoAmt`, `${L} LFO amount`, -1, 1, 0, { group: g }),
      def(`${t}LfoRate`, `${L} LFO speed`, 0.05, 30, 4, { unit: 'Hz', curve: 'log', group: g }),
      choice(`${t}LfoShape`, `${L} LFO shape`, ['Sine', 'Triangle', 'Saw up', 'Saw down', 'Square', 'Random'], 0, { group: g }),
      def(`${t}LfoDel`, `${L} LFO delay`, 0, 5, 0, { unit: 's', curve: 'pow', group: g }),
      def(`${t}LfoAtt`, `${L} LFO attack`, 0, 5, 0, { unit: 's', curve: 'pow', group: g }),
    );
  }
  return s;
}

export const schema = buildSchema();
export const meta = {
  id: 'sampler', name: 'Sampler', kind: 'sampler', rootDefault: 60,
  tabs: ['SMP', 'INS', 'MISC', 'FUNC'],
};
export const paramMap = schemaMap(schema);

const CHUNK = 16;

class Voice {
  constructor() {
    this.envs = TARGETS.map(() => new DAHDSR());
    this.lfos = TARGETS.map((_, i) => new LFO(i + 1));
    this.lfoT = new Float64Array(5);
    this.svfL = new SVF();
    this.svfR = new SVF();
    this.reset();
  }

  reset() {
    this.alive = false;
    this.key = 0; this.id = 0; this.time = 0;
    this.pos = 0; this.dir = 1; this.baseInc = 1;
    this.l = null; this.r = null; this.len = 0;
    this.startF = 0; this.endF = 0; this.loopS = 0; this.loopE = 0; this.loopMode = 0; this.xf = 0;
    this.gain = 1; this.pan = 0; this.fineSemis = 0;
    this.keySemis = 0;               // current pitch offset from root in semitones (glides on slide notes)
    this.targetSemis = 0; this.glideStep = 0;
    this.gainNow = 0; this.panNow = 0; this.pitchNow = 0;
    this.releasing = false; this.relScale = 1;
    this.fadeIn = 0; this.kill = 0; this.killStep = 0;
    this.lastKey = 0; this.sampleRate = 44100; this.relRel = 0.05;
  }
}

export class Sampler {
  constructor(sr, host) {
    this.sr = sr;
    this.host = host;
    this.p = defaults(schema);
    this.voices = [];
    for (let i = 0; i < 40; i++) this.voices.push(new Voice());
    this.counter = 0;
    this.envP = TARGETS.map(() => ({ delay: 0, attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.05 }));
    this.sampleId = null;
    for (const t of TARGETS) this._updateEnv(t);
  }

  get active() {
    for (const v of this.voices) if (v.alive) return true;
    return false;
  }

  setParam(id, v) {
    if (id === 'sampleId') { this.sampleId = v; return; }
    this.p[id] = v;
    for (const t of TARGETS) if (id.startsWith(t) && (id.length <= t.length + 4)) this._updateEnv(t);
    if (id === 'volEnvOn') this._updateEnv('vol');
  }

  _updateEnv(t) {
    const p = this.p, e = this.envP[TARGETS.indexOf(t)];
    if (t === 'vol' && !p.volEnvOn) {
      e.delay = 0; e.attack = 0; e.hold = 0; e.decay = 0; e.sustain = 1; e.release = p.volRel;
      return;
    }
    e.delay = p[`${t}Del`]; e.attack = p[`${t}Att`]; e.hold = p[`${t}Hold`];
    e.decay = p[`${t}Dec`]; e.sustain = p[`${t}Sus`]; e.release = p[`${t}Rel`];
  }

  allOff() { for (const v of this.voices) v.alive = false; }

  chokeAll() {
    for (const v of this.voices) if (v.alive && !v.kill) { v.kill = 1; v.killStep = 1 / (0.004 * this.sr); }
  }

  _alloc() {
    const maxPoly = this.p.poly;
    let n = 0, oldest = null, free = null;
    for (const v of this.voices) {
      if (v.alive) { n++; if (!oldest || v.time < oldest.time) oldest = v; } else if (!free) free = v;
    }
    if (free && n < maxPoly) return free;
    if (oldest) { // steal: oldest voice fades out quickly, new voice takes the free slot or reuses it
      if (free) { oldest.kill = 1; oldest.killStep = 1 / (0.004 * this.sr); return free; }
      return oldest;
    }
    return free;
  }

  noteOn(ev) {
    const smp = this.sampleId != null ? this.host.getSample(this.sampleId) : null;
    if (!smp) return;
    const p = this.p;
    if (ev.slide) {
      // slide note: glide the most recent sounding voice to the new key, no retrigger
      let best = null;
      for (const v of this.voices) if (v.alive && !v.releasing && (!best || v.time > best.time)) best = v;
      if (best) {
        best.targetSemis = ev.key - best.key;
        const frames = Math.max(1, (ev.len || 0.1 * this.sr));
        best.glideStep = (best.targetSemis - best.keySemis) / frames;
        best.lastKey = ev.key;
        return;
      }
    }
    if (p.cutItself) this.chokeAll();
    const v = this._alloc();
    if (!v) return;
    v.reset();
    v.alive = true;
    v.key = ev.key; v.lastKey = ev.key; v.id = ev.id || 0; v.time = ++this.counter;
    v.l = smp.ch[0]; v.r = smp.ch[1] || smp.ch[0]; v.len = smp.length;
    v.sampleRate = smp.rate;
    const len = smp.length;
    v.startF = Math.floor(clamp(p.start, 0, 1) * len);
    v.endF = Math.max(v.startF + 1, Math.floor(clamp(p.end, 0, 1) * len));
    v.loopS = clamp(Math.floor(p.loopStart * len), v.startF, v.endF - 1);
    v.loopE = clamp(Math.floor(p.loopEnd * len), v.loopS + 1, v.endF);
    v.loopMode = p.loop;
    v.xf = Math.min(Math.floor(p.xfade * 0.001 * smp.rate), (v.loopE - v.loopS) >> 1);
    v.dir = p.reverse ? -1 : 1;
    v.pos = p.reverse ? v.endF - 1 : v.startF;
    v.keySemis = ev.key - p.root;
    v.targetSemis = v.keySemis;
    v.fineSemis = (p.fine + (ev.fine || 0)) / 100;
    v.baseInc = smp.rate / this.sr;
    const norm = p.normalize && smp.peak > 0 ? 1 / smp.peak : 1;
    v.gain = clamp(ev.vel, 0, 1) * norm * (p.invert ? -1 : 1);
    v.pan = ev.pan || 0;
    const rel = ev.rel == null ? 64 : ev.rel;
    v.relScale = Math.pow(2, (rel - 64) / 32);
    v.fadeIn = Math.floor(0.0007 * this.sr);
    for (let i = 0; i < 5; i++) {
      v.envs[i].trigger();
      v.lfos[i].shape = p[`${TARGETS[i]}LfoShape`];
      v.lfos[i].reset(0);
      v.lfoT[i] = 0;
    }
    v.svfL.reset(); v.svfR.reset();
    v.gainNow = -1; // snap on first control update
  }

  noteOff(key) {
    if (this.p.ignoreOff) return;
    for (const v of this.voices) {
      if (v.alive && v.key === key && !v.releasing) {
        v.releasing = true;
        v.relRel = this.envP[0].release * v.relScale;
        for (let i = 0; i < 5; i++) v.envs[i].release();
      }
    }
  }

  process(L, R, i0, i1) {
    for (const v of this.voices) if (v.alive) this._voice(v, L, R, i0, i1);
  }

  _voice(v, L, R, i0, i1) {
    const p = this.p, sr = this.sr;
    const lData = v.l, rData = v.r, len = v.len;
    const startF = v.startF, endF = v.endF, loopS = v.loopS, loopE = v.loopE, loopMode = v.loopMode;
    const loopLen = loopE - loopS, xf = v.xf;
    const ftype = p.ftype;
    const filterOn = ftype > 0;
    const hasPan = p.panAmt !== 0 || p.panLfoAmt !== 0;
    const swap = p.swapLR, mono = p.mono, fade = p.fade;
    let i = i0;
    while (i < i1 && v.alive) {
      const n = Math.min(CHUNK, i1 - i);
      // ---- control rate ----
      const env = v.envs, E = this.envP;
      // volume envelope (release time scaled by the note's release property after note-off)
      const ve = env[0];
      let vol;
      if (v.releasing) {
        const saved = E[0].release; E[0].release = v.relRel;
        vol = ve.step(n, sr, E[0]); E[0].release = saved;
      } else vol = ve.step(n, sr, E[0]);
      if (ve.done || (ve.stage === 5 && E[0].sustain < 0.0005)) { v.alive = false; break; }

      let panMod = 0, cutMul = 1, resAdd = 0, pitchSemis = 0;
      if (hasPan) {
        const pe = env[1].step(n, sr, E[1]);
        panMod = pe * p.panAmt + this._lfo(v, 1, n) * p.panLfoAmt;
      }
      if (p.cutAmt !== 0 || p.cutLfoAmt !== 0) {
        const ce = env[2].step(n, sr, E[2]);
        cutMul = Math.pow(2, ce * p.cutAmt * 5 + this._lfo(v, 2, n) * p.cutLfoAmt * 3);
      }
      if (p.resAmt !== 0 || p.resLfoAmt !== 0) {
        const re = env[3].step(n, sr, E[3]);
        resAdd = re * p.resAmt * 0.5 + this._lfo(v, 3, n) * p.resLfoAmt * 0.5;
      }
      if (p.pitchAmt !== 0 || p.pitchLfoAmt !== 0) {
        const pe = env[4].step(n, sr, E[4]);
        pitchSemis = pe * p.pitchAmt * 24 + this._lfo(v, 4, n) * p.pitchLfoAmt * 12;
      }
      if (filterOn) {
        const fc = p.cutoff * cutMul, q = clamp(p.res + resAdd, 0, 1);
        v.svfL.setup(sr, fc, q);
        v.svfR.a1 = v.svfL.a1; v.svfR.a2 = v.svfL.a2; v.svfR.a3 = v.svfL.a3; v.svfR.k = v.svfL.k;
      }
      // glide for slide notes
      if (v.glideStep !== 0) {
        v.keySemis += v.glideStep * n;
        if ((v.glideStep > 0 && v.keySemis >= v.targetSemis) || (v.glideStep < 0 && v.keySemis <= v.targetSemis)) {
          v.keySemis = v.targetSemis; v.glideStep = 0;
        }
      }
      const inc = v.baseInc * Math.pow(2, (v.keySemis + v.fineSemis + pitchSemis) / 12) * v.dir;
      const gTarget = vol * v.gain;
      const pTarget = clamp(v.pan + panMod, -1, 1);
      if (v.gainNow < 0) { v.gainNow = gTarget; v.panNow = pTarget; }
      const gStep = (gTarget - v.gainNow) / n, pStep = (pTarget - v.panNow) / n;
      let g = v.gainNow, pn = v.panNow, pos = v.pos;

      // ---- audio rate ----
      for (let j = 0; j < n; j++) {
        // boundaries
        if (loopMode) {
          if (v.dir > 0) {
            if (pos >= loopE) {
              if (loopMode === 1) pos -= loopLen; else { v.dir = -1; pos = 2 * loopE - pos; }
            }
          } else if (pos < loopS) {
            if (loopMode === 1) pos += loopLen; else { v.dir = 1; pos = 2 * loopS - pos; }
          }
        } else if (v.dir > 0 ? pos >= endF : pos < startF) { v.alive = false; break; }
        if (pos < 0 || pos >= len) { v.alive = false; break; }

        let sl = hermite(lData, pos, len), sr_ = lData === rData ? sl : hermite(rData, pos, len);
        if (loopMode === 1 && xf > 0 && v.dir > 0 && pos > loopE - xf) {
          const t = (pos - (loopE - xf)) / xf, q = pos - loopLen;
          if (q >= 0) {
            const l2 = hermite(lData, q, len), r2 = lData === rData ? l2 : hermite(rData, q, len);
            sl = sl * (1 - t) + l2 * t; sr_ = sr_ * (1 - t) + r2 * t;
          }
        }
        pos += inc;

        if (filterOn) {
          v.svfL.process(sl); v.svfR.process(sr_);
          if (ftype === 1) { sl = v.svfL.lp; sr_ = v.svfR.lp; }
          else if (ftype === 2) { sl = v.svfL.bp; sr_ = v.svfR.bp; }
          else if (ftype === 3) { sl = v.svfL.hp; sr_ = v.svfR.hp; }
          else { sl = v.svfL.hp + v.svfL.lp; sr_ = v.svfR.hp + v.svfR.lp; }
        }
        if (mono) { sl = sr_ = (sl + sr_) * 0.5; }
        if (swap) { const t = sl; sl = sr_; sr_ = t; }
        if (fade) { // -1 = left only fades in .. simple stereo balance fade
          if (fade > 0) sl *= 1 - fade; else sr_ *= 1 + fade;
        }

        let gg = g;
        if (v.fadeIn > 0) { gg *= 1 - v.fadeIn / (0.0007 * sr + 1); v.fadeIn--; }
        if (v.kill) { v.kill -= v.killStep; if (v.kill <= 0) { v.alive = false; break; } gg *= v.kill; }
        // equal-power pan with unity at centre: left gets cos, right gets sin
        const a = (pn + 1) * 0.7853981634;
        L[i + j] += sl * gg * Math.cos(a) * 1.41421356;
        R[i + j] += sr_ * gg * Math.sin(a) * 1.41421356;
        g += gStep; pn += pStep;
      }
      v.pos = pos; v.gainNow = g; v.panNow = pn;
      i += n;
    }
  }

  // LFO value for target index with delay/attack fade-in, advanced by n samples
  _lfo(v, idx, n) {
    const p = this.p, t = TARGETS[idx];
    const inc = (p[`${t}LfoRate`] / this.sr);
    const lfo = v.lfos[idx];
    const val = lfo.next(inc * n);
    v.lfoT[idx] += n / this.sr;
    const del = p[`${t}LfoDel`], att = p[`${t}LfoAtt`];
    let f = 1;
    if (v.lfoT[idx] < del) f = 0;
    else if (att > 0) f = Math.min(1, (v.lfoT[idx] - del) / att);
    return val * f;
  }
}

export function create(sr, host) { return new Sampler(sr, host); }
