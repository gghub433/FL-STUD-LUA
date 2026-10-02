// AudioWorkletProcessor hosting the Engine. All DSP and event scheduling happen here, on the
// audio thread; the main thread only sends commands and receives meters / playhead updates.
import { Engine } from '../core/engine.js';
import { installPackHook } from '../core/packs.js';

// plugin packs are added with audioWorklet.addModule(); each one calls this when it is evaluated (the page has validated it already)
installPackHook(globalThis, { smoke: false });

const REPORT_BLOCKS = 6; // ~16 ms at 44.1 kHz

class StepwiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new Engine(sampleRate);
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
        case 'ping': this.port.postMessage({ t: 'pong', id: m.id }); break;
        default: break;
      }
    } catch (err) {
      this.port.postMessage({ t: 'error', where: m.t, message: String(err && err.message || err), stack: String(err && err.stack || '') });
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const e = this.engine;
    if (!e.project) return true;
    const t0 = Date.now();
    try {
      e.process(L, R, L.length);
    } catch (err) {
      L.fill(0); R.fill(0);
      this.port.postMessage({ t: 'error', where: 'process', message: String(err && err.message || err), stack: String(err && err.stack || '') });
      e.tr.playing = false;
    }
    // Date.now() has ms resolution; summing many blocks gives an unbiased CPU estimate.
    this.cpuMs += Date.now() - t0;
    this.audioMs += (L.length / sampleRate) * 1000;
    if (++this.blocks % REPORT_BLOCKS === 0) {
      if (this.audioMs >= 250) { this.cpu = Math.min(1, this.cpuMs / this.audioMs); this.cpuMs = 0; this.audioMs = 0; }
      const st = e.state();
      st.t = 'state';
      st.cpu = this.cpu;
      st.peaks = e.takePeaks().slice();
      this.port.postMessage(st, [st.peaks.buffer]);
      const msgs = e.drain();
      if (msgs) for (const m of msgs) this.port.postMessage(m);
    }
    return true;
  }
}

registerProcessor('stepwise-engine', StepwiseProcessor);
