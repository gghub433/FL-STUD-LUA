// Main-thread side of the engine: owns the AudioContext, the worklet node and the message
// protocol. Everything audio-related that the UI needs goes through here.
import { Bus } from '../app/bus.js';
import { PPQ } from '../core/constants.js';

export class AudioHost {
  constructor() {
    this.bus = new Bus();
    this.ctx = null;
    this.node = null;
    this.analyser = null;
    this.ready = false;
    this.sampleRate = 44100;
    this.queue = [];
    this.st = { playing: false, paused: false, mode: 'pat', tick: 0, tempo: 130, recording: false, cpu: 0, recv: 0, frame: 0 };
    this.peaks = new Float32Array(252);
    this.error = null;
  }

  async init(workletUrl) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio is not supported in this browser');
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    this.sampleRate = this.ctx.sampleRate;
    await this.ctx.audioWorklet.addModule(workletUrl);
    this.node = new AudioWorkletNode(this.ctx, 'stepwise-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.7;
    this.node.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.node.port.onmessage = (e) => this._onMessage(e.data);
    this.node.onprocessorerror = () => { this.error = 'audio processor crashed'; this.bus.emit('error', this.error); };
    this.ready = true;
    for (const [m, t] of this.queue) this.node.port.postMessage(m, t || []);
    this.queue = [];
    // browsers keep the context suspended until a user gesture
    const resume = () => this.resume();
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, resume, { capture: true });
    return this;
  }

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch (_) { /* needs gesture */ } }
  }

  send(msg, transfer) {
    if (!this.ready) { this.queue.push([msg, transfer]); return; }
    this.node.port.postMessage(msg, transfer || []);
  }

  _onMessage(m) {
    switch (m.t) {
      case 'state':
        Object.assign(this.st, { playing: m.playing, paused: m.paused, mode: m.mode, tick: m.tick, tempo: m.tempo, recording: m.recording, cpu: m.cpu, frame: m.frame, recv: performance.now() });
        this.peaks = m.peaks;
        this.bus.emit('state', this.st);
        break;
      case 'error':
        console.error('[engine]', m.where, m.message, m.stack);
        this.error = m.message;
        this.bus.emit('error', m.message);
        break;
      default:
        this.bus.emit(m.t, m);
    }
  }

  // Playhead position for drawing: last reported tick advanced by the wall-clock time since the report,
  // minus the output latency, so the cursor matches what is audible.
  displayTick(loopS = 0, loopE = Infinity) {
    const s = this.st;
    if (!s.playing) return s.tick;
    const latency = this.ctx ? (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0) : 0;
    const dt = Math.max(0, (performance.now() - s.recv) / 1000 - latency);
    let t = s.tick + dt * (s.tempo * PPQ) / 60;
    if (loopE !== Infinity && t >= loopE) t = loopS + ((t - loopS) % Math.max(1, loopE - loopS));
    return t;
  }

  // ask the engine for a spectrum + effect meters of mixer track `track`, slot (-1 = track output); null stops it
  watch(track, slot = -1) { this.send({ t: 'watch', track, slot }); }

  peak(track) { return [this.peaks[track * 2] || 0, this.peaks[track * 2 + 1] || 0]; }
}
