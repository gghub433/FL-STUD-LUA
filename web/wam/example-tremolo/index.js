// FL LUA Example Tremolo: a WAM 2.0 effect (Web Audio Modules) built with the WebAudioModules SDK, to try the format in
// FL LUA without the internet. Rate, depth, stereo spread (0 = tremolo, 1 = auto-pan) and output level.
import { WebAudioModule, WamNode, addFunctionModule } from '../../vendor/wam-sdk.js';
import { createParamsGui } from '../gui.js';

const getProcessor = (moduleId) => {
  const { registerProcessor } = globalThis;
  const { WamProcessor, WamParameterInfo } = globalThis.webAudioModules.getModuleScope(moduleId);
  class ExampleTremoloProcessor extends WamProcessor {
    constructor(options) { super(options); this.ph = 0; }
    _generateWamParameterInfo() {
      return {
        rate: new WamParameterInfo('rate', { type: 'float', label: 'Rate', defaultValue: 4, minValue: 0.1, maxValue: 20, exponent: 2, units: 'Hz' }),
        depth: new WamParameterInfo('depth', { type: 'float', label: 'Depth', defaultValue: 0.6, minValue: 0, maxValue: 1 }),
        spread: new WamParameterInfo('spread', { type: 'float', label: 'Spread', defaultValue: 0, minValue: 0, maxValue: 1 }),
        output: new WamParameterInfo('output', { type: 'float', label: 'Output', defaultValue: 1, minValue: 0, maxValue: 2 }),
      };
    }
    _process(start, end, inputs, outputs) {
      const inp = inputs[0], out = outputs[0];
      if (!out || !out.length) return;
      const oL = out[0], oR = out[1] || out[0];
      const iL = inp && inp[0], iR = inp && (inp[1] || inp[0]);
      const P = this._parameterState;
      const inc = P.rate.value / sampleRate, depth = P.depth.value, off = P.spread.value * 0.5, g = P.output.value;
      for (let i = start; i < end; i++) {
        const a = 1 - depth * (0.5 - 0.5 * Math.cos(2 * Math.PI * this.ph));
        const b = 1 - depth * (0.5 - 0.5 * Math.cos(2 * Math.PI * (this.ph + off)));
        this.ph += inc; if (this.ph >= 1) this.ph -= 1;
        oL[i] = iL ? iL[i] * a * g : 0;
        oR[i] = iR ? iR[i] * b * g : 0;
      }
    }
  }
  try { registerProcessor(moduleId, ExampleTremoloProcessor); } catch (_) { /* already registered in this context */ }
};

const added = new WeakMap();
class ExampleTremoloNode extends WamNode {
  static addModules(audioContext, moduleId) {
    if (!added.has(audioContext)) added.set(audioContext, (async () => { await WamNode.addModules(audioContext, moduleId); await addFunctionModule(audioContext.audioWorklet, getProcessor, moduleId); })());
    return added.get(audioContext);
  }
}

export default class ExampleTremolo extends WebAudioModule {
  constructor(groupId, audioContext) {
    super(groupId, audioContext);
    Object.assign(this._descriptor, {
      identifier: 'app.fllua.example-tremolo', name: 'FL LUA Example Tremolo', vendor: 'FL LUA', version: '1.0.0', apiVersion: '2.0.0-alpha.6',
      description: 'Tremolo and auto-pan', isInstrument: false, website: 'https://github.com/gghub433/FL-STUD-LUA',
      hasAudioInput: true, hasAudioOutput: true, hasMidiInput: false, hasMidiOutput: false, hasAutomationInput: true, hasAutomationOutput: false,
      hasMpeInput: false, hasMpeOutput: false, hasOscInput: false, hasOscOutput: false, hasSysexInput: false, hasSysexOutput: false, keywords: ['tremolo', 'example'],
    });
  }
  async createAudioNode(initialState) {
    await ExampleTremoloNode.addModules(this.audioContext, this.moduleId);
    const node = new ExampleTremoloNode(this, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    await node._initialize();
    if (initialState) await node.setState(initialState);
    return node;
  }
  createGui() { return createParamsGui(this, '#4aa8e0'); }
}
