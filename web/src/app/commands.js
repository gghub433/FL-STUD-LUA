// High-level project operations. Each one is a single undo step and tells the store which
// sections of the project changed.
import { STEP, MIDDLE_C } from '../core/constants.js';
import {
  createChannel, createNote, createPattern, clone, patternLength, barTicks, stepsPerBar, nextId, COLORS, currentArrangement, createFxSlot,
} from '../core/project.js';
import { instrumentMeta } from '../core/instruments/index.js';

const CH = [['channels']];

export function addChannel(store, type, opts = {}) {
  const ch = store.edit(`Add ${opts.name || type}`, (p) => {
    const c = createChannel(p, type, opts);
    if (type === 'sampler' && !c.sample && opts.sample === undefined) c.sample = null;
    p.channels.push(c);
    return c;
  }, CH);
  store.select(ch.id);
  if (ch.sample) store.bank.ensure(ch.sample.id);
  return ch;
}

export function setChannelSample(store, chId, sample) {
  store.edit('Change sample', () => { store.channel(chId).sample = sample ? { id: sample.id, name: sample.name } : null; }, CH);
  if (sample) store.bank.ensure(sample.id);
}

export function removeChannel(store, id) {
  store.edit('Delete channel', (p) => {
    const i = p.channels.findIndex((c) => c.id === id);
    if (i < 0) return;
    p.channels.splice(i, 1);
    for (const pat of Object.values(p.patterns)) delete pat.notes[id];
    for (const c of p.channels) if (c.children) c.children = c.children.filter((x) => x !== id);
    for (const arr of p.playlist.arrangements) arr.clips = arr.clips.filter((c) => c.type === 'pattern' || c.ref !== id);
    p.controllers = p.controllers.filter((l) => !l.addr.startsWith(`ch:${id}:`));
  }, [['channels'], ['patterns'], ['playlist']]);
  if (store.selected === id) store.select(store.project.channels[0] ? store.project.channels[0].id : null);
}

export function cloneChannel(store, id) {
  const src = store.channel(id);
  if (!src) return null;
  const copy = store.edit('Clone channel', (p) => {
    const c = clone(src);
    c.id = nextId(p);
    c.name = src.name.replace(/ \(\d+\)$/, '') + ' (2)';
    const i = p.channels.findIndex((x) => x.id === id);
    p.channels.splice(i + 1, 0, c);
    for (const pat of Object.values(p.patterns)) {
      if (pat.notes[id]) pat.notes[c.id] = pat.notes[id].map((n) => ({ ...n, id: nextId(p) }));
    }
    return c;
  }, [['channels'], ['patterns']]);
  store.select(copy.id);
  return copy;
}

export function moveChannel(store, id, delta) {
  store.edit('Move channel', (p) => {
    const i = p.channels.findIndex((c) => c.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= p.channels.length) return;
    [p.channels[i], p.channels[j]] = [p.channels[j], p.channels[i]];
  }, CH);
}

export function renameChannel(store, id, name) {
  store.edit('Rename channel', () => { const c = store.channel(id); if (c) c.name = name.slice(0, 40) || c.name; }, CH);
}

export function setChannelColor(store, id, color) {
  store.edit('Channel color', () => { const c = store.channel(id); if (c) c.color = color; }, CH);
}

export function setChannelField(store, id, field, value, label = 'Edit channel') {
  store.edit(label, () => { const c = store.channel(id); if (c) c[field] = value; }, CH, { coalesce: `chf:${id}:${field}` });
}

export function setChannelInstrument(store, id, type) {
  store.edit('Replace plugin', (p) => {
    const c = store.channel(id);
    if (!c) return;
    const fresh = createChannel(p, type, { name: c.name, color: c.color, mixer: c.mixer });
    p.seq--; // createChannel consumed an id we do not need
    const i = p.channels.indexOf(c);
    fresh.id = c.id; fresh.vol = c.vol; fresh.pan = c.pan; fresh.pitch = c.pitch; fresh.group = c.group;
    if (type === 'sampler' && c.sample) fresh.sample = c.sample;
    p.channels[i] = fresh;
  }, CH);
}

// ---------------------------------------------------------------- steps / patterns
export function patternSteps(p, pat) {
  return Math.ceil(patternLength(p, pat) / STEP);
}

// A note belongs to a step when it starts within half a step of it and is at most one step long
// (shifted steps from the graph editor still count, longer notes belong to the piano roll).
export const stepOfNote = (n) => Math.round(n.s / STEP);
export const isStepNote = (n, step) => stepOfNote(n) === step && Math.abs(n.s - step * STEP) <= 11 && n.l <= STEP;

export function stepNote(p, pat, chId, step) {
  const list = pat.notes[chId];
  if (!list) return null;
  return list.find((n) => isStepNote(n, step)) || null;
}

export function setStep(store, chId, step, on, opts = {}) {
  const p = store.project, pat = store.pattern;
  const has = !!stepNote(p, pat, chId, step);
  if (has === on) return false;
  store.edit(on ? 'Add step' : 'Remove step', () => {
    const list = pat.notes[chId] || (pat.notes[chId] = []);
    if (on) {
      list.push(createNote(p, step * STEP, STEP, opts.key ?? p.settings.stepKey ?? MIDDLE_C, opts.vel ?? 100));
      list.sort((a, b) => a.s - b.s || a.k - b.k);
    } else {
      pat.notes[chId] = list.filter((n) => !isStepNote(n, step));
    }
  }, [['patterns', pat.id]], { coalesce: 'steps' });
  return true;
}

export function fillEvery(store, chId, n, offset = 0) {
  const p = store.project, pat = store.pattern;
  const steps = patternSteps(p, pat);
  store.edit(`Fill each ${n} steps`, () => {
    const keep = (pat.notes[chId] || []).filter((x) => x.s % STEP !== 0 || x.l !== STEP);
    pat.notes[chId] = keep;
    for (let s = offset; s < steps; s += n) keep.push(createNote(p, s * STEP, STEP, p.settings.stepKey, 100));
    keep.sort((a, b) => a.s - b.s);
  }, [['patterns', pat.id]]);
}

export function randomizeSteps(store, chId, density = 0.3) {
  const p = store.project, pat = store.pattern;
  const steps = patternSteps(p, pat);
  store.edit('Randomize steps', () => {
    const list = [];
    for (let s = 0; s < steps; s++) {
      if (Math.random() < density) list.push(createNote(p, s * STEP, STEP, p.settings.stepKey, 60 + Math.floor(Math.random() * 60)));
    }
    pat.notes[chId] = list;
  }, [['patterns', pat.id]]);
}

export function clearChannelNotes(store, chId) {
  const pat = store.pattern;
  store.edit('Clear channel', () => { delete pat.notes[chId]; }, [['patterns', pat.id]]);
}

export function setStepProp(store, chId, step, prop, value) {
  const pat = store.pattern;
  const n = stepNote(store.project, pat, chId, step);
  if (!n) return;
  store.edit('Edit step', () => {
    if (prop === 'shift') { n.s = Math.max(0, step * STEP + value); return; }
    if (value === undefined) delete n[prop]; else n[prop] = value;
  }, [['patterns', pat.id]], { coalesce: `stepprop:${prop}` });
}

export function setPatternSteps(store, patId, steps) {
  store.edit('Pattern length', (p) => { p.patterns[patId].len = Math.max(1, steps) * STEP; }, [['patterns', patId]]);
}

export function selectPattern(store, id) {
  if (!store.project.patterns[id]) return;
  store.setState(['currentPattern'], id);
  store.bus.emit('pattern', id);
}

export function newPattern(store) {
  let id = 1;
  const p = store.project;
  while (p.patterns[id]) id++;
  store.edit('New pattern', () => { createPattern(p, id); p.currentPattern = id; }, [['patterns', id], ['currentPattern']]);
  store.bus.emit('pattern', id);
  return id;
}

export function clonePattern(store, srcId) {
  const p = store.project;
  let id = 1;
  while (p.patterns[id]) id++;
  const src = p.patterns[srcId];
  store.edit('Clone pattern', () => {
    const np = createPattern(p, id, src.name.replace(/ \(\d+\)$/, '') + ' (2)');
    np.len = src.len;
    for (const k of Object.keys(src.notes)) np.notes[k] = src.notes[k].map((n) => ({ ...n, id: nextId(p) }));
    p.currentPattern = id;
  }, [['patterns', id], ['currentPattern']]);
  store.bus.emit('pattern', id);
  return id;
}

export function deletePattern(store, id) {
  const p = store.project;
  if (Object.keys(p.patterns).length <= 1) { store.bus.emit('toast', 'A project needs at least one pattern'); return; }
  store.edit('Delete pattern', () => {
    delete p.patterns[id];
    for (const arr of p.playlist.arrangements) arr.clips = arr.clips.filter((c) => !(c.type === 'pattern' && c.ref === id));
    if (p.currentPattern === id) p.currentPattern = Number(Object.keys(p.patterns).sort((a, b) => a - b)[0]);
  }, [['patterns', id], ['playlist'], ['currentPattern']]);
  store.bus.emit('pattern', store.project.currentPattern);
}

export function renamePattern(store, id, name) {
  store.edit('Rename pattern', (p) => { p.patterns[id].name = name.slice(0, 40) || p.patterns[id].name; }, [['patterns', id]]);
}

export function setPatternColor(store, id, color) {
  store.edit('Pattern color', (p) => { p.patterns[id].color = color; }, [['patterns', id]]);
}

export function addGroup(store, name) {
  store.edit('Add group', (p) => { if (!p.groups.includes(name)) p.groups.push(name); }, [['groups']]);
}

export function setChannelGroup(store, id, group) {
  store.edit('Set channel group', () => { const c = store.channel(id); if (c) c.group = group === 'All' ? '' : group; }, CH);
}

export function setMixerTarget(store, chId, track) {
  store.edit('Set mixer track', () => { const c = store.channel(chId); if (c) c.mixer = Math.max(0, Math.min(125, track | 0)); }, CH, { coalesce: `mxt:${chId}` });
}

export function nextColor(project) { return COLORS[project.channels.length % COLORS.length]; }
export { instrumentMeta, barTicks, stepsPerBar, currentArrangement, createFxSlot };
