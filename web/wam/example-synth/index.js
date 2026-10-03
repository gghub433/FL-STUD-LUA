// FL LUA Example Synth: a WAM 2.0 instrument (Web Audio Modules) built with the WebAudioModules SDK. It is here to try
// the format in FL LUA without the internet, and as a starting point: any WAM host can load it from this address.
// Polyphonic: sine, saw (polyBLEP) or square, a two-pole low-pass, attack and release, level.
import { WebAudioModule, WamNode, addFunctionModule } from '../../vendor/wam-sdk.js';
import { createParamsGui } from '../gui.js';

// runs in the AudioWorklet (the SDK injects it as text, so it uses nothing from this module)
const getProcessor = (moduleId) => {
  const { registerProcessor } = globalThis;
  const { WamProcessor, WamParameterInfo } = globalThis.webAudioModules.getModuleScope(moduleId);
  const blep = (t, dt) => {
    if (t < dt) { t /= dt; return t + t - t * t - 1; }
    if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
    return 0;
  };
  class ExampleSynthProcessor extends WamProcessor {
    constructor(options) { super(options); this.voices = []; }
    _generateWamParameterInfo() {
      return {
        wave: new WamParameterInfo('wave', { type: 'choice', label: 'Wave', defaultValue: 1, choices: ['Sine', 'Saw', 'Square'] }),
        cutoff: new WamParameterInfo('cutoff', { type: 'float', label: 'Cutoff', defaultValue: 3000, minValue: 80, maxValue: 16000, exponent: 3, units: 'Hz' }),
        attack: new WamParameterInfo('attack', { type: 'float', label: 'Attack', defaultValue: 0.004, minValue: 0.001, maxValue: 2, exponent: 3, units: 's' }),
        release: new WamParameterInfo('release', { type: 'float', label: 'Release', defaultValue: 0.25, minValue: 0.005, maxValue: 4, exponent: 3, units: 's' }),
        level: new WamParameterInfo('level', { type: 'float', label: 'Level', defaultValue: 0.5, minValue: 0, maxValue: 1 }),
      };
    }
    _onMidi({ bytes }) {
      const [st, n, v] = bytes, t = st & 0xf0;
      if (t === 0x90 && v > 0) {
        if (this.voices.length > 31) this.voices.shift();
        this.voices.push({ n, inc: (440 * 2 ** ((n - 69) / 12)) / sampleRate, ph: 0, vel: v / 127, env: 0, rel: false, a: 0, b: 0 });
      } else if (t === 0x80 || t === 0x90) {
        for (const vo of this.voices) if (vo.n === n) vo.rel = true;
      } else if (t === 0xb0 && (n === 120 || n === 123)) {
        for (const vo of this.voices) vo.rel = true;
      }
    }
    _process(start, end, inputs, outputs) {
      const out = outputs[0];
      if (!out || !out.length) return;
      const L = out[0], R = out[1] || out[0];
      const P = this._parameterState;
      const wave = Math.round(P.wave.value), level = P.level.value;
      const up = 1 / Math.max(1, P.attack.value * sampleRate), down = Math.exp(-6.9 / Math.max(1, P.release.value * sampleRate));
      const g = Math.min(0.95, 1 - Math.exp((-2 * Math.PI * P.cutoff.value) / sampleRate));
      for (let i = start; i < end; i++) { L[i] = 0; R[i] = 0; }
      for (const vo of this.voices) {
        for (let i = start; i < end; i++) {
          vo.env = vo.rel ? vo.env * down : Math.min(1, vo.env + up);
          const ph = vo.ph;
          let s = wave === 0 ? Math.sin(2 * Math.PI * ph) : wave === 1 ? 2 * ph - 1 - blep(ph, vo.inc) : (ph < 0.5 ? 1 : -1) + blep(ph, vo.inc) - blep((ph + 0.5) % 1, vo.inc);
          vo.ph = ph + vo.inc; if (vo.ph >= 1) vo.ph -= 1;
          vo.a += g * (s - vo.a); vo.b += g * (vo.a - vo.b); s = vo.b;
          const y = s * vo.env * vo.vel * level * 0.4;
          L[i] += y; R[i] += y;
        }
      }
      this.voices = this.voices.filter((vo) => !(vo.rel && vo.env < 1e-4));
    }
  }
  try { registerProcessor(moduleId, ExampleSynthProcessor); } catch (_) { /* already registered in this context */ }
};

const added = new WeakMap();           // AudioContext -> Promise: the processor code is added once per context
class ExampleSynthNode extends WamNode {
  static addModules(audioContext, moduleId) {
    if (!added.has(audioContext)) added.set(audioContext, (async () => { await WamNode.addModules(audioContext, moduleId); await addFunctionModule(audioContext.audioWorklet, getProcessor, moduleId); })());
    return added.get(audioContext);
  }
}

export default class ExampleSynth extends WebAudioModule {
  constructor(groupId, audioContext) {
    super(groupId, audioContext);
    Object.assign(this._descriptor, {
      identifier: 'app.fllua.example-synth', name: 'FL LUA Example Synth', vendor: 'FL LUA', version: '1.0.0', apiVersion: '2.0.0-alpha.6',
      description: 'Polyphonic synth: sine, saw or square, filter, attack and release', isInstrument: true, website: 'https://github.com/gghub433/FL-STUD-LUA',
      hasAudioInput: false, hasAudioOutput: true, hasMidiInput: true, hasMidiOutput: false, hasAutomationInput: true, hasAutomationOutput: false,
      hasMpeInput: false, hasMpeOutput: false, hasOscInput: false, hasOscOutput: false, hasSysexInput: false, hasSysexOutput: false, keywords: ['synth', 'example'],
    });
  }
  async createAudioNode(initialState) {
    await ExampleSynthNode.addModules(this.audioContext, this.moduleId);
    const node = new ExampleSynthNode(this, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    await node._initialize();
    if (initialState) await node.setState(initialState);
    return node;
  }
  createGui() { return createParamsGui(this, '#ffb02e'); }
}
