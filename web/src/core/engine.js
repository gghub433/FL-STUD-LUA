// The audio engine. No DOM, no Web Audio: process() fills output buffers, so the same
// class runs inside the AudioWorklet (live), in a Worker (export) and in Node (tests).
//
// Timing model: the transport position is a float in ticks. For every 128-frame block we
// convert the tick span into sample offsets (ticks-per-sample derives from the tempo), walk the
// compiled event list with a cursor and render the instruments in slices between events.
// Notes therefore start on the exact sample, independent of any JS timer or message latency.
import { BLOCK, PPQ, MAX_INSERT } from './constants.js';
import { faderGain, clamp, TAU } from './dsp.js';
import { Sequencer, EV_ON, EV_OFF, EV_AUDIO_ON, EV_AUDIO_OFF } from './sequencer.js';
import { Mixer } from './mixer.js';
import { TimeMap } from './timemap.js';
import { evalPoints } from './automation.js';
import { parseAddr, paramDef, setParam as setProjectParam } from './addr.js';
import { fromNorm } from './schema.js';
import { currentArrangement } from './project.js';
import { hasInstrument, createInstrument } from './instruments/index.js';
import { AudioClipPlayer } from './instruments/audioclip.js';

const EPS = 1e-9;

class ChannelRT {
  constructor(data, engine) {
    this.id = data.id; this.type = data.type; this.data = data; this.engine = engine;
    this.bufL = new Float32Array(BLOCK); this.bufR = new Float32Array(BLOCK);
    this.inst = null;
    this.live = false;
    this.gL = 0; this.gR = 0; this.gInit = false;
    this.vol = 0.8; this.pan = 0; this.pitch = 0; this.mixer = 0; this.enabled = true;
    if (hasInstrument(data.type)) this.inst = createInstrument(data.type, engine.sr, engine.host);
    else if (data.type === 'audio') this.inst = new AudioClipPlayer(engine.sr, engine.host);
  }

  apply(data) {
    this.data = data;
    this.vol = data.vol; this.pan = data.pan; this.pitch = data.pitch; this.mixer = data.mixer;
    const was = this.enabled;
    this.enabled = data.enabled !== 0;
    if (was && !this.enabled && this.inst) this.inst.allOff();
    if (this.inst && data.params) for (const k in data.params) this.inst.setParam(k, data.params[k]);
    if (this.inst && (data.type === 'sampler' || data.type === 'audio') && this.inst.setParam) {
      this.inst.setParam('sampleId', data.sample ? (data.sample.use || data.sample.id) : null);
    }
    if (this.inst && this.inst.setData) this.inst.setData(data);
  }
}

export class Engine {
  constructor(sr = 44100) {
    this.sr = sr;
    this.samples = new Map();
    this.host = { getSample: (id) => this.samples.get(id) || null, sr, midiQueue: null, evFrame: 0 };
    this.project = null;
    this.mixer = new Mixer(sr, this.host);
    this.channels = new Map();
    this.chList = [];
    this.seq = new Sequencer();
    this.timeMap = new TimeMap({ num: 4, den: 4 });
    this.tr = {
      playing: false, paused: false, mode: 'pat', tick: 0, startTick: 0, recording: false,
      countIn: 0, countInTotal: 0, loopS: 0, loopE: Infinity,
    };
    this.dirty = true;
    this.noLoop = false;      // offline rendering never loops
    this.live = [];
    this.held = new Map();
    this.perf = [];            // performance mode: [{ clip, start, stop }]
    this.evs = [];
    this.out = [];
    this.lastAuto = new Map();
    this.autoDefs = new Map();
    this.autoOut = new Map();
    this.swingApplied = 0;
    this.masterPitch = 0;
    this.click = { on: false, phase: 0, inc: 0, env: 0, k: 0, amp: 0 };
    this.frame = 0;
    this.peakBuf = new Float32Array((MAX_INSERT + 1) * 2);
    this.meter = null;         // LoudnessMeter on the master output (live engine and export set one)
    this.touched = new Set();  // parameters held by the hand while automation is recorded: their automation pauses
    // MIDI out: the live engine sets host.midiQueue = []; messages carry the frame they belong to
    this.frameOffset = 0;      // frame of the audio clock minus this.frame (set by the worklet every block)
    this.clockOut = false;     // MIDI clock (24 per quarter note), Start / Continue / Stop and song position
    this.clockPhase = 0;
  }

  // ------------------------------------------------------------------ project sync
  setProject(project) {
    this.project = project;
    this.masterPitch = project.masterPitch || 0;
    this._syncChannels();
    this.mixer.setProject(project);
    this.autoDefs.clear();
    this.dirty = true;
  }

  applyPath(path, value) {
    const p = this.project;
    if (!p) return;
    let o = p;
    for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
    const last = path[path.length - 1];
    if (value === undefined) delete o[last]; else o[last] = value;
    switch (path[0]) {
      case 'channels': this._syncChannels(); this.autoDefs.clear(); this.dirty = true; break;
      case 'patterns': case 'playlist': case 'timeSig': this.dirty = true; break;
      case 'currentPattern': this.dirty = true; break;
      case 'mixer':
        if (path[1] === 'tracks' && path.length >= 3) this.mixer.updateTrack(path[2], p.mixer.tracks[path[2]]);
        else if (path.length <= 2 && path[1] !== 'selected') this.mixer.setProject(p);   // whole mixer / all tracks
        this.autoDefs.clear();
        break;
      case 'swing': this.dirty = true; break;
      case 'masterPitch': this.masterPitch = p.masterPitch; break;
      default: break;
    }
  }

  _syncChannels() {
    const next = new Map();
    for (const data of this.project.channels) {
      let rt = this.channels.get(data.id);
      if (!rt || rt.type !== data.type) {
        if (rt && rt.inst) rt.inst.allOff();
        rt = new ChannelRT(data, this);
      }
      rt.apply(data);
      next.set(data.id, rt);
    }
    this.channels = next;
    this.chList = [...next.values()];
  }

  addSample(id, rate, channels) {
    const ch = channels.length > 1 ? [channels[0], channels[1]] : [channels[0]];
    let peak = 0;
    for (const c of ch) for (let i = 0; i < c.length; i++) { const a = c[i] < 0 ? -c[i] : c[i]; if (a > peak) peak = a; }
    this.samples.set(id, { rate, ch, length: ch[0].length, peak });
  }

  removeSample(id) { this.samples.delete(id); }

  // ------------------------------------------------------------------ parameters
  setParam(addr, value) {
    const a = parseAddr(addr);
    if (!a) return;
    const d = paramDef(this.project, a);
    if (!d) return;
    const v = setProjectParam(this.project, a, value);
    if (v === undefined) return;
    this._applyRuntime(a, v);
  }

  _applyRuntime(a, v) {
    switch (a.kind) {
      case 'ch': {
        const rt = this.channels.get(a.id);
        if (rt) { rt[a.key] = v; }
        break;
      }
      case 'chp': { const rt = this.channels.get(a.id); if (rt && rt.inst) rt.inst.setParam(a.key, v); break; }
      case 'mx': this.mixer.setTrackParam(a.track, a.key, v); break;
      case 'fxs': case 'fxp': this.mixer.setSlotParam(a.track, a.slot, a.key, v); break;
      case 'master':
        if (a.key === 'vol') this.mixer.setTrackParam(0, 'vol', v); else this.masterPitch = v;
        break;
      case 'transport': if (a.key === 'swing') this.dirty = true; break;
      default: break;
    }
  }

  // ------------------------------------------------------------------ transport
  get tps() { return (this.project.tempo * PPQ) / (60 * this.sr); } // ticks per sample

  _compile() {
    const p = this.project, tr = this.tr;
    if (tr.mode === 'song') {
      const arr = currentArrangement(p);
      this.seq.compileSong(p, arr, p.swing);
      this.timeMap = new TimeMap(p.timeSig, arr.markers);
      tr.loopS = arr.loop ? arr.loop.s : 0;
      tr.loopE = arr.loop ? arr.loop.e : Infinity;
    } else if (tr.mode === 'perf') {
      const arr = currentArrangement(p);
      this.seq.compilePerf(p, arr, p.swing, this.perf, tr.tick);
      this.timeMap = new TimeMap(p.timeSig, arr.markers);
      tr.loopS = 0; tr.loopE = Infinity;
    } else {
      this.seq.compilePattern(p, p.currentPattern, p.swing);
      this.timeMap = new TimeMap(p.timeSig, []);
      tr.loopS = 0; tr.loopE = this.seq.length;
    }
    if (this.noLoop) { tr.loopS = 0; tr.loopE = Infinity; }
    this.dirty = false;
    this.seq.seek(Math.max(0, tr.tick));
  }

  startPosition(mode) {
    if (mode !== 'song') return 0;
    const arr = currentArrangement(this.project);
    return arr.start != null ? arr.start : arr.loop ? arr.loop.s : 0;
  }

  play(mode, from) {
    const tr = this.tr;
    if (tr.paused && from === undefined && mode === tr.mode) {
      tr.paused = false; tr.playing = true;
      this.seek(tr.tick);
      return;
    }
    this.allNotesOff(true);
    tr.mode = mode === 'song' ? 'song' : mode === 'perf' ? 'perf' : 'pat';
    if (tr.mode === 'perf') this.perf = [];
    tr.tick = from !== undefined ? from : this.startPosition(tr.mode);
    tr.startTick = tr.tick;
    tr.paused = false;
    tr.countIn = 0;
    if (this.meter) this.meter.resetIntegrated();          // integrated loudness measures this playthrough
    this._compile();
    this._startAudioMidway();
    this.lastAuto.clear();
    this.autoOut.clear();
    this._applyAutomation(tr.tick);
    tr.playing = true;
    this._midiStart(tr.tick);
  }

  // ---- MIDI out: song position + Start / Continue, programs of MIDI Out channels; Stop
  _midi(data, port = null, clock = false) {
    const q = this.host.midiQueue;
    if (q && q.length < 4096) q.push({ port, data, clock, frame: this.host.evFrame || 0 });
  }

  _midiStart(tick) {
    if (!this.host.midiQueue) return;
    this.host.evFrame = this.frame + this.frameOffset;
    for (const rt of this.chList) if (rt.type === 'midiout' && rt.inst) rt.inst.sendProgram();
    if (!this.clockOut) return;
    const spp = Math.max(0, Math.floor(tick / (PPQ / 4)));           // MIDI beats = sixteenth notes
    if (spp > 0) { this._midi([0xf2, spp & 127, (spp >> 7) & 127], null, true); this._midi([0xfb], null, true); }
    else this._midi([0xfa], null, true);
    this.clockPhase = PPQ / 24;                                       // the first clock goes out with the start
  }

  _midiClock(m) {
    const per = PPQ / 24, adv = m * this.tps;
    let need = per - this.clockPhase;
    while (need <= adv + 1e-9) {
      this.host.evFrame = this.frame + this.frameOffset + Math.min(m - 1, Math.max(0, Math.round(need / this.tps)));
      this._midi([0xf8], null, true);
      need += per;
    }
    this.clockPhase = (this.clockPhase + adv) % per;
  }

  record(mode, from, countInBars) {
    this.play(mode, from);
    this.tr.recording = true;
    if (countInBars > 0) {
      const bar = this.timeMap.barLenAt(this.tr.tick);
      this.tr.countIn = countInBars * bar;
      this.tr.countInTotal = this.tr.countIn;
      this.tr.tick = this.tr.startTick - this.tr.countIn;
    }
  }

  stop() {
    const tr = this.tr;
    const wasPlaying = tr.playing || tr.paused;
    this.host.evFrame = this.frame + this.frameOffset;
    if (this.clockOut && tr.playing) this._midi([0xfc], null, true);
    tr.playing = false; tr.paused = false; tr.recording = false; tr.countIn = 0;
    this.touched.clear();
    this.allNotesOff(true);
    tr.tick = wasPlaying ? tr.startTick : tr.tick;
    this.lastAuto.clear();
  }

  pause() {
    const tr = this.tr;
    if (!tr.playing) return;
    this.host.evFrame = this.frame + this.frameOffset;
    if (this.clockOut) this._midi([0xfc], null, true);
    tr.playing = false; tr.paused = true;
    this.allNotesOff(false);
  }

  seek(tick) {
    const tr = this.tr;
    tr.tick = tick;
    if (tr.playing) {
      this.allNotesOff(false);
      if (this.dirty) this._compile();
      this.seq.seek(Math.max(0, tick));
      this._startAudioMidway();
      this.lastAuto.clear();
      this._applyAutomation(tick);
    } else if (!tr.paused) tr.startTick = tick;
  }

  // ------------------------------------------------------------------ performance mode
  // Clips are launched live. quant = ticks to wait for (0 = at once); the clip starts on that boundary.
  _perfBoundary(quant) { const t = Math.max(0, this.tr.tick); return quant > 0 ? Math.ceil(t / quant - 1e-9) * quant : Math.ceil(t); }

  _perfEnsure() {
    const tr = this.tr;
    if (!(tr.playing && tr.mode === 'perf')) { this.play('perf', 0); tr.tick = 0; }
  }

  perfLaunch(clipId, quant) {
    const arr = currentArrangement(this.project);
    const clip = arr.clips.find((c) => c.id === clipId);
    if (!clip) return;
    this._perfEnsure();
    const start = this._perfBoundary(quant);
    for (const en of this.perf) if (en.clip.track === clip.track && (en.stop == null || en.stop > start)) en.stop = start;
    this.perf.push({ clip, start, stop: null });
    this._perfRecompile();
  }

  perfStop(track, quant) {
    const tr = this.tr;
    if (!(tr.playing && tr.mode === 'perf')) return;
    const at = this._perfBoundary(quant);
    for (const en of this.perf) if ((track == null || en.clip.track === track) && (en.stop == null || en.stop > at)) en.stop = Math.max(at, en.start);
    this._perfRecompile();
  }

  _perfRecompile() {
    const tr = this.tr;
    this.perf = this.perf.filter((en) => en.stop == null || en.stop > tr.tick - 1);
    this._compile();
    this.out.push({ t: 'perf', entries: this.perf.map((en) => ({ clipId: en.clip.id, track: en.clip.track, start: en.start, stop: en.stop })) });
  }

  // hard = cut every voice immediately; otherwise only release notes the sequencer is holding
  allNotesOff(hard) {
    if (hard) {
      for (const rt of this.chList) if (rt.inst) rt.inst.allOff();
      this.held.clear();
    } else {
      this._releaseHeld();
      for (const rt of this.chList) if (rt.type === 'audio' && rt.inst) rt.inst.chokeAll();
    }
  }

  _releaseHeld() {
    for (const ev of this.held.values()) this._dispatchOff(ev.ch, ev.key, 0);
    this.held.clear();
  }

  _startAudioMidway() {
    const tr = this.tr;
    if (tr.mode !== 'song' || tr.tick <= 0) return;
    for (const a of this.seq.audioActiveAt(tr.tick)) this._startClip(a.clip, a.ch, tr.tick - a.s);
  }

  _startClip(clip, chId, offsetTicks) {
    const rt = this.channels.get(chId);
    if (!rt || !rt.enabled || !rt.inst || !rt.data.sample) return;
    const sec = 60 / this.project.tempo / PPQ;
    const sid = clip.use || rt.data.sample.id;              // clip.use: derived (time-stretched) sample
    const smp = this.samples.get(sid) || this.samples.get(rt.data.sample.id);
    if (!smp) return;
    const lenTicks = clip.l - offsetTicks;
    if (lenTicks <= 0) return;
    this._prepare(rt);
    rt.inst.start({
      clipId: clip.id, sampleId: this.samples.has(sid) ? sid : rt.data.sample.id,
      // reversed clips play their window [o, o + l) backwards, so they start at its end
      startSrc: (clip.rev ? clip.o + clip.l - offsetTicks : clip.o + offsetTicks) * sec * smp.rate,
      lenFrames: Math.max(1, Math.round(lenTicks * sec * this.sr)),
      gain: clip.gain ? Math.pow(10, clip.gain / 20) : 1,
      fadeIn: Math.round((clip.fi || 0) * sec * this.sr), fadeOut: Math.round((clip.fo || 0) * sec * this.sr),
      rev: clip.rev, rate: clip.pitch ? Math.pow(2, clip.pitch / 12) : 1, norm: clip.norm,
    });
  }

  // ------------------------------------------------------------------ notes
  _prepare(rt) {
    if (rt.live) return;
    rt.bufL.fill(0); rt.bufR.fill(0);
    rt.live = true;
    this.live.push(rt);
  }

  noteOn(chId, key, vel = 0.8, opts) {
    this.host.evFrame = this.frame + this.frameOffset;
    const ev = { key, vel, pan: 0, rel: 64, fine: 0, mx: 128, my: 128, slide: 0, len: 0, nid: 0 };
    if (opts) Object.assign(ev, opts);
    this._dispatchOn(chId, ev, 0);
    const tr = this.tr;
    if (tr.recording && tr.playing && tr.tick >= 0 && !(opts && opts.fromSeq)) {
      this.out.push({ t: 'rec', on: 1, ch: chId, key, vel, tick: tr.tick });
    }
  }

  noteOff(chId, key, opts) {
    this.host.evFrame = this.frame + this.frameOffset;
    this._dispatchOff(chId, key, 0);
    const tr = this.tr;
    if (tr.recording && tr.playing && tr.tick >= 0 && !(opts && opts.fromSeq)) {
      this.out.push({ t: 'rec', on: 0, ch: chId, key, tick: tr.tick });
    }
  }

  _dispatchOn(chId, ev, depth) {
    const rt = this.channels.get(chId);
    if (!rt || !rt.enabled || depth > 4) return;
    if (rt.type === 'layer') {
      for (const c of rt.data.children || []) this._dispatchOn(c, ev, depth + 1);
      return;
    }
    if (!rt.inst || rt.type === 'audio') return;
    this._prepare(rt);
    const o = {
      key: ev.key, vel: ev.vel, pan: ev.pan, rel: ev.rel, slide: ev.slide, len: ev.len ? ev.len / this.tps : 0,
      mx: ev.mx, my: ev.my, id: ev.nid,
      fine: ev.fine + (rt.pitch + this.masterPitch) * 100,
    };
    const g = rt.inst.p && rt.inst.p.cutGroup;
    if (g > 0) {
      for (const other of this.chList) {
        if (other !== rt && other.inst && other.inst.p && other.inst.p.cutBy === g) other.inst.chokeAll();
      }
    }
    rt.inst.noteOn(o);
  }

  _dispatchOff(chId, key, depth) {
    const rt = this.channels.get(chId);
    if (!rt || depth > 4) return;
    if (rt.type === 'layer') {
      for (const c of rt.data.children || []) this._dispatchOff(c, key, depth + 1);
      return;
    }
    if (rt.inst && rt.type !== 'audio') rt.inst.noteOff(key);
  }

  // ------------------------------------------------------------------ automation
  _autoDef(target) {
    let d = this.autoDefs.get(target);
    if (d === undefined) {
      const a = parseAddr(target);
      const def = a && paramDef(this.project, a);
      d = def ? { a, def } : null;
      this.autoDefs.set(target, d);
    }
    return d;
  }

  _applyAutomation(tick) {
    if (!this.seq.autos.size) return;
    for (const [target, list] of this.seq.autos) {
      if (this.touched.size && this.touched.has(target)) continue;
      // last clip starting at or before `tick`
      let lo = -1, hi = list.length;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (list[mid].s <= tick) lo = mid; else hi = mid; }
      if (lo < 0) continue;
      const c = list[lo];
      const t = Math.min(tick, c.e) - c.s + c.o;
      const n = evalPoints(c.ch.points, t);
      if (n === null) continue;
      const d = this._autoDef(target);
      if (!d) continue;
      const v = fromNorm(d.def, n);
      const prev = this.lastAuto.get(target);
      if (prev !== undefined && Math.abs(prev - v) < 1e-7) continue;
      this.lastAuto.set(target, v);
      if (d.a.kind === 'transport' && d.a.key === 'tempo') { this.project.tempo = v; continue; }
      setProjectParam(this.project, d.a, v);
      this._applyRuntime(d.a, v);
      this.autoOut.set(target, v);
    }
  }

  _applyControllers(m) {
    for (const rt of this.chList) {
      if (rt.type !== 'controller' || !rt.enabled || !rt.inst) continue;
      const links = rt.data.links;
      const v = rt.inst.control(m);
      if (!links || !links.length) continue;
      for (const l of links) {
        const d = this._autoDef(l.addr);
        if (!d) continue;
        const a = l.min + (l.max - l.min) * (l.inv ? 1 - v : v);
        const val = fromNorm(d.def, a);
        const key = `${rt.id}>${l.addr}`;
        const prev = this.lastAuto.get(key);
        if (prev !== undefined && Math.abs(prev - val) < 1e-7) continue;
        this.lastAuto.set(key, val);
        if (d.a.kind === 'transport' && d.a.key === 'tempo') { this.project.tempo = val; continue; }
        setProjectParam(this.project, d.a, val);
        this._applyRuntime(d.a, val);
        this.autoOut.set(l.addr, val);
      }
    }
  }

  // ------------------------------------------------------------------ rendering
  process(outL, outR, n, offset = 0) {
    let done = 0;
    while (done < n) {
      const m = Math.min(BLOCK, n - done);
      this._block(outL, outR, offset + done, m);
      done += m;
    }
  }

  _block(outL, outR, off, m) {
    const tr = this.tr, mixer = this.mixer;
    if (this.dirty || Math.abs(this.project.swing - this.swingApplied) > 0.001) {
      this.swingApplied = this.project.swing;
      this._compile();
    }
    this.live.length = 0;
    for (const rt of this.chList) {
      rt.live = false;
      if (rt.inst && rt.inst.active) this._prepare(rt);
    }
    mixer.clearBuffers();
    this.host.tempo = this.project.tempo;
    this.host.tick = tr.tick;
    this.host.playing = tr.playing;

    // ---- collect events for this block (sample offsets) ----
    const evs = this.evs;
    evs.length = 0;
    this.host.evFrame = this.frame + this.frameOffset;
    if (tr.playing && this.clockOut && this.host.midiQueue && tr.countIn <= 0) this._midiClock(m);
    if (tr.playing) this._collect(m, evs);

    // ---- controllers (LFO / Envelope) write their value into the linked parameters once per block ----
    this._applyControllers(m);

    // ---- render instruments in slices between events ----
    let pos = 0;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      const o = e.off > m ? m : e.off;
      if (o > pos) { this._renderSlice(pos, o); pos = o; }
      this.host.evFrame = this.frame + this.frameOffset + o;
      this._apply(e);
    }
    if (pos < m) this._renderSlice(pos, m);

    // ---- channels -> mixer ----
    const live = this.live;
    for (let k = 0; k < live.length; k++) {
      const rt = live[k];
      const g = faderGain(rt.vol);
      const a = (clamp(rt.pan, -1, 1) + 1) * 0.7853981634;
      const tl = g * Math.cos(a) * 1.41421356, tR = g * Math.sin(a) * 1.41421356;
      if (!rt.gInit) { rt.gL = tl; rt.gR = tR; rt.gInit = true; }
      const sl = (tl - rt.gL) / m, sr_ = (tR - rt.gR) / m;
      let gl = rt.gL, gr = rt.gR;
      const L = rt.bufL, R = rt.bufR;
      for (let i = 0; i < m; i++) { gl += sl; gr += sr_; L[i] *= gl; R[i] *= gr; }
      rt.gL = tl; rt.gR = tR;
      mixer.feed(rt.mixer, L, R, m, 1, 1);
    }

    const master = mixer.process(m);
    if (mixer.tap && mixer.analyzer.ready) {
      const tp = mixer.tap;
      this.out.push({ t: 'spectrum', track: tp.track, slot: tp.slot, mags: mixer.analyzer.compute() });
      const slot = tp.slot >= 0 ? mixer.tracks[tp.track].fx[tp.slot] : null;
      if (slot) this.out.push({ t: 'fxmeter', track: tp.track, slot: tp.slot, values: slot.inst.meters ? Array.from(slot.inst.meters) : [], status: slot.inst.status || '' });
    }
    const mL = master.inL, mR = master.inR;
    for (let i = 0; i < m; i++) { outL[off + i] = mL[i]; outR[off + i] = mR[i]; }
    if (this.meter) this.meter.process(mL, mR, m);            // before the metronome click
    if (this.click.on) this._renderClick(outL, outR, off, m);
    this.frame += m;
  }

  _renderSlice(a, b) {
    const live = this.live;
    for (let k = 0; k < live.length; k++) {
      const rt = live[k];
      if (rt.inst) rt.inst.process(rt.bufL, rt.bufR, a, b);
    }
  }

  // Walk transport time across the block, emitting {off, kind, ev} entries.
  _collect(m, evs) {
    const tr = this.tr, seq = this.seq, tm = this.timeMap;
    const tps = this.tps;
    let tick = tr.tick;
    let o = 0;
    const metro = !!(this.project.settings && this.project.settings.metronome);
    // keep tick inside the loop if the loop shrank
    if (tr.countIn <= 0 && tr.loopE !== Infinity && tick >= tr.loopE) {
      tick = tr.loopS + ((tick - tr.loopS) % Math.max(1, tr.loopE - tr.loopS));
    }

    while (o < m) {
      let seg = m - o;
      let wrap = false;
      const counting = tr.countIn > 0;
      const loopE = counting ? Infinity : tr.loopE;
      if (counting) {
        const at = Math.max(1, Math.ceil((0 - tick) / tps - EPS));
        if (at <= seg) { seg = at; tr.countIn = 0; evs.push({ off: o + seg, kind: 'countin-done' }); }
      } else if (loopE !== Infinity) {
        const at = Math.max(1, Math.ceil((loopE - tick) / tps - EPS));
        if (at <= seg) { seg = at; wrap = true; }
      }
      const segEnd = tick + seg * tps;
      const limit = counting ? segEnd : Math.min(segEnd, loopE);

      // metronome: beats in [tick, limit)
      if (metro || counting) {
        const bl0 = tm.beatLenAt(0);
        let b = tick < 0 ? Math.ceil(tick / bl0 - EPS) * bl0 : tm.atOrAfterBeat(tick);
        while (b < limit - EPS) {
          const co = o + clamp(Math.ceil((b - tick) / tps - EPS), 0, seg - 1);
          const accent = b < 0 ? ((b + tr.countInTotal) % tm.barLenAt(0) === 0) : tm.isBarStart(b);
          evs.push({ off: co, kind: 'click', accent });
          b = b < 0 ? b + bl0 : tm.nextBeat(b);
        }
      }

      // sequencer events (never during the count-in)
      if (!counting) {
        let e;
        while ((e = seq.next(limit)) !== null) {
          const co = o + clamp(Math.ceil((e.t - tick) / tps - EPS), 0, seg - 1);
          evs.push({ off: co, kind: 'seq', ev: e });
        }
      }

      tick = segEnd;
      o += seg;
      if (wrap) {
        evs.push({ off: o, kind: 'wrap' });
        tick = tr.loopS + (tick - loopE);
        seq.seek(tr.loopS); // events at the loop start fall inside the sub-sample overshoot
      }
    }
    tr.tick = tick;

    // song ended (no loop region)
    if (tr.mode === 'song' && tr.loopE === Infinity && !tr.recording && tr.countIn <= 0 && tr.tick >= seq.length + 1) {
      evs.push({ off: m, kind: 'end' });
    }
    // automation is evaluated once per block
    if (tr.tick >= 0) this._applyAutomation(tr.tick);
    if (evs.length > 1) evs.sort((x, y) => x.off - y.off);
  }

  _apply(e) {
    switch (e.kind) {
      case 'seq': {
        const ev = e.ev;
        if (ev.k === EV_ON) { this.held.set(ev.ch + ':' + ev.key, ev); this._dispatchOn(ev.ch, ev, 0); }
        else if (ev.k === EV_OFF) { this.held.delete(ev.ch + ':' + ev.key); this._dispatchOff(ev.ch, ev.key, 0); }
        else if (ev.k === EV_AUDIO_ON) this._startClip(ev.clip, ev.ch, 0);
        else if (ev.k === EV_AUDIO_OFF) { const rt = this.channels.get(ev.ch); if (rt && rt.inst && rt.inst.stopClip) rt.inst.stopClip(ev.clip.id); }
        break;
      }
      case 'wrap':
        this._releaseHeld();
        for (const rt of this.chList) if (rt.type === 'audio' && rt.inst) rt.inst.chokeAll();
        this.lastAuto.clear();
        this._startAudioMidway();
        this.out.push({ t: 'wrap' });
        break;
      case 'click': {
        const c = this.click;
        c.on = true; c.phase = 0; c.env = 1;
        c.inc = (e.accent ? 1500 : 1000) / this.sr;
        c.amp = e.accent ? 0.55 : 0.35;
        c.k = Math.exp(-4.6 / (0.03 * this.sr));
        break;
      }
      case 'countin-done':
        this.out.push({ t: 'countin-done' });
        break;
      case 'end':
        this.tr.playing = false; this.tr.recording = false;
        this._releaseHeld();
        this.tr.tick = this.tr.startTick;
        this.out.push({ t: 'ended' });
        break;
      default: break;
    }
  }

  _renderClick(outL, outR, off, m) {
    const c = this.click;
    for (let i = 0; i < m; i++) {
      const s = Math.sin(TAU * c.phase) * c.env * c.amp;
      c.phase += c.inc; if (c.phase >= 1) c.phase -= 1;
      c.env *= c.k;
      outL[off + i] += s; outR[off + i] += s;
      if (c.env < 0.001) { c.on = false; break; }
    }
  }

  touch(addr, on) { if (on) this.touched.add(addr); else this.touched.delete(addr); }

  // UI asks for a spectrum (and effect meters) of one effect slot, or of a track output (slot -1)
  watch(track, slot) { this.mixer.setTap(track == null ? null : { track, slot }); }

  // ------------------------------------------------------------------ reporting
  state() {
    const tr = this.tr;
    return { playing: tr.playing, paused: tr.paused, mode: tr.mode, tick: tr.tick, recording: tr.recording, frame: this.frame, tempo: this.project ? this.project.tempo : 130 };
  }

  takePeaks() { return this.mixer.takePeaks(this.peakBuf); }

  drain() {
    if (!this.out.length && !this.autoOut.size) return null;
    const msgs = this.out;
    this.out = [];
    if (this.autoOut.size) {
      msgs.push({ t: 'auto', values: [...this.autoOut] });
      this.autoOut.clear();
    }
    return msgs;
  }
}
