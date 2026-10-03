// High-level project operations. Each one is a single undo step and tells the store which
// sections of the project changed.
import { STEP, MIDDLE_C } from '../core/constants.js';
import {
  createChannel, createNote, createPattern, clone, patternLength, barTicks, stepsPerBar, nextId, COLORS, currentArrangement, createFxSlot,
} from '../core/project.js';
import { instrumentMeta, instrumentSchema } from '../core/instruments/index.js';
import { defaults, clampParam } from '../core/schema.js';
import { defaultPatch, normalizePatch } from '../core/patcher/spec.js';

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
    // automation clips and controller links that pointed at the deleted channel's parameters go with it
    const orphan = new Set(p.channels.filter((c) => c.type === 'automation' && c.target && c.target.startsWith(`ch:${id}:`)).map((c) => c.id));
    if (orphan.size) {
      p.channels = p.channels.filter((c) => !orphan.has(c.id));
      for (const arr of p.playlist.arrangements) arr.clips = arr.clips.filter((c) => !orphan.has(c.ref));
    }
    for (const c of p.channels) if (c.type === 'controller') c.links = c.links.filter((l) => !l.addr.startsWith(`ch:${id}:`));
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

// ---------------------------------------------------------------- mixer
import { reaches, normalizeWam } from '../core/project.js';
import { effectSchema } from '../core/effects/index.js';

const mx = (n) => [['mixer', 'tracks', n]];

export function selectTrack(store, n) {
  store.project.mixer.selected = n;
  store.bus.emit('mixerSel', n);
}

export function setFx(store, track, slot, type) {
  store.edit(type ? 'Insert effect' : 'Remove effect', (p) => {
    p.mixer.tracks[track].fx[slot] = type ? createFxSlot(type) : null;
  }, mx(track));
}

export function setFxExtra(store, track, slot, extra) {
  store.edit('Edit effect data', (p) => { const s = p.mixer.tracks[track].fx[slot]; if (s) s.extra = extra; }, mx(track), { coalesce: `fxextra:${track}:${slot}` });
}

export function moveFx(store, track, from, to) {
  if (from === to) return;
  store.edit('Move effect', (p) => {
    const t = p.mixer.tracks[track];
    const item = t.fx[from];
    const rest = t.fx.filter((_, i) => i !== from);   // 9 entries
    rest.splice(to, 0, item);                          // back to 10, neighbours shift
    t.fx = rest;
  }, mx(track));
}

export function swapFx(store, track, a, b) {
  store.edit('Swap effects', (p) => { const fx = p.mixer.tracks[track].fx; [fx[a], fx[b]] = [fx[b], fx[a]]; }, mx(track));
}

export function copyFx(store, fromTrack, fromSlot, toTrack, toSlot) {
  const src = store.project.mixer.tracks[fromTrack].fx[fromSlot];
  if (!src) return;
  store.edit('Copy effect', (p) => {
    const c = JSON.parse(JSON.stringify(src));
    if (c.type === 'wam' && c.extra) c.extra.wam = normalizeWam({ ...c.extra.wam, id: '' }, true);     // a copy is a second plugin instance
    p.mixer.tracks[toTrack].fx[toSlot] = c;
  }, mx(toTrack));
}

export function setTrackField(store, n, field, value, label = 'Edit track') {
  store.edit(label, (p) => { p.mixer.tracks[n][field] = value; }, mx(n), { coalesce: `trk:${n}:${field}` });
}

export function toggleTrackFlag(store, n, field) {
  store.edit(`Toggle ${field}`, (p) => { const t = p.mixer.tracks[n]; t[field] = t[field] ? 0 : 1; }, mx(n));
}

export function soloTrack(store, n, exclusive) {
  store.edit('Solo', (p) => {
    const t = p.mixer.tracks;
    const was = t[n].solo;
    if (exclusive) for (const x of t) x.solo = 0;
    t[n].solo = was ? 0 : 1;
  }, [['mixer']]);
}

// Toggle a route src -> dest. Returns false when it would create a cycle.
export function toggleRoute(store, src, dest, sidechain = false) {
  const tracks = store.project.mixer.tracks;
  if (src === dest) return false;
  const idx = tracks[src].routes.findIndex((r) => r[0] === dest);
  if (idx < 0 && reaches(tracks, dest, src)) return false;
  store.edit(idx >= 0 ? 'Remove route' : 'Add route', (p) => {
    const r = p.mixer.tracks[src].routes;
    if (idx >= 0) r.splice(idx, 1);
    else r.push([dest, 1, sidechain ? 1 : 0]);
  }, mx(src));
  return true;
}

export function setRoute(store, src, dest, level, sidechain) {
  store.edit('Edit route', (p) => {
    const r = p.mixer.tracks[src].routes.find((x) => x[0] === dest);
    if (r) { if (level !== undefined) r[1] = Math.max(0, Math.min(2, level)); if (sidechain !== undefined) r[2] = sidechain ? 1 : 0; }
  }, mx(src), { coalesce: `route:${src}:${dest}` });
}

export function clearTrack(store, n) {
  store.edit('Reset track', (p) => {
    const t = createTrackLike(p, n);
    p.mixer.tracks[n] = t;
  }, mx(n));
}

import { createTrack } from '../core/project.js';
function createTrackLike(p, n) { return createTrack(n); }

export { effectSchema };

// ---------------------------------------------------------------- instruments
import { slicesToNotes, estimateLoop } from '../core/slice-detect.js';
import { stretchAudio } from '../core/stretch.js';

export function editPad(store, chId, idx, fn, label = 'Edit pad') {
  store.edit(label, () => { const c = store.channel(chId); if (c && c.pads) fn(c.pads[idx], c.pads); }, CH, { coalesce: `pad:${chId}:${idx}:${label}` });
}

export function setChannelData(store, chId, patch, label = 'Edit channel') {
  store.edit(label, () => { const c = store.channel(chId); if (c) Object.assign(c, patch); }, CH, { coalesce: `chd:${chId}:${Object.keys(patch).join()}` });
}

// Several instrument parameters as ONE undo step (e.g. loading a drum-type preset)
export function applyParams(store, chId, values, label = 'Load preset') {
  store.edit(label, (p) => {
    const c = store.channel(chId);
    for (const [k, v] of Object.entries(values)) c.params[k] = v;
  }, CH);
}

export function setSampleUse(store, chId, use) {
  store.edit('Time stretch', () => { const c = store.channel(chId); if (c && c.sample) { if (use) c.sample.use = use; else delete c.sample.use; } }, CH);
  if (use) store.bank.ensure(use);
}

// Render a time-stretched / pitch-shifted copy of the channel's sample into the bank and use it.
export async function applyStretch(store, chId) {
  const c = store.channel(chId);
  if (!c || !c.sample) return false;
  const src = await store.bank.ensure(c.sample.id);
  if (!src) return false;
  const ratio = c.params.stretchTime, semi = c.params.stretchPitch;
  const id = `stretch:${c.sample.id}:${ratio.toFixed(4)}:${semi.toFixed(2)}`;
  if (!store.bank.has(id)) {
    const channels = stretchAudio(src.channels, { ratio, semitones: semi, rate: src.rate });
    store.bank.addPCM(`${src.name} (stretched)`, src.rate, channels, id);
  }
  setSampleUse(store, chId, id);
  return true;
}

export function setSlices(store, chId, slices, loopBpm) {
  store.edit('Edit slices', () => {
    const c = store.channel(chId);
    if (!c) return;
    c.slices = slices.slice(0, 64);
    if (loopBpm !== undefined) c.loopBpm = loopBpm;
  }, CH, { coalesce: `slices:${chId}` });
}

// Write the slices into the current pattern in their original order, quantized to the step grid.
export function sliceToPattern(store, chId, grid = 24) {
  const c = store.channel(chId);
  const e = c && c.sample ? store.bank.get(c.sample.id) : null;
  if (!c || !e || !c.slices.length) return 0;
  const bpm = c.loopBpm || estimateLoop(e.length, e.rate).bpm;
  const notes = slicesToNotes(c.slices, e.length, e.rate, bpm, 60, 100, grid);
  const pat = store.pattern;
  store.edit('Slicer: write MIDI', (p) => {
    pat.notes[chId] = notes.map((n) => createNote(p, n.s, n.l, n.k, n.v));
    if (!pat.len) { const bar = barTicks(p.timeSig); const end = Math.max(...notes.map((n) => n.s + n.l)); if (end > bar) pat.len = Math.ceil(end / bar) * bar; }
  }, [['patterns', pat.id]]);
  return notes.length;
}

// ------------------------------------------------------------------------------ piano roll notes
// All note edits go to the *current pattern*. `ids` are note ids; each call is one undo step (or
// part of a coalesced gesture when `coalesce` is given).

const sortNotes = (list) => list.sort((a, b) => a.s - b.s || a.k - b.k);
const noteEdit = (store, label, fn, coalesce) => {
  const pat = store.pattern;
  return store.edit(label, (p) => fn(p, pat), [['patterns', pat.id]], coalesce ? { coalesce } : {});
};

export function notesOf(store, chId) { const l = store.pattern.notes[chId]; return l || []; }

// create notes from partials {s,l,k,v,...}; returns the created notes
export function addNotes(store, chId, partials, label = 'Add notes', coalesce) {
  return noteEdit(store, label, (p, pat) => {
    const list = pat.notes[chId] || (pat.notes[chId] = []);
    const made = partials.map((n) => ({ ...n, id: nextId(p) }));
    for (const n of made) { if (n.v === undefined) n.v = 100; list.push(n); }
    sortNotes(list);
    return made;
  }, coalesce);
}

export function deleteNotes(store, chId, ids, label = 'Delete notes', coalesce) {
  const set = new Set(ids);
  noteEdit(store, label, (p, pat) => { pat.notes[chId] = (pat.notes[chId] || []).filter((n) => !set.has(n.id)); }, coalesce);
}

// fn(note, index) mutates each selected note in place
export function updateNotes(store, chId, ids, fn, label = 'Edit notes', coalesce) {
  const set = new Set(ids);
  noteEdit(store, label, (p, pat) => {
    const list = pat.notes[chId] || [];
    let i = 0;
    for (const n of list) if (set.has(n.id)) fn(n, i++);
    sortNotes(list);
  }, coalesce);
}

// tool(selectedNotes, newId) -> replacement notes (see core/note-tools.js). Returns the new selection ids.
export function replaceNotes(store, chId, ids, tool, label = 'Edit notes') {
  const set = new Set(ids);
  return noteEdit(store, label, (p, pat) => {
    const list = pat.notes[chId] || [];
    const sel = list.filter((n) => set.has(n.id));
    const rest = list.filter((n) => !set.has(n.id));
    const out = tool(sel, () => nextId(p)) || [];
    const merged = rest.concat(out);
    pat.notes[chId] = sortNotes(merged);
    return out.map((n) => n.id);
  });
}

// notes: complete note objects (ids are reassigned); tick offset and key shift applied
export function pasteNotes(store, chId, notes, dTick, dKey = 0, label = 'Paste notes') {
  return noteEdit(store, label, (p, pat) => {
    const list = pat.notes[chId] || (pat.notes[chId] = []);
    const made = notes.map((n) => ({ ...n, id: nextId(p), s: Math.max(0, n.s + dTick), k: Math.max(0, Math.min(120, n.k + dKey)) }));
    list.push(...made);
    sortNotes(list);
    return made;
  });
}

export function setPatternLength(store, patId, ticks) {
  store.edit('Pattern length', (p) => { p.patterns[patId].len = ticks || null; }, [['patterns', patId]]);
}

// ------------------------------------------------------------------------------ playlist
import { resolveOverlaps, splitClip, defaultClipLength, MAX_TRACK, sortClips } from '../core/playlist-ops.js';
import { createClip, createArrangement } from '../core/project.js';
export { defaultClipLength, MAX_TRACK };

const PLP = [['playlist']];
const plEdit = (store, label, fn, coalesce) => store.edit(label, (p) => fn(p, currentArrangement(p)), PLP, coalesce ? { coalesce } : {});
const clampTrack = (t) => Math.max(1, Math.min(MAX_TRACK, Math.round(t)));

// partials: { type, track, s, l, ref, o?, ...extra }. Existing clips under the new ones are trimmed away.
export function addClips(store, partials, label = 'Add clips', coalesce, { overlap = true } = {}) {
  return plEdit(store, label, (p, arr) => {
    const made = partials.map((c) => {
      const { type, track, s, l, ref, id, ...extra } = c;
      for (const k of Object.keys(extra)) if (extra[k] === undefined) delete extra[k];
      return createClip(p, type, clampTrack(track), Math.max(0, Math.round(s)), Math.max(1, Math.round(l)), ref, extra);
    });
    arr.clips.push(...made);
    arr.clips = overlap ? resolveOverlaps(arr.clips, made, () => nextId(p)) : sortClips(arr.clips);
    return made;
  }, coalesce);
}

export function deleteClips(store, ids, label = 'Delete clips', coalesce) {
  const set = new Set(ids);
  plEdit(store, label, (p, arr) => { arr.clips = arr.clips.filter((c) => !set.has(c.id)); }, coalesce);
}

// fn(clip, index) mutates the selected clips; the result is cleaned up so clips on a track never overlap
export function updateClips(store, ids, fn, label = 'Edit clips', coalesce, { overlap = true } = {}) {
  const set = new Set(ids);
  plEdit(store, label, (p, arr) => {
    const sel = arr.clips.filter((c) => set.has(c.id));
    sel.forEach((c, i) => fn(c, i));
    for (const c of sel) { c.track = clampTrack(c.track); c.s = Math.max(0, c.s); c.l = Math.max(1, c.l); }
    arr.clips = overlap ? resolveOverlaps(arr.clips, sel, () => nextId(p)) : sortClips(arr.clips);
  }, coalesce);
}

// One step of a clip drag. `base` is the clip list as it was when the drag started (after any Ctrl-copy);
// every step rebuilds the list from it, so clips the dragged ones pass over are cut only while they are
// on top of them and come back when the drag moves on.
export function dragClips(store, base, ids, fn, label, coalesce) {
  const set = new Set(ids);
  plEdit(store, label, (p, arr) => {
    const clips = base.map((c) => ({ ...c }));
    const sel = clips.filter((c) => set.has(c.id));
    sel.forEach((c, i) => fn(c, i));
    for (const c of sel) { c.track = clampTrack(c.track); c.s = Math.max(0, c.s); c.l = Math.max(1, c.l); }
    arr.clips = resolveOverlaps(clips, sel, () => nextId(p));
  }, coalesce);
}

// tool(selClips, newId) -> replacement clips (slice, glue…); returns the ids of the replacement clips
export function replaceClips(store, ids, tool, label = 'Edit clips') {
  const set = new Set(ids);
  return plEdit(store, label, (p, arr) => {
    const sel = arr.clips.filter((c) => set.has(c.id));
    const rest = arr.clips.filter((c) => !set.has(c.id));
    const out = tool(sel, () => nextId(p)) || [];
    arr.clips = sortClips(rest.concat(out));
    return out.map((c) => c.id);
  });
}

export function sliceClips(store, cuts /* [[clipId, tick]] */, label = 'Slice clips') {
  const map = new Map(cuts);
  return replaceClips(store, [...map.keys()], (sel, newId) => {
    const out = [];
    for (const c of sel) { out.push(c); const r = splitClip(c, map.get(c.id), newId); if (r) out.push(r); }
    return out;
  }, label);
}

export function pasteClips(store, clips, dTick, dTrack = 0, label = 'Paste clips') {
  return addClips(store, clips.map((c) => ({ ...c, id: undefined, s: c.s + dTick, track: c.track + dTrack })), label);
}

// give pattern clips their own copy of the pattern so editing it no longer changes the other clips
export function makeUnique(store, ids) {
  const set = new Set(ids);
  return plEdit(store, 'Make pattern unique', (p, arr) => {
    const cache = new Map();
    for (const c of arr.clips) {
      if (!set.has(c.id) || c.type !== 'pattern') continue;
      if (!cache.has(c.ref)) {
        const src = p.patterns[c.ref];
        let nid = 1; while (p.patterns[nid]) nid++;
        const copy = { ...clone(src), id: nid, name: `${src.name} (unique)` };
        for (const k of Object.keys(copy.notes)) copy.notes[k] = copy.notes[k].map((n) => ({ ...n, id: nextId(p) }));
        p.patterns[nid] = copy;
        cache.set(c.ref, nid);
      }
      c.ref = cache.get(c.ref);
    }
  }, [['playlist'], ['patterns']]);
}

// ---- arrangements
export function selectArrangement(store, id) {
  store.edit('Select arrangement', (p) => { p.playlist.current = id; }, PLP, { noUndo: true });
  store.bus.emit('arrangement', id);
}

export function addArrangement(store, name) {
  const a = store.edit('Add arrangement', (p) => {
    const arr = createArrangement(nextId(p), name || `Arrangement ${p.playlist.arrangements.length + 1}`);
    p.playlist.arrangements.push(arr);
    p.playlist.current = arr.id;
    return arr;
  }, PLP);
  store.bus.emit('arrangement', a.id);
  return a;
}

export function cloneArrangement(store, id) {
  const a = store.edit('Duplicate arrangement', (p) => {
    const src = p.playlist.arrangements.find((x) => x.id === id);
    if (!src) return null;
    const copy = clone(src);
    copy.id = nextId(p); copy.name = `${src.name} (copy)`;
    for (const c of copy.clips) c.id = nextId(p);
    for (const m of copy.markers) m.id = nextId(p);
    p.playlist.arrangements.push(copy);
    p.playlist.current = copy.id;
    return copy;
  }, PLP);
  if (a) store.bus.emit('arrangement', a.id);
  return a;
}

export function renameArrangement(store, id, name) {
  store.edit('Rename arrangement', (p) => { const a = p.playlist.arrangements.find((x) => x.id === id); if (a) a.name = name.slice(0, 40) || a.name; }, PLP);
}

export function deleteArrangement(store, id) {
  if (store.project.playlist.arrangements.length < 2) return false;
  store.edit('Delete arrangement', (p) => {
    p.playlist.arrangements = p.playlist.arrangements.filter((x) => x.id !== id);
    if (p.playlist.current === id) p.playlist.current = p.playlist.arrangements[0].id;
  }, PLP);
  store.bus.emit('arrangement', store.project.playlist.current);
  return true;
}

// ---- markers, loop, start, punch (all live in the current arrangement)
export function addMarker(store, marker) {
  return plEdit(store, 'Add marker', (p, arr) => { const m = { id: nextId(p), name: '', num: 4, den: 4, len: 384, ...marker }; arr.markers.push(m); arr.markers.sort((a, b) => a.t - b.t); return m; });
}

export function updateMarker(store, id, fn, label = 'Edit marker', coalesce) {
  plEdit(store, label, (p, arr) => { const m = arr.markers.find((x) => x.id === id); if (m) { fn(m); arr.markers.sort((a, b) => a.t - b.t); } }, coalesce);
}

export function removeMarker(store, id) { plEdit(store, 'Delete marker', (p, arr) => { arr.markers = arr.markers.filter((m) => m.id !== id); }); }
export function setLoop(store, loop, coalesce) { plEdit(store, 'Loop region', (p, arr) => { arr.loop = loop && loop.e > loop.s ? { s: Math.max(0, Math.round(loop.s)), e: Math.round(loop.e) } : null; }, coalesce); }
export function setStartMarker(store, t) { plEdit(store, 'Start marker', (p, arr) => { arr.start = t == null ? null : Math.max(0, Math.round(t)); }); }
export function setPunch(store, punch) { plEdit(store, 'Punch region', (p, arr) => { arr.punch = punch && punch.out > punch.in ? { in: Math.round(punch.in), out: Math.round(punch.out) } : null; }); }

// ---- per-track settings: { name, color, mute, solo, lock, height }
export function setPlaylistTrack(store, track, patch, label = 'Edit track') {
  plEdit(store, label, (p, arr) => {
    const t = arr.tracks[track] || (arr.tracks[track] = {});
    for (const [k, v] of Object.entries(patch)) { if (v === undefined || v === null || v === 0 || v === '') delete t[k]; else t[k] = v; }
    if (!Object.keys(t).length) delete arr.tracks[track];
  });
}

// ---- audio / automation sources for clips
export function addAudioChannel(store, sample, name) {
  const ch = addChannel(store, 'audio', { name: name || sample.name, sample: { id: sample.id, name: sample.name } });
  return ch;
}

// Time-stretch / pitch-shift one audio clip: renders a derived copy of the sample and points the clip at it.
export async function stretchClip(store, clipId, ratio, semitones) {
  const arr = store.arrangement;
  const clip = arr.clips.find((c) => c.id === clipId);
  const ch = clip && store.channel(clip.ref);
  if (!clip || !ch || !ch.sample) return false;
  const baseId = ch.sample.id;
  const src = await store.bank.ensure(baseId);
  if (!src) return false;
  const id = `stretch:${baseId}:${ratio.toFixed(4)}:${semitones.toFixed(2)}`;
  if (!store.bank.has(id)) store.bank.addPCM(`${src.name} (stretched)`, src.rate, stretchAudio(src.channels, { ratio, semitones, rate: src.rate }), id);
  const oldRatio = clip.stretch || 1;
  updateClips(store, [clipId], (c) => {
    c.use = id; c.stretch = ratio;
    c.l = Math.max(1, Math.round((c.l * ratio) / oldRatio));      // the clip keeps showing the same material
    c.o = Math.round((c.o * ratio) / oldRatio);
    delete c.pitch;
  }, 'Time-stretch clip');
  return true;
}

// Fit an audio clip recorded at `bpm` to the project tempo (time-stretch, pitch kept). follow: keep it fitted
// whenever the project tempo changes (see followTempo).
export async function fitClipToTempo(store, clipId, bpm, { follow = true } = {}) {
  const ratio = bpm / store.project.tempo;
  if (!(ratio > 0.1 && ratio < 10)) return false;
  const same = Math.abs(ratio - 1) < 1e-4;
  if (!same && !(await stretchClip(store, clipId, ratio, 0))) return false;
  updateClips(store, [clipId], (c) => {
    if (follow) c.bpm = Math.round(bpm * 100) / 100; else delete c.bpm;
    if (same && c.stretch) { const r = c.stretch; c.l = Math.max(1, Math.round(c.l / r)); c.o = Math.round(c.o / r); delete c.use; delete c.stretch; }
  }, 'Fit clip to tempo');
  return true;
}

// After a tempo change: re-stretch every clip that follows the tempo. The clips keep their place and length in
// the song (ticks); only the audio behind them is rendered again. Returns how many clips changed.
export async function followTempo(store) {
  const p = store.project, changed = [];
  for (const arr of p.playlist.arrangements) {
    for (const clip of arr.clips) {
      if (clip.type !== 'audio' || !clip.bpm) continue;
      const ratio = clip.bpm / p.tempo;
      if (Math.abs((clip.stretch || 1) - ratio) < 1e-4 || ratio <= 0.1 || ratio >= 10) continue;
      const ch = store.channel(clip.ref);
      const src = ch && ch.sample ? await store.bank.ensure(ch.sample.id) : null;
      if (!src) continue;
      const id = Math.abs(ratio - 1) < 1e-4 ? null : `stretch:${ch.sample.id}:${ratio.toFixed(4)}:0.00`;
      if (id && !store.bank.has(id)) store.bank.addPCM(`${src.name} (stretched)`, src.rate, stretchAudio(src.channels, { ratio, semitones: 0, rate: src.rate }), id);
      changed.push([arr.id, clip.id, id, ratio]);
    }
  }
  if (!changed.length) return 0;
  store.edit('Follow tempo', (pr) => {
    for (const [aid, cid, id, ratio] of changed) {
      const c = pr.playlist.arrangements.find((a) => a.id === aid).clips.find((x) => x.id === cid);
      if (!c) continue;
      if (id) { c.use = id; c.stretch = ratio; } else { delete c.use; delete c.stretch; }
      delete c.pitch;
    }
  }, [['playlist']], { noUndo: true });
  return changed.length;
}

// Load a preset: the instrument returns to its defaults first, then the preset's values are applied (one undo step)
export function loadInstrumentPreset(store, chId, params, label = 'Load preset') {
  store.edit(label, () => {
    const c = store.channel(chId);
    if (!c) return;
    const schema = instrumentSchema(c.type) || [];
    c.params = { ...defaults(schema) };
    for (const [k, v] of Object.entries(params)) {
      const d = schema.find((x) => x.id === k);
      if (d) c.params[k] = clampParam(d, v);
    }
  }, CH);
}


// ------------------------------------------------------------------------------ automation clips
import { paramDef as paramDefOf, paramLabel as paramLabelOf, getParam as getParamOf } from '../core/addr.js';
import { toNorm as toNormOf } from '../core/schema.js';

export const automationFor = (project, addr) => project.channels.find((c) => c.type === 'automation' && c.target === addr) || null;

// first playlist track where [s, s+l) is free
function freeTrack(arr, s, l, from = 1) {
  for (let t = from; t <= MAX_TRACK; t++) if (!arr.clips.some((c) => c.track === t && c.s < s + l && c.s + c.l > s)) return t;
  return MAX_TRACK;
}

// Right-click a knob -> "Create automation clip": a channel holding the curve (flat at the knob's current
// value) plus a clip for it in the current arrangement. An existing curve for the same knob is reused.
export function createAutomationClip(store, addr, { start = 0, bars = 1 } = {}) {
  const p0 = store.project;
  const def = paramDefOf(p0, addr);
  if (!def) return null;
  let made = null;
  store.edit('Create automation clip', (p) => {
    let ch = automationFor(p, addr);
    if (!ch) {
      const len = barTicks(p.timeSig) * bars;
      const v = toNormOf(def, getParamOf(p, addr) ?? def.def);
      ch = createChannel(p, 'automation', { name: paramLabelOf(p, addr), target: addr, len, points: [{ t: 0, v, type: 'single', tension: 0, count: 4 }, { t: len, v, type: 'single', tension: 0, count: 4 }] });
      p.channels.push(ch);
    }
    const arr = currentArrangement(p);
    const l = ch.len || barTicks(p.timeSig);
    const s = Math.max(0, Math.round(start));
    const clip = createClip(p, 'automation', freeTrack(arr, s, l), s, l, ch.id);
    arr.clips.push(clip);
    arr.clips = sortClips(arr.clips);
    made = { channel: ch, clip };
  }, [['channels'], ['playlist']]);
  return made;
}

export function setAutomationPoints(store, chId, points, label = 'Edit automation', coalesce) {
  store.edit(label, () => {
    const c = store.channel(chId);
    if (c && c.type === 'automation') { c.points = points.slice(0, 4096).sort((a, b) => a.t - b.t); }
  }, CH, coalesce ? { coalesce } : {});
}

// fn(points) mutates a copy of the points; the result is stored
export function editAutomation(store, chId, fn, label = 'Edit automation', coalesce) {
  store.edit(label, () => {
    const c = store.channel(chId);
    if (!c || c.type !== 'automation') return;
    const pts = c.points.map((q) => ({ ...q }));
    const out = fn(pts, c) || pts;
    c.points = out.slice(0, 4096).sort((a, b) => a.t - b.t);
  }, CH, coalesce ? { coalesce } : {});
}

export function setAutomationLength(store, chId, len) {
  store.edit('Automation length', () => { const c = store.channel(chId); if (c) c.len = Math.max(STEP, Math.round(len)); }, CH, { coalesce: `autolen:${chId}` });
}

export function setAutomationTarget(store, chId, addr) {
  store.edit('Automation target', () => { const c = store.channel(chId); if (c) { c.target = addr; c.name = paramLabelOf(store.project, addr); } }, CH);
}

// ------------------------------------------------------------------------------ controllers (LFO / envelope)
export function addController(store, mode = 0, name) {
  return addChannel(store, 'controller', { name: name || (mode === 1 ? 'Envelope 1' : 'LFO 1'), params: { mode } });
}

export function linkController(store, ctrlId, addr, { min = 0, max = 1, inv = 0 } = {}) {
  store.edit('Link to controller', () => {
    const c = store.channel(ctrlId);
    if (!c || c.type !== 'controller') return;
    const l = c.links.find((x) => x.addr === addr);
    if (l) Object.assign(l, { min, max, inv }); else c.links.push({ addr, min, max, inv });
  }, CH);
}

export function updateLink(store, ctrlId, index, patch, coalesce) {
  store.edit('Edit link', () => { const c = store.channel(ctrlId); const l = c && c.links[index]; if (l) Object.assign(l, patch); }, CH, coalesce ? { coalesce } : {});
}

export function unlinkController(store, ctrlId, addr) {
  store.edit('Remove link', () => { const c = store.channel(ctrlId); if (c && c.type === 'controller') c.links = c.links.filter((l) => l.addr !== addr); }, CH);
}

export const controllersFor = (project, addr) => project.channels.filter((c) => c.type === 'controller' && c.links.some((l) => l.addr === addr));

// ------------------------------------------------------------------------------ MIDI links (project.controllers)
export function setMidiLink(store, link) {
  store.edit('Link to MIDI controller', (p) => {
    p.controllers = p.controllers.filter((l) => l.addr !== link.addr);
    p.controllers.push({ addr: link.addr, chan: link.chan ?? 0, cc: link.cc, min: link.min ?? 0, max: link.max ?? 1, invert: link.invert ? 1 : 0 });
  }, [['controllers']]);
}

export function removeMidiLink(store, addr) {
  store.edit('Remove MIDI link', (p) => { p.controllers = p.controllers.filter((l) => l.addr !== addr); }, [['controllers']]);
}

// ------------------------------------------------------------------------------ library: presets, snapshots, scores
// a channel saved with channelSnapshot() comes back as a new channel (fresh id, same sounds and settings)
export function addChannelSnapshot(store, snap, opts = {}) {
  const ch = store.edit(`Add ${snap.name || 'channel'}`, (p) => {
    const c = JSON.parse(JSON.stringify(snap));
    c.id = nextId(p);
    c.mixer = opts.mixer ?? 0;
    c.name = opts.name || snap.name;
    if (c.type === 'controller') c.links = [];                       // links point at other channels' parameters
    p.channels.push(c);
    return c;
  }, CH);
  store.select(ch.id);
  const ids = new Set();
  if (ch.sample) { ids.add(ch.sample.id); if (ch.sample.use) ids.add(ch.sample.use); }
  if (ch.pads) for (const pd of ch.pads) for (const l of pd.layers || []) ids.add(l.sample.id);
  for (const id of ids) store.bank.ensure(id);
  return ch;
}

// replace the settings and the effect chain of one mixer track with a saved snapshot
export function applyMixerSnapshot(store, track, snap) {
  store.edit('Load mixer preset', (p) => {
    const t = p.mixer.tracks[track];
    const s = JSON.parse(JSON.stringify(snap));
    for (const k of ['vol', 'pan', 'sep', 'delay', 'eqLowG', 'eqLowF', 'eqMidG', 'eqMidF', 'eqMidQ', 'eqHighG', 'eqHighF']) if (s[k] !== undefined) t[k] = s[k];
    t.fx = Array.from({ length: t.fx.length }, (_, i) => (s.fx && s.fx[i] && effectSchema(s.fx[i].type) ? s.fx[i] : null));
  }, [['mixer', 'tracks', track]]);
  const t = store.project.mixer.tracks[track];
  for (const f of t.fx) if (f && f.extra && f.extra.irId) store.bank.ensure(f.extra.irId);
}

// put an effect (with preset values) into a slot; slot < 0 = first free slot. Returns the slot used or -1
export function setFxPreset(store, track, slot, type, params = {}, extra = null) {
  const t0 = store.project.mixer.tracks[track];
  const at = slot >= 0 ? slot : t0.fx.findIndex((s) => !s);
  if (at < 0) return -1;
  store.edit('Insert effect', (p) => {
    const s = createFxSlot(type);
    const schema = effectSchema(type) || [];
    for (const [k, v] of Object.entries(params)) { const d = schema.find((x) => x.id === k); if (d) s.params[k] = clampParam(d, v); }
    if (extra) s.extra = JSON.parse(JSON.stringify(extra));
    p.mixer.tracks[track].fx[at] = s;
  }, [['mixer', 'tracks', track]]);
  const f = store.project.mixer.tracks[track].fx[at];
  if (f && f.extra && f.extra.irId) store.bank.ensure(f.extra.irId);
  return at;
}

// ---- Patcher. A target is { ch: channelId } (instrument) or { track, slot } (effect slot).
// The edit function receives the live patch object; `sync: false` is for edits the audio thread does not care
// about (node positions) so they do not rebuild the graph.
function patchHolder(p, t) {
  if (t.ch !== undefined) { const c = p.channels.find((x) => x.id === t.ch); return c && c.type === 'patcher' ? c : null; }
  const s = p.mixer.tracks[t.track] && p.mixer.tracks[t.track].fx[t.slot];
  return s && s.type === 'patcher' ? s : null;
}
export function getPatch(store, t) {
  const hd = patchHolder(store.project, t);
  if (!hd) return null;
  return t.ch !== undefined ? hd.patch : hd.extra && hd.extra.patch;
}
export function patchEdit(store, t, label, fn, { sync = true, coalesce } = {}) {
  const p = store.project;
  const hd = patchHolder(p, t);
  if (!hd) return null;
  const path = t.ch !== undefined ? ['channels', p.channels.indexOf(hd), 'patch'] : ['mixer', 'tracks', t.track, 'fx', t.slot, 'extra'];
  return store.edit(label, () => {
    const patch = t.ch !== undefined ? (hd.patch || (hd.patch = defaultPatch('instrument'))) : ((hd.extra || (hd.extra = {})).patch || (hd.extra.patch = defaultPatch('effect')));
    return fn(patch);
  }, sync ? [path] : [], { coalesce });
}
export function setPatch(store, t, patch, label = 'Load patch') {
  return patchEdit(store, t, label, () => {
    const hd = patchHolder(store.project, t);
    const clean = normalizePatch(JSON.parse(JSON.stringify(patch)), t.ch !== undefined ? 'instrument' : 'effect');
    if (t.ch !== undefined) hd.patch = clean; else hd.extra = { ...(hd.extra || {}), patch: clean };
  });
}
