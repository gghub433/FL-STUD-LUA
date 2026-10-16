// Piano roll scripts: small JavaScript programs that change, add or delete notes. A script is a definition
//   { name, description, params: [{ id, name, type, … }], run(ctx) }
// and run(ctx) gets plain copies of the notes (ctx.notes, with readable field names), the parameter values
// (ctx.params) and helpers; it returns the new list of notes or changes ctx.notes in place.
//
// This module is pure (no DOM, no project): the piano roll runs the factory scripts with it directly, a user script
// runs in a Worker (worker/roll-script-worker.js) with the same code, and the page checks every note that comes back
// (finish) before anything reaches the project. See app/roll-scripts.js for the preview and undo side.
import { PPQ, STEP, KEY_MAX, NOTE_NAMES, keyName } from './constants.js';
import { SCALES, SCALE_BY_ID, CHORDS, inScale, snapToScale, scaleStep, chordKeys, diatonicChord } from './scales.js';
import * as T from './note-tools.js';

export const MAX_NOTES = 20000;          // a script that makes more notes than this stops with an error
export const MAX_TICK = 1e8;             // same limit as the project loader
export const MAX_SOURCE = 200000;        // characters of a user script
export const PARAM_TYPES = ['slider', 'number', 'key', 'choice', 'check', 'text'];

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const mod12 = (n) => ((n % 12) + 12) % 12;
const fail = (error) => ({ ok: false, error });

// ------------------------------------------------------------------------------ notes
// script field, project field, default, min, max (the optional fields; time / length / key / velocity are separate)
const OPTIONAL = [
  ['pan', 'pan', 0, -64, 64], ['release', 'rel', 64, 0, 127], ['fine', 'fine', 0, -120, 120],
  ['modX', 'mx', 128, 0, 255], ['modY', 'my', 128, 0, 255], ['color', 'c', 0, 0, 15],
];
const FIELDS = ['id', 'time', 'length', 'key', 'velocity', ...OPTIONAL.map((f) => f[0]), 'slide', 'muted'];

// project note -> script note (every field present, defaults filled in)
export function toScriptNote(n) {
  const o = { id: n.id, time: n.s, length: n.l, key: n.k, velocity: n.v };
  for (const [name, field, def] of OPTIONAL) o[name] = n[field] === undefined ? def : n[field];
  o.slide = !!n.slide; o.muted = !!n.mute;
  return o;
}

// script note -> project-shaped note without any checking (for the note tools that scripts call through ctx.tools)
function looseProjectNote(o, id) {
  const n = { id, s: Number(o.time) || 0, l: Number(o.length) || STEP, k: Number(o.key) || 0, v: o.velocity === undefined ? 100 : Number(o.velocity) };
  for (const [name, field, def] of OPTIONAL) if (o[name] !== undefined && o[name] !== def) n[field] = Number(o[name]);
  if (o.slide) n.slide = 1;
  if (o.muted) n.mute = 1;
  return n;
}

// Copy of what a script returned, reduced to the known fields with primitive values, so it can cross postMessage and
// cannot run code later (getters, toString tricks). Anything that is not a plain value becomes NaN and fails finish().
export function plainNote(o) {
  if (!o || typeof o !== 'object') return null;
  const n = {};
  for (const f of FIELDS) {
    const v = o[f];
    if (v === undefined) continue;
    n[f] = v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ? v : NaN;
  }
  return n;
}

// One returned note -> a project note, or the reason it cannot be used. Missing optional fields take their defaults,
// values outside their range are clamped; NaN, a key outside 0..120, a negative time or a length <= 0 are errors.
function checkNote(o, i) {
  const at = `Note ${i + 1}`;
  if (!o || typeof o !== 'object') return `${at} is not an object`;
  const num = (f, def) => {
    const v = o[f];
    if (v === undefined || v === null) {
      if (def === undefined) throw new Error(`${at}: ${f} is missing`);
      return def;
    }
    if (typeof v === 'boolean') return +v;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${at}: ${f} is not a number`);
    return v;
  };
  try {
    const time = Math.round(num('time'));
    if (time < 0) return `${at}: time is negative (${time})`;
    if (time > MAX_TICK) return `${at}: time is too large`;
    const len = num('length', STEP);
    if (!(len > 0)) return `${at}: length must be more than 0`;
    const key = Math.round(num('key'));
    if (key < 0 || key > KEY_MAX) return `${at}: key ${key} is outside 0–${KEY_MAX}`;
    const n = { s: time, l: clamp(Math.round(len), 1, MAX_TICK), k: key, v: clamp(Math.round(num('velocity', 100)), 1, 127) };
    for (const [name, field, def, lo, hi] of OPTIONAL) {
      const v = clamp(Math.round(num(name, def)), lo, hi);
      if (v !== def) n[field] = v;
    }
    if (o.slide) n.slide = 1;
    if (o.muted) n.mute = 1;
    return n;
  } catch (e) { return e.message; }
}

// Turns what run() returned into project notes. A note keeps its id when the id belongs to one of the notes the
// script was given (the first copy wins); every other note is new and gets an id when it is written.
export function finish(list, inputIds = []) {
  if (!Array.isArray(list)) return fail('run() must return a list of notes');
  if (list.length > MAX_NOTES) return fail(`The script made more than ${MAX_NOTES} notes`);
  const known = new Set(inputIds), used = new Set(), out = [];
  for (let i = 0; i < list.length; i++) {
    const n = checkNote(list[i], i);
    if (typeof n === 'string') return fail(n);
    const id = list[i].id;
    if (known.has(id) && !used.has(id)) { n.id = id; used.add(id); }
    out.push(n);
  }
  return { ok: true, notes: out };
}

// ------------------------------------------------------------------------------ parameters
const isId = (s) => typeof s === 'string' && /^[A-Za-z_$][\w$]*$/.test(s);
const fin = (v, def) => (typeof v === 'number' && Number.isFinite(v) ? v : def);

// Checks the parameter list of a script and fills in what is left out. Throws with a readable message.
export function normalizeParams(defs) {
  if (defs === undefined || defs === null) return [];
  if (!Array.isArray(defs)) throw new Error('params must be a list');
  if (defs.length > 40) throw new Error('A script can have at most 40 parameters');
  const out = [], ids = new Set();
  defs.forEach((d, i) => {
    const at = `Parameter ${i + 1}`;
    if (!d || typeof d !== 'object') throw new Error(`${at} is not an object`);
    if (!isId(d.id)) throw new Error(`${at} needs an id (a name like "amount")`);
    if (ids.has(d.id)) throw new Error(`${at}: the id "${d.id}" is used twice`);
    ids.add(d.id);
    const type = d.type === undefined ? 'slider' : d.type;
    if (!PARAM_TYPES.includes(type)) throw new Error(`${at} has an unknown type "${type}" (${PARAM_TYPES.join(', ')})`);
    const label = d.name ?? d.label;
    const p = { id: d.id, name: typeof label === 'string' && label ? label.slice(0, 80) : d.id, type };
    const def = d.value ?? d.default;
    if (type === 'slider' || type === 'number' || type === 'key') {
      const lo = type === 'key' ? 0 : -1e9, hi = type === 'key' ? KEY_MAX : 1e9;
      p.min = clamp(fin(d.min, 0), lo, hi);
      p.max = clamp(fin(d.max, type === 'key' ? KEY_MAX : 100), lo, hi);
      if (p.max < p.min) throw new Error(`${at}: max is below min`);
      p.step = type === 'key' ? 1 : fin(d.step, 1) > 0 ? fin(d.step, 1) : 1;
      p.value = clamp(fin(def, p.min), p.min, p.max);
      if (typeof d.unit === 'string') p.unit = d.unit.slice(0, 12);
    } else if (type === 'choice') {
      if (!Array.isArray(d.options) || !d.options.length) throw new Error(`${at}: a choice needs options`);
      p.options = d.options.map((o) => {
        const [v, l] = Array.isArray(o) ? o : [o, o];
        if (typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) throw new Error(`${at}: options must be texts or numbers`);
        return [v, String(l ?? v).slice(0, 80)];
      });
      p.value = (p.options.find(([v]) => v === def) || p.options[0])[0];
    } else if (type === 'check') p.value = !!def;
    else p.value = typeof def === 'string' ? def.slice(0, 500) : '';
    if (typeof d.hint === 'string') p.hint = d.hint.slice(0, 200);
    out.push(p);
  });
  return out;
}

// The values a run uses: the given ones where they fit the parameter, the defaults otherwise.
export function paramValues(params, given = {}) {
  const o = {};
  for (const p of params) {
    const v = given ? given[p.id] : undefined;
    if (p.type === 'choice') o[p.id] = (p.options.find(([x]) => v !== undefined && String(x) === String(v)) || [p.value])[0];
    else if (p.type === 'check') o[p.id] = v === undefined ? p.value : !!v;
    else if (p.type === 'text') o[p.id] = typeof v === 'string' ? v.slice(0, 500) : p.value;
    else o[p.id] = typeof v === 'number' && Number.isFinite(v) ? clamp(v, p.min, p.max) : p.value;
  }
  return o;
}

// ------------------------------------------------------------------------------ context
// Seeded random numbers: random() is 0 <= x < 1, plus a few shapes on top of it.
export function makeRandom(seed = 1) {
  const r = T.mulberry32(Math.floor(fin(seed, 1)));
  const random = () => r();
  random.int = (lo, hi) => lo + Math.floor(r() * (Math.floor(hi) - Math.floor(lo) + 1));
  random.range = (lo, hi) => lo + r() * (hi - lo);
  random.pick = (list) => list[Math.floor(r() * list.length)];
  random.chance = (p) => r() < p;
  random.gauss = () => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  return random;
}

const barOf = (ts) => Math.round((ts.num * PPQ * 4) / ts.den);

// What the piano roll hands to a script, as plain data: the notes (project notes), the time signature, the scale,
// the pattern length and whether the notes are a selection. The range is the selection rounded out to whole bars,
// or the whole pattern when nothing is selected.
export function scriptInput({ notes = [], timeSig = { num: 4, den: 4 }, scale = { root: 0, id: 'chromatic' }, patternLength = 0, selection = false } = {}) {
  const ts = { num: Math.max(1, Math.round(fin(timeSig.num, 4))), den: Math.max(1, Math.round(fin(timeSig.den, 4))) };
  const bar = barOf(ts);
  const b = T.bounds(notes);
  let range;
  if (selection && b) {
    const start = Math.floor(b.s / bar) * bar;
    range = { start, end: Math.max(start + bar, Math.ceil(b.e / bar) * bar) };
  } else range = { start: 0, end: Math.max(bar, patternLength, b ? Math.ceil(b.e / bar) * bar : 0) };
  return { notes: notes.map((n) => ({ ...n })), timeSig: ts, scale: { root: mod12(Math.round(fin(scale.root, 0))), id: SCALE_BY_ID.has(scale.id) ? scale.id : 'chromatic' }, patternLength, selection: !!selection, range };
}

// Groups notes that start together (within `tol` ticks) into chords: [{ time, notes (lowest key first) }].
function chordGroups(notes, tol = 2) {
  const sorted = notes.slice().sort((a, b) => a.time - b.time || a.key - b.key);
  const out = [];
  for (const n of sorted) {
    const g = out[out.length - 1];
    if (g && Math.abs(n.time - g.time) <= tol) g.notes.push(n); else out.push({ time: n.time, notes: [n] });
  }
  for (const g of out) g.notes.sort((a, b) => a.key - b.key);
  return out;
}

export function parseKey(s) {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(s).trim());
  if (!m) return null;
  const k = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12 * +m[3];
  return k >= 0 && k <= KEY_MAX ? k : null;
}

// Everything a script sees: ctx.notes, ctx.params and the helpers listed in README (Piano roll scripts).
export function makeContext(input, values) {
  const ts = input.timeSig || { num: 4, den: 4 };
  const sc = input.scale && SCALE_BY_ID.has(input.scale.id) ? input.scale.id : 'chromatic';
  const root = mod12((input.scale && input.scale.root) || 0);
  const scaleDef = SCALE_BY_ID.get(sc);
  const bar = barOf(ts);
  const range = input.range ? { start: input.range.start, end: input.range.end } : { start: 0, end: Math.max(bar, input.patternLength || 0) };
  const seed = typeof values.seed === 'number' ? values.seed : fin(input.seed, 1);
  const pick = (r, id) => [r === undefined ? root : mod12(r), id === undefined ? sc : id];
  // the note tools of the piano roll (core/note-tools.js) on script notes: notes in, notes out
  const via = (notes, fn) => {
    let tmp = 0;
    const newId = () => --tmp;              // negative ids mark notes the tool made; they become new notes
    const list = notes.map((n) => looseProjectNote(n, typeof n.id === 'number' && n.id > 0 ? n.id : newId()));
    return fn(list, newId).map((n) => { const o = toScriptNote(n); if (!(o.id > 0)) delete o.id; return o; });
  };
  return {
    notes: (input.notes || []).map(toScriptNote),
    params: { ...values },
    ppq: PPQ, step: STEP, beat: Math.round((PPQ * 4) / ts.den), bar,
    timeSig: { num: ts.num, den: ts.den },
    scale: { root, id: sc, name: scaleDef.name, intervals: scaleDef.iv.slice() },
    range, selection: !!input.selection, patternLength: input.patternLength || range.end,
    scales: SCALES.map((s) => ({ id: s.id, name: s.name, intervals: s.iv.slice() })),
    chordTypes: CHORDS.map((c) => ({ id: c.id, name: c.name, intervals: c.iv.slice() })),
    noteNames: NOTE_NAMES.slice(),
    random: makeRandom(seed),
    makeRandom,
    clamp,
    quantize: (t, grid = STEP, strength = 1) => Math.round(t + (Math.round(t / grid) * grid - t) * strength),
    note: (fields = {}) => {
      const n = { time: 0, length: STEP, key: 60, velocity: 100, pan: 0, release: 64, fine: 0, modX: 128, modY: 128, color: 0, slide: false, muted: false, ...fields };
      delete n.id;
      return n;
    },
    chords: chordGroups,
    keyName: (k) => keyName(Math.round(k)),
    parseKey,
    inScale: (k, r, id) => inScale(Math.round(k), ...pick(r, id)),
    snapToScale: (k, r, id) => snapToScale(Math.round(k), ...pick(r, id)),
    scaleStep: (k, steps, r, id) => scaleStep(Math.round(k), Math.round(steps), ...pick(r, id)),
    scaleKeys: (lo, hi, r, id) => { const out = []; const [rr, ii] = pick(r, id); for (let k = Math.max(0, Math.ceil(lo)); k <= Math.min(KEY_MAX, hi); k++) if (inScale(k, rr, ii)) out.push(k); return out; },
    chord: (rootKey, type = 'maj', inversion = 0) => chordKeys(Math.round(rootKey), type, { inversion }),
    diatonicChord: (degree, size = 3, octaveKey = 60, r, id) => diatonicChord(...pick(r, id), Math.round(degree), size, octaveKey),
    tools: {
      quantize: (ns, o) => via(ns, (l) => T.quantize(l, o)),
      chop: (ns, o) => via(ns, (l, id) => T.chop(l, o, id)),
      glue: (ns, o) => via(ns, (l) => T.glue(l, o)),
      flip: (ns, axis = 'h') => via(ns, (l) => T.flip(l, axis)),
      strum: (ns, o) => via(ns, (l) => T.strum(l, o)),
      arpeggiate: (ns, o) => via(ns, (l, id) => T.arpeggiate(l, o, id)),
      legato: (ns, o) => via(ns, (l) => T.legato(l, o)),
      transpose: (ns, semis, o) => via(ns, (l) => T.transpose(l, semis, o)),
      fitToScale: (ns, r, id) => via(ns, (l) => T.fitToScale(l, ...pick(r, id))),
    },
  };
}

// ------------------------------------------------------------------------------ running
// The message of an error thrown by a script, with its line when the stack points into the script's module.
export function errorText(e, url) {
  const msg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
  const stack = e && typeof e.stack === 'string' ? e.stack : '';
  const i = url ? stack.indexOf(`${url}:`) : -1;
  const m = i >= 0 ? /^:(\d+):\d+/.exec(stack.slice(i + url.length)) : null;
  return m ? `Script error (line ${m[1]}): ${msg}` : `Script error: ${msg}`;
}

// Runs the script once. Returns { ok, notes } with the notes as plain values (not yet checked, see finish) or
// { ok: false, error }. Never throws.
export function execute(def, input, values, { url } = {}) {
  try {
    const ctx = makeContext(input, paramValues(def.params, values));
    const ret = def.run(ctx);
    if (ret && typeof ret.then === 'function') return fail('run() must return the notes right away (it cannot be async)');
    if (ret !== undefined && !Array.isArray(ret)) return fail('run() must return a list of notes');
    const list = ret === undefined ? ctx.notes : ret;
    if (!Array.isArray(list)) return fail('run() must return a list of notes');
    if (list.length > MAX_NOTES) return fail(`The script made more than ${MAX_NOTES} notes`);
    return { ok: true, notes: list.map(plainNote) };
  } catch (e) { return fail(errorText(e, url)); }
}

// execute + finish: what the piano roll does for a factory script (and what the tests check)
export function runScript(def, input, values = {}) {
  const r = execute(def, input, values);
  return r.ok ? finish(r.notes, (input.notes || []).map((n) => n.id)) : r;
}

// A loaded module -> a checked definition. Accepts `export default { name, params, run }`, `export default function
// run(ctx)` (with `export const params`) or named exports `params` / `run`.
export function scriptDefinition(mod) {
  let d = mod && mod.default !== undefined ? mod.default : mod;
  if (typeof d === 'function') d = { run: d, params: mod.params, name: mod.name, description: mod.description };
  if (!d || typeof d !== 'object' || typeof d.run !== 'function') throw new Error('The script must export its definition: export default { name, params, run(ctx) { … } }');
  return {
    name: typeof d.name === 'string' ? d.name.trim().slice(0, 80) : '',
    description: typeof d.description === 'string' ? d.description.slice(0, 400) : '',
    params: normalizeParams(d.params),
    run: d.run,
  };
}

const dataUrl = (source) => `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;

// Loads the source of a user script as an ES module. `toUrl` makes the module address (the worker uses a blob: URL,
// Node a data: URL). Returns { def, url }; throws with a readable message.
export async function loadScript(source, { toUrl = dataUrl, importer = (u) => import(u) } = {}) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('The script is empty');
  if (source.length > MAX_SOURCE) throw new Error('The script is too long');
  const url = toUrl(source);
  let mod;
  try { mod = await importer(url); } catch (e) { throw new Error(`The script could not be loaded: ${e && e.message ? e.message : e}`); }
  return { def: scriptDefinition(mod), url };
}

// what the page needs to know about a script before running it (plain data)
export const scriptInfo = (def) => ({ name: def.name, description: def.description, params: def.params });
