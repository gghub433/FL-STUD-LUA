// Factory patches: starting points for the Patcher (and a showcase of what the nodes can do together).
// Every entry builds a fresh patch, so they can be edited freely after loading.
import { emptyPatch, addNode, connect, setExposed, modPort } from './spec.js';

function builder() {
  const patch = emptyPatch(), n = {};
  const api = {
    patch, n,
    add(name, type, opts) { n[name] = addNode(patch, type, opts); if (!n[name]) throw new Error(`preset node ${name}`); return n[name]; },
    wire(a, ap, b, bp) { if (!connect(patch, [n[a].id, ap], [n[b].id, bp])) throw new Error(`preset wire ${a}.${ap}->${b}.${bp}`); },
    // expose a parameter and wire a control source into it
    mod(src, srcPort, node, param) { setExposed(patch, n[node].id, param, true); api.wire(src, srcPort, node, modPort(param)); },
  };
  return api;
}

export const PATCH_PRESETS = {
  instrument: {
    'Supersaw chord stabs': () => {
      const b = builder();
      b.add('in', 'noteIn', { x: 30, y: 60 }); b.add('ch', 'chord', { x: 230, y: 40, params: { chord: 9, octaves: 1 } });
      b.add('syn', 'inst', { ref: 'subsynth', x: 440, y: 40, params: { uni: 7, unidet: 0.35, unispread: 0.8 } });
      b.add('cho', 'fx', { ref: 'chorus', x: 660, y: 40 }); b.add('out', 'audioOut', { x: 880, y: 60 });
      b.wire('in', 'notes', 'ch', 'notes'); b.wire('ch', 'notes', 'syn', 'notes'); b.wire('syn', 'out', 'cho', 'in'); b.wire('cho', 'out', 'out', 'in');
      return b.patch;
    },
    'Layered pluck + sub octave': () => {
      const b = builder();
      b.add('in', 'noteIn', { x: 30, y: 100 }); b.add('pl', 'inst', { ref: 'pluck', x: 280, y: 20 });
      b.add('tr', 'transpose', { x: 230, y: 190, params: { semis: -12 } }); b.add('syn', 'inst', { ref: 'subsynth', x: 440, y: 190 });
      b.add('g', 'gain', { x: 660, y: 190, params: { level: 0.6 } }); b.add('out', 'audioOut', { x: 880, y: 100 });
      b.wire('in', 'notes', 'pl', 'notes'); b.wire('in', 'notes', 'tr', 'notes'); b.wire('tr', 'notes', 'syn', 'notes');
      b.wire('pl', 'out', 'out', 'in'); b.wire('syn', 'out', 'g', 'in'); b.wire('g', 'out', 'out', 'in');
      return b.patch;
    },
    'Keyboard split: organ + pluck': () => {
      const b = builder();
      b.add('in', 'noteIn', { x: 30, y: 100 });
      b.add('lo', 'noteFilter', { x: 230, y: 20, params: { lo: 0, hi: 59 } }); b.add('org', 'inst', { ref: 'organ', x: 440, y: 20 });
      b.add('hi', 'noteFilter', { x: 230, y: 200, params: { lo: 60, hi: 127 } }); b.add('pl', 'inst', { ref: 'pluck', x: 440, y: 200 });
      b.add('out', 'audioOut', { x: 700, y: 100 });
      b.wire('in', 'notes', 'lo', 'notes'); b.wire('lo', 'notes', 'org', 'notes'); b.wire('in', 'notes', 'hi', 'notes'); b.wire('hi', 'notes', 'pl', 'notes');
      b.wire('org', 'out', 'out', 'in'); b.wire('pl', 'out', 'out', 'in');
      return b.patch;
    },
    'Wobble bass (LFO -> filter)': () => {
      const b = builder();
      b.add('in', 'noteIn', { x: 30, y: 60 }); b.add('syn', 'inst', { ref: 'subsynth', x: 240, y: 40 });
      b.add('f', 'fx', { ref: 'filter', x: 470, y: 40, params: { res: 0.6, lfoAmt: 0 } }); b.add('lfo', 'lfo', { x: 240, y: 230, params: { rate: 3, depth: 0.8, offset: 0.45, retrig: 1 } });
      b.add('out', 'audioOut', { x: 700, y: 60 });
      b.wire('in', 'notes', 'syn', 'notes'); b.wire('syn', 'out', 'f', 'in'); b.wire('f', 'out', 'out', 'in');
      b.wire('in', 'notes', 'lfo', 'retrig'); b.mod('lfo', 'out', 'f', 'cutoff');
      return b.patch;
    },
    'Velocity-swept lead (macro 1 = brightness)': () => {
      const b = builder();
      b.add('in', 'noteIn', { x: 30, y: 60 }); b.add('syn', 'inst', { ref: 'subsynth', x: 240, y: 40 });
      b.add('m', 'macro', { x: 30, y: 230, params: { n: 1 } }); b.add('v', 'math', { x: 240, y: 230, params: { op: 5 } });
      b.add('f', 'fx', { ref: 'filter', x: 470, y: 40, params: { res: 0.25, lfoAmt: 0 } }); b.add('out', 'audioOut', { x: 700, y: 60 });
      b.wire('in', 'notes', 'syn', 'notes'); b.wire('syn', 'out', 'f', 'in'); b.wire('f', 'out', 'out', 'in');
      b.wire('in', 'vel', 'v', 'a'); b.wire('m', 'out', 'v', 'b'); b.mod('v', 'out', 'f', 'cutoff');
      return b.patch;
    },
  },
  effect: {
    'Auto-wah (level -> filter)': () => {
      const b = builder();
      b.add('in', 'audioIn', { x: 30, y: 60 }); b.add('fo', 'follower', { x: 230, y: 200, params: { attack: 3, release: 140, boost: 6 } });
      b.add('f', 'fx', { ref: 'filter', x: 480, y: 40, params: { type: 1, res: 0.6, lfoAmt: 0 } }); b.add('out', 'audioOut', { x: 720, y: 60 });
      b.wire('in', 'out', 'fo', 'in'); b.wire('in', 'out', 'f', 'in'); b.wire('f', 'out', 'out', 'in'); b.mod('fo', 'level', 'f', 'cutoff');
      return b.patch;
    },
    'Tremolo (LFO -> level)': () => {
      const b = builder();
      b.add('in', 'audioIn', { x: 30, y: 60 }); b.add('g', 'gain', { x: 300, y: 40 }); b.add('lfo', 'lfo', { x: 120, y: 200, params: { rate: 5, depth: 0.7, offset: 0.65 } });
      b.add('out', 'audioOut', { x: 540, y: 60 });
      b.wire('in', 'out', 'g', 'in'); b.wire('g', 'out', 'out', 'in'); b.mod('lfo', 'out', 'g', 'level');
      return b.patch;
    },
    'Parallel distortion': () => {
      const b = builder();
      b.add('in', 'audioIn', { x: 30, y: 100 }); b.add('d', 'fx', { ref: 'distortion', x: 250, y: 200, params: { drive: 24 } });
      b.add('g', 'gain', { x: 480, y: 200, params: { level: 0.35 } }); b.add('out', 'audioOut', { x: 700, y: 100 });
      b.wire('in', 'out', 'out', 'in'); b.wire('in', 'out', 'd', 'in'); b.wire('d', 'out', 'g', 'in'); b.wire('g', 'out', 'out', 'in');
      return b.patch;
    },
    'Sidechain pump (sidechain -> level)': () => {
      const b = builder();
      b.add('in', 'audioIn', { x: 30, y: 80 }); b.add('fo', 'follower', { x: 230, y: 260, params: { attack: 1, release: 160, boost: 24 } });
      b.add('inv', 'math', { x: 440, y: 260, params: { op: 8 } }); b.add('mp', 'map', { x: 640, y: 260, params: { outHi: 0.5 } });
      b.add('g', 'gain', { x: 640, y: 40 }); b.add('out', 'audioOut', { x: 860, y: 80 });
      b.wire('in', 'out', 'g', 'in'); b.wire('g', 'out', 'out', 'in'); b.wire('in', 'sc', 'fo', 'in'); b.wire('fo', 'level', 'inv', 'a'); b.wire('inv', 'out', 'mp', 'in'); b.mod('mp', 'out', 'g', 'level');
      return b.patch;
    },
    'Dry / wet reverb (macro 1 = amount)': () => {
      const b = builder();
      b.add('in', 'audioIn', { x: 30, y: 100 }); b.add('r', 'fx', { ref: 'reverb', x: 250, y: 190, params: { dry: -60, wet: 0 } });
      b.add('x', 'xfade', { x: 500, y: 100 }); b.add('m', 'macro', { x: 250, y: 20, params: { n: 1 } }); b.add('out', 'audioOut', { x: 720, y: 100 });
      b.wire('in', 'out', 'x', 'a'); b.wire('in', 'out', 'r', 'in'); b.wire('r', 'out', 'x', 'b'); b.wire('x', 'out', 'out', 'in'); b.mod('m', 'out', 'x', 'mix');
      return b.patch;
    },
  },
};
