// Patcher: the data model of a modular patch. Pure data + validation, no DSP and no DOM, so the
// engine (worklet / offline / tests), the project loader and the editor UI all share one definition.
//
//   patch = { next, nodes: [{ id, type, x, y, name?, bypass?, params, mods?, ref?, sample? }],
//             wires: [{ id, from: [nodeId, port], to: [nodeId, port] }], macroNames: [] }
//
// Three kinds of ports, a wire only joins ports of the same kind:
//   audio  stereo signal; several wires into one input are summed
//   ctl    control signal 0..1 evaluated once per processing slice; several wires are summed
//   note   note events (on/off); several wires merge
// A node parameter can be turned into a control input ("exposed"): while a wire is connected to it the
// wired value (0..1) is mapped onto the parameter range, otherwise the knob value is used.
import { def, bool, choice, clampParam } from '../schema.js';
import { hasInstrument, INSTRUMENTS } from '../instruments/index.js';
import { hasEffect, EFFECTS } from '../effects/index.js';
import { SYNC_LABELS } from '../dsp.js';
import { PATCHER_MACROS } from '../constants.js';

export const MACROS = PATCHER_MACROS;
export const MAX_NODES = 64;
export const MAX_WIRES = 256;
export const MAX_MODS = 16;

const A = (id, name) => ({ id, name, type: 'audio' });
const C = (id, name) => ({ id, name, type: 'ctl' });
const N = (id, name) => ({ id, name, type: 'note' });

export const CHORDS = {
  Octave: [0, 12], Major: [0, 4, 7], Minor: [0, 3, 7], Sus2: [0, 2, 7], Sus4: [0, 5, 7], Diminished: [0, 3, 6], Augmented: [0, 4, 8],
  'Power (5th)': [0, 7], 'Major 7': [0, 4, 7, 11], 'Minor 7': [0, 3, 7, 10], 'Dominant 7': [0, 4, 7, 10], 'Major 9': [0, 4, 7, 11, 14], 'Minor 9': [0, 3, 7, 10, 14],
};
export const CHORD_NAMES = Object.keys(CHORDS);
export const MATH_OPS = ['A + B', 'A − B', 'A × B', 'Min', 'Max', 'Average', '|A − B|', 'A ^ B', '1 − A', 'A > B'];
export const LFO_SHAPES_P = ['Sine', 'Triangle', 'Square', 'Saw up', 'Saw down', 'Random (S&H)', 'Smooth random'];

// Built-in node types. `cat` groups them in the Add menu; instrument / effect nodes are generated per plugin.
export const NODE_TYPES = {
  audioIn: { name: 'Audio In', cat: 'Input / output', unique: true, ins: [], outs: [A('out', 'Audio'), A('sc', 'Sidechain')], params: [],
    desc: 'The signal coming into the Patcher when it is used as an effect (and its sidechain input)' },
  noteIn: { name: 'Note In', cat: 'Input / output', unique: true, ins: [], outs: [N('notes', 'Notes'), C('key', 'Key'), C('vel', 'Velocity'), C('gate', 'Gate')], params: [],
    desc: 'The notes played on the channel. Also outputs the last key, velocity and gate as control signals' },
  audioOut: { name: 'Audio Out', cat: 'Input / output', unique: true, ins: [A('in', 'Audio')], outs: [], params: [],
    desc: 'Everything wired here is the output of the Patcher' },
  macro: { name: 'Macro', cat: 'Control', ins: [], outs: [C('out', 'Value')], params: [def('n', 'Macro', 1, MACROS, 1, { int: true })],
    desc: 'One of the 16 macro knobs of the Patcher — they can be automated and linked to MIDI like any other knob' },
  lfo: { name: 'LFO', cat: 'Control', ins: [N('retrig', 'Retrigger')], outs: [C('out', 'Out')], params: [
    choice('shape', 'Shape', LFO_SHAPES_P, 0), bool('sync', 'Tempo sync', 0), def('rate', 'Rate', 0.02, 30, 1, { unit: 'Hz', curve: 'log' }),
    choice('division', 'Division', SYNC_LABELS, 5), def('depth', 'Depth', 0, 1, 0.5), def('offset', 'Offset', 0, 1, 0.5), def('phase', 'Phase', 0, 1, 0),
    bool('retrig', 'Restart on note', 0)], desc: 'Low-frequency oscillator. Depth 1 swings across the whole range around Offset' },
  env: { name: 'Envelope', cat: 'Control', ins: [N('notes', 'Trigger')], outs: [C('out', 'Level')], params: [
    def('attack', 'Attack', 0.5, 5000, 10, { unit: 'ms', curve: 'log' }), def('decay', 'Decay', 1, 5000, 250, { unit: 'ms', curve: 'log' }),
    def('sustain', 'Sustain', 0, 1, 0.7), def('release', 'Release', 1, 8000, 300, { unit: 'ms', curve: 'log' }), def('amount', 'Amount', 0, 1, 1)],
    desc: 'ADSR envelope triggered by the notes wired into it' },
  follower: { name: 'Envelope follower', cat: 'Control', ins: [A('in', 'Audio')], outs: [A('out', 'Audio'), C('level', 'Level')], params: [
    def('attack', 'Attack', 0.1, 200, 5, { unit: 'ms', curve: 'log' }), def('release', 'Release', 5, 2000, 120, { unit: 'ms', curve: 'log' }),
    def('boost', 'Sensitivity', 0, 36, 12, { unit: 'dB' })], desc: 'Turns the loudness of an audio signal into a control signal (passes the audio through)' },
  random: { name: 'Random', cat: 'Control', ins: [N('notes', 'Trigger')], outs: [C('out', 'Value')], params: [
    def('min', 'Minimum', 0, 1, 0), def('max', 'Maximum', 0, 1, 1), def('glide', 'Glide', 0, 2000, 0, { unit: 'ms', curve: 'pow', skew: 2 }),
    def('steps', 'Steps (0 = free)', 0, 16, 0, { int: true })], desc: 'A new random value on every note' },
  math: { name: 'Math', cat: 'Control', ins: [C('a', 'A'), C('b', 'B')], outs: [C('out', 'Out')], params: [
    choice('op', 'Operation', MATH_OPS, 0), def('a', 'A (unwired)', 0, 1, 0.5), def('b', 'B (unwired)', 0, 1, 0.5)],
    desc: 'Combines two control signals. Unwired inputs use their knob' },
  map: { name: 'Map', cat: 'Control', ins: [C('in', 'In')], outs: [C('out', 'Out')], params: [
    def('inLo', 'Input low', 0, 1, 0), def('inHi', 'Input high', 0, 1, 1), def('outLo', 'Output low', 0, 1, 0), def('outHi', 'Output high', 0, 1, 1),
    def('curve', 'Curve', -1, 1, 0), def('steps', 'Steps (0 = free)', 0, 32, 0, { int: true })], desc: 'Scales, inverts, bends and quantizes a control signal' },
  gain: { name: 'Volume / Pan', cat: 'Audio', ins: [A('in', 'Audio')], outs: [A('out', 'Audio')], params: [
    def('level', 'Level', 0, 2, 1), def('pan', 'Panning', -1, 1, 0)], desc: 'Level and equal-power panning' },
  xfade: { name: 'Crossfade', cat: 'Audio', ins: [A('a', 'A'), A('b', 'B')], outs: [A('out', 'Out')], params: [def('mix', 'A ← → B', 0, 1, 0.5)],
    desc: 'Equal-power crossfade between two audio signals' },
  transpose: { name: 'Transpose', cat: 'Notes', ins: [N('notes', 'Notes')], outs: [N('notes', 'Notes')], params: [def('semis', 'Semitones', -48, 48, 0, { int: true })],
    desc: 'Shifts incoming notes up or down' },
  noteFilter: { name: 'Note filter', cat: 'Notes', ins: [N('notes', 'Notes')], outs: [N('notes', 'Notes')], params: [
    def('lo', 'Lowest key', 0, 127, 0, { int: true }), def('hi', 'Highest key', 0, 127, 127, { int: true }),
    def('velLo', 'Lowest velocity', 0, 127, 0, { int: true }), def('velHi', 'Highest velocity', 0, 127, 127, { int: true }), bool('invert', 'Invert', 0)],
    desc: 'Lets only notes inside a key and velocity window through (split keyboards, velocity layers)' },
  chord: { name: 'Chord', cat: 'Notes', ins: [N('notes', 'Notes')], outs: [N('notes', 'Notes')], params: [
    choice('chord', 'Chord', CHORD_NAMES, 1), def('inversion', 'Inversion', 0, 3, 0, { int: true }), def('octaves', 'Octaves', 1, 3, 1, { int: true })],
    desc: 'Turns every note into a chord' },
  velocity: { name: 'Velocity', cat: 'Notes', ins: [N('notes', 'Notes')], outs: [N('notes', 'Notes')], params: [
    choice('mode', 'Mode', ['Scale', 'Fixed', 'Random'], 0), def('amount', 'Scale', 0, 2, 1), def('fixed', 'Fixed value', 0, 1, 0.8), def('spread', 'Random spread', 0, 1, 0.3)],
    desc: 'Scales, fixes or randomizes the velocity of notes' },
};

export const CATEGORIES = ['Input / output', 'Control', 'Audio', 'Notes'];
export const PLUGIN_NODE_TYPES = ['inst', 'fx'];

// instruments that can live inside a patch (the rest need channel data of their own)
export const canHostInstrument = (t) => hasInstrument(t) && !['controller', 'patcher', 'fpc', 'slicer', 'audio'].includes(t);
export const canHostEffect = (t) => hasEffect(t) && t !== 'patcher';

// ---- per-node description (depends on the node: plugin nodes take ports and parameters from their plugin)
export function nodeInfo(node) {
  if (node.type === 'inst') {
    const m = INSTRUMENTS[node.ref];
    return m ? { name: m.meta.name, cat: 'Generators', ins: [N('notes', 'Notes')], outs: [A('out', 'Audio')], params: m.schema, plugin: true, desc: m.meta.description || '' } : null;
  }
  if (node.type === 'fx') {
    const m = EFFECTS[node.ref];
    return m ? { name: m.meta.name, cat: 'Effects', ins: [A('in', 'Audio'), A('sc', 'Sidechain')], outs: [A('out', 'Audio')], params: m.schema, plugin: true, desc: m.meta.description || '' } : null;
  }
  const t = NODE_TYPES[node.type];
  return t ? { ...t, plugin: false } : null;
}

export const modPort = (id) => `p:${id}`;

// full port lists including the control inputs of exposed parameters
export function portsOf(node) {
  const info = nodeInfo(node);
  if (!info) return { ins: [], outs: [] };
  const ins = info.ins.slice();
  for (const id of node.mods || []) {
    const d = info.params.find((q) => q.id === id);
    if (d) ins.push({ ...C(modPort(id), d.name), mod: id });
  }
  return { ins, outs: info.outs };
}

export function findPort(node, dir, id) {
  const p = portsOf(node);
  return (dir === 'in' ? p.ins : p.outs).find((x) => x.id === id) || null;
}

// ---- construction
export function newNode(patch, type, opts = {}) {
  const node = { id: patch.next++, type, x: Math.round(opts.x ?? 60), y: Math.round(opts.y ?? 60), params: {} };
  if (type === 'inst' || type === 'fx') node.ref = opts.ref;
  const info = nodeInfo(node);
  for (const d of info ? info.params : []) node.params[d.id] = d.def;
  if (opts.params) for (const d of info.params) if (opts.params[d.id] !== undefined) node.params[d.id] = clampParam(d, opts.params[d.id]);
  if (opts.name) node.name = String(opts.name).slice(0, 24);
  return node;
}

export function emptyPatch() { return { next: 1, nodes: [], wires: [], macroNames: [] }; }

export function defaultPatch(kind) {
  const p = emptyPatch();
  if (kind === 'effect') {
    const a = newNode(p, 'audioIn', { x: 40, y: 90 }), o = newNode(p, 'audioOut', { x: 420, y: 90 });
    p.nodes.push(a, o);
    connect(p, [a.id, 'out'], [o.id, 'in']);
  } else {
    const n = newNode(p, 'noteIn', { x: 40, y: 70 }), s = newNode(p, 'inst', { ref: 'subsynth', x: 300, y: 50 }), o = newNode(p, 'audioOut', { x: 620, y: 70 });
    p.nodes.push(n, s, o);
    connect(p, [n.id, 'notes'], [s.id, 'notes']);
    connect(p, [s.id, 'out'], [o.id, 'in']);
  }
  return p;
}

export const getNode = (patch, id) => patch.nodes.find((n) => n.id === id) || null;

// ---- validation
export function reaches(patch, fromId, toId) {
  const seen = new Set([fromId]), stack = [fromId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === toId) return true;
    for (const w of patch.wires) if (w.from[0] === cur && !seen.has(w.to[0])) { seen.add(w.to[0]); stack.push(w.to[0]); }
  }
  return false;
}

// -> null when the wire is allowed, otherwise the reason
export function wireProblem(patch, from, to) {
  const a = getNode(patch, from[0]), b = getNode(patch, to[0]);
  if (!a || !b) return 'Unknown node';
  if (a === b) return 'A node cannot be wired to itself';
  const po = findPort(a, 'out', from[1]), pi = findPort(b, 'in', to[1]);
  if (!po || !pi) return 'Unknown port';
  if (po.type !== pi.type) return `Cannot wire ${po.type} into ${pi.type}`;
  if (patch.wires.some((w) => w.from[0] === from[0] && w.from[1] === from[1] && w.to[0] === to[0] && w.to[1] === to[1])) return 'Already connected';
  if (patch.wires.length >= MAX_WIRES) return 'Too many wires';
  if (reaches(patch, to[0], from[0])) return 'That would create a feedback loop';
  return null;
}

export function connect(patch, from, to) {
  if (wireProblem(patch, from, to)) return null;
  const w = { id: patch.next++, from: [from[0], from[1]], to: [to[0], to[1]] };
  patch.wires.push(w);
  return w;
}

export function disconnect(patch, wireId) { patch.wires = patch.wires.filter((w) => w.id !== wireId); }

export function addNode(patch, type, opts = {}) {
  if (patch.nodes.length >= MAX_NODES) return null;
  const t = NODE_TYPES[type];
  if (t && t.unique && patch.nodes.some((n) => n.type === type)) return null;
  const node = newNode(patch, type, opts);
  if (!nodeInfo(node)) return null;
  patch.nodes.push(node);
  return node;
}

export function removeNodes(patch, ids) {
  const set = new Set(ids);
  patch.nodes = patch.nodes.filter((n) => !set.has(n.id));
  patch.wires = patch.wires.filter((w) => !set.has(w.from[0]) && !set.has(w.to[0]));
}

// expose / hide a parameter as a control input; hiding drops the wires into it
export function setExposed(patch, nodeId, paramId, on) {
  const node = getNode(patch, nodeId), info = node && nodeInfo(node);
  if (!info || !info.params.some((d) => d.id === paramId)) return false;
  const mods = node.mods || (node.mods = []);
  const has = mods.includes(paramId);
  if (on && !has) { if (mods.length >= MAX_MODS) return false; mods.push(paramId); }
  if (!on && has) {
    node.mods = mods.filter((m) => m !== paramId);
    if (!node.mods.length) delete node.mods;
    patch.wires = patch.wires.filter((w) => !(w.to[0] === nodeId && w.to[1] === modPort(paramId)));
  }
  return true;
}

export function duplicateNodes(patch, ids, dx = 30, dy = 30) {
  const idMap = new Map(), made = [];
  for (const id of ids) {
    const src = getNode(patch, id);
    if (!src || (NODE_TYPES[src.type] && NODE_TYPES[src.type].unique) || patch.nodes.length >= MAX_NODES) continue;
    const c = JSON.parse(JSON.stringify(src));
    c.id = patch.next++; c.x += dx; c.y += dy;
    patch.nodes.push(c); idMap.set(id, c.id); made.push(c);
  }
  for (const w of patch.wires.slice()) {
    if (idMap.has(w.from[0]) && idMap.has(w.to[0]) && patch.wires.length < MAX_WIRES) patch.wires.push({ id: patch.next++, from: [idMap.get(w.from[0]), w.from[1]], to: [idMap.get(w.to[0]), w.to[1]] });
  }
  return made;
}

// ---- samples used by sampler / convolver nodes (to load them with the project and store them in project files)
export function patchSampleIds(patch, ids = new Set()) {
  if (patch && Array.isArray(patch.nodes)) {
    for (const n of patch.nodes) {
      if (n.sample && n.sample.id) { ids.add(n.sample.id); if (n.sample.use) ids.add(n.sample.use); }
      if (n.extra && n.extra.irId) ids.add(n.extra.irId);
    }
  }
  return ids;
}
export function projectPatchSampleIds(project, ids = new Set()) {
  for (const c of project.channels) if (c.type === 'patcher') patchSampleIds(c.patch, ids);
  for (const t of project.mixer.tracks) for (const f of t.fx) if (f && f.type === 'patcher' && f.extra) patchSampleIds(f.extra.patch, ids);
  return ids;
}

// ---- normalization of untrusted data (project files, presets)
const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const str = (v, d, max) => (typeof v === 'string' ? v.slice(0, max) : d);

export function normalizePatch(raw, kind = 'instrument') {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) return defaultPatch(kind);
  const p = emptyPatch();
  const ids = new Set();
  for (const r of raw.nodes.slice(0, MAX_NODES)) {
    if (!r || typeof r !== 'object' || !Number.isInteger(r.id) || r.id < 1 || ids.has(r.id) || typeof r.type !== 'string') continue;
    const t = NODE_TYPES[r.type];
    if (r.type === 'inst' ? !canHostInstrument(r.ref) : r.type === 'fx' ? !canHostEffect(r.ref) : !t) continue;
    if (t && t.unique && p.nodes.some((n) => n.type === r.type)) continue;
    const node = { id: r.id, type: r.type, x: Math.round(num(r.x, -5000, 5000, 60)), y: Math.round(num(r.y, -5000, 5000, 60)), params: {} };
    if (r.type === 'inst' || r.type === 'fx') node.ref = r.ref;
    const info = nodeInfo(node);
    for (const d of info.params) node.params[d.id] = clampParam(d, r.params && typeof r.params === 'object' ? r.params[d.id] : undefined);
    if (typeof r.name === 'string' && r.name) node.name = r.name.slice(0, 24);
    if (r.bypass) node.bypass = 1;
    if (Array.isArray(r.mods)) {
      const mods = [];
      for (const m of r.mods) if (typeof m === 'string' && info.params.some((d) => d.id === m) && !mods.includes(m) && mods.length < MAX_MODS) mods.push(m);
      if (mods.length) node.mods = mods;
    }
    if (r.type === 'fx' && r.extra && typeof r.extra === 'object' && JSON.stringify(r.extra).length < 20000) node.extra = JSON.parse(JSON.stringify(r.extra));
    if (r.type === 'inst' && r.ref === 'sampler' && r.sample && typeof r.sample.id === 'string') {
      node.sample = { id: str(r.sample.id, '', 80), name: str(r.sample.name, '', 80) };
      if (typeof r.sample.use === 'string') node.sample.use = str(r.sample.use, '', 120);
    }
    ids.add(r.id); p.nodes.push(node);
  }
  p.next = Math.max(1, Math.floor(num(raw.next, 1, 1e9, 1)), ...p.nodes.map((n) => n.id + 1));
  const wires = Array.isArray(raw.wires) ? raw.wires.slice(0, MAX_WIRES * 2) : [];
  const used = new Set();
  for (const w of wires) {
    if (!w || !Array.isArray(w.from) || !Array.isArray(w.to)) continue;
    const from = [w.from[0], String(w.from[1])], to = [w.to[0], String(w.to[1])];
    if (wireProblem(p, from, to)) continue;
    const id = Number.isInteger(w.id) && w.id > 0 && !used.has(w.id) ? w.id : p.next++;
    used.add(id); p.next = Math.max(p.next, id + 1);
    p.wires.push({ id, from, to });
  }
  p.macroNames = Array.from({ length: MACROS }, (_, i) => (Array.isArray(raw.macroNames) ? str(raw.macroNames[i], '', 24) : ''));
  if (!p.macroNames.some(Boolean)) p.macroNames = [];
  return p;
}

// effect slots keep the patch in `extra.patch`
export function normalizeFxExtra(extra) { return { patch: normalizePatch(extra && extra.patch, 'effect') }; }
