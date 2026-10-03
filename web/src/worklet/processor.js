// AudioWorkletProcessor hosting the Engine. All DSP and event scheduling happen here, on the
// audio thread; the main thread only sends commands and receives meters / playhead updates.
import { Engine } from '../core/engine.js';
import { installPackHook } from '../core/packs.js';
import { LoudnessMeter } from '../core/loudness.js';
import { BLOCK, PPQ } from '../core/constants.js';
import { wamState } from '../core/wam-link.js';

// plugin packs are added with audioWorklet.addModule(); each one calls this when it is evaluated (the page has validated it already)
installPackHook(globalThis, { smoke: false });

const REPORT_BLOCKS = 6; // ~16 ms at 44.1 kHz

class StepwiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new Engine(sampleRate);
    this.engine.meter = new LoudnessMeter(sampleRate);
    this.engine.host.midiQueue = [];
    this.loud = new Array(8);
    this.blocks = 0;
    this.cpuMs = 0;
    this.audioMs = 0;
    this.cpu = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
    this.port.postMessage({ t: 'ready', sampleRate });
  }

  onMessage(m) {
    const e = this.engine;
    try {
      switch (m.t) {
        case 'init': e.setProject(m.project); break;
        case 'set': e.applyPath(m.path, m.value); break;
        case 'param': e.setParam(m.addr, m.value); break;
        case 'sample': e.addSample(m.id, m.rate, m.channels); break;
        case 'sampleDel': e.removeSample(m.id); break;
        case 'play': e.play(m.mode, m.from); break;
        case 'record': e.record(m.mode, m.from, m.countIn || 0); break;
        case 'perf': if (m.op === 'launch') e.perfLaunch(m.clip, m.quant || 0); else if (m.op === 'stop') e.perfStop(m.track, m.quant || 0); else if (m.op === 'stopAll') e.perfStop(null, m.quant || 0); break;
        case 'stop': e.stop(); break;
        case 'pause': e.pause(); break;
        case 'seek': e.seek(m.tick); break;
        case 'noteOn': e.noteOn(m.ch, m.key, m.vel); break;
        case 'noteOff': e.noteOff(m.ch, m.key); break;
        case 'panic': e.allNotesOff(true); e.mixer.reset(); break;
        case 'watch': e.watch(m.track, m.slot); break;
        case 'meterReset': e.meter.resetIntegrated(); break;
        case 'touch': e.touch(m.addr, m.on); break;
        case 'clock': e.clockOut = !!m.on; break;
        case 'wam': this.wam(m); break;
        case 'offline': e.noLoop = true; this.off = { end: m.end, tailMax: Math.round((m.tail === 'auto' ? 20 : m.tail) * sampleRate), auto: m.tail === 'auto', frames: 0, stopped: false, body: 0, tail: 0, quiet: 0, done: false }; break;
        case 'ping': this.port.postMessage({ t: 'pong', id: m.id }); break;
        default: break;
      }
    } catch (err) {
      this.port.postMessage({ t: 'error', where: m.t, message: String(err && err.message || err), stack: String(err && err.stack || '') });
    }
  }

  // WAM plugins: the host group of this page (its processors share this scope), and which port each plugin uses
  wam(m) {
    const w = wamState(this.engine.host);
    if (m.op === 'group') {
      try { w.group = globalThis.webAudioModules ? globalThis.webAudioModules.getGroup(m.id, m.key) : null; } catch (_) { w.group = null; }
    } else if (m.op === 'port') this.engine.wamPort(m.owner, m);
    else if (m.op === 'unport') this.engine.wamPort(m.owner, null);
    this.wamTransport = null;
  }

  // tells the plugins when the transport starts or stops and the tempo (wam-transport events)
  wamSync() {
    const e = this.engine, w = e.host.wam;
    if (!w || !w.group || !w.ports.size) return;
    const playing = e.tr.playing && e.tr.countIn <= 0, tempo = e.project.tempo;
    const key = `${playing}|${tempo}`;
    if (key === this.wamTransport) return;
    this.wamTransport = key;
    const tick = Math.max(0, e.tr.tick), b = e.timeMap.bbt(tick), sig = b.sig;
    const inBar = tick - e.timeMap.barStart(b.bar);
    const data = { tempo, timeSigNumerator: sig.num, timeSigDenominator: sig.den, playing, currentBar: b.bar - 1,
      currentBarStarted: currentTime + BLOCK / sampleRate - (inBar * 60) / (tempo * PPQ) };
    for (const link of w.ports.values()) {
      const proc = w.group.processors.get(link.instanceId);
      if (proc) proc.scheduleEvents({ type: 'wam-transport', time: currentTime + BLOCK / sampleRate, data });
    }
  }

  // export through Web Audio (projects with WAM plugins): stop at the end, ring out, then report where the audio ends
  offline(L, R) {
    const o = this.off, e = this.engine;
    if (o.done) return;
    if (o.stopped) {
      o.tail += L.length;
      if (o.auto) {
        let peak = 0;
        for (let i = 0; i < L.length; i++) { const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (a > peak) peak = a; }
        o.quiet = peak < 1e-4 ? o.quiet + L.length : 0;
      }
      if (o.tail >= o.tailMax || (o.auto && o.quiet > sampleRate * 0.4)) {
        o.done = true;
        this.port.postMessage({ t: 'offlineDone', frames: o.frames, bodyFrames: o.body, loudness: e.meter.stats() });
      }
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const e = this.engine;
    if (!e.project) return true;
    const t0 = Date.now();
    e.frameOffset = currentFrame - e.frame;                 // MIDI timestamps are in the audio clock's frames
    const send = outputs[1];
    if (send) for (let c = 0; c < send.length; c++) send[c].fill(0);
    e.host.extIn = inputs[0] && inputs[0].length ? inputs[0] : null;
    e.host.extOut = send && send.length ? send : null;
    const o = this.off;
    if (o && !o.stopped && (!e.tr.playing || e.tr.tick >= o.end)) {
      e.stop(); o.stopped = true; o.body = o.frames;
      if (o.tailMax <= 0) { o.done = true; this.port.postMessage({ t: 'offlineDone', frames: o.frames, bodyFrames: o.body, loudness: e.meter.stats() }); }
    }
    try {
      e.process(L, R, L.length);
    } catch (err) {
      L.fill(0); R.fill(0);
      this.port.postMessage({ t: 'error', where: 'process', message: String(err && err.message || err), stack: String(err && err.stack || '') });
      e.tr.playing = false;
    }
    if (o) { o.frames += L.length; this.offline(L, R); }
    this.wamSync();
    // MIDI goes out every block, not with the meters: it is scheduled ahead and must not wait
    const mq = e.host.midiQueue;
    if (mq.length) { this.port.postMessage({ t: 'midi', events: mq.splice(0) }); }
    // Date.now() has ms resolution; summing many blocks gives an unbiased CPU estimate.
    this.cpuMs += Date.now() - t0;
    this.audioMs += (L.length / sampleRate) * 1000;
    if (++this.blocks % REPORT_BLOCKS === 0) {
      if (this.audioMs >= 250) { this.cpu = Math.min(1, this.cpuMs / this.audioMs); this.cpuMs = 0; this.audioMs = 0; }
      const st = e.state();
      st.t = 'state';
      st.cpu = this.cpu;
      st.peaks = e.takePeaks().slice();
      st.loud = e.meter.snapshot(this.loud);
      this.port.postMessage(st, [st.peaks.buffer]);
      const msgs = e.drain();
      if (msgs) for (const m of msgs) this.port.postMessage(m);
    }
    return true;
  }
}

registerProcessor('stepwise-engine', StepwiseProcessor);
