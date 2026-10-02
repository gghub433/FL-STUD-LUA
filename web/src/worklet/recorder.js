// Audio input recorder: collects the input channels in blocks and posts them to the page.
class StepwiseRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false; this.frames = 0;
    this.port.onmessage = (e) => { if (e.data === 'start') { this.on = true; this.frames = 0; } else if (e.data === 'stop') { this.on = false; this.port.postMessage({ t: 'stopped', frames: this.frames }); } };
  }

  process(inputs) {
    const input = inputs[0];
    if (this.on && input && input.length) {
      const n = input[0].length;
      const out = input.map((c) => c.slice());
      this.port.postMessage({ t: 'data', channels: out }, out.map((c) => c.buffer));
      this.frames += n;
    }
    return true;
  }
}
registerProcessor('stepwise-recorder', StepwiseRecorder);
