// Microphone / line-in recording. start() opens the chosen input, stop() returns what was captured:
// { channels: Float32Array[], rate, seconds, latency } where `latency` is the estimated input-to-output delay
// to trim from the start so the take lines up with the playback it was recorded against.
export class AudioRecorder {
  constructor(host) { this.host = host; this.node = null; this.stream = null; this.chunks = []; this.active = false; this.ready = null; }

  static supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }

  async devices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Input ${i + 1}` }));
  }

  async _module() {
    if (!this.ready) this.ready = this.host.ctx.audioWorklet.addModule(new URL('../worklet/recorder.js', import.meta.url).href);
    return this.ready;
  }

  async start({ deviceId = null } = {}) {
    if (this.active) return;
    if (!AudioRecorder.supported()) throw new Error('Audio input is not available in this browser');
    const ctx = this.host.ctx;
    await this._module();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } } });
    await this.host.resume();
    const src = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'stepwise-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'max' });
    this.mute = ctx.createGain(); this.mute.gain.value = 0;      // the node must be pulled by the graph to run
    src.connect(this.node); this.node.connect(this.mute); this.mute.connect(ctx.destination);
    this.src = src;
    this.chunks = [];
    this.node.port.onmessage = (e) => { if (e.data.t === 'data') this.chunks.push(e.data.channels); };
    this.node.port.postMessage('start');
    this.active = true;
    this.t0 = ctx.currentTime;
  }

  async stop() {
    if (!this.active) return null;
    this.active = false;
    const ctx = this.host.ctx;
    await new Promise((resolve) => { const prev = this.node.port.onmessage; this.node.port.onmessage = (e) => { prev(e); if (e.data.t === 'stopped') resolve(); }; this.node.port.postMessage('stop'); setTimeout(resolve, 500); });
    const track = this.stream.getAudioTracks()[0];
    const settings = track && track.getSettings ? track.getSettings() : {};
    const latency = (settings.latency || 0) + (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    this.src.disconnect(); this.node.disconnect(); this.mute.disconnect();
    for (const t of this.stream.getTracks()) t.stop();
    this.node = null; this.stream = null;
    const nch = this.chunks.length ? this.chunks[0].length : 1;
    const total = this.chunks.reduce((a, c) => a + c[0].length, 0);
    const channels = Array.from({ length: Math.min(2, nch) }, () => new Float32Array(total));
    let o = 0;
    for (const c of this.chunks) { channels.forEach((dst, i) => dst.set(c[i], o)); o += c[0].length; }
    this.chunks = [];
    return { channels, rate: ctx.sampleRate, seconds: total / ctx.sampleRate, latency };
  }
}
