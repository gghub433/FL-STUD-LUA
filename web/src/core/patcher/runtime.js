// Patcher runtime: turns a patch (see spec.js) into a running graph.
//
// The graph is evaluated in topological order over a *slice* of the 128-frame block [i0, i1): as an
// instrument the engine renders between note events, so notes still start on the exact sample. Audio buffers
// are owned by the node that produces them and are never modified by the nodes that read them, so a wire can
// simply alias the source buffer. Control signals are scalars computed once per slice.
import { BLOCK, PPQ } from '../constants.js';
import { clamp, TAU, panGains, Noise, SYNC_DIVS } from '../dsp.js';
import { fromNorm, clampParam } from '../schema.js';
import { createInstrument } from '../instruments/index.js';
import { createEffect } from '../effects/index.js';
import { nodeInfo, portsOf, modPort, normalizePatch, defaultPatch, MACROS, CHORDS, CHORD_NAMES } from './spec.js';

const pair = (n = BLOCK) => ({ L: new Float32Array(n), R: new Float32Array(n) });
const TAIL_SECONDS = 6;

// ------------------------------------------------------------------------------------------ nodes
class RT {
  constructor(spec, g) {
    this.id = spec.id; this.type = spec.type; this.ref = spec.ref; this.g = g; this.sr = g.sr; this.host = g.host;
    this.info = nodeInfo(spec);
    this.p = {}; this.base = {}; this.mods = []; this.bypass = false;
    this.inb = {}; this.ci = {}; this.co = {}; this.outb = {};
    for (const o of this.info.outs) { if (o.type === 'audio') this.outb[o.id] = pair(); else if (o.type === 'ctl') this.co[o.id] = 0; }
    this.asrc = []; this.csrc = []; this.nt = {};
    this.ptype = { in: {}, out: {} };
  }

  configure(spec) {
    this.bypass = !!spec.bypass;
    const ports = portsOf(spec);
    this.ptype = { in: {}, out: {} };
    for (const q of ports.ins) this.ptype.in[q.id] = q.type;
    for (const q of ports.outs) this.ptype.out[q.id] = q.type;
    this.mods = [];
    for (const id of spec.mods || []) { const def = this.info.params.find((d) => d.id === id); if (def) this.mods.push({ id, def, port: modPort(id) }); }
    for (const d of this.info.params) {
      const v = clampParam(d, spec.params ? spec.params[d.id] : undefined);
      this.base[d.id] = v;
      this.put(d.id, v);
    }
    this.onConfigure(spec);
  }

  // buffers normally hold one 128-frame block; hosts that render bigger chunks make them grow
  grow(n) { for (const k in this.outb) this.outb[k] = pair(n); for (const a of this.asrc) if (a.mix) a.mix = pair(n); }

  put(id, v) { if (this.p[id] === v) return; this.p[id] = v; this.onParam(id, v); }
  modulate() {
    for (let i = 0; i < this.mods.length; i++) {
      const m = this.mods[i], c = this.ci[m.port];
      this.put(m.id, c === undefined ? this.base[m.id] : fromNorm(m.def, c));
    }
  }

  onParam() {}
  onConfigure() {}
  onNote() {}
  offNote() {}
  allOff() {}
  chokeAll() { this.allOff(); }
  reset() { this.allOff(); }
  get busy() { return false; }
  latency() { return 0; }
  process() {}

  emitOn(port, ev) { const t = this.nt[port]; if (t) for (let i = 0; i < t.length; i++) t[i].rt.onNote(t[i].port, ev); }
  emitOff(port, key) { const t = this.nt[port]; if (t) for (let i = 0; i < t.length; i++) t[i].rt.offNote(t[i].port, key); }
  ctl(id, dflt) { const v = this.ci[id]; return v === undefined ? dflt : v; }
}

// ---- hosted plugins
class InstNode extends RT {
  constructor(spec, g) { super(spec, g); this.inst = createInstrument(spec.ref, g.sr, g.host); }
  onParam(id, v) { this.inst.setParam(id, v); }
  onConfigure(spec) {
    if (this.ref === 'sampler') this.inst.setParam('sampleId', spec.sample ? (spec.sample.use || spec.sample.id) : null);
  }
  onNote(port, ev) { if (!this.bypass) this.inst.noteOn(ev); }
  offNote(port, key) { this.inst.noteOff(key); }
  allOff() { this.inst.allOff(); }
  chokeAll() { if (this.inst.chokeAll) this.inst.chokeAll(); else this.inst.allOff(); }
  get busy() { return !!this.inst.active; }
  process(i0, i1) {
    const o = this.outb.out;
    o.L.fill(0, i0, i1); o.R.fill(0, i0, i1);
    if (!this.bypass) this.inst.process(o.L, o.R, i0, i1);
  }
}

class FxNode extends RT {
  constructor(spec, g) {
    super(spec, g);
    this.inst = createEffect(spec.ref, g.sr, g.host);
    this.wL = new Float32Array(BLOCK); this.wR = new Float32Array(BLOCK);
    this.sL = new Float32Array(BLOCK); this.sR = new Float32Array(BLOCK);
    this.ctx = { scL: null, scR: null };
  }
  onParam(id, v) { this.inst.setParam(id, v); }
  grow(n) { super.grow(n); this.wL = new Float32Array(n); this.wR = new Float32Array(n); this.sL = new Float32Array(n); this.sR = new Float32Array(n); }
  onConfigure(spec) { if (this.inst.setExtra && spec.extra) this.inst.setExtra(spec.extra); }
  allOff() {}
  reset() { if (this.inst.reset) this.inst.reset(); }
  latency() { return this.bypass ? 0 : (this.inst.latency || 0); }
  process(i0, i1) {
    const n = i1 - i0, o = this.outb.out, a = this.inb.in, sc = this.inb.sc;
    if (this.bypass) {
      if (a) for (let i = i0; i < i1; i++) { o.L[i] = a.L[i]; o.R[i] = a.R[i]; } else { o.L.fill(0, i0, i1); o.R.fill(0, i0, i1); }
      return;
    }
    const src = a || this.g.zero, wL = this.wL, wR = this.wR, ctx = this.ctx;      // a wire-less effect still runs so its tail rings out
    for (let i = 0; i < n; i++) { wL[i] = src.L[i0 + i]; wR[i] = src.R[i0 + i]; }
    if (sc) {
      for (let i = 0; i < n; i++) { this.sL[i] = sc.L[i0 + i]; this.sR[i] = sc.R[i0 + i]; }
      ctx.scL = this.sL; ctx.scR = this.sR;
    } else { ctx.scL = null; ctx.scR = null; }
    this.inst.process(wL, wR, n, ctx);
    for (let i = 0; i < n; i++) { o.L[i0 + i] = wL[i]; o.R[i0 + i] = wR[i]; }
  }
}

// ---- input / output
class AudioInNode extends RT {
  process() { const g = this.g; this.outb.out = g.inPair || g.zero; this.outb.sc = g.scOn ? g.scPair : g.zero; }
}
class AudioOutNode extends RT {
  process(i0, i1) {
    const a = this.inb.in, g = this.g;
    if (!a) return;
    const oL = g.outL, oR = g.outR;
    for (let i = i0; i < i1; i++) { oL[i] += a.L[i]; oR[i] += a.R[i]; }
  }
}
class NoteInNode extends RT {
  constructor(spec, g) { super(spec, g); this.down = 0; }
  inject(ev) { this.down++; this.co.key = ev.key / 127; this.co.vel = ev.vel; this.co.gate = 1; this.emitOn('notes', ev); }
  injectOff(key) { if (this.down > 0) this.down--; if (!this.down) this.co.gate = 0; this.emitOff('notes', key); }
  allOff() { this.down = 0; this.co.gate = 0; }
}

// ---- control sources and shapers
class MacroNode extends RT {
  process() { const v = this.g.macros[(this.p.n | 0) - 1]; this.co.out = v === undefined ? 0 : v; }
}

class LfoNode extends RT {
  constructor(spec, g) { super(spec, g); this.ph = 0; this.last = 0; this.r0 = 0; this.r1 = 0; this.noise = new Noise(900 + spec.id * 17); }
  onNote() { if (this.p.retrig) { this.ph = 0; this.last = 0; this.r0 = this.r1; this.r1 = this.noise.next(); } }
  process(i0, i1) {
    const p = this.p, sr = this.sr, h = this.host, n = i1 - i0;
    let inc;
    if (p.sync) {
      const beats = SYNC_DIVS[p.division][1], tempo = h.tempo || 120;
      inc = (tempo / 60) / (beats * sr);
      if (h.playing) { const tps = (tempo * PPQ) / (60 * sr); this.ph = ((((h.tick || 0) + i0 * tps) / (beats * PPQ)) % 1 + 1) % 1; }
    } else inc = p.rate / sr;
    const u = (this.ph + p.phase) % 1;
    if (u < this.last) { this.r0 = this.r1; this.r1 = this.noise.next(); }
    this.last = u;
    let w;
    switch (p.shape) {
      case 1: w = u < 0.5 ? 4 * u - 1 : 3 - 4 * u; break;
      case 2: w = u < 0.5 ? 1 : -1; break;
      case 3: w = 2 * u - 1; break;
      case 4: w = 1 - 2 * u; break;
      case 5: w = this.r0; break;
      case 6: { const s = u * u * (3 - 2 * u); w = this.r0 + (this.r1 - this.r0) * s; break; }
      default: w = Math.sin(TAU * u);
    }
    this.co.out = clamp(p.offset + p.depth * w * 0.5, 0, 1);
    this.ph += inc * n; if (this.ph >= 1) this.ph -= Math.floor(this.ph);
  }
}

class EnvNode extends RT {
  constructor(spec, g) { super(spec, g); this.v = 0; this.stage = 0; this.held = 0; }   // 0 idle, 1 attack, 2 decay, 3 sustain, 4 release
  onNote() { this.held++; this.stage = 1; }
  offNote() { if (this.held > 0) this.held--; if (!this.held && this.stage) this.stage = 4; }
  allOff() { this.held = 0; if (this.stage) this.stage = 4; }
  reset() { this.held = 0; this.stage = 0; this.v = 0; this.co.out = 0; }
  process(i0, i1) {
    const p = this.p, dt = (i1 - i0) / this.sr;
    switch (this.stage) {
      case 1: this.v += dt / (p.attack * 0.001); if (this.v >= 1) { this.v = 1; this.stage = 2; } break;
      case 2: this.v = p.sustain + (this.v - p.sustain) * Math.exp((-dt * 4) / (p.decay * 0.001)); if (Math.abs(this.v - p.sustain) < 1e-4) { this.v = p.sustain; this.stage = 3; } break;
      case 3: this.v = p.sustain; break;
      case 4: this.v *= Math.exp((-dt * 4) / (p.release * 0.001)); if (this.v < 1e-4) { this.v = 0; this.stage = 0; } break;
      default: break;
    }
    this.co.out = clamp(this.v * p.amount, 0, 1);
  }
}

class FollowerNode extends RT {
  constructor(spec, g) { super(spec, g); this.e = 0; }
  reset() { this.e = 0; this.co.level = 0; }
  process(i0, i1) {
    const a = this.inb.in || this.g.zero, p = this.p, sr = this.sr;
    this.outb.out = a;
    const ca = 1 - Math.exp(-1 / (p.attack * 0.001 * sr)), cr = 1 - Math.exp(-1 / (p.release * 0.001 * sr));
    let e = this.e;
    for (let i = i0; i < i1; i++) {
      const l = a.L[i] < 0 ? -a.L[i] : a.L[i], r = a.R[i] < 0 ? -a.R[i] : a.R[i], x = l > r ? l : r;
      e += (x > e ? ca : cr) * (x - e);
    }
    this.e = e;
    this.co.level = clamp(e * Math.pow(10, p.boost / 20), 0, 1);
  }
}

class RandomNode extends RT {
  constructor(spec, g) { super(spec, g); this.noise = new Noise(300 + spec.id * 29); this.cur = 0; this.target = 0; this.first = true; }
  onNote() {
    const p = this.p;
    let t = (this.noise.next() + 1) / 2;
    if (p.steps > 0) t = Math.round(t * (p.steps - 1)) / Math.max(1, p.steps - 1);
    this.target = p.min + (p.max - p.min) * t;
  }
  process(i0, i1) {
    const p = this.p;
    if (this.first) { this.first = false; this.cur = this.target = p.min; }
    if (p.glide < 1) this.cur = this.target; else this.cur += (this.target - this.cur) * (1 - Math.exp(-(i1 - i0) / ((p.glide * 0.001) * this.sr)));
    this.co.out = clamp(this.cur, 0, 1);
  }
}

class MathNode extends RT {
  process() {
    const p = this.p, a = this.ctl('a', p.a), b = this.ctl('b', p.b);
    let v;
    switch (p.op) {
      case 1: v = a - b; break;
      case 2: v = a * b; break;
      case 3: v = a < b ? a : b; break;
      case 4: v = a > b ? a : b; break;
      case 5: v = (a + b) / 2; break;
      case 6: v = Math.abs(a - b); break;
      case 7: v = Math.pow(a, b * 4); break;
      case 8: v = 1 - a; break;
      case 9: v = a > b ? 1 : 0; break;
      default: v = a + b;
    }
    this.co.out = clamp(v, 0, 1);
  }
}

class MapNode extends RT {
  process() {
    const p = this.p, x = this.ctl('in', 0);
    let t = clamp((x - p.inLo) / (Math.abs(p.inHi - p.inLo) < 1e-6 ? 1e-6 : p.inHi - p.inLo), 0, 1);
    const c = p.curve;
    if (c > 0) t = Math.pow(t, 1 + c * 3); else if (c < 0) t = Math.pow(t, 1 / (1 - c * 3));
    if (p.steps > 0) t = Math.round(t * p.steps) / p.steps;
    this.co.out = clamp(p.outLo + (p.outHi - p.outLo) * t, 0, 1);
  }
}

// ---- audio utilities
class GainNode extends RT {
  constructor(spec, g) { super(spec, g); this.gl = 0; this.gr = 0; this.init = false; this.tmp = [0, 0]; }
  process(i0, i1) {
    const a = this.inb.in, o = this.outb.out, p = this.p;
    if (!a) { o.L.fill(0, i0, i1); o.R.fill(0, i0, i1); return; }
    if (this.bypass) { for (let i = i0; i < i1; i++) { o.L[i] = a.L[i]; o.R[i] = a.R[i]; } return; }
    panGains(p.pan, this.tmp);
    const tl = p.level * this.tmp[0], tr = p.level * this.tmp[1];
    if (!this.init) { this.gl = tl; this.gr = tr; this.init = true; }
    const n = i1 - i0, sl = (tl - this.gl) / n, sr_ = (tr - this.gr) / n;
    let gl = this.gl, gr = this.gr;
    for (let i = i0; i < i1; i++) { gl += sl; gr += sr_; o.L[i] = a.L[i] * gl; o.R[i] = a.R[i] * gr; }
    this.gl = tl; this.gr = tr;
  }
}

class XfadeNode extends RT {
  constructor(spec, g) { super(spec, g); this.ga = 0; this.gb = 0; this.init = false; }
  process(i0, i1) {
    const a = this.inb.a, b = this.inb.b, o = this.outb.out, m = this.p.mix;
    const ta = Math.cos(m * Math.PI / 2), tb = Math.sin(m * Math.PI / 2);
    if (!this.init) { this.ga = ta; this.gb = tb; this.init = true; }
    const n = i1 - i0, da = (ta - this.ga) / n, db = (tb - this.gb) / n;
    let ga = this.ga, gb = this.gb;
    for (let i = i0; i < i1; i++) {
      ga += da; gb += db;
      o.L[i] = (a ? a.L[i] * ga : 0) + (b ? b.L[i] * gb : 0);
      o.R[i] = (a ? a.R[i] * ga : 0) + (b ? b.R[i] * gb : 0);
    }
    this.ga = ta; this.gb = tb;
  }
}

// ---- note processors: every one remembers what it sent for a key so the note-off matches
class NoteProc extends RT {
  constructor(spec, g) { super(spec, g); this.held = new Map(); }
  _push(key, out) { let s = this.held.get(key); if (!s) this.held.set(key, (s = [])); s.push(out); }
  offNote(port, key) {
    const s = this.held.get(key);
    if (!s || !s.length) return;
    const out = s.shift();
    if (Array.isArray(out)) for (const k of out) this.emitOff('notes', k); else if (out !== null) this.emitOff('notes', out);
  }
  allOff() { this.held.clear(); }
}
class TransposeNode extends NoteProc {
  onNote(port, ev) { const k = clamp(ev.key + this.p.semis, 0, 127); this._push(ev.key, k); this.emitOn('notes', { ...ev, key: k }); }
}
class NoteFilterNode extends NoteProc {
  onNote(port, ev) {
    const p = this.p, v = Math.round(ev.vel * 127);
    const inside = ev.key >= p.lo && ev.key <= p.hi && v >= p.velLo && v <= p.velHi;
    if (inside === !!p.invert) { this._push(ev.key, null); return; }
    this._push(ev.key, ev.key); this.emitOn('notes', ev);
  }
}
class ChordNode extends NoteProc {
  onNote(port, ev) {
    const p = this.p, base = (CHORDS[CHORD_NAMES[p.chord]] || [0]).slice();
    for (let i = 0; i < p.inversion && i < base.length; i++) base[i] += 12;
    const keys = [];
    for (let o = 0; o < p.octaves; o++) for (const iv of base) { const k = ev.key + iv + 12 * o; if (k >= 0 && k <= 127 && !keys.includes(k)) keys.push(k); }
    this._push(ev.key, keys);
    for (const k of keys) this.emitOn('notes', { ...ev, key: k });
  }
}
class VelocityNode extends NoteProc {
  constructor(spec, g) { super(spec, g); this.noise = new Noise(77 + spec.id); }
  onNote(port, ev) {
    const p = this.p;
    let v = ev.vel;
    if (p.mode === 0) v *= p.amount; else if (p.mode === 1) v = p.fixed; else v += this.noise.next() * p.spread * 0.5;
    this._push(ev.key, ev.key);
    this.emitOn('notes', { ...ev, vel: clamp(v, 0.01, 1) });
  }
}

const IMPL = {
  inst: InstNode, fx: FxNode, audioIn: AudioInNode, audioOut: AudioOutNode, noteIn: NoteInNode, macro: MacroNode, lfo: LfoNode, env: EnvNode,
  follower: FollowerNode, random: RandomNode, math: MathNode, map: MapNode, gain: GainNode, xfade: XfadeNode,
  transpose: TransposeNode, noteFilter: NoteFilterNode, chord: ChordNode, velocity: VelocityNode,
};

// ------------------------------------------------------------------------------------------ graph
export class PatchGraph {
  constructor(sr, host, kind = 'instrument') {
    this.sr = sr; this.host = host; this.kind = kind;
    this.nodes = new Map(); this.order = [];
    this.macros = new Float64Array(MACROS).fill(0.5);
    this.cap = BLOCK;
    this.zero = pair(); this.outL = new Float32Array(BLOCK); this.outR = new Float32Array(BLOCK);
    this.inPair = { L: null, R: null }; this.scPair = { L: null, R: null }; this.scOn = false;
    this.latency = 0; this.hasFx = false; this.tail = 0; this.lastRaw = null;
    this.noteIns = [];
    this.setPatch(defaultPatch(kind));
  }

  setPatch(raw) {
    if (!raw || raw === this.lastRaw) return;
    this.lastRaw = raw;
    const patch = normalizePatch(raw, this.kind);
    const next = new Map();
    for (const spec of patch.nodes) {
      const sig = spec.type === 'inst' || spec.type === 'fx' ? `${spec.type}:${spec.ref}` : spec.type;
      let rt = this.nodes.get(spec.id);
      if (!rt || rt.sig !== sig) {
        if (rt) rt.allOff();
        rt = new IMPL[spec.type](spec, this); rt.sig = sig;
        if (this.cap > BLOCK) rt.grow(this.cap);
      }
      rt.configure(spec);
      next.set(spec.id, rt);
    }
    for (const [id, rt] of this.nodes) if (!next.has(id)) rt.allOff();
    this.nodes = next;
    this._compile(patch);
  }

  _compile(patch) {
    for (const rt of this.nodes.values()) { rt.asrc = []; rt.csrc = []; rt.nt = {}; rt.inb = {}; rt.ci = {}; }
    const out = new Map(), indeg = new Map();
    for (const rt of this.nodes.values()) { out.set(rt.id, []); indeg.set(rt.id, 0); }
    for (const w of patch.wires) {
      const src = this.nodes.get(w.from[0]), dst = this.nodes.get(w.to[0]);
      if (!src || !dst) continue;
      const type = src.ptype.out[w.from[1]];
      if (!type || type !== dst.ptype.in[w.to[1]]) continue;
      if (type === 'audio') {
        let a = dst.asrc.find((x) => x.pid === w.to[1]);
        if (!a) dst.asrc.push((a = { pid: w.to[1], srcs: [], mix: null }));
        a.srcs.push({ rt: src, port: w.from[1] });
      } else if (type === 'ctl') {
        let c = dst.csrc.find((x) => x.pid === w.to[1]);
        if (!c) dst.csrc.push((c = { pid: w.to[1], srcs: [] }));
        c.srcs.push({ rt: src, port: w.from[1] });
      } else (src.nt[w.from[1]] || (src.nt[w.from[1]] = [])).push({ rt: dst, port: w.to[1] });
      out.get(src.id).push(dst.id); indeg.set(dst.id, indeg.get(dst.id) + 1);
    }
    for (const rt of this.nodes.values()) for (const a of rt.asrc) if (a.srcs.length > 1) a.mix = pair(this.cap);
    // topological order (Kahn), stable in patch order
    const order = [], ready = [];
    for (const rt of this.nodes.values()) if (!indeg.get(rt.id)) ready.push(rt.id);
    while (ready.length) {
      const id = ready.shift();
      order.push(this.nodes.get(id));
      for (const d of out.get(id)) { indeg.set(d, indeg.get(d) - 1); if (!indeg.get(d)) ready.push(d); }
    }
    this.order = order;
    this.noteIns = order.filter((r) => r.type === 'noteIn');
    this.hasFx = order.some((r) => r.type === 'fx');
    // plugin delay compensation is reported to the mixer: the longest chain of effect latencies leading to the output
    const lat = new Map();
    let worst = 0;
    for (const rt of order) {
      let m = 0;
      for (const a of rt.asrc) for (const s of a.srcs) m = Math.max(m, lat.get(s.rt.id) || 0);
      lat.set(rt.id, m + rt.latency());
      if (rt.type === 'audioOut') worst = Math.max(worst, m);
    }
    this.latency = Math.round(worst);
  }

  // ---- notes
  noteOn(ev) { for (const n of this.noteIns) n.inject(ev); this.tail = this.hasFx ? TAIL_SECONDS * this.sr : 0; }
  noteOff(key) { for (const n of this.noteIns) n.injectOff(key); }
  allOff() { for (const rt of this.nodes.values()) rt.allOff(); }
  chokeAll() { for (const rt of this.nodes.values()) rt.chokeAll(); }
  reset() { for (const rt of this.nodes.values()) rt.reset(); this.tail = 0; }

  get active() {
    for (let i = 0; i < this.order.length; i++) if (this.order[i].busy) return true;
    return this.tail > 0;
  }

  // ---- rendering
  _grow(n) {
    this.cap = n;
    this.zero = pair(n); this.outL = new Float32Array(n); this.outR = new Float32Array(n);
    for (const rt of this.nodes.values()) rt.grow(n);
  }

  run(i0, i1) {
    if (i1 > this.cap) this._grow(i1);
    this.outL.fill(0, i0, i1); this.outR.fill(0, i0, i1);
    const order = this.order;
    for (let k = 0; k < order.length; k++) {
      const rt = order[k];
      for (let j = 0; j < rt.asrc.length; j++) {
        const a = rt.asrc[j], s = a.srcs;
        if (s.length === 1) { rt.inb[a.pid] = s[0].rt.outb[s[0].port]; continue; }
        const m = a.mix;
        m.L.fill(0, i0, i1); m.R.fill(0, i0, i1);
        for (let q = 0; q < s.length; q++) {
          const b = s[q].rt.outb[s[q].port];
          for (let i = i0; i < i1; i++) { m.L[i] += b.L[i]; m.R[i] += b.R[i]; }
        }
        rt.inb[a.pid] = m;
      }
      for (let j = 0; j < rt.csrc.length; j++) {
        const c = rt.csrc[j];
        let v = 0;
        for (let q = 0; q < c.srcs.length; q++) v += c.srcs[q].rt.co[c.srcs[q].port];
        rt.ci[c.pid] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
      if (rt.mods.length) rt.modulate();
      rt.process(i0, i1);
    }
  }

  // instrument use: add the result into the channel buffers
  renderAdd(L, R, i0, i1) {
    this.inPair.L = null; this.inPair.R = null; this.scOn = false;
    this.run(i0, i1);
    const oL = this.outL, oR = this.outR;
    for (let i = i0; i < i1; i++) { L[i] += oL[i]; R[i] += oR[i]; }
    let busy = false;
    for (let i = 0; i < this.order.length; i++) if (this.order[i].busy) { busy = true; break; }
    if (busy) this.tail = this.hasFx ? TAIL_SECONDS * this.sr : 0; else if (this.tail > 0) this.tail -= i1 - i0;
  }

  // effect use: the block comes in as L/R and is replaced by the output of the patch
  renderReplace(L, R, n, ctx) {
    this.inPair.L = L; this.inPair.R = R;
    if (ctx && ctx.scL) { this.scPair.L = ctx.scL; this.scPair.R = ctx.scR; this.scOn = true; } else this.scOn = false;
    this.run(0, n);
    const oL = this.outL, oR = this.outR;
    for (let i = 0; i < n; i++) { L[i] = oL[i]; R[i] = oR[i]; }
  }
}
