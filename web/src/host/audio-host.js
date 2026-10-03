// Main-thread side of the engine: owns the AudioContext, the worklet node and the message
// protocol. Everything audio-related that the UI needs goes through here.
import { Bus } from '../app/bus.js';
import { PPQ } from '../core/constants.js';

const SETTINGS_KEY = 'fllua.audio';
// latency choices: Web Audio hints or a target buffer in milliseconds
export const LATENCIES = [['interactive', 'Lowest (interactive)'], [10, '10 ms'], [20, '20 ms'], ['balanced', 'Balanced (~40 ms)'], ['playback', 'Safe (playback, ~80 ms+)']];
export const RATES = [[0, 'Device default'], [44100, '44.1 kHz'], [48000, '48 kHz'], [88200, '88.2 kHz'], [96000, '96 kHz']];
export function loadAudioSettings() {
  try { return { sampleRate: 0, latency: 'interactive', sinkId: '', ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch (_) { return { sampleRate: 0, latency: 'interactive', sinkId: '' }; }
}
export function saveAudioSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ sampleRate: s.sampleRate || 0, latency: s.latency, sinkId: s.sinkId || '' })); } catch (_) { /* private mode */ } }
// the engine node: output 0 is the master; input 0 and output 1 carry 16 stereo ports for WAM plugins (core/wam-link.js)
export const ENGINE_NODE_OPTIONS = { numberOfInputs: 1, numberOfOutputs: 2, outputChannelCount: [2, 32], channelCount: 32, channelCountMode: 'explicit', channelInterpretation: 'discrete' };
const hintOf = (l) => (typeof l === 'number' ? l / 1000 : ['interactive', 'balanced', 'playback'].includes(l) ? l : 'interactive');

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
    this.settings = { sampleRate: 0, latency: 'interactive', sinkId: '' };
    this.moduleHooks = [];          // (ctx) => Promise: extra worklet modules (plugin packs) added before the engine node exists
    this.restartHooks = [];         // () => Promise: run before the old context closes (WAM plugins save their state)
    this.warning = null;
    this.loud = [-Infinity, -Infinity, -Infinity, 0, -Infinity, -Infinity, -Infinity, 0];   // see LoudnessMeter.snapshot
    this.error = null;
  }

  async init(workletUrl, settings = null) {
    this.workletUrl = workletUrl;
    if (settings) this.settings = { ...this.settings, ...settings };
    await this._start();
    // browsers keep the context suspended until a user gesture
    const resume = () => this.resume();
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, resume, { capture: true });
    return this;
  }

  async _start() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio is not supported in this browser');
    const s = this.settings, opts = { latencyHint: hintOf(s.latency) };
    if (s.sampleRate) opts.sampleRate = s.sampleRate;
    this.warning = null;
    try { this.ctx = new Ctx(opts); } catch (err) {
      if (!opts.sampleRate) throw err;
      delete opts.sampleRate;
      this.ctx = new Ctx(opts);
      this.warning = `${s.sampleRate} Hz is not supported by this audio device; using ${this.ctx.sampleRate} Hz`;
    }
    this.sampleRate = this.ctx.sampleRate;
    await this.ctx.audioWorklet.addModule(this.workletUrl);
    for (const f of this.moduleHooks) { try { await f(this.ctx); } catch (err) { console.warn('[audio] module', err); } }
    this.node = new AudioWorkletNode(this.ctx, 'stepwise-engine', ENGINE_NODE_OPTIONS);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.7;
    this.node.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.node.port.onmessage = (e) => this._onMessage(e.data);
    this.node.onprocessorerror = () => { this.error = 'audio processor crashed'; this.bus.emit('error', this.error); };
    if (s.sinkId) await this.setOutput(s.sinkId).catch(() => { this.warning = 'The chosen output device is not available; using the system default'; this.settings.sinkId = ''; });
    this.ready = true;
    for (const [m, t] of this.queue) this.node.port.postMessage(m, t || []);
    this.queue = [];
  }

  // New AudioContext with other settings (sample rate, latency, device). The engine starts empty: listeners of
  // 'restarted' send the project and the samples again.
  async restart(settings = null) {
    if (settings) this.settings = { ...this.settings, ...settings };
    for (const f of this.restartHooks) { try { await f(); } catch (err) { console.warn('[audio] restart', err); } }
    this.ready = false;
    this.queue = [];                                   // anything queued now is superseded by the full resend
    const old = this.ctx;
    try { this.node.port.onmessage = null; this.node.disconnect(); this.analyser.disconnect(); } catch (_) { /* already gone */ }
    this.node = null;
    try { if (old) await old.close(); } catch (_) { /* closed */ }
    Object.assign(this.st, { playing: false, paused: false, recording: false });
    await this._start();
    this.bus.emit('restarted', this);
    return this;
  }

  // output device without a restart (Chromium's AudioContext.setSinkId); '' = system default
  async setOutput(sinkId) {
    if (!this.ctx.setSinkId) throw new Error('Choosing the output device is not supported in this browser');
    await this.ctx.setSinkId(sinkId || '');
    this.settings.sinkId = sinkId || '';
  }

  static outputSelectable() { return typeof window.AudioContext === 'function' && 'setSinkId' in AudioContext.prototype; }

  async outputs() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, i) => ({ id: d.deviceId, label: d.label || `Output ${i + 1}` }));
  }

  info() {
    const c = this.ctx;
    return { sampleRate: this.sampleRate, baseLatency: c ? c.baseLatency || 0 : 0, outputLatency: c ? c.outputLatency || 0 : 0, state: c ? c.state : 'none', settings: { ...this.settings }, warning: this.warning };
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
        if (m.loud) this.loud = m.loud;
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

  // integrated loudness, range and maxima start over
  resetLoudness() { this.send({ t: 'meterReset' }); }

  peak(track) { return [this.peaks[track * 2] || 0, this.peaks[track * 2 + 1] || 0]; }
}
